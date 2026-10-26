import { access } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import { uploadTaskAttachment, type UploadedAttachment } from "./clickup-client.js";

const TextBlock = z.object({
  type: z.literal("text"),
  value: z.string(),
});

const MentionBlock = z.object({
  type: z.literal("mention"),
  user_id: z.number().int().positive(),
});

const ImageBlock = z.object({
  type: z.literal("image"),
  file_path: z
    .string()
    .min(1)
    .describe("Absolute path of a local image (png, jpg, gif, webp)."),
  width: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Display width in px. Default 300, like the ClickUp app."),
});

export const BlockSchema = z.discriminatedUnion("type", [TextBlock, MentionBlock, ImageBlock]);

// ClickUp rejects editing a comment to add a new image (ACCESS_610,
// can_use_public_api_dev_key), so updates take text and mentions only.
export const TextBlockSchema = z.discriminatedUnion("type", [TextBlock, MentionBlock]);

export type Block = z.infer<typeof BlockSchema>;

type ClickUpBlock =
  | { text: string }
  | { type: "tag"; user: { id: number } }
  | { type: "image"; text: string; image: Record<string, unknown>; attributes: Record<string, unknown> };

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const DEFAULT_IMAGE_WIDTH = 300;

function imageExtension(filePath: string): string {
  const ext = extname(filePath).slice(1).toLowerCase();
  if (!IMAGE_MIME[ext]) {
    throw new Error(
      `Unsupported image type for ${basename(filePath)}: use one of ${Object.keys(IMAGE_MIME).join(", ")}.`,
    );
  }
  return ext;
}

// Same shape the ClickUp app writes when an image is pasted into a comment.
function toImageBlock(att: UploadedAttachment, width: number | undefined): ClickUpBlock {
  const ext = att.extension.toLowerCase();
  return {
    type: "image",
    text: att.title,
    image: {
      id: att.id,
      name: att.title,
      title: att.title,
      type: ext,
      extension: IMAGE_MIME[ext] ?? `image/${ext}`,
      thumbnail_large: att.thumbnail_large,
      thumbnail_medium: att.thumbnail_medium,
      thumbnail_small: att.thumbnail_small,
      url: att.url,
      uploaded: true,
      width: att.width,
      height: att.height,
    },
    attributes: {
      width: String(width ?? DEFAULT_IMAGE_WIDTH),
      "data-id": att.id,
      "data-attachment": null,
      "data-natural-width": String(att.width ?? ""),
      "data-natural-height": String(att.height ?? ""),
    },
  };
}

/** Names the attachments left on the task when the comment itself failed. */
export function withUploadedAttachments(err: unknown, attachments: ConvertedBlocks["attachments"]): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (attachments.length === 0) return err instanceof Error ? err : new Error(message);
  const ids = attachments.map((a) => a.id).join(", ");
  return new Error(`${message} (already uploaded to the task: ${ids})`);
}

export type ConvertedBlocks = {
  comment: ClickUpBlock[];
  attachments: { id: string; url: string }[];
};

/**
 * Converts input blocks to ClickUp's `comment[]` body. Image blocks are first
 * uploaded to `taskId` as task attachments (the public API cannot attach a file
 * to a comment), so they also appear in the task's Attachments panel.
 */
export async function toClickUpBlocks(
  blocks: Block[],
  taskId?: string,
): Promise<ConvertedBlocks> {
  const images = blocks.filter((b) => b.type === "image");
  if (images.length > 0) {
    if (!taskId) {
      throw new Error("Image blocks need task_id: images are uploaded to that task as attachments.");
    }
    // Fail before uploading anything, so a bad path leaves no orphan attachment.
    for (const b of images) {
      imageExtension(b.file_path);
      await access(b.file_path).catch(() => {
        throw new Error(`Image not found: ${b.file_path}`);
      });
    }
  }

  const comment: ClickUpBlock[] = [];
  const attachments: ConvertedBlocks["attachments"] = [];
  const endsWithNewline = () => {
    const last = comment[comment.length - 1];
    return !last || ("text" in last && !("type" in last) && last.text.endsWith("\n"));
  };

  for (const b of blocks) {
    if (b.type === "text") {
      comment.push({ text: b.value });
    } else if (b.type === "mention") {
      comment.push({ type: "tag", user: { id: b.user_id } });
    } else {
      let att: UploadedAttachment;
      try {
        att = await uploadTaskAttachment(taskId!, b.file_path);
      } catch (err) {
        throw withUploadedAttachments(err, attachments);
      }
      attachments.push({ id: att.id, url: att.url });
      // An image is a line of its own: start it on a new line and close it.
      if (!endsWithNewline()) comment.push({ text: "\n" });
      comment.push(toImageBlock(att, b.width));
      comment.push({ text: "\n" });
    }
  }

  return { comment, attachments };
}
