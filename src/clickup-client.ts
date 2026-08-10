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
