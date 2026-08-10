# clickup-mcp-extras

Local MCP server exposing ClickUp comment tools with structured @-mentions support, complementing the official ClickUp MCP (`https://mcp.clickup.com/mcp`) which only supports flat-text comments.

## Why

The official ClickUp MCP's `clickup_create_task_comment` accepts only `comment_text` (plain string), so `@Name` strings are not rendered as real mentions — no notification, no clickable badge. This wrapper hits the REST API directly with the structured `comment[]` body that ClickUp's web app uses, producing proper mention blocks.

## Tools exposed

### Comments with real @-mentions
- `post_comment_with_mentions` — create a new comment on a task with text + mention blocks
- `update_comment_with_mentions` — replace an existing comment's body
- `reply_to_comment_with_mentions` — reply in a comment thread

### Subtask reparenting (missing from official MCP)
- `reparent_subtask` — move a subtask under a different parent task
- `set_task_parent` — alias: set/replace a task's parent

> Clearing the parent (promoting a subtask to standalone) is **not supported** by ClickUp REST API v2 — `parent: null` returns 200 but is silently ignored. Not a wrapper limitation.

## Setup

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
   claude mcp add clickup-extras -- node /Users/marco.bottichio/.local/share/clickup-mcp-extras/dist/index.js
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
    { "type": "mention", "user_id": 18324758 },
    { "type": "text", "value": ", controlla qui grazie!" }
  ],
  notify_all: true
)
```

## References

- ClickUp comment formatting: https://developer.clickup.com/docs/comment-formatting
- ClickUp create task comment: https://developer.clickup.com/reference/createtaskcomment
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
