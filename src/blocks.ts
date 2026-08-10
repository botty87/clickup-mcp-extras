import { z } from "zod";

export const BlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    value: z.string(),
  }),
  z.object({
    type: z.literal("mention"),
    user_id: z.number().int().positive(),
  }),
]);

export type Block = z.infer<typeof BlockSchema>;

export const BlocksArraySchema = z.array(BlockSchema).min(1);

type ClickUpBlock =
  | { text: string }
  | { type: "tag"; user: { id: number } };

export function toClickUpBlocks(blocks: Block[]): ClickUpBlock[] {
  return blocks.map((b) => {
    if (b.type === "text") return { text: b.value };
    return { type: "tag" as const, user: { id: b.user_id } };
  });
}

