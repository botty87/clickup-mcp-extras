import { z } from "zod";
import { BlockSchema, toClickUpBlocks, withUploadedAttachments, type Block } from "../blocks.js";
import { request } from "../clickup-client.js";

export const postCommentInputShape = {
  task_id: z.string().min(1).describe("ClickUp task ID (the short alphanumeric id, e.g. 'abc123')."),
  blocks: z
    .array(BlockSchema)
    .min(1)
    .describe(
      "Ordered content blocks. Use { type:'text', value:'...' } for plain text, { type:'mention', user_id:<int> } for a real @-mention and { type:'image', file_path:'/abs/path.png', width?:<px> } for an inline image (uploaded to the task as an attachment).",
    ),
  notify_all: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true, ClickUp notifies all task followers."),
  assignee: z
    .number()
    .int()
    .optional()
    .describe("Optional user ID to assign the comment to."),
};

const InputSchema = z.object(postCommentInputShape);

type PostCommentResponse = {
  id?: string;
  hist_id?: string;
  date?: string | number;
};

export async function handlePostComment(input: z.infer<typeof InputSchema>) {
  const { task_id, blocks, notify_all, assignee } = input;
  const { comment, attachments } = await toClickUpBlocks(blocks as Block[], task_id);
  const body: Record<string, unknown> = {
    comment,
    notify_all,
  };
  if (assignee !== undefined) body.assignee = assignee;

  let res: PostCommentResponse;
  try {
    res = await request<PostCommentResponse>(
      "POST",
      `/task/${encodeURIComponent(task_id)}/comment`,
      body,
    );
  } catch (err) {
    throw withUploadedAttachments(err, attachments);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            comment_id: res.id,
            hist_id: res.hist_id,
            date: res.date,
            ...(attachments.length > 0 && { attachments }),
          },
          null,
          2,
        ),
      },
    ],
  };
}
