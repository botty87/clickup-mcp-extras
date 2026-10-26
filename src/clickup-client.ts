import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const BASE_URL = "https://api.clickup.com/api/v2";

export class ClickUpError extends Error {
  constructor(
    public status: number,
    public body: string,
    message: string,
  ) {
    super(message);
    this.name = "ClickUpError";
  }
}

function getToken(): string {
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) {
    throw new Error(
      "CLICKUP_API_TOKEN is not set. Create a .env file in the project root with CLICKUP_API_TOKEN=pk_xxx.",
    );
  }
  return token;
}

export async function request<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: getToken(),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return parseResponse<T>(res, method, path);
}

async function parseResponse<T>(res: Response, method: string, path: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new ClickUpError(
      res.status,
      text,
      `ClickUp ${method} ${path} failed: ${res.status} ${res.statusText} — ${text}`,
    );
  }

  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export type UploadedAttachment = {
  id: string;
  title: string;
  extension: string;
  url: string;
  thumbnail_small?: string;
  thumbnail_medium?: string;
  thumbnail_large?: string;
  width?: number;
  height?: number;
};

export async function uploadTaskAttachment(
  taskId: string,
  filePath: string,
): Promise<UploadedAttachment> {
  const data = await readFile(filePath);
  const form = new FormData();
  form.append("attachment", new Blob([data]), basename(filePath));

  const path = `/task/${encodeURIComponent(taskId)}/attachment`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { Authorization: getToken() },
    body: form,
  });
  return parseResponse<UploadedAttachment>(res, "POST", path);
}
