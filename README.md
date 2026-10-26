# clickup-mcp-extras

Local MCP server exposing ClickUp comment tools built from structured blocks (text, @-mentions, inline images), complementing the official ClickUp MCP (`https://mcp.clickup.com/mcp`).

## Why

The official MCP's `clickup_create_comment` takes Markdown and now real mentions (`[@Name](#user_mention#id)`), but it cannot show an image inside a comment: `![](url)` is saved as a broken image. This wrapper hits the REST API directly with the structured `comment[]` body that ClickUp's web app uses, so it can post the same `image` block the app writes when you paste a screenshot.

## Tools exposed

### Comments with real @-mentions and inline images
- `post_comment_with_mentions` — create a new comment on a task with text, mention and image blocks
- `reply_to_comment_with_mentions` — reply in a comment thread (pass `task_id` when the reply has images)
- `update_comment_with_mentions` — replace an existing comment's body with text and mention blocks

Image blocks (`{ "type": "image", "file_path": "/abs/path.png", "width": 300 }`) take a local png, jpg, gif or webp. The file is uploaded to the task as an attachment and then referenced from the comment, so it also shows up in the task's Attachments panel (the public API cannot attach a file to a comment, as the app does). `width` is the display width in px, default 300.

> ClickUp rejects an edit that adds an image to a comment (`ACCESS_610`, `can_use_public_api_dev_key`), so `update_comment_with_mentions` accepts text and mentions only and drops any image the comment had. To add a picture to an existing comment, reply to it.

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
    { "type": "text", "value": ", controlla qui grazie!" },
    { "type": "image", "file_path": "/Users/me/Desktop/screenshot.png" }
  ],
  notify_all: true
)
```

## References

- ClickUp comment formatting: https://developer.clickup.com/docs/comment-formatting
- ClickUp create task comment: https://developer.clickup.com/reference/createtaskcomment
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
