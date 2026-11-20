import type { ParticipantId } from "./allocate.ts";
import type { NetBalance } from "./balance.ts";
import { balancesSum } from "./balance.ts";
import { LedgerError, LedgerErrorCode } from "./errors.ts";
import { isZeroMinor, minor, toMinorUnits, type Minor } from "./money.ts";

export interface Transfer {
  /** Person whose net is negative (they owe). */
  readonly fromId: ParticipantId;
  /** Person whose net is positive (they are owed). */
  readonly toId: ParticipantId;
  readonly amount: Minor;
}

/**
 * Greedy debt simplification.
 * This is not a solver for the NP-hard minimum-transfer problem.
 * It does guarantee, when nets sum to zero:
 * - applying the transfers leaves every listed participant at zero
 * - the number of transfers is <= participants − 1
 *   (each transfer zeroes at least one remaining party)
 * Parties are matched largest-absolute-net first. Ties break by id ascending.
 */
export function simplifyDebts(balances: readonly NetBalance[]): readonly Transfer[] {
  const seen = new Set<ParticipantId>();
  let sum = 0n;
  const debtors: { id: ParticipantId; amount: bigint }[] = [];
  const creditors: { id: ParticipantId; amount: bigint }[] = [];

  for (const balance of balances) {
    if (balance.participantId.length === 0) {
      throw new LedgerError(LedgerErrorCode.invalidParticipant, "Participant id must be non-empty.");
    }
    if (seen.has(balance.participantId)) {
      throw new LedgerError(
        LedgerErrorCode.duplicateParticipant,
        `Duplicate balance for ${balance.participantId}.`,
      );
    }
    seen.add(balance.participantId);
    const net = toMinorUnits(balance.net);
    sum += net;
    if (net < 0n) debtors.push({ id: balance.participantId, amount: -net });
    else if (net > 0n) creditors.push({ id: balance.participantId, amount: net });
  }

  if (sum !== 0n) {
    throw new LedgerError(
      LedgerErrorCode.balancesNotConserved,
      `Balances sum to ${sum.toString(10)} minor units, expected 0. Refusing to simplify a ledger that creates or loses money.`,
    );
  }

  const byAmountDescThenId = (
    left: { id: ParticipantId; amount: bigint },
    right: { id: ParticipantId; amount: bigint },
  ): number => {
    if (left.amount === right.amount) {
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    }
    return left.amount > right.amount ? -1 : 1;
  };
  debtors.sort(byAmountDescThenId);
  creditors.sort(byAmountDescThenId);

  const transfers: Transfer[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    if (!debtor || !creditor) break;
    const amount = debtor.amount < creditor.amount ? debtor.amount : creditor.amount;
    if (amount <= 0n) {
      throw new LedgerError(LedgerErrorCode.internal, "Settlement produced a non-positive transfer.");
    }
    transfers.push({ fromId: debtor.id, toId: creditor.id, amount: minor(amount) });
    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount === 0n) debtorIndex += 1;
    if (creditor.amount === 0n) creditorIndex += 1;
  }

  return transfers;
}

/** Apply transfers to nets. A debtor's net moves toward zero by increasing; a creditor's decreases. */
export function applyTransfers(
  balances: readonly NetBalance[],
  transfers: readonly Transfer[],
): readonly NetBalance[] {
  const nets = new Map<ParticipantId, bigint>();
  for (const balance of balances) {
    if (nets.has(balance.participantId)) {
      throw new LedgerError(
        LedgerErrorCode.duplicateParticipant,
        `Duplicate balance for ${balance.participantId}.`,
      );
    }
    nets.set(balance.participantId, toMinorUnits(balance.net));
  }

  for (const transfer of transfers) {
    if (!nets.has(transfer.fromId) || !nets.has(transfer.toId)) {
      throw new LedgerError(
        LedgerErrorCode.unknownTransferParty,
        `Transfer ${transfer.fromId} → ${transfer.toId} names someone outside the balance vector.`,
      );
    }
    const from = nets.get(transfer.fromId);
    const to = nets.get(transfer.toId);
    if (from === undefined || to === undefined) {
      throw new LedgerError(LedgerErrorCode.internal, "Missing net while applying a transfer.");
    }
    const amount = toMinorUnits(transfer.amount);
    nets.set(transfer.fromId, from + amount);
    nets.set(transfer.toId, to - amount);
  }

  return [...nets.keys()]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((participantId) => ({
      participantId,
      net: minor(nets.get(participantId) ?? 0n),
    }));
}

export function settledToZero(balances: readonly NetBalance[]): boolean {
  return balances.every((balance) => isZeroMinor(balance.net));
}

/** Upper bound used by the settle-up invariant. Empty and single-person ledgers allow zero transfers. */
export function transferBound(participantCount: number): number {
  if (!Number.isSafeInteger(participantCount) || participantCount < 0) {
    throw new LedgerError(LedgerErrorCode.internal, "Participant count must be a non-negative integer.");
  }
  return participantCount === 0 ? 0 : participantCount - 1;
}

export function assertConserved(balances: readonly NetBalance[]): void {
  const sum = toMinorUnits(balancesSum(balances));
  if (sum !== 0n) {
    throw new LedgerError(
      LedgerErrorCode.balancesNotConserved,
      `Balances sum to ${sum.toString(10)} minor units, expected 0.`,
    );
  }
}
