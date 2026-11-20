import { LedgerError, type LedgerErrorCode } from "@open-split/core";

type Status = 400 | 401 | 403 | 404 | 409 | 422 | 500;

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
};

export function asServiceError(error: unknown): ServiceError | null {
  if (error instanceof ServiceError) return error;
  if (error instanceof LedgerError) {
    return new ServiceError(422, error.code, ledgerDetail[error.code] ?? "這筆帳的分法不成立。");
  }
  return null;
}
