# clickup-mcp-extras

Local MCP server exposing ClickUp comment tools built from structured blocks (text, @-mentions, inline images) and a bulk task export, complementing the official ClickUp MCP (`https://mcp.clickup.com/mcp`).

## Why

The official MCP's `clickup_create_comment` takes Markdown and now real mentions (`[@Name](#user_mention#id)`), but it cannot show an image inside a comment: `![](url)` is saved as a broken image. This wrapper hits the REST API directly with the structured `comment[]` body that ClickUp's web app uses, so it can post the same `image` block the app writes when you paste a screenshot.

## Tools exposed

### Comments with real @-mentions and inline images
- `post_comment_with_mentions` — create a new comment on a task with text, mention and image blocks
- `reply_to_comment_with_mentions` — reply in a comment thread (pass `task_id` when the reply has images)
- `update_comment_with_mentions` — replace an existing comment's body with text and mention blocks

Image blocks (`{ "type": "image", "file_path": "/abs/path.png", "width": 300 }`) take an absolute path to a local png, jpg, gif or webp, recognised by its content, not its extension. The file is uploaded to the task as an attachment and then referenced from the comment, so it also shows up in the task's Attachments panel (the public API cannot attach a file to a comment, as the app does). `width` is the display width in px: default 300, or the image's own width if smaller. Images are read and checked before any upload, so a bad path leaves nothing on the task.

> ClickUp rejects an edit that adds an image to a comment (`ACCESS_610`, `can_use_public_api_dev_key`), so `update_comment_with_mentions` accepts text and mentions only and drops any image the comment had. To add a picture to an existing comment, reply to it.

### Subtask reparenting (missing from official MCP)
- `reparent_subtask` — move a subtask under a different parent task
- `set_task_parent` — alias: set/replace a task's parent

> Clearing the parent (promoting a subtask to standalone) is **not supported** by ClickUp REST API v2 — `parent: null` returns 200 but is silently ignored. Not a wrapper limitation.

### Bulk export (read-only)
- `export_tasks` — read the tasks of a workspace (closed and subtasks included by default, optional `space_ids` / `list_ids` filters; archived tasks are not returned by ClickUp's team endpoint) through the REST API and save it as a local JSON snapshot

The official MCP counts every call, reads included, against a daily cap shared by the workspace (300 per 24 h on the Core plan). This tool uses the REST API with your personal token instead: about one request per 100 tasks, limited only by the per-token rate limit (100 requests/min on most plans). The full tasks never enter the conversation: the tool returns the snapshot path, counts by status, assignee and list, and the IDs missing since the previous snapshot (deleted, archived, moved or no longer visible). Query the file from the shell:

```sh
jq '[.tasks[] | select(.status.status == "in progress") | {id, name}]' ~/.local/state/clickup-mcp-extras/snapshots/latest.json
```

Snapshots live in `${XDG_STATE_HOME:-~/.local/state}/clickup-mcp-extras/snapshots/`, outside the install folder so updates don't delete them. Each export keeps the last 5 and removes older ones. Only a whole-workspace export (no space/list filters, closed tasks and subtasks included) updates `latest.json` and is compared with the previous one; a filtered export writes a `filtered-*.json` file, and each kind keeps its own last 5. ClickUp pages by offset, so a task created, deleted or moved while an export runs can be missed and appear among the missing IDs: rerun the export to confirm. `team_id` defaults to `CLICKUP_TEAM_ID` in `.env`.

### Bulk changes (plan / check / apply)
Bulk status, tag and comment changes go through a plan file and a command-line tool, not through MCP calls, so they skip the official MCP's daily cap and need a person to approve them:

```sh
node ~/.local/share/clickup-mcp-extras/dist/cli.js check plan.json          # read-only preview, prints the hash
node ~/.local/share/clickup-mcp-extras/dist/cli.js apply plan.json --approve <hash8>   # you, in a terminal
```

Format, operations, logs and rollback: [docs/plan-format.md](docs/plan-format.md).

### Rate limiting
Every request goes through one wrapper that reads `X-RateLimit-Remaining` / `X-RateLimit-Reset`: it pauses when fewer than 10 requests are left and, on a 429, waits for the reset and retries up to 3 times.

### Read-only sessions
`docs/audit-settings.json` denies, in one settings file:

- every write tool of the official ClickUp MCP as the claude.ai connector names them (`mcp__claude_ai_ClickUp__*`), including `clickup_execute_operator`, whose bulk reads `export_tasks` replaces;
- this server's write tools (`mcp__clickup-extras__*`);
- `cli.js apply`, reading the `.env` and shell calls to `api.clickup.com`.

If you registered either server under another name, change those prefixes. Start a session that must not change ClickUp with:

```sh
claude --settings ~/.local/share/clickup-mcp-extras/docs/audit-settings.json
```

It guards against mistakes, not against a determined agent: the token stays readable by your user.

## Setup

Requires Node.js ≥ 22.

1. Generate a Personal API Token at app.clickup.com → Settings → Apps.
2. Copy `.env.example` to `.env` and paste the token (`CLICKUP_API_TOKEN=pk_xxx`).
3. Install deps and build:
   ```sh
   cd ~/.local/share/clickup-mcp-extras
   npm install
   npm run build
   ```
4. Register with Claude Code:
   ```sh
   claude mcp add clickup-extras --scope user -- node "$HOME/.local/share/clickup-mcp-extras/dist/index.js"
   ```
5. Verify: `claude mcp list` should show `clickup-extras: ✓ Connected`.

## Usage

User IDs for mentions come from the official ClickUp MCP via `clickup_get_workspace_members` — don't duplicate that here.

Example call from Claude Code:

```
post_comment_with_mentions(
  task_id: "abc123",
  blocks: [
    { "type": "text", "value": "Ciao " },
    { "type": "mention", "user_id": 12345678 },
    { "type": "text", "value": ", controlla qui grazie!" },
    { "type": "image", "file_path": "/Users/you/Desktop/screenshot.png" }
  ],
  notify_all: true
)
```

## References

- ClickUp comment formatting: https://developer.clickup.com/docs/comment-formatting
- ClickUp create task comment: https://developer.clickup.com/reference/createtaskcomment
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
