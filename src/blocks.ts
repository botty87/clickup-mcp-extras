import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
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
    .describe("Absolute path of a local image (png, jpg, gif, webp); the content is checked, not the extension."),
  width: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Display width in px. Default 300 like the ClickUp app, or the image's own width if smaller."),
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

const DEFAULT_IMAGE_WIDTH = 300;

// Recognised by content, so a secret renamed to *.png is never published.
function detectImageMime(data: Buffer): string | undefined {
  const ascii = (start: number, end: number) => data.subarray(start, end).toString("latin1");
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

type PreparedImage = { data: Buffer; fileName: string; mime: string };

async function readImage(filePath: string): Promise<PreparedImage> {
  if (!isAbsolute(filePath)) {
    throw new Error(`Image path must be absolute (no ~ or relative paths): ${filePath}`);
  }
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`Image not found: ${filePath}`);
  const data = await readFile(filePath);
  const mime = detectImageMime(data);
  if (!mime) throw new Error(`Not a png, jpg, gif or webp image: ${basename(filePath)}`);
  return { data, fileName: basename(filePath), mime };
}

// Same shape the ClickUp app writes when an image is pasted into a comment.
function toImageBlock(att: UploadedAttachment, mime: string, width: number | undefined): ClickUpBlock {
  const displayWidth = width ?? Math.min(DEFAULT_IMAGE_WIDTH, att.width ?? DEFAULT_IMAGE_WIDTH);
  return {
    type: "image",
    text: att.title,
    image: {
      id: att.id,
      name: att.title,
      title: att.title,
      type: mime.slice("image/".length),
      extension: mime,
      thumbnail_large: att.thumbnail_large,
      thumbnail_medium: att.thumbnail_medium,
      thumbnail_small: att.thumbnail_small,
      url: att.url,
      uploaded: true,
      width: att.width,
      height: att.height,
    },
    attributes: {
      width: String(displayWidth),
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
  // Read and check every image before uploading any, so a bad one leaves no orphan.
  const images = new Map<Block, PreparedImage>();
  for (const b of blocks) {
    if (b.type !== "image") continue;
    if (!taskId) {
      throw new Error("Image blocks need task_id: images are uploaded to that task as attachments.");
    }
    images.set(b, await readImage(b.file_path));
  }

  const comment: ClickUpBlock[] = [];
  const attachments: ConvertedBlocks["attachments"] = [];
  const endsWithNewline = () => {
    const last = comment[comment.length - 1];
    return !last || ("text" in last && !("type" in last) && last.text.endsWith("\n"));
  };

  try {
    for (const b of blocks) {
      if (b.type === "text") {
        comment.push({ text: b.value });
      } else if (b.type === "mention") {
        comment.push({ type: "tag", user: { id: b.user_id } });
      } else {
        const image = images.get(b)!;
        const att = await uploadTaskAttachment(taskId!, image.data, image.fileName, image.mime);
        attachments.push({ id: att.id, url: att.url });
        // An image is a line of its own: start it on a new line and close it.
        if (!endsWithNewline()) comment.push({ text: "\n" });
        comment.push(toImageBlock(att, image.mime, b.width));
        comment.push({ text: "\n" });
      }
    }
  } catch (err) {
    throw withUploadedAttachments(err, attachments);
  }

  return { comment, attachments };
}
