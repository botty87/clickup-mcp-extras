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

const MAX_429_RETRIES = 3;
const LOW_REMAINING = 10;
const MAX_WAIT_MS = 70_000;
// Floor for a 429 wait: if the local clock runs ahead of ClickUp's, the reset
// can look already past and the retries would otherwise fire back to back.
const MIN_429_WAIT_MS = 2_000;

// Earliest time the next request may go out. Shared by every call in this
// process; other processes using the same token see the same server-side
// counter in the X-RateLimit-* headers, so no cross-process lock is needed.
let pauseUntil = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Numeric header value, or undefined when the header is missing or not a number. */
function numericHeader(res: Response, name: string): number | undefined {
  const raw = res.headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Epoch ms of X-RateLimit-Reset (documented as a Unix timestamp), if present. */
function resetAt(res: Response): number | undefined {
  const raw = numericHeader(res, "x-ratelimit-reset");
  if (raw === undefined || raw <= 0) return undefined;
  return raw > 1e12 ? raw : raw * 1000;
}

function waitUntil(at: number | undefined, fallbackMs: number, minMs = 0): number {
  const ms = at === undefined ? fallbackMs : at - Date.now() + 1000;
  return Math.min(Math.max(ms, minMs), MAX_WAIT_MS);
}

/** Never shorten a pause another response already set. */
function pauseFor(ms: number): void {
  pauseUntil = Math.max(pauseUntil, Date.now() + ms);
}

/**
 * The single place where this server talks to ClickUp. Keeps under the
 * per-token rate limit: pauses when X-RateLimit-Remaining runs low and, on a
 * 429 (request not executed), waits for the reset and retries.
 */
async function clickupFetch(path: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const delay = pauseUntil - Date.now();
    if (delay > 0) await sleep(delay);

    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { Authorization: getToken(), ...init.headers },
    });

    const reset = resetAt(res);
    const remaining = numericHeader(res, "x-ratelimit-remaining");
    if (remaining !== undefined && remaining < LOW_REMAINING) {
      pauseFor(waitUntil(reset, 60_000));
    }

    if (res.status !== 429 || attempt >= MAX_429_RETRIES) return res;
    await res.body?.cancel();
    pauseFor(waitUntil(reset, 60_000, MIN_429_WAIT_MS));
  }
}

export async function request<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await clickupFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
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
  data: Buffer,
  fileName: string,
  mimeType: string,
): Promise<UploadedAttachment> {
  const form = new FormData();
  form.append("attachment", new Blob([new Uint8Array(data)], { type: mimeType }), fileName);

  const path = `/task/${encodeURIComponent(taskId)}/attachment`;
  const res = await clickupFetch(path, { method: "POST", body: form });
  return parseResponse<UploadedAttachment>(res, "POST", path);
}
