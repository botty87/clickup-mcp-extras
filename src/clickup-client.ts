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
// ClickUp's rate-limit window is one minute. Used when a 429 carries no usable
// reset: missing, or already past because the local clock runs ahead.
const WINDOW_MS = 60_000;

// Earliest time the next request may go out, shared by every call in this
// process. Other processes using the same token are not coordinated: they can
// read the same X-RateLimit-Remaining and overshoot together, and the 429
// retry below is what absorbs that.
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

/**
 * How long to wait for the rate-limit window to reopen: until the reset (+1 s),
 * or a full window when the reset is missing or already past (local clock ahead).
 */
function windowWait(reset: number | undefined): number {
  if (reset === undefined || reset <= Date.now()) return WINDOW_MS;
  return Math.min(reset - Date.now() + 1000, MAX_WAIT_MS);
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
async function clickupFetch(path: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    // Loop: another response may extend the pause while this one sleeps.
    for (let d = pauseUntil - Date.now(); d > 0; d = pauseUntil - Date.now()) {
      await sleep(d);
    }

    const headers = new Headers(init.headers);
    headers.set("Authorization", getToken());
    // The timeout covers the request only, started after any rate-limit pause,
    // so a pause can never make it fire before anything is sent.
    const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : init.signal;
    const res = await fetch(`${BASE_URL}${path}`, { ...init, headers, signal });

    const reset = resetAt(res);
    const remaining = numericHeader(res, "x-ratelimit-remaining");
    if (remaining !== undefined && remaining < LOW_REMAINING) {
      pauseFor(windowWait(reset));
    }

    if (res.status !== 429) return res;
    // Pause even when giving up, so the next call does not go straight back
    // into the same exhausted window.
    pauseFor(windowWait(reset));
    if (attempt >= MAX_429_RETRIES) return res;
    await res.body?.cancel();
  }
}

export async function request<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const res = await clickupFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, opts.timeoutMs); // opt-in: a stalled connection then fails instead of hanging

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
