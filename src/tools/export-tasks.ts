import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request } from "../clickup-client.js";

const KEEP_SNAPSHOTS = 5;
const MAX_PAGES = 500;
const TOP = 10;
const REMOVED_SAMPLE = 20;

export const exportTasksInputShape = {
  team_id: z
    .string()
    .min(1)
    .optional()
    .describe("Workspace (team) ID. Defaults to CLICKUP_TEAM_ID from .env."),
  include_closed: z.boolean().default(true).describe("Include closed tasks."),
  include_subtasks: z.boolean().default(true).describe("Include subtasks."),
  space_ids: z.array(z.string().min(1)).optional().describe("Only these Spaces."),
  list_ids: z.array(z.string().min(1)).optional().describe("Only these Lists."),
};

const ExportTasksSchema = z.object(exportTasksInputShape);
type ExportTasksInput = z.infer<typeof ExportTasksSchema>;

type Task = {
  id: string;
  status?: { status?: string };
  assignees?: { username?: string; email?: string }[];
  list?: { name?: string };
  due_date?: string | null;
};

type Snapshot = {
  fetched_at: string;
  team_id: string;
  params: Record<string, unknown>;
  tasks: Task[];
};

export function snapshotDir(): string {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "clickup-mcp-extras", "snapshots");
}

/**
 * Write via a temp file in the same directory, then rename: readers never see
 * half a file. Owner-only (0600): snapshots hold the whole workspace.
 */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Sorted, and empty treated as absent: the same filters always compare equal. */
function normalizeIds(ids: string[] | undefined): string[] | null {
  return ids && ids.length > 0 ? [...ids].sort() : null;
}

/** The previous full snapshot, or undefined if missing or not in the expected shape. */
async function readPrevious(path: string): Promise<Snapshot | undefined> {
  try {
    const s = JSON.parse(await readFile(path, "utf8")) as Partial<Snapshot>;
    return typeof s.team_id === "string" && Array.isArray(s.tasks) ? (s as Snapshot) : undefined;
  } catch {
    return undefined;
  }
}

/** Top-N counts plus an "(other)" bucket, so the reply stays small. */
function countTop(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const out: Record<string, number> = Object.fromEntries(sorted.slice(0, TOP));
  const rest = sorted.slice(TOP).reduce((sum, [, n]) => sum + n, 0);
  if (rest > 0) out["(other)"] = rest;
  return out;
}

function buildQuery(input: ExportTasksInput, page: number): string {
  const q = new URLSearchParams({
    page: String(page),
    include_closed: String(input.include_closed),
    subtasks: String(input.include_subtasks),
  });
  for (const id of input.space_ids ?? []) q.append("space_ids[]", id);
  for (const id of input.list_ids ?? []) q.append("list_ids[]", id);
  return q.toString();
}

export async function handleExportTasks(input: ExportTasksInput) {
  const teamId = input.team_id ?? process.env.CLICKUP_TEAM_ID;
  if (!teamId) {
    throw new Error("team_id missing: pass it or set CLICKUP_TEAM_ID in .env.");
  }
  const started = Date.now();

  // Keyed by ID: offset paging can return a task twice if the workspace
  // changes while the export runs.
  const byId = new Map<string, Task>();
  let pages = 0;
  let done = false;
  while (!done && pages < MAX_PAGES) {
    const res = await request<{ tasks: Task[]; last_page?: boolean }>(
      "GET",
      `/team/${encodeURIComponent(teamId)}/task?${buildQuery(input, pages)}`,
    );
    pages++;
    if (!res || !Array.isArray(res.tasks)) {
      throw new Error(
        `Unexpected response for page ${pages - 1}: ${JSON.stringify(res).slice(0, 300)}`,
      );
    }
    for (const t of res.tasks) byId.set(t.id, t);
    done = Boolean(res.last_page) || res.tasks.length === 0;
  }
  if (!done) {
    throw new Error(`Stopped after ${MAX_PAGES} pages without reaching the last one.`);
  }
  const tasks = [...byId.values()];

  const params = {
    include_closed: input.include_closed,
    include_subtasks: input.include_subtasks,
    space_ids: normalizeIds(input.space_ids),
    list_ids: normalizeIds(input.list_ids),
  };
  // Only a whole-workspace export becomes latest.json, so the baseline (and the
  // documented `jq ... latest.json`) never turns into a filtered subset.
  const isFull =
    input.include_closed && input.include_subtasks && !params.space_ids && !params.list_ids;
  const fetchedAt = new Date().toISOString();
  const snapshot: Snapshot = { fetched_at: fetchedAt, team_id: teamId, params, tasks };

  const dir = snapshotDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const latestPath = join(dir, "latest.json");
  const previous = isFull ? await readPrevious(latestPath) : undefined;

  // Full and filtered exports keep separate pools of KEEP_SNAPSHOTS, so filtered
  // runs never push the full-workspace history out.
  const prefix = isFull ? "tasks-" : "filtered-";
  const json = JSON.stringify(snapshot);
  const path = join(dir, `${prefix}${fetchedAt.replace(/[:.]/g, "-")}.json`);
  await writeAtomic(path, json);
  if (isFull) await writeAtomic(latestPath, json);

  const old = (await readdir(dir))
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .slice(0, -KEEP_SNAPSHOTS);
  await Promise.all(old.map((f) => rm(join(dir, f), { force: true })));

  // Only full exports are compared, and only within the same workspace.
  let removed: { count: number; ids: string[] } | string;
  if (!isFull) {
    removed = "filtered export: not compared, latest.json unchanged";
  } else if (!previous) {
    removed = "no previous snapshot";
  } else if (previous.team_id !== teamId) {
    removed = "previous snapshot is from another workspace";
  } else {
    const now = new Set(tasks.map((t) => t.id));
    const gone = previous.tasks.map((t) => t.id).filter((id) => !now.has(id));
    removed = { count: gone.length, ids: gone.slice(0, REMOVED_SAMPLE) };
  }

  const summary = {
    path,
    latest: isFull ? latestPath : null,
    count: tasks.length,
    pages,
    duration_s: Math.round((Date.now() - started) / 100) / 10,
    fetched_at: fetchedAt,
    by_status: countTop(tasks.map((t) => t.status?.status ?? "(none)")),
    by_assignee: countTop(
      tasks.flatMap((t) =>
        t.assignees?.length
          ? t.assignees.map((a) => a.username ?? a.email ?? "(unknown)")
          : ["(unassigned)"],
      ),
    ),
    by_list: countTop(tasks.map((t) => t.list?.name ?? "(none)")),
    unassigned: tasks.filter((t) => !t.assignees?.length).length,
    no_due_date: tasks.filter((t) => !t.due_date).length,
    // Missing tasks may be deleted, archived, moved, or no longer visible to the token.
    removed_since_previous: removed,
  };

  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary) }],
  };
}
