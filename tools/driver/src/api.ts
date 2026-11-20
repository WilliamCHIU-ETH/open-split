import { DriverFailure } from "./failure.ts";

export class WorkerFailure extends DriverFailure {
  readonly status: number;

  constructor(status: number, message: string) {
    super(status >= 500 ? 2 : 1, message);
    this.status = status;
  }
}

export function apiBase(): string {
  return (process.env.OPEN_SPLIT_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
}

export async function apiRequest(token: string | null, path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("x-open-split-request", "1");
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(new URL(path, `${apiBase()}/`), {
      method: init?.method ?? "GET",
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DriverFailure(
      1,
      `連不到 Worker（${apiBase()}）。請先執行 pnpm --filter @open-split/worker dev，並確認 .dev.vars 把 ENVIRONMENT 設成 development、AUTH_DEV_IDENTITIES 設成 true。${message}`,
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.detail === "string" ? body.detail : text;
    throw new WorkerFailure(response.status, `Worker ${String(response.status)} ${path}：${detail}`);
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
