import { LedgerError } from "@open-split/core";

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

export function asServiceError(error: unknown): ServiceError | null {
  if (error instanceof ServiceError) return error;
  if (error instanceof LedgerError) return new ServiceError(422, error.code, error.message);
  return null;
}
