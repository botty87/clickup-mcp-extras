import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as dotenvConfig } from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenvConfig({ path: resolve(__dirname, "..", ".env") });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  postCommentInputShape,
  handlePostComment,
} from "./tools/post-comment.js";
import {
  updateCommentInputShape,
  handleUpdateComment,
} from "./tools/update-comment.js";
import {
  replyCommentInputShape,
  handleReplyComment,
} from "./tools/reply-comment.js";
import {
  reparentSubtaskInputShape,
  handleReparentSubtask,
  setTaskParentInputShape,
  handleSetTaskParent,
} from "./tools/reparent.js";

if (!process.env.CLICKUP_API_TOKEN) {
  console.error(
    "[clickup-mcp-extras] CLICKUP_API_TOKEN missing. Add it to .env in the project root.",
  );
  process.exit(1);
}

const server = new McpServer(
  {
    name: "clickup-mcp-extras",
    version: "0.3.0",
  },
  {
    capabilities: { tools: {} },
  },
);

server.tool(
  "post_comment_with_mentions",
  "Create a new ClickUp task comment from structured blocks: text, real @-mentions and inline images from local files. Use this instead of the official ClickUp MCP's create_comment when the comment needs an image shown inline: the official tool cannot render one.",
  postCommentInputShape,
  handlePostComment,
);

server.tool(
  "update_comment_with_mentions",
  "Replace an existing ClickUp comment's body with structured text and mention blocks. Use to fix or rewrite a previously posted comment. Images cannot be added or kept: ClickUp rejects them on edit, so a comment with images is better answered with a reply.",
  updateCommentInputShape,
  handleUpdateComment,
);

server.tool(
  "reply_to_comment_with_mentions",
  "Post a threaded reply to an existing ClickUp comment with structured blocks (text, mentions, inline images). Pass task_id when adding images.",
  replyCommentInputShape,
  handleReplyComment,
);

server.tool(
  "reparent_subtask",
  "Move an existing subtask under a different parent task. The official ClickUp MCP's update_task does not expose the 'parent' field, so use this to re-parent subtasks. Both tasks must live in the same workspace.",
  reparentSubtaskInputShape,
  handleReparentSubtask,
);

server.tool(
  "set_task_parent",
  "Set the parent of a task by passing the parent's ID. If the task was standalone, it becomes a subtask. If it already had a parent, the parent is replaced (equivalent to reparent_subtask).",
  setTaskParentInputShape,
  handleSetTaskParent,
);

const transport = new StdioServerTransport();
await server.connect(transport);
