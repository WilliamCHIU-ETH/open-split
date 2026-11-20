import {
  ATTACHMENT_MAX_BYTES,
  attachmentMimeTypes,
  type ActivityResult,
  type AddMemberResult,
  type AttachmentSummary,
  type AttachmentUploadIntentInput,
  type AttachmentUploadIntentResult,
  type BalancesResult,
  type ClaimGrant,
  type ClaimPreview,
  type ClaimResult,
  type CurrentSession,
  type DevUser,
  type FxRateWire,
  type Group,
  type GroupDetail,
  type GroupSummary,
  type InvitePreview,
  type JoinResult,
  type PaymentProfileWrite,
  type SettlementPreview,
  type SettlementWrite,
  type SplitWire,
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
  readonly fxRate?: FxRateWire;
  readonly participantIds: readonly string[];
  readonly split: SplitWire;
  readonly category?: string;
  readonly note?: string;
  readonly attachmentIds?: readonly string[];
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
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
  return parseJsonResponse<T>(response);
}

async function sha256HexBuffer(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
    request<AddMemberResult>(`/api/groups/${groupId}/members`, { method: "POST", body }),
  rotateClaim: (groupId: string, memberId: string) =>
    request<ClaimGrant>(`/api/groups/${groupId}/members/${memberId}/claim-link`, { method: "POST" }),
  previewClaim: (token: string) => request<ClaimPreview>(`/api/claims/${encodeURIComponent(token)}`),
  claim: (token: string) => request<ClaimResult>(`/api/claims/${encodeURIComponent(token)}`, { method: "POST" }),
  createInvite: (groupId: string) =>
    request<{ invitePath: string; token: string }>(`/api/groups/${groupId}/invites`, { method: "POST" }),
  previewInvite: (token: string) => request<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string) => request<JoinResult>(`/api/invites/${encodeURIComponent(token)}/accept`, { method: "POST" }),
  addExpense: (draft: ExpenseDraft) =>
    request<{ id: string; shares: { participantId: string; amount: string }[] }>(`/api/groups/${draft.groupId}/expenses`, {
      method: "POST",
      body: draft,
    }),
  updateExpense: (expenseId: string, draft: ExpenseDraft) =>
    request<{ id: string; shares: { participantId: string; amount: string }[] }>(
      `/api/groups/${draft.groupId}/expenses/${expenseId}`,
      { method: "PATCH", body: draft },
    ),
  voidExpense: (groupId: string, expenseId: string) =>
    request<{ id: string; voided: true }>(`/api/groups/${groupId}/expenses/${expenseId}/void`, { method: "POST" }),
  attachments: (groupId: string) => request<{ attachments: AttachmentSummary[] }>(`/api/groups/${groupId}/attachments`),
  createAttachmentUpload: (groupId: string, body: Omit<AttachmentUploadIntentInput, "groupId">) =>
    request<AttachmentUploadIntentResult>(`/api/groups/${groupId}/attachments/upload-intent`, {
      method: "POST",
      body: { ...body, groupId },
    }),
  deleteAttachment: (groupId: string, attachmentId: string) =>
    request<{ id: string; deleted: true }>(`/api/groups/${groupId}/attachments/${attachmentId}`, { method: "DELETE" }),
  uploadReceiptFile: async (groupId: string, file: File, expenseId?: string): Promise<AttachmentSummary> => {
    const mimeType = (attachmentMimeTypes as readonly string[]).includes(file.type)
      ? (file.type as AttachmentUploadIntentInput["mimeType"])
      : null;
    if (!mimeType) {
      throw new ApiError(415, "只支援 JPG、PNG、WEBP 圖片或 PDF 收據。");
    }
    if (file.size <= 0 || file.size > ATTACHMENT_MAX_BYTES) {
      throw new ApiError(413, "收據檔案大小需介於 1 B 到 10 MB 之間。");
    }
    const bytes = await file.arrayBuffer();
    const sha256 = await sha256HexBuffer(bytes);
    const intent = await api.createAttachmentUpload(groupId, {
      ...(expenseId ? { expenseId } : {}),
      filename: file.name || "receipt",
      mimeType,
      byteSize: file.size,
      sha256,
    });
    let response: Response;
    try {
      response = await fetch(intent.uploadPath, {
        method: intent.uploadMethod,
        headers: { ...intent.uploadHeaders, "x-open-split-request": "1" },
        credentials: "same-origin",
        body: bytes,
      });
    } catch {
      throw new ApiError(0, "收據上傳失敗，請稍後再試。");
    }
    return parseJsonResponse<AttachmentSummary>(response);
  },
  balances: (groupId: string) => request<BalancesResult>(`/api/groups/${groupId}/balances`),
  settlementPlan: (groupId: string) => request<SettlementPreview>(`/api/groups/${groupId}/settlement-plan`),
  recordSettlement: (groupId: string, body: SettlementWrite) =>
    request<{ id: string }>(`/api/groups/${groupId}/settlements`, { method: "POST", body }),
  voidSettlement: (groupId: string, settlementId: string) =>
    request<{ id: string; voided: true }>(`/api/groups/${groupId}/settlements/${settlementId}/void`, { method: "POST" }),
  savePaymentProfile: (groupId: string, memberId: string, body: PaymentProfileWrite) =>
    request<{ id: string }>(`/api/groups/${groupId}/members/${memberId}/payment-profile`, { method: "PUT", body }),
  clearPaymentProfile: (groupId: string, memberId: string) =>
    request<{ ok: true }>(`/api/groups/${groupId}/members/${memberId}/payment-profile`, { method: "DELETE" }),
  summary: (groupId: string) => request<GroupSummary>(`/api/groups/${groupId}/summary`),
  activity: (groupId: string) => request<ActivityResult>(`/api/groups/${groupId}/activity`),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
