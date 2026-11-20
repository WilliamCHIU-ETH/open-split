import { LedgerError, LedgerErrorCode } from "./errors.ts";
import { minor, toMinorUnits, type Minor } from "./money.ts";

export type ParticipantId = string;

/** 100% expressed as basis points so percentages never use floating point. */
export const PERCENT_BASIS_POINTS = 10_000;

export interface EqualSplit {
  readonly type: "equal";
}

export interface ExactSplit {
  readonly type: "exact";
  readonly amounts: Readonly<Record<ParticipantId, Minor>>;
}

export interface PercentageSplit {
  readonly type: "percentage";
  /** Positive integers. Included participants must sum to {@link PERCENT_BASIS_POINTS}. */
  readonly basisPoints: Readonly<Record<ParticipantId, number>>;
}

export interface SharesSplit {
  readonly type: "shares";
  /** Positive integers. They are weights, not money. */
  readonly weights: Readonly<Record<ParticipantId, number>>;
}

export type SplitSpec = EqualSplit | ExactSplit | PercentageSplit | SharesSplit;

export interface AllocationInput {
  readonly amount: Minor;
  readonly participantIds: readonly ParticipantId[];
  readonly split: SplitSpec;
}

export interface Share {
  readonly participantId: ParticipantId;
  readonly amount: Minor;
}

/**
 * Split `amount` across participants.
 * Shares are returned in lexicographic participant-id order.
 * Any minor unit that does not divide evenly goes to the earliest ids in that order
 * (equal split) or to the largest fractional remainder, ties broken by id
 * (shares and percentage). The order is part of the contract: it is deterministic,
 * and it does bias leftover cents toward earlier ids.
 * The sum of returned shares equals `amount` exactly.
 */
export function allocate(input: AllocationInput): readonly Share[] {
  const amount = toMinorUnits(input.amount);
  if (amount < 0n) {
    throw new LedgerError(LedgerErrorCode.negativeAmount, "Expense amount must be >= 0 minor units.");
  }
  const ids = normalizeParticipants(input.participantIds);

  switch (input.split.type) {
    case "equal":
      return allocateEqual(amount, ids);
    case "exact":
      return allocateExact(amount, ids, input.split.amounts);
    case "percentage":
      return allocatePercentage(amount, ids, input.split.basisPoints);
    case "shares":
      return allocateShares(amount, ids, input.split.weights);
    default: {
      const unexpected: never = input.split;
      throw new LedgerError(LedgerErrorCode.internal, `Unknown split ${String(unexpected)}.`);
    }
  }
}

function normalizeParticipants(participantIds: readonly ParticipantId[]): readonly ParticipantId[] {
  if (participantIds.length === 0) {
    throw new LedgerError(LedgerErrorCode.emptyParticipants, "At least one participant is required.");
  }
  if (participantIds.some((id) => id.length === 0)) {
    throw new LedgerError(LedgerErrorCode.invalidParticipant, "Participant id must be non-empty.");
  }
  if (new Set(participantIds).size !== participantIds.length) {
    throw new LedgerError(LedgerErrorCode.duplicateParticipant, "Participant ids must be unique.");
  }
  return [...participantIds].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function allocateEqual(amount: bigint, ids: readonly ParticipantId[]): readonly Share[] {
  const count = BigInt(ids.length);
  const base = amount / count;
  const remainder = amount % count;
  return ids.map((participantId, index) => ({
    participantId,
    amount: minor(base + (BigInt(index) < remainder ? 1n : 0n)),
  }));
}

function allocateExact(
  amount: bigint,
  ids: readonly ParticipantId[],
  amounts: Readonly<Record<ParticipantId, Minor>>,
): readonly Share[] {
  const idSet = new Set(ids);
  for (const key of Object.keys(amounts)) {
    if (!idSet.has(key)) {
      throw new LedgerError(
        LedgerErrorCode.exactUnknownParticipant,
        `Exact split has an amount for ${key}, who is not a participant.`,
      );
    }
  }

  let sum = 0n;
  const shares: Share[] = [];
  for (const participantId of ids) {
    const part = amounts[participantId];
    if (part === undefined) {
      throw new LedgerError(
        LedgerErrorCode.exactMissingParticipant,
        `Exact split is missing an amount for ${participantId}.`,
      );
    }
    const units = toMinorUnits(part);
    if (units < 0n) {
      throw new LedgerError(LedgerErrorCode.negativeAmount, "Exact shares must be >= 0 minor units.");
    }
    sum += units;
    shares.push({ participantId, amount: part });
  }

  if (sum !== amount) {
    throw new LedgerError(
      LedgerErrorCode.exactMismatch,
      `Exact shares sum to ${sum.toString(10)} minor units, expense is ${amount.toString(10)}.`,
    );
  }
  return shares;
}

function allocatePercentage(
  amount: bigint,
  ids: readonly ParticipantId[],
  basisPoints: Readonly<Record<ParticipantId, number>>,
): readonly Share[] {
  assertKeysMatch(ids, basisPoints, "percentage");
  let sum = 0;
  const weights = new Map<ParticipantId, bigint>();
  for (const id of ids) {
    const points = basisPoints[id];
    if (points === undefined || !Number.isSafeInteger(points) || points <= 0) {
      throw new LedgerError(
        LedgerErrorCode.nonPositiveWeight,
        `Percentage for ${id} must be a positive safe integer of basis points. Exclusion is done by omitting the participant, not by using 0.`,
      );
    }
    sum += points;
    weights.set(id, BigInt(points));
  }
  if (sum !== PERCENT_BASIS_POINTS) {
    throw new LedgerError(
      LedgerErrorCode.basisPointsNot10000,
      `Basis points must sum to ${String(PERCENT_BASIS_POINTS)}, received ${String(sum)}.`,
    );
  }
  return allocateByWeights(amount, ids, weights);
}

function allocateShares(
  amount: bigint,
  ids: readonly ParticipantId[],
  weights: Readonly<Record<ParticipantId, number>>,
): readonly Share[] {
  assertKeysMatch(ids, weights, "shares");
  const parsed = new Map<ParticipantId, bigint>();
  for (const id of ids) {
    const weight = weights[id];
    if (weight === undefined || !Number.isSafeInteger(weight) || weight <= 0) {
      throw new LedgerError(
        LedgerErrorCode.nonPositiveWeight,
        `Share weight for ${id} must be a positive safe integer.`,
      );
    }
    parsed.set(id, BigInt(weight));
  }
  return allocateByWeights(amount, ids, parsed);
}

function assertKeysMatch(
  ids: readonly ParticipantId[],
  record: Readonly<Record<ParticipantId, number>>,
  label: string,
): void {
  const idSet = new Set(ids);
  for (const key of Object.keys(record)) {
    if (!idSet.has(key)) {
      throw new LedgerError(
        LedgerErrorCode.exactUnknownParticipant,
        `${label} split has a value for ${key}, who is not a participant.`,
      );
    }
  }
}

/**
 * Hamilton / largest-remainder method on integer weights.
 * Each participant receives `floor(amount * weight / totalWeight)` and then
 * one extra minor unit, in descending fractional-part order, until the
 * original amount is exhausted. Ties break by participant id ascending.
 */
function allocateByWeights(
  amount: bigint,
  ids: readonly ParticipantId[],
  weights: ReadonlyMap<ParticipantId, bigint>,
): readonly Share[] {
  let totalWeight = 0n;
  for (const id of ids) {
    const weight = weights.get(id);
    if (weight === undefined || weight <= 0n) {
      throw new LedgerError(LedgerErrorCode.nonPositiveWeight, `Weight for ${id} must be positive.`);
    }
    totalWeight += weight;
  }

  const rows: { id: ParticipantId; base: bigint; frac: bigint }[] = [];
  let allocated = 0n;
  for (const id of ids) {
    const weight = weights.get(id);
    if (weight === undefined) {
      throw new LedgerError(LedgerErrorCode.internal, `Missing weight for ${id}.`);
    }
    const product = amount * weight;
    const base = product / totalWeight;
    const frac = product % totalWeight;
    rows.push({ id, base, frac });
    allocated += base;
  }

  const remainder = amount - allocated;
  if (remainder < 0n || remainder >= BigInt(ids.length)) {
    throw new LedgerError(
      LedgerErrorCode.internal,
      `Remainder ${remainder.toString(10)} is outside the largest-remainder bound.`,
    );
  }

  const winners = [...rows].sort((left, right) => {
    if (left.frac === right.frac) {
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    }
    return left.frac > right.frac ? -1 : 1;
  });

  const extra = new Set<ParticipantId>();
  const extraCount = Number(remainder);
  for (let index = 0; index < extraCount; index += 1) {
    const winner = winners[index];
    if (!winner) {
      throw new LedgerError(LedgerErrorCode.internal, "Ran out of participants while placing the remainder.");
    }
    extra.add(winner.id);
  }

  return rows.map((row) => ({
    participantId: row.id,
    amount: minor(row.base + (extra.has(row.id) ? 1n : 0n)),
  }));
}
