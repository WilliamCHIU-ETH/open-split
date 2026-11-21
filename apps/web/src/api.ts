import type {
  ActivityResult,
  AddMemberResult,
  AttachmentSummary,
  AttachmentUploadIntentInput,
  AttachmentUploadIntentResult,
  BalancesResult,
  ClaimGrant,
  ClaimPreview,
  ClaimResult,
  CreateGroupResult,
  CurrentSession,
  DevUser,
  ExpenseInput,
  ExpenseResult,
  GroupDetail,
  GroupList,
  GroupSummary,
  InvitePreview,
  InviteResult,
  JoinResult,
  PaymentProfileWrite,
  SettlementPreview,
  SettlementWrite,
  VoidExpenseResult,
} from "@open-split/contracts";
import { ATTACHMENT_MAX_BYTES, apiPaths, attachmentMimeTypes } from "@open-split/contracts/client";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export type ExpenseDraft = ExpenseInput;

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
  devEnabled: () => request<{ enabled: true }>(apiPaths.devSession()),
  signIn: (name: string, provider: "line" | "google") =>
    request<CurrentSession & { token: string }>(apiPaths.devSession(), { method: "POST", body: { name, provider } }),
  session: () => request<CurrentSession>(apiPaths.session()),
  signOut: () => request<{ ok: true }>(apiPaths.session(), { method: "DELETE" }),
  devUsers: () => request<{ users: DevUser[] }>(apiPaths.devUsers()),
  groups: () => request<GroupList>(apiPaths.groups()),
  createGroup: (name: string, defaultCurrency: string) =>
    request<CreateGroupResult>(apiPaths.groups(), { method: "POST", body: { name, defaultCurrency } }),
  group: (groupId: string) => request<GroupDetail>(apiPaths.group(groupId)),
  addMember: (groupId: string, body: { displayName: string; virtual: boolean; userId?: string }) =>
    request<AddMemberResult>(apiPaths.groupMembers(groupId), { method: "POST", body }),
  rotateClaim: (groupId: string, memberId: string) =>
    request<ClaimGrant>(apiPaths.memberClaimLink(groupId, memberId), { method: "POST" }),
  previewClaim: (token: string) => request<ClaimPreview>(apiPaths.claim(token)),
  claim: (token: string) => request<ClaimResult>(apiPaths.claim(token), { method: "POST" }),
  createInvite: (groupId: string) => request<InviteResult>(apiPaths.groupInvites(groupId), { method: "POST" }),
  previewInvite: (token: string) => request<InvitePreview>(apiPaths.invite(token)),
  acceptInvite: (token: string) => request<JoinResult>(apiPaths.inviteAccept(token), { method: "POST" }),
  addExpense: (draft: ExpenseDraft) =>
    request<ExpenseResult>(apiPaths.groupExpenses(draft.groupId), { method: "POST", body: draft }),
  updateExpense: (expenseId: string, draft: ExpenseDraft) =>
    request<ExpenseResult>(apiPaths.groupExpense(draft.groupId, expenseId), { method: "PATCH", body: draft }),
  voidExpense: (groupId: string, expenseId: string) =>
    request<VoidExpenseResult>(apiPaths.groupExpenseVoid(groupId, expenseId), { method: "POST" }),
  attachments: (groupId: string) => request<{ attachments: AttachmentSummary[] }>(apiPaths.groupAttachments(groupId)),
  createAttachmentUpload: (groupId: string, body: Omit<AttachmentUploadIntentInput, "groupId">) =>
    request<AttachmentUploadIntentResult>(apiPaths.groupAttachmentUploadIntent(groupId), {
      method: "POST",
      body: { ...body, groupId },
    }),
  deleteAttachment: (groupId: string, attachmentId: string) =>
    request<{ id: string; deleted: true }>(apiPaths.groupAttachment(groupId, attachmentId), { method: "DELETE" }),
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
  balances: (groupId: string) => request<BalancesResult>(apiPaths.groupBalances(groupId)),
  settlementPlan: (groupId: string) => request<SettlementPreview>(apiPaths.groupSettlementPlan(groupId)),
  recordSettlement: (groupId: string, body: SettlementWrite) =>
    request<{ id: string }>(apiPaths.groupSettlements(groupId), { method: "POST", body }),
  voidSettlement: (groupId: string, settlementId: string) =>
    request<{ id: string; voided: true }>(apiPaths.groupSettlementVoid(groupId, settlementId), { method: "POST" }),
  savePaymentProfile: (groupId: string, memberId: string, body: PaymentProfileWrite) =>
    request<{ id: string }>(apiPaths.memberPaymentProfile(groupId, memberId), { method: "PUT", body }),
  clearPaymentProfile: (groupId: string, memberId: string) =>
    request<{ ok: true }>(apiPaths.memberPaymentProfile(groupId, memberId), { method: "DELETE" }),
  summary: (groupId: string) => request<GroupSummary>(apiPaths.groupSummary(groupId)),
  activity: (groupId: string) => request<ActivityResult>(apiPaths.groupActivity(groupId)),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
