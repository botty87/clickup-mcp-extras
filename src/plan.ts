import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendFile, chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { ClickUpError, request } from "./clickup-client.js";
import { stateDir } from "./state.js";

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

// apply's requests fail after this instead of hanging on a stalled connection.
const TIMEOUT = { timeoutMs: 60_000 };

export async function getTask(taskId: string): Promise<LiveTask> {
  return request<LiveTask>("GET", `/task/${encodeURIComponent(taskId)}`, undefined, TIMEOUT);
}

// ClickUp tag names are case-insensitive and come back lowercased, so tags are
// compared in lowercase and written in lowercase (see write()).
const tagKey = (tag: string) => tag.toLowerCase();
const hasTag = (task: LiveTask, tag: string) => (task.tags ?? []).some((t) => t.name !== undefined && tagKey(t.name) === tagKey(tag));

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
      return { ...task, tags: (task.tags ?? []).filter((t) => t.name === undefined || tagKey(t.name) !== tagKey(op.args.tag)) };
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
      await request("PUT", task, { status: op.args.status }, TIMEOUT);
      return {};
    case "add_tag":
      await request("POST", `${task}/tag/${encodeURIComponent(tagKey(op.args.tag))}`, undefined, TIMEOUT);
      return {};
    case "remove_tag":
      await request("DELETE", `${task}/tag/${encodeURIComponent(tagKey(op.args.tag))}`, undefined, TIMEOUT);
      return {};
    case "comment": {
      const res = await request<{ id?: string | number }>("POST", `${task}/comment`, {
        comment_text: op.args.text,
        notify_all: false,
      }, TIMEOUT);
      return { comment_id: res?.id === undefined ? undefined : String(res.id) };
    }
  }
}

// Connection errors raised before the request could reach ClickUp.
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/** A failure after which the write may or may not have happened. */
export function isAmbiguous(err: unknown): boolean {
  if (err instanceof ClickUpError) return err.status >= 500;
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code && NOT_SENT.has(code)) return false;
  if (err instanceof Error && err.message.startsWith("CLICKUP_API_TOKEN")) return false;
  return true; // timeouts, resets mid-request, anything unrecognised
}

// --- Check and apply ---------------------------------------------------------

export type Io = {
  out: (line: string) => void;
  isTTY: boolean;
  /** Asks the person at the terminal; returns their answer. */
  ask: (question: string) => Promise<string>;
};

export type Preview = { hash: string; drifted: number; notified: string[]; calls: number };

export function plansDir(): string {
  return stateDir("plans");
}

/** Read-only: validates against the live tasks and prints before → after. */
export async function preview(
  plan: Plan,
  io: Io,
  opts: { allowLarge?: boolean; signal?: { name?: string } } = {},
): Promise<Preview> {
  if (plan.ops.length > LARGE_PLAN && !opts.allowLarge) {
    throw new Error(`Plan has ${plan.ops.length} operations (more than ${LARGE_PLAN}): pass --allow-large.`);
  }
  const hash = planHash(plan);
  const tasks = new Map<string, LiveTask>();
  for (const id of new Set(plan.ops.map((o) => o.task_id))) {
    if (opts.signal?.name) throw new Interrupted(opts.signal.name);
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
    const d = drift(op, task);
    if (d.length) drifted++;
    else {
      // A drifted op is not applied (apply stops, or skips it with --skip-drift):
      // later ops on the task are checked without it, and it notifies no one.
      simulated.set(op.task_id, simulate(op, task));
      for (const p of [...(task.assignees ?? []), ...(task.watchers ?? [])]) {
        const who = p.username ?? p.email;
        if (who) notified.add(who);
      }
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
  return { hash, drifted, notified: [...notified], calls };
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

export type ApplyResult = { dir: string; applied: number; skipped: number; stopped?: string };

class Interrupted extends Error {
  constructor(public signalName: string) {
    super(`interrupted (${signalName})`);
  }
}

/**
 * Applies a plan once, one operation at a time. Refuses without a terminal,
 * without the person typing the hash, and for a plan that already has a log:
 * to continue after a stop, write a new plan from the current state. Stops at
 * the first drift or error; Ctrl+C stops after the current operation.
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

  // One apply at a time per plan: two terminals must not both run it.
  const lockPath = join(dir, "apply.lock");
  try {
    await writeFile(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    throw new Error(`Another apply of this plan is running, or one crashed: if none is running, delete ${lockPath}.`);
  }

  // Ctrl+C or a kill from here on: finish what is in progress, then stop, so the
  // lock is released and the rollback covers everything written.
  const signal = { name: undefined as string | undefined };
  const onSignal = (sig: NodeJS.Signals) => {
    signal.name = sig;
    io.out(`${sig}: stopping after the current step...`);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await applyLocked(plan, io, opts, dir, short, signal);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await rm(lockPath, { force: true });
  }
}

async function applyLocked(
  plan: Plan,
  io: Io,
  opts: { skipDrift?: boolean; allowLarge?: boolean },
  dir: string,
  short: string,
  signal: { name?: string },
): Promise<ApplyResult> {
  // Earlier runs of the same plan: no automatic resume, so a rerun applies
  // every op again. Say so before the person confirms.
  const earlier = (await readdir(dir)).filter((f) => /^run-/.test(f)).sort();
  const notConfirmed = (stopped: string): ApplyResult => ({ dir, applied: 0, skipped: 0, stopped });

  let answer: string;
  try {
    io.out("Live preview:");
    await preview(plan, io, { ...opts, signal });
    if (earlier.length) {
      io.out(
        `WARNING: this plan already ran ${earlier.length} time(s) (${earlier.map((f) => join(dir, f)).join(", ")}). ` +
          `Running it again repeats every operation; those without expected_before, like comments, are not guarded.`,
      );
    }
    if (signal.name) throw new Interrupted(signal.name);
    answer = (await io.ask(`Type the first 8 characters of the hash to apply: `)).trim();
    if (signal.name) throw new Interrupted(signal.name);
  } catch (err) {
    // Ctrl+C at the prompt reaches readline, which aborts the question.
    if (err instanceof Interrupted) return notConfirmed(`interrupted (${err.signalName}) before writing`);
    if (err instanceof Error && err.name === "AbortError") return notConfirmed("interrupted (SIGINT) before writing");
    throw err;
  }
  if (answer !== short) return notConfirmed("not confirmed");

  // Each confirmed run gets its own folder.
  const runDir = join(dir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(runDir, { mode: 0o700 });
  await writeFile(join(runDir, "plan.json"), JSON.stringify(plan, null, 2), { mode: 0o600 });
  const logPath = join(runDir, "apply-log.jsonl");

  const entries: LogEntry[] = [];
  const log = async (e: Omit<LogEntry, "ts">) => {
    const entry = { ts: new Date().toISOString(), ...e };
    entries.push(entry);
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  };

  let applied = 0;
  let skipped = 0;
  let stopped: string | undefined;
  try {
    for (const [index, op] of plan.ops.entries()) {
      if (signal.name) {
        stopped = `interrupted (${signal.name}) before #${index + 1}`;
        break;
      }
      const base = { index, op: op.op, task_id: op.task_id };
      // A comment has no state to compare, so it needs no read before writing.
      let task: LiveTask | undefined;
      if (op.op !== "comment") {
        try {
          task = await getTask(op.task_id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await log({ ...base, result: "error", error: `read failed: ${msg}` });
          stopped = `#${index + 1}: reading the task failed (${msg}); nothing written for it`;
          break;
        }
      }
      const before = task ? stateFor(op, task) : {};
      const d = task ? drift(op, task) : [];
      if (d.length) {
        if (!opts.skipDrift) {
          await log({ ...base, result: "stopped_drift", before, error: d.join("; ") });
          stopped = `drift at #${index + 1} (${d.join("; ")}): nothing written for it`;
          break;
        }
        await log({ ...base, result: "skipped_drift", before, error: d.join("; ") });
        skipped++;
        continue;
      }
      try {
        const res = await write(op);
        applied++;
        try {
          await log({ ...base, result: "ok", before, ...res });
        } catch (logErr) {
          // The write landed: it is in `entries`, so the rollback still covers it.
          const msg = logErr instanceof Error ? logErr.message : String(logErr);
          stopped = `#${index + 1} was written, but the log could not be updated (${msg})`;
          break;
        }
        io.out(`#${index + 1} ok`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const unknown = isAmbiguous(err);
        await log({ ...base, result: unknown ? "unknown" : "error", before, error: msg });
        stopped = unknown
          ? `#${index + 1} ${op.op}: the outcome is unknown (${msg}). Check the task; the rollback note says how to undo it if it landed.`
          : `#${index + 1} failed: ${msg}`;
        break;
      }
    }
  } finally {
    // Also on an unexpected error, so what was written can always be undone. A
    // failure here is reported without hiding the error that ended the run.
    try {
      await writeRollback(plan, runDir, short, entries);
    } catch (err) {
      io.out(`WARNING: rollback not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (stopped && applied + skipped < plan.ops.length) {
    stopped += `. Applied before stopping: ${applied}. To go on, write a new plan for the remaining operations.`;
  }
  return { dir: runDir, applied, skipped, stopped };
}

/**
 * A plan that undoes this run's writes, newest first; it goes through
 * check/apply like any plan. Writes of unknown outcome are not in it (their
 * undo would stop the rollback as drift if the write never landed): the note
 * says how to undo them by hand.
 */
async function writeRollback(plan: Plan, dir: string, short: string, entries: LogEntry[]): Promise<void> {
  const newestFirst = [...entries].reverse();
  const ops = newestFirst
    .filter((e) => e.result === "ok" && e.before)
    .map((e) => inverse(plan.ops[e.index], e.before!))
    .filter((o): o is Op => o !== null);
  const comments = newestFirst.filter((e) => e.result === "ok" && e.comment_id).map((e) => `${e.task_id}:${e.comment_id}`);
  const uncertain = newestFirst
    .filter((e) => e.result === "unknown")
    .map((e) => {
      const undo = e.before ? inverse(plan.ops[e.index], e.before) : null;
      return `#${e.index + 1} ${e.op} on ${e.task_id}` + (undo ? ` (if it landed, undo with ${canonical(undo)})` : " (if it was posted, delete it by hand)");
    });
  const note =
    `Rollback of plan ${short}.` +
    (comments.length ? ` Comments cannot be undone (task:comment_id): ${comments.join(", ")}.` : "") +
    (uncertain.length ? ` Outcome unknown, check by hand: ${uncertain.join("; ")}.` : "");
  if (ops.length === 0) {
    // A plan needs at least one op: with nothing to undo, leave a note instead.
    await writeFile(join(dir, "rollback-note.txt"), `${note}\nNothing to undo.\n`, { mode: 0o600 });
    return;
  }
  const rollback = { version: 1, team_id: plan.team_id, created_at: new Date().toISOString(), note, ops };
  await writeFile(join(dir, "rollback.json"), JSON.stringify(rollback, null, 2), { mode: 0o600 });
}
