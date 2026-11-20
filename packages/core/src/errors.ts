export const LedgerErrorCode = {
  negativeAmount: "negative_amount",
  emptyParticipants: "empty_participants",
  duplicateParticipant: "duplicate_participant",
  invalidParticipant: "invalid_participant",
  nonPositiveWeight: "non_positive_weight",
  unsafeInteger: "unsafe_integer",
  basisPointsNot10000: "basis_points_not_10000",
  exactMismatch: "exact_mismatch",
  exactUnknownParticipant: "exact_unknown_participant",
  exactMissingParticipant: "exact_missing_participant",
  balancesNotConserved: "balances_not_conserved",
  unknownTransferParty: "unknown_transfer_party",
  internal: "internal",
} as const;

export type LedgerErrorCode = (typeof LedgerErrorCode)[keyof typeof LedgerErrorCode];

/** Deterministic failure of the ledger engine. `code` is the stable contract. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}
