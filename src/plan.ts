import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { ClickUpError, request } from "./clickup-client.js";

// A plan is a file of bulk ClickUp changes. An agent may write it and run
// `check` (read-only); only a person at a terminal can `apply` it.

const TaskId = z.string().min(1);

const SetStatus = z.object({
  op: z.literal("set_status"),
  task_id: TaskId,
  args: z.object({ status: z.string().min(1) }).strict(),
  expected_before: z.object({ status: z.string().min(1) }).strict().optional(),
}).strict();

const TagArgs = z.object({ tag: z.string().min(1) }).strict();
const TagBefore = z.object({ has_tag: z.boolean() }).strict().optional();
const AddTag = z.object({ op: z.literal("add_tag"), task_id: TaskId, args: TagArgs, expected_before: TagBefore }).strict();
const RemoveTag = z.object({ op: z.literal("remove_tag"), task_id: TaskId, args: TagArgs, expected_before: TagBefore }).strict();

const Comment = z.object({
  op: z.literal("comment"),
  task_id: TaskId,
  args: z.object({ text: z.string().min(1) }).strict(),
}).strict();

export const OpSchema = z.discriminatedUnion("op", [SetStatus, AddTag, RemoveTag, Comment]);
export type Op = z.infer<typeof OpSchema>;

export const PlanSchema = z.object({
  version: z.literal(1),
  team_id: z.string().min(1),
  created_at: z.string().optional(),
  note: z.string().optional(),
  ops: z.array(OpSchema).min(1),
}).strict();
export type Plan = z.infer<typeof PlanSchema>;

export const LARGE_PLAN = 100;

/** JSON with object keys sorted at every level, so the hash ignores key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the parts that matter: the workspace and the operations. */
export function planHash(plan: Plan): string {
  return createHash("sha256").update(canonical({ team_id: plan.team_id, ops: plan.ops })).digest("hex");
}

export function parsePlan(json: unknown): Plan {
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid plan:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

export async function readPlan(path: string): Promise<Plan> {
  return parsePlan(JSON.parse(await readFile(path, "utf8")));
}

// --- Live task state -------------------------------------------------------

type Person = { username?: string; email?: string };
export type LiveTask = {
  id: string;
  name?: string;
  team_id?: string;
  status?: { status?: string };
  tags?: { name?: string }[];
  assignees?: Person[];
  watchers?: Person[];
};

export async function getTask(taskId: string): Promise<LiveTask> {
  return request<LiveTask>("GET", `/task/${encodeURIComponent(taskId)}`);
}

const hasTag = (task: LiveTask, tag: string) =>
  (task.tags ?? []).some((t) => t.name?.toLowerCase() === tag.toLowerCase());

/** The part of a task's state an operation reads and changes. */
export function stateFor(op: Op, task: LiveTask): Record<string, unknown> {
  switch (op.op) {
    case "set_status":
      return { status: task.status?.status ?? null };
    case "add_tag":
    case "remove_tag":
      return { has_tag: hasTag(task, op.args.tag) };
    case "comment":
      return {};
  }
}

export function stateAfter(op: Op): Record<string, unknown> {
  switch (op.op) {
    case "set_status":
      return { status: op.args.status };
    case "add_tag":
      return { has_tag: true };
    case "remove_tag":
      return { has_tag: false };
    case "comment":
      return { comment: op.args.text };
  }
}

/** Fields of expected_before that differ from the live state (status compared case-insensitively). */
export function drift(op: Op, task: LiveTask): string[] {
  if (op.op === "comment" || !op.expected_before) return [];
  const now = stateFor(op, task);
  return Object.entries(op.expected_before)
    .filter(([k, v]) => {
      const cur = now[k];
      return typeof v === "string" && typeof cur === "string"
        ? v.toLowerCase() !== cur.toLowerCase()
        : v !== cur;
    })
    .map(([k, v]) => `${k}: expected ${JSON.stringify(v)}, found ${JSON.stringify(now[k])}`);
}

/** The operation that undoes `op`, given the state read right before it ran; null if none. */
export function inverse(op: Op, before: Record<string, unknown>): Op | null {
  switch (op.op) {
    case "set_status":
      return typeof before.status === "string" && before.status.toLowerCase() !== op.args.status.toLowerCase()
        ? { op: "set_status", task_id: op.task_id, args: { status: before.status }, expected_before: { status: op.args.status } }
        : null;
    case "add_tag":
      return before.has_tag === false
        ? { op: "remove_tag", task_id: op.task_id, args: op.args, expected_before: { has_tag: true } }
        : null;
    case "remove_tag":
      return before.has_tag === true
        ? { op: "add_tag", task_id: op.task_id, args: op.args, expected_before: { has_tag: false } }
        : null;
    case "comment":
      return null; // A comment and its notifications cannot be taken back.
  }
}

export async function write(op: Op): Promise<{ comment_id?: string }> {
  const task = `/task/${encodeURIComponent(op.task_id)}`;
  switch (op.op) {
    case "set_status":
      await request("PUT", task, { status: op.args.status });
      return {};
    case "add_tag":
      await request("POST", `${task}/tag/${encodeURIComponent(op.args.tag)}`);
      return {};
    case "remove_tag":
      await request("DELETE", `${task}/tag/${encodeURIComponent(op.args.tag)}`);
      return {};
    case "comment": {
      const res = await request<{ id?: string | number }>("POST", `${task}/comment`, {
        comment_text: op.args.text,
        notify_all: false,
      });
      return { comment_id: res?.id === undefined ? undefined : String(res.id) };
    }
  }
}

/** A failure after which the write may or may not have happened. */
export function isAmbiguous(err: unknown): boolean {
  return !(err instanceof ClickUpError) || err.status >= 500;
}

// --- Check and apply ---------------------------------------------------------

export type Io = {
  out: (line: string) => void;
  isTTY: boolean;
  /** Asks the person at the terminal; returns their answer. */
  ask: (question: string) => Promise<string>;
};

export type Preview = {
  hash: string;
  drifted: number;
  notified: string[];
  calls: number;
  tasks: Map<string, LiveTask>;
};

export function plansDir(): string {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "clickup-mcp-extras", "plans");
}

/** Read-only: validates against the live tasks and prints before → after. */
export async function preview(plan: Plan, io: Io, opts: { allowLarge?: boolean } = {}): Promise<Preview> {
  if (plan.ops.length > LARGE_PLAN && !opts.allowLarge) {
    throw new Error(`Plan has ${plan.ops.length} operations (more than ${LARGE_PLAN}): pass --allow-large.`);
  }
  const hash = planHash(plan);
  const tasks = new Map<string, LiveTask>();
  for (const id of new Set(plan.ops.map((o) => o.task_id))) {
    const task = await getTask(id);
    if (task.team_id && task.team_id !== plan.team_id) {
      throw new Error(`Task ${id} belongs to workspace ${task.team_id}, not ${plan.team_id}.`);
    }
    tasks.set(id, task);
  }

  const notified = new Set<string>();
  let drifted = 0;
  plan.ops.forEach((op, i) => {
    const task = tasks.get(op.task_id)!;
    const d = drift(op, task);
    if (d.length) drifted++;
    for (const p of [...(task.assignees ?? []), ...(task.watchers ?? [])]) {
      const who = p.username ?? p.email;
      if (who) notified.add(who);
    }
    io.out(
      `#${i + 1} ${op.op} ${op.task_id} "${task.name ?? ""}": ` +
        `${canonical(stateFor(op, task))} -> ${canonical(stateAfter(op))}` +
        (d.length ? `  DRIFT (${d.join("; ")})` : ""),
    );
  });

  const calls = tasks.size + plan.ops.length * 2; // check reads + per-op read and write
  io.out(`operations: ${plan.ops.length}, tasks: ${tasks.size}, drifted: ${drifted}`);
  io.out(`notified (assignees and watchers): ${[...notified].sort().join(", ") || "none"}`);
  io.out(`REST calls for apply: about ${calls}, at most 100 per minute`);
  io.out(`hash: ${hash}`);
  io.out(`to apply, from your own terminal: node dist/cli.js apply <plan> --approve ${hash.slice(0, 8)}`);
  return { hash, drifted, notified: [...notified], calls, tasks };
}

type LogEntry = {
  ts: string;
  index: number;
  op: Op["op"];
  task_id: string;
  result: "ok" | "skipped_drift" | "error";
  before?: Record<string, unknown>;
  comment_id?: string;
  error?: string;
};

async function readLog(path: string): Promise<LogEntry[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogEntry);
  } catch {
    return [];
  }
}

export type ApplyResult = { dir: string; applied: number; skipped: number; stopped?: string };

/**
 * Applies a plan, one operation at a time. Refuses without a terminal and
 * without the person typing the hash; stops at the first drift or error.
 * Resumable: operations already "ok" in the log are skipped.
 */
export async function apply(
  plan: Plan,
  io: Io,
  opts: { approve?: string; skipDrift?: boolean; allowLarge?: boolean } = {},
): Promise<ApplyResult> {
  if (!io.isTTY) throw new Error("apply needs an interactive terminal: run it yourself, not from an agent.");
  const hash = planHash(plan);
  const short = hash.slice(0, 8);
  if (!opts.approve || opts.approve !== short) {
    throw new Error(`--approve must be the first 8 characters of the plan hash (run check to see it).`);
  }

  const dir = join(plansDir(), short);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(join(dir, "plan.json"), JSON.stringify(plan, null, 2), { mode: 0o600 });
  const logPath = join(dir, "apply-log.jsonl");
  const done = new Set((await readLog(logPath)).filter((e) => e.result === "ok").map((e) => e.index));

  io.out("Live preview:");
  await preview(plan, io, opts);
  if (done.size) io.out(`${done.size} operation(s) already applied in a previous run will be skipped.`);
  const answer = (await io.ask(`Type the first 8 characters of the hash to apply: `)).trim();
  if (answer !== short) return { dir, applied: 0, skipped: 0, stopped: "not confirmed" };

  const log = async (e: Omit<LogEntry, "ts">) =>
    appendFile(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...e })}\n`, { mode: 0o600 });

  let applied = 0;
  let skipped = 0;
  let stopped: string | undefined;
  for (const [index, op] of plan.ops.entries()) {
    if (done.has(index)) continue;
    const base = { index, op: op.op, task_id: op.task_id };
    const task = await getTask(op.task_id);
    const before = stateFor(op, task);
    const d = drift(op, task);
    if (d.length) {
      await log({ ...base, result: "skipped_drift", before, error: d.join("; ") });
      if (!opts.skipDrift) {
        stopped = `drift at #${index + 1} (${d.join("; ")}): nothing written for it; rerun with --skip-drift to skip it`;
        break;
      }
      skipped++;
      continue;
    }
    try {
      const res = await write(op);
      await log({ ...base, result: "ok", before, ...res });
      applied++;
      io.out(`#${index + 1} ok`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log({ ...base, result: "error", before, error: msg });
      stopped =
        op.op === "comment" && isAmbiguous(err)
          ? `#${index + 1} comment: the outcome is unknown (${msg}). Check the task before rerunning, or the comment may be posted twice.`
          : `#${index + 1} failed: ${msg}`;
      break;
    }
  }

  await writeRollback(plan, dir, short, await readLog(logPath));
  return { dir, applied, skipped, stopped };
}

/** A plan that undoes every "ok" operation, newest first; it goes through check/apply like any plan. */
async function writeRollback(plan: Plan, dir: string, short: string, entries: LogEntry[]): Promise<void> {
  const ops = entries
    .filter((e) => e.result === "ok")
    .sort((a, b) => b.index - a.index)
    .map((e) => (e.before ? inverse(plan.ops[e.index], e.before) : null))
    .filter((o): o is Op => o !== null);
  const comments = entries.filter((e) => e.result === "ok" && e.comment_id).map((e) => `${e.task_id}:${e.comment_id}`);
  const note =
    `Rollback of plan ${short}.` +
    (comments.length ? ` Comments cannot be undone (task:comment_id): ${comments.join(", ")}.` : "");
  const rollback = { version: 1, team_id: plan.team_id, created_at: new Date().toISOString(), note, ops };
  await writeFile(join(dir, "rollback.json"), JSON.stringify(rollback, null, 2), { mode: 0o600 });
}
