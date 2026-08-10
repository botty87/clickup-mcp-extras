import { z } from "zod";
import { request } from "../clickup-client.js";

export const reparentSubtaskInputShape = {
  task_id: z
    .string()
    .min(1)
    .describe("ID of the subtask to move under a new parent."),
  new_parent_id: z
    .string()
    .min(1)
    .describe("ID of the task that will become the new parent."),
};

const ReparentSchema = z.object(reparentSubtaskInputShape);

export async function handleReparentSubtask(
  input: z.infer<typeof ReparentSchema>,
) {
  const { task_id, new_parent_id } = input;
  await request<unknown>(
    "PUT",
    `/task/${encodeURIComponent(task_id)}`,
    { parent: new_parent_id },
  );
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { task_id, new_parent_id, reparented: true },
          null,
          2,
        ),
      },
    ],
  };
}

export const setTaskParentInputShape = {
  task_id: z
    .string()
    .min(1)
    .describe(
      "ID of the task whose parent will be set. If it had no parent before, it becomes a subtask now.",
    ),
  parent_id: z
    .string()
    .min(1)
    .describe("ID of the task that will become the parent."),
};

const SetParentSchema = z.object(setTaskParentInputShape);

export async function handleSetTaskParent(
  input: z.infer<typeof SetParentSchema>,
) {
  const { task_id, parent_id } = input;
  await request<unknown>(
    "PUT",
    `/task/${encodeURIComponent(task_id)}`,
    { parent: parent_id },
  );
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { task_id, parent_id, parent_set: true },
          null,
          2,
        ),
      },
    ],
  };
}

