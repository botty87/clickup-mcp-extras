import { z } from "zod";
import { TextBlockSchema, toClickUpBlocks, type Block } from "../blocks.js";
import { request } from "../clickup-client.js";

export const updateCommentInputShape = {
  comment_id: z.string().min(1).describe("ID of the existing ClickUp comment to update."),
  blocks: z
    .array(TextBlockSchema)
    .min(1)
    .describe(
      "New ordered text and mention blocks. Replaces the comment body entirely, images included: ClickUp does not let an edit add images, so they cannot be kept or added here.",
    ),
  resolved: z
    .boolean()
    .optional()
    .describe("If set, mark the comment as resolved/unresolved."),
  assignee: z
    .number()
    .int()
    .optional()
    .describe("Optional user ID to assign the comment to."),
};

const InputSchema = z.object(updateCommentInputShape);

export async function handleUpdateComment(input: z.infer<typeof InputSchema>) {
  const { comment_id, blocks, resolved, assignee } = input;
  const { comment } = await toClickUpBlocks(blocks as Block[]);
  const body: Record<string, unknown> = {
    comment,
  };
  if (resolved !== undefined) body.resolved = resolved;
  if (assignee !== undefined) body.assignee = assignee;

  await request<unknown>(
    "PUT",
    `/comment/${encodeURIComponent(comment_id)}`,
    body,
  );

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ comment_id, updated: true }, null, 2),
      },
    ],
  };
}
