import { LedgerError, type LedgerErrorCode } from "@open-split/core";

type Status = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500;

export class ServiceError extends Error {
  readonly status: Status;
  readonly code: string;

  constructor(status: Status, code: string, message: string) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
    this.code = code;
  }
}

const ledgerDetail: Partial<Record<LedgerErrorCode, string>> = {
  exact_mismatch: "指定金額的合計必須剛好等於這筆支出。",
  basis_points_not_10000: "百分比要合計 100%。",
  non_positive_weight: "份數和百分比都要大於 0。不想分的人請取消勾選，不要填 0。",
  exact_missing_participant: "每個要分攤的人都要有一個指定金額。",
  exact_unknown_participant: "分法裡有不在這筆帳的人。",
  empty_participants: "至少要有一個人分攤。",
  negative_amount: "金額不能是負的。",
  duplicate_participant: "同一個人不能出現兩次。",
  unknown_currency: "不支援這個幣別代碼。",
  invalid_rate: "匯率設定不正確。外幣支出需要正整數比值，同幣別不能填匯率。",
  invalid_decimal_amount: "金額格式或小數位數不符合該幣別限制。",
  unsafe_integer: "金額超出系統整數安全範圍。",
};

export function asServiceError(error: unknown): ServiceError | null {
  if (error instanceof ServiceError) return error;
  if (error instanceof LedgerError) {
    return new ServiceError(422, error.code, ledgerDetail[error.code] ?? "這筆帳的分法不成立。");
  }
  return null;
}

export function errorHasText(error: unknown, needle: string): boolean {
  const lowerNeedle = needle.toLowerCase();
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error ? current.message : typeof current === "string" ? current : "";
    if (message.toLowerCase().includes(lowerNeedle)) return true;
    current = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}
