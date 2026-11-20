import type {
  ActivityResult,
  BalancesResult,
  CurrentSession,
  DevUser,
  Group,
  GroupDetail,
  Member,
} from "@open-split/contracts";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ExpenseDraft {
  readonly groupId: string;
  readonly payerId: string;
  readonly amount: string;
  readonly currency: string;
  readonly participantIds: readonly string[];
  readonly category?: string;
  readonly note?: string;
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const headers = new Headers();
  headers.set("accept", "application/json");
  headers.set("x-open-split-request", "1");
  if (init?.body !== undefined) headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? "GET",
      headers,
      credentials: "same-origin",
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "連不到帳本服務。請確認本機 Worker 已啟動。");
  }
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.detail === "string" ? body.detail : "請求沒有完成。";
    throw new ApiError(response.status, detail);
  }
  return body as T;
}

export const api = {
  devEnabled: () => request<{ enabled: true }>("/api/dev/session"),
  signIn: (name: string, provider: "line" | "google") =>
    request<CurrentSession & { token: string }>("/api/dev/session", { method: "POST", body: { name, provider } }),
  session: () => request<CurrentSession>("/api/session"),
  signOut: () => request<{ ok: true }>("/api/session", { method: "DELETE" }),
  devUsers: () => request<{ users: DevUser[] }>("/api/dev/users"),
  groups: () => request<{ groups: Group[] }>("/api/groups"),
  createGroup: (name: string, defaultCurrency: string) =>
    request<Group & { ownerMemberId: string }>("/api/groups", { method: "POST", body: { name, defaultCurrency } }),
  group: (groupId: string) => request<GroupDetail>(`/api/groups/${groupId}`),
  addMember: (groupId: string, body: { displayName: string; virtual: boolean; userId?: string }) =>
    request<Member>(`/api/groups/${groupId}/members`, { method: "POST", body }),
  addExpense: (draft: ExpenseDraft) =>
    request<{ id: string; shares: { participantId: string; amount: string }[] }>(`/api/groups/${draft.groupId}/expenses`, {
      method: "POST",
      body: { ...draft, split: { type: "equal" } },
    }),
  updateExpense: (expenseId: string, draft: ExpenseDraft) =>
    request<{ id: string; shares: { participantId: string; amount: string }[] }>(
      `/api/groups/${draft.groupId}/expenses/${expenseId}`,
      { method: "PATCH", body: { ...draft, split: { type: "equal" } } },
    ),
  voidExpense: (groupId: string, expenseId: string) =>
    request<{ id: string; voided: true }>(`/api/groups/${groupId}/expenses/${expenseId}/void`, { method: "POST" }),
  balances: (groupId: string) => request<BalancesResult>(`/api/groups/${groupId}/balances`),
  activity: (groupId: string) => request<ActivityResult>(`/api/groups/${groupId}/activity`),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
