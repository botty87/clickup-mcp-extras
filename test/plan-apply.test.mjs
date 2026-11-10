// Tests for plan/check/apply against an in-memory ClickUp: no request leaves
// this process. Run with `npm test` after `npm run build`.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateHome = await mkdtemp(join(tmpdir(), "clickup-plan-test-"));
process.env.XDG_STATE_HOME = stateHome;
process.env.CLICKUP_API_TOKEN = "pk_test";
after(() => rm(stateHome, { recursive: true, force: true }));

const TEAM = "9015293131";
let tasks;
let writes;
let failNext; // { method, status } to make the next matching write fail

beforeEach(() => {
  tasks = {
    a: { id: "a", name: "Task A", team_id: TEAM, status: { status: "in review" }, tags: [], assignees: [{ username: "Ada" }], watchers: [{ username: "Bob" }] },
    b: { id: "b", name: "Task B", team_id: TEAM, status: { status: "in review" }, tags: [{ name: "keep" }], assignees: [], watchers: [] },
  };
  writes = [];
  failNext = undefined;
});

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  const path = new URL(url).pathname.replace("/api/v2", "");
  const m = path.match(/^\/task\/([^/]+)(?:\/(tag|comment)(?:\/(.+))?)?$/);
  if (!m) return json({ err: "not found" }, 404);
  const [, id, kind, tag] = m;
  const task = tasks[id];
  if (!task) return json({ err: "Task not found" }, 404);
  if (method === "GET") return json(task);
  if (failNext && failNext.method === method) {
    const { status } = failNext;
    failNext = undefined;
    return json({ err: "boom" }, status);
  }
  writes.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
  if (method === "PUT") task.status = { status: JSON.parse(init.body).status };
  if (kind === "tag" && method === "POST") task.tags.push({ name: decodeURIComponent(tag) });
  if (kind === "tag" && method === "DELETE") task.tags = task.tags.filter((t) => t.name !== decodeURIComponent(tag));
  if (kind === "comment") return json({ id: 4242 });
  return json({});
};

const { parsePlan, planHash, preview, apply, plansDir } = await import("../dist/plan.js");

const io = (answer = "", isTTY = true) => {
  const lines = [];
  return { lines, out: (l) => lines.push(l), isTTY, ask: async () => answer };
};

const closePlan = () =>
  parsePlan({
    version: 1,
    team_id: TEAM,
    ops: [
      { op: "set_status", task_id: "a", args: { status: "done" }, expected_before: { status: "in review" } },
      { op: "add_tag", task_id: "a", args: { tag: "merged" }, expected_before: { has_tag: false } },
      { op: "remove_tag", task_id: "b", args: { tag: "keep" } },
    ],
  });

test("schema rejects an unknown op and extra fields", () => {
  assert.throws(() => parsePlan({ version: 1, team_id: TEAM, ops: [{ op: "delete", task_id: "a", args: {} }] }), /Invalid plan/);
  assert.throws(
    () => parsePlan({ version: 1, team_id: TEAM, ops: [{ op: "set_status", task_id: "a", args: { status: "done", priority: 1 } }] }),
    /Invalid plan/,
  );
});

test("check refuses a task from another workspace", async () => {
  tasks.a.team_id = "other";
  await assert.rejects(preview(closePlan(), io()), /belongs to workspace other/);
});

test("hash ignores key order and changes with the ops", () => {
  const p1 = closePlan();
  const p2 = parsePlan({
    ops: p1.ops.map((o) => Object.fromEntries(Object.entries(o).reverse())),
    team_id: TEAM,
    version: 1,
  });
  assert.equal(planHash(p1), planHash(p2));
  const p3 = parsePlan({ ...p1, ops: [p1.ops[0]] });
  assert.notEqual(planHash(p1), planHash(p3));
});

test("check is read-only and reports drift and who is notified", async () => {
  tasks.a.status = { status: "to do" };
  const o = io();
  const p = await preview(closePlan(), o);
  assert.equal(writes.length, 0);
  assert.equal(p.drifted, 1);
  assert.deepEqual(p.notified, ["Ada", "Bob"]);
  assert.match(o.lines.join("\n"), /DRIFT \(status: expected "in review", found "to do"\)/);
  assert.match(o.lines.join("\n"), new RegExp(`hash: ${p.hash}`));
});

test("check refuses more than 100 ops without --allow-large", async () => {
  const ops = Array.from({ length: 101 }, () => ({ op: "add_tag", task_id: "a", args: { tag: "x" } }));
  await assert.rejects(preview(parsePlan({ version: 1, team_id: TEAM, ops }), io()), /--allow-large/);
});

test("apply refuses without a terminal and with a wrong hash", async () => {
  const plan = closePlan();
  const short = planHash(plan).slice(0, 8);
  await assert.rejects(apply(plan, io(short, false), { approve: short }), /interactive terminal/);
  await assert.rejects(apply(plan, io(short), { approve: "deadbeef" }), /--approve/);
  const r = await apply(plan, io("nope"), { approve: short });
  assert.equal(r.stopped, "not confirmed");
  assert.equal(writes.length, 0);
});

test("apply writes every op, logs it and builds the rollback plan", async () => {
  const plan = closePlan();
  const short = planHash(plan).slice(0, 8);
  const r = await apply(plan, io(short), { approve: short });
  assert.equal(r.applied, 3);
  assert.equal(r.stopped, undefined);
  assert.deepEqual(
    writes.map((w) => `${w.method} ${w.path}`),
    ["PUT /task/a", "POST /task/a/tag/merged", "DELETE /task/b/tag/keep"],
  );
  assert.equal(tasks.a.status.status, "done");

  const dir = r.dir;
  const log = (await readFile(join(dir, "apply-log.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(log.map((e) => e.result), ["ok", "ok", "ok"]);
  const rollback = parsePlan(JSON.parse(await readFile(join(dir, "rollback.json"), "utf8")));
  assert.deepEqual(rollback.ops, [
    { op: "add_tag", task_id: "b", args: { tag: "keep" }, expected_before: { has_tag: false } },
    { op: "remove_tag", task_id: "a", args: { tag: "merged" }, expected_before: { has_tag: true } },
    { op: "set_status", task_id: "a", args: { status: "in review" }, expected_before: { status: "done" } },
  ]);
});

test("--skip-drift skips the drifted op and goes on", async () => {
  const plan = parsePlan({
    version: 1,
    team_id: TEAM,
    ops: [
      { op: "set_status", task_id: "a", args: { status: "done" }, expected_before: { status: "to do" } },
      { op: "add_tag", task_id: "b", args: { tag: "z" } },
    ],
  });
  const short = planHash(plan).slice(0, 8);
  const r = await apply(plan, io(short), { approve: short, skipDrift: true });
  assert.equal(r.applied, 1);
  assert.equal(r.skipped, 1);
  assert.deepEqual(writes.map((w) => w.path), ["/task/b/tag/z"]);
});

test("a comment that fails with a 5xx stops without retrying", async () => {
  const plan = parsePlan({
    version: 1,
    team_id: TEAM,
    ops: [
      { op: "comment", task_id: "a", args: { text: "PR merged" } },
      { op: "add_tag", task_id: "a", args: { tag: "after" } },
    ],
  });
  const short = planHash(plan).slice(0, 8);
  failNext = { method: "POST", status: 502 };
  const r = await apply(plan, io(short), { approve: short });
  assert.equal(r.applied, 0);
  assert.match(r.stopped, /outcome is unknown/);
  assert.equal(writes.length, 0);
});

test("a posted comment is not in the rollback but its id is in the note", async () => {
  const plan = parsePlan({ version: 1, team_id: TEAM, ops: [{ op: "comment", task_id: "a", args: { text: "hello" } }] });
  const short = planHash(plan).slice(0, 8);
  const r = await apply(plan, io(short), { approve: short });
  assert.equal(r.applied, 1);
  assert.deepEqual(writes[0].body, { comment_text: "hello", notify_all: false });
  await assert.rejects(readFile(join(r.dir, "rollback.json"), "utf8"), /ENOENT/);
  assert.match(await readFile(join(r.dir, "rollback-note.txt"), "utf8"), /a:4242/);
});

test("check follows chained ops on the same task instead of reporting drift", async () => {
  const plan = parsePlan({
    version: 1,
    team_id: TEAM,
    ops: [
      { op: "set_status", task_id: "a", args: { status: "testing" }, expected_before: { status: "in review" } },
      { op: "set_status", task_id: "a", args: { status: "done" }, expected_before: { status: "testing" } },
      { op: "add_tag", task_id: "a", args: { tag: "t" } },
      { op: "remove_tag", task_id: "a", args: { tag: "t" }, expected_before: { has_tag: true } },
    ],
  });
  const p = await preview(plan, io());
  assert.equal(p.drifted, 0);
});

test("a stop at drift is logged as stopped_drift, not skipped", async () => {
  const plan = parsePlan({
    version: 1,
    team_id: TEAM,
    ops: [{ op: "set_status", task_id: "a", args: { status: "done" }, expected_before: { status: "to do" } }],
  });
  const short = planHash(plan).slice(0, 8);
  const r = await apply(plan, io(short), { approve: short });
  const log = (await readFile(join(r.dir, "apply-log.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(log.map((e) => e.result), ["stopped_drift"]);
});

test("a second apply of the same plan is refused while the first holds the lock", async () => {
  const plan = parsePlan({ version: 1, team_id: TEAM, ops: [{ op: "comment", task_id: "a", args: { text: "once" } }] });
  const short = planHash(plan).slice(0, 8);
  let release;
  const gate = new Promise((r) => (release = r));
  const first = apply(plan, { ...io(), ask: async () => (await gate, short) }, { approve: short });
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(apply(plan, io(short), { approve: short }), /Another apply of this plan is running/);
  release();
  assert.equal((await first).applied, 1);
  assert.equal(writes.length, 1);
});

test("plan.json is written only after confirmation", async () => {
  const plan = parsePlan({ version: 1, team_id: TEAM, ops: [{ op: "add_tag", task_id: "a", args: { tag: "n" } }] });
  const short = planHash(plan).slice(0, 8);
  const r = await apply(plan, io("wrong"), { approve: short });
  assert.equal(r.stopped, "not confirmed");
  assert.equal(r.dir, undefined);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(join(plansDir(), short))).filter((f) => f.startsWith("run-")), []);
});

test("a lock left by a dead process is taken over", async () => {
  const plan = parsePlan({ version: 1, team_id: TEAM, ops: [{ op: "add_tag", task_id: "a", args: { tag: "s" } }] });
  const short = planHash(plan).slice(0, 8);
  await mkdir(join(plansDir(), short), { recursive: true });
  await writeFile(join(plansDir(), short, "apply.lock"), "999999\n"); // no such process
  const o = io(short);
  const r = await apply(plan, o, { approve: short });
  assert.equal(r.applied, 1);
  assert.match(o.lines.join("\n"), /stale lock left by process 999999/);
});

test("tags compare case-insensitively and are written in lowercase", async () => {
  tasks.b.tags = [{ name: "blocked" }];
  const plan = parsePlan({
    version: 1,
    team_id: TEAM,
    ops: [{ op: "remove_tag", task_id: "b", args: { tag: "Blocked" }, expected_before: { has_tag: true } }],
  });
  assert.equal((await preview(plan, io())).drifted, 0);
  const short = planHash(plan).slice(0, 8);
  await apply(plan, io(short), { approve: short });
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), ["DELETE /task/b/tag/blocked"]);
});

test("Ctrl+C during the writes stops after the current op, releases the lock and writes the rollback", async () => {
  const plan = parsePlan({
    version: 1,
    team_id: TEAM,
    ops: [
      { op: "add_tag", task_id: "a", args: { tag: "one" } },
      { op: "add_tag", task_id: "b", args: { tag: "two" } },
    ],
  });
  const short = planHash(plan).slice(0, 8);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const res = await realFetch(url, init);
    if ((init.method ?? "GET") === "POST") process.emit("SIGINT", "SIGINT");
    return res;
  };
  let r;
  try {
    r = await apply(plan, io(short), { approve: short });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(r.applied, 1);
  assert.match(r.stopped, /interrupted \(SIGINT\) before #2/);
  await assert.rejects(readFile(join(plansDir(), planHash(plan).slice(0, 8), "apply.lock"), "utf8"), /ENOENT/);
  const rollback = parsePlan(JSON.parse(await readFile(join(r.dir, "rollback.json"), "utf8")));
  assert.deepEqual(rollback.ops.map((o) => `${o.op} ${o.task_id}`), ["remove_tag a"]);
});
test("apply stops at drift; a rerun warns that it repeats every op and uses a new run folder", async () => {
  const plan = parsePlan({
    version: 1,
    team_id: TEAM,
    ops: [
      { op: "add_tag", task_id: "a", args: { tag: "one" } },
      { op: "set_status", task_id: "b", args: { status: "done" }, expected_before: { status: "to do" } },
    ],
  });
  const short = planHash(plan).slice(0, 8);
  const first = await apply(plan, io(short), { approve: short });
  assert.equal(first.applied, 1);
  assert.match(first.stopped, /drift at #2.*Applied before stopping: 1/);
  const o = io("no");
  const second = await apply(plan, o, { approve: short });
  assert.equal(second.stopped, "not confirmed");
  assert.match(o.lines.join("\n"), /WARNING: this plan already ran 1 time\(s\)/);
  assert.equal(writes.length, 1);
});

test("Ctrl+C at the prompt (aborted question) stops cleanly and releases the lock", async () => {
  const plan = parsePlan({ version: 1, team_id: TEAM, ops: [{ op: "add_tag", task_id: "a", args: { tag: "n" } }] });
  const short = planHash(plan).slice(0, 8);
  const ask = async () => {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    throw e;
  };
  const r = await apply(plan, { ...io(), ask }, { approve: short });
  assert.equal(r.stopped, "cancelled at the prompt (Ctrl+C or Ctrl+D)");
  assert.equal(writes.length, 0);
  await assert.rejects(readFile(join(plansDir(), short, "apply.lock"), "utf8"), /ENOENT/);
});

test("a failed read mid-run stops cleanly and still writes the rollback", async () => {
  const plan = parsePlan({
    version: 1,
    team_id: TEAM,
    ops: [
      { op: "add_tag", task_id: "a", args: { tag: "first" } },
      { op: "add_tag", task_id: "b", args: { tag: "second" } },
    ],
  });
  const short = planHash(plan).slice(0, 8);
  const ask = async () => {
    delete tasks.b; // b disappears after the preview: its read before the write fails
    return short;
  };
  const r = await apply(plan, { ...io(), ask }, { approve: short });
  assert.equal(r.applied, 1);
  assert.match(r.stopped, /#2: reading the task failed/);
  const rollback = parsePlan(JSON.parse(await readFile(join(r.dir, "rollback.json"), "utf8")));
  assert.deepEqual(rollback.ops, [{ op: "remove_tag", task_id: "a", args: { tag: "first" }, expected_before: { has_tag: true } }]);
});

test("a write with an unknown outcome is left to the rollback note with its undo", async () => {
  const plan = parsePlan({
    version: 1,
    team_id: TEAM,
    ops: [
      { op: "add_tag", task_id: "b", args: { tag: "first" } },
      { op: "set_status", task_id: "a", args: { status: "done" }, expected_before: { status: "in review" } },
    ],
  });
  const short = planHash(plan).slice(0, 8);
  failNext = { method: "PUT", status: 504 };
  const r = await apply(plan, io(short), { approve: short });
  assert.match(r.stopped, /outcome is unknown/);
  const rollback = parsePlan(JSON.parse(await readFile(join(r.dir, "rollback.json"), "utf8")));
  assert.deepEqual(rollback.ops, [{ op: "remove_tag", task_id: "b", args: { tag: "first" }, expected_before: { has_tag: true } }]);
  assert.match(rollback.note, /Outcome unknown.*#2 set_status on a.*"in review"/);
});

test("a connection refused before sending is a plain error, not an unknown outcome", async () => {
  const plan = parsePlan({ version: 1, team_id: TEAM, ops: [{ op: "comment", task_id: "a", args: { text: "x" } }] });
  const short = planHash(plan).slice(0, 8);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method ?? "GET") === "POST") throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    return realFetch(url, init);
  };
  let r;
  try {
    r = await apply(plan, io(short), { approve: short });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(r.stopped, /#1 failed: fetch failed/);
});

test("Ctrl+C before confirming stops without writing and releases the lock", async () => {
  const plan = parsePlan({ version: 1, team_id: TEAM, ops: [{ op: "add_tag", task_id: "a", args: { tag: "n" } }] });
  const short = planHash(plan).slice(0, 8);
  const ask = async () => {
    process.emit("SIGINT", "SIGINT");
    return short;
  };
  const r = await apply(plan, { ...io(), ask }, { approve: short });
  assert.match(r.stopped, /interrupted \(SIGINT\) before writing/);
  assert.equal(writes.length, 0);
  await assert.rejects(readFile(join(plansDir(), planHash(plan).slice(0, 8), "apply.lock"), "utf8"), /ENOENT/);
});


test("a SIGTERM while waiting at the prompt cancels the question", async () => {
  const plan = parsePlan({ version: 1, team_id: TEAM, ops: [{ op: "add_tag", task_id: "a", args: { tag: "t" } }] });
  const short = planHash(plan).slice(0, 8);
  let reject;
  const o = {
    ...io(),
    ask: () => {
      setTimeout(() => process.emit("SIGTERM", "SIGTERM"), 10);
      return new Promise((_, r) => (reject = r));
    },
    cancel: () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    },
  };
  const r = await apply(plan, o, { approve: short });
  assert.match(r.stopped, /cancelled at the prompt|interrupted \(SIGTERM\)/);
  assert.equal(writes.length, 0);
});

test("rollback-note.txt gives way to rollback.json once something is undoable", async () => {
  const plan = parsePlan({
    version: 1,
    team_id: TEAM,
    ops: [
      { op: "comment", task_id: "a", args: { text: "c" } },
      { op: "add_tag", task_id: "a", args: { tag: "z" } },
    ],
  });
  const short = planHash(plan).slice(0, 8);
  const r = await apply(plan, io(short), { approve: short });
  await assert.rejects(readFile(join(r.dir, "rollback-note.txt"), "utf8"), /ENOENT/);
  const rollback = parsePlan(JSON.parse(await readFile(join(r.dir, "rollback.json"), "utf8")));
  assert.equal(rollback.ops.length, 1);
  assert.match(rollback.note, /a:4242/);
});

test("a status change with no previous status is named in the note", async () => {
  delete tasks.a.status;
  const plan = parsePlan({ version: 1, team_id: TEAM, ops: [{ op: "set_status", task_id: "a", args: { status: "done" } }] });
  const short = planHash(plan).slice(0, 8);
  const r = await apply(plan, io(short), { approve: short });
  assert.match(await readFile(join(r.dir, "rollback-note.txt"), "utf8"), /no previous status.*#1 on a/);
});
