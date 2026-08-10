import { z } from "zod";
import { BlockSchema, toClickUpBlocks, type Block } from "../blocks.js";
import { request } from "../clickup-client.js";

export const replyCommentInputShape = {
  comment_id: z.string().min(1).describe("ID of the parent comment to reply to."),
  blocks: z
    .array(BlockSchema)
    .min(1)
    .describe(
      "Ordered content blocks for the reply. Same shape as post_comment_with_mentions.",
    ),
  notify_all: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true, ClickUp notifies thread participants."),
  assignee: z
    .number()
    .int()
    .optional()
    .describe("Optional user ID to assign the reply to."),
};

const InputSchema = z.object(replyCommentInputShape);

type ReplyResponse = {
  id?: string;
  hist_id?: string;
  date?: string | number;
};

export async function handleReplyComment(input: z.infer<typeof InputSchema>) {
  const { comment_id, blocks, notify_all, assignee } = input;
  const body: Record<string, unknown> = {
    comment: toClickUpBlocks(blocks as Block[]),
    notify_all,
  };
  if (assignee !== undefined) body.assignee = assignee;

  const res = await request<ReplyResponse>(
    "POST",
    `/comment/${encodeURIComponent(comment_id)}/reply`,
    body,
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            reply_id: res.id,
            hist_id: res.hist_id,
            date: res.date,
          },
          null,
          2,
        ),
      },
    ],
  };
}
