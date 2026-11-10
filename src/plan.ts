import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** The task as it will be after `op`, so later ops on the same task are checked against it. */
export function simulate(op: Op, task: LiveTask): LiveTask {
  switch (op.op) {
    case "set_status":
      return { ...task, status: { ...task.status, status: op.args.status } };
    case "add_tag":
      return hasTag(task, op.args.tag) ? task : { ...task, tags: [...(task.tags ?? []), { name: op.args.tag }] };
    case "remove_tag":
      return { ...task, tags: (task.tags ?? []).filter((t) => t.name?.toLowerCase() !== op.args.tag.toLowerCase()) };
    case "comment":
      return task;
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
  // Walk the ops on a simulated copy, so chained ops on one task are not reported as drift.
  const simulated = new Map(tasks);
  plan.ops.forEach((op, i) => {
    const task = simulated.get(op.task_id)!;
    simulated.set(op.task_id, simulate(op, task));
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

  // Preview reads, then a read before each non-comment op, then the writes.
  const calls = tasks.size + plan.ops.filter((o) => o.op !== "comment").length + plan.ops.length;
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
  // unknown: the write may or may not have happened (timeout, 5xx).
  result: "ok" | "unknown" | "skipped_drift" | "stopped_drift" | "error";
  before?: Record<string, unknown>;
  comment_id?: string;
  error?: string;
};

/** Log entries; a line cut short by a crash is skipped, any other bad line stops the run. */
async function readLog(path: string): Promise<LogEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = text.split("\n").filter(Boolean);
  const entries: LogEntry[] = [];
  lines.forEach((line, i) => {
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      if (i !== lines.length - 1 || text.endsWith("\n")) {
        throw new Error(`${path} line ${i + 1} is not valid JSON: fix or move the log before applying again.`);
      }
    }
  });
  return entries;
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
  const previous = await readLog(logPath);
  const raw = await readFile(logPath, "utf8").catch(() => "");
  if (raw && !raw.endsWith("\n")) {
    // The last line was cut short by a crash: drop it before appending, or the
    // next entry would be glued to it.
    const kept = previous.map((e) => `${JSON.stringify(e)}\n`).join("");
    await writeFile(logPath, kept, { mode: 0o600 });
  }
  const done = new Set(previous.filter((e) => e.result === "ok").map((e) => e.index));

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
  try {
    for (const [index, op] of plan.ops.entries()) {
      if (done.has(index)) continue;
      const base = { index, op: op.op, task_id: op.task_id };
      // A comment has no state to compare, so it needs no read before writing.
      const task = op.op === "comment" ? undefined : await getTask(op.task_id);
      const before = task ? stateFor(op, task) : {};
      const d = task ? drift(op, task) : [];
      if (d.length) {
        if (!opts.skipDrift) {
          await log({ ...base, result: "stopped_drift", before, error: d.join("; ") });
          stopped = `drift at #${index + 1} (${d.join("; ")}): nothing written for it; rerun with --skip-drift to skip it`;
          break;
        }
        await log({ ...base, result: "skipped_drift", before, error: d.join("; ") });
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
        const unknown = isAmbiguous(err);
        await log({ ...base, result: unknown ? "unknown" : "error", before, error: msg });
        stopped = unknown
          ? `#${index + 1} ${op.op}: the outcome is unknown (${msg}). Check the task before rerunning` +
            (op.op === "comment" ? ", or the comment may be posted twice." : "; rollback.json includes its undo.")
          : `#${index + 1} failed: ${msg}`;
        break;
      }
    }
  } finally {
    // Also on an unexpected error (a failed read, a lost connection), so the
    // operations already applied can always be undone.
    await writeRollback(plan, dir, short, await readLog(logPath));
  }
  return { dir, applied, skipped, stopped };
}

/** A plan that undoes every "ok" operation, newest first; it goes through check/apply like any plan. */
async function writeRollback(plan: Plan, dir: string, short: string, entries: LogEntry[]): Promise<void> {
  // "unknown" writes may have happened: undoing them is harmless if they did not,
  // because the undo carries its own expected_before.
  const ops = entries
    .filter((e) => e.result === "ok" || e.result === "unknown")
    .sort((a, b) => b.index - a.index)
    .map((e) => (e.before ? inverse(plan.ops[e.index], e.before) : null))
    .filter((o): o is Op => o !== null);
  const comments = entries.filter((e) => e.result === "ok" && e.comment_id).map((e) => `${e.task_id}:${e.comment_id}`);
  const note =
    `Rollback of plan ${short}.` +
    (comments.length ? ` Comments cannot be undone (task:comment_id): ${comments.join(", ")}.` : "");
  const path = join(dir, "rollback.json");
  if (ops.length === 0) {
    // A plan needs at least one op: with nothing to undo, leave a note instead.
    await rm(path, { force: true });
    await writeFile(join(dir, "rollback-note.txt"), `${note}\nNothing to undo.\n`, { mode: 0o600 });
    return;
  }
  const rollback = { version: 1, team_id: plan.team_id, created_at: new Date().toISOString(), note, ops };
  await writeFile(path, JSON.stringify(rollback, null, 2), { mode: 0o600 });
  await rm(join(dir, "rollback-note.txt"), { force: true });
}
