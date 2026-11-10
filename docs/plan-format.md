# Bulk changes: plan, check, apply

Bulk ClickUp changes go through a plan file instead of one MCP call per task. They use the REST API with your personal token, so they do not count against the official MCP's daily cap (100 requests per minute per token instead).

1. **Plan** — an agent (or you) writes a JSON file listing the changes. Writing the file changes nothing.
2. **Check** — `node dist/cli.js check plan.json` reads every task (GET only), shows each change as before → after, flags drift, lists who will be notified and prints the plan hash. Safe in any session.
3. **Apply** — `node dist/cli.js apply plan.json --approve <first 8 chars of the hash>`, run by a person in a terminal. It refuses without an interactive terminal, re-reads the live tasks, shows the preview again, and asks you to type the hash before writing anything.

Run the commands from the install folder (`~/.local/share/clickup-mcp-extras`), or give the full path to `dist/cli.js`.

## Format

```json
{
  "version": 1,
  "team_id": "9015293131",
  "note": "Close tasks whose PR is merged",
  "ops": [
    { "op": "set_status", "task_id": "86abc1", "args": { "status": "done" }, "expected_before": { "status": "in review" } },
    { "op": "add_tag", "task_id": "86abc1", "args": { "tag": "merged" }, "expected_before": { "has_tag": false } },
    { "op": "remove_tag", "task_id": "86abc2", "args": { "tag": "blocked" } },
    { "op": "comment", "task_id": "86abc1", "args": { "text": "PR #437 merged" } }
  ]
}
```

| `op` | `args` | `expected_before` (optional) | Undo |
|---|---|---|---|
| `set_status` | `status`: the status name as shown in ClickUp | `status` | back to the previous status |
| `add_tag` | `tag`: an existing tag name (compared and sent in lowercase, as ClickUp stores tags) | `has_tag` | `remove_tag` |
| `remove_tag` | `tag` | `has_tag` | `add_tag` |
| `comment` | `text`: plain text | — | none: a comment and its notifications cannot be taken back |

There is no delete, create, move or custom-field operation. Unknown fields are rejected. A plan with more than 100 operations needs `--allow-large`. `expected_before` can be filled from an `export_tasks` snapshot, so the agent builds the plan without extra calls.

## What apply does

- **A plan is applied once.** If its folder already has a log, `apply` refuses: to continue after a stop, write a new plan from the current state of the tasks (`expected_before` guards it). There is no automatic resume.
- Takes a lock (`apply.lock` in the plan folder), so the same plan cannot run in two terminals at once. If a run was killed, delete the lock by hand.
- Runs one operation at a time: it reads the task, compares it with `expected_before`, writes, and logs the result.
- Stops at the first drift (the task changed since the plan was written), logged as `stopped_drift`. `--skip-drift` skips drifted operations (`skipped_drift`) and goes on. `check` follows several operations on the same task in order, so a chain such as `in review` → `testing` → `done` is not reported as drift.
- Stops on any error, and says how many operations it applied before stopping. After a timeout (60 s) or a 5xx the outcome is unknown (logged as `unknown`): check the task. An operation of unknown outcome is not in `rollback.json`, since its undo would stop the rollback if the write never landed: the rollback `note` names it and gives the undo to run by hand. A connection refused before sending is a plain error.
- Ctrl+C (or SIGTERM), at the prompt or during the writes, finishes the current step, then stops, releases the lock and writes the rollback.
- Writes to `${XDG_STATE_HOME:-~/.local/state}/clickup-mcp-extras/plans/<hash8>/`:
  - `plan.json`, the plan that was approved, written only after you confirm;
  - `apply-log.jsonl`, one line per operation with the state before it;
  - `rollback.json`, a plan that undoes the run's writes, newest first, written even when the run stops on an error. It goes through `check` and `apply` like any other plan. Posted comments are listed in its `note` by ID. When there is nothing to undo, there is a `rollback-note.txt` instead.

The terminal check and the typed hash guard against mistakes, not against an agent that drives a terminal on purpose: they are a brake, not a lock.

Changes are made as the owner of the token: assignees and watchers get ClickUp's usual notifications. Status changes can also trigger the workspace's Automations, which a rollback does not undo.
