import { allocate, type ParticipantId, type SplitSpec } from "./allocate.ts";
import { LedgerError, LedgerErrorCode } from "./errors.ts";
import { minor, sumMinor, toMinorUnits, ZERO_MINOR, type Minor } from "./money.ts";

export interface Expense {
  readonly payerId: ParticipantId;
  /** Positive minor units in the expense currency. Conversion belongs to a later slice, still inside core. */
  readonly amount: Minor;
  /** People who share the cost. The payer may be absent; that means they paid and owe none of it. */
  readonly participantIds: readonly ParticipantId[];
  readonly split: SplitSpec;
}

export interface NetBalance {
  readonly participantId: ParticipantId;
  /**
   * Positive: the group owes this person.
   * Negative: this person owes the group.
   * Zero: settled for the expenses that were passed in.
   */
  readonly net: Minor;
}

/**
 * Net each person across expenses.
 * `net = amount paid − amount allocated`.
 * For every valid expense the shares sum to the amount, so the nets sum to zero.
 * People who never pay and never share are omitted; their net is implicitly zero.
 * Results are in lexicographic participant-id order.
 */
export function computeBalances(expenses: readonly Expense[]): readonly NetBalance[] {
  const nets = new Map<ParticipantId, bigint>();

  for (const expense of expenses) {
    if (expense.payerId.length === 0) {
      throw new LedgerError(LedgerErrorCode.invalidParticipant, "Payer id must be non-empty.");
    }
    const shares = allocate({
      amount: expense.amount,
      participantIds: expense.participantIds,
      split: expense.split,
    });
    const paid = nets.get(expense.payerId) ?? 0n;
    nets.set(expense.payerId, paid + toMinorUnits(expense.amount));
    for (const share of shares) {
      const current = nets.get(share.participantId) ?? 0n;
      nets.set(share.participantId, current - toMinorUnits(share.amount));
    }
  }

  return [...nets.keys()]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((participantId) => ({
      participantId,
      net: minor(nets.get(participantId) ?? 0n),
    }));
}

export function balancesSum(balances: readonly NetBalance[]): Minor {
  if (balances.length === 0) return ZERO_MINOR;
  return sumMinor(balances.map((balance) => balance.net));
}
