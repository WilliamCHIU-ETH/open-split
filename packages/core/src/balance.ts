import type { ParticipantId, SplitSpec } from "./allocate.ts";
import { sumMinor, ZERO_MINOR, type Minor } from "./money.ts";
import type { Transfer } from "./settle.ts";
import { summarizeMemberBalances } from "./summary.ts";

export interface Expense {
  readonly payerId: ParticipantId;
  /** Positive minor units in the group's default currency (converted via convertMinor when needed). */
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
   * Zero: settled for the ledger entries that were passed in.
   */
  readonly net: Minor;
}

/**
 * Net each person across expenses and recorded settlements.
 * Settlement payers increase their net and receivers decrease theirs.
 * The nets sum to zero and results are in lexicographic participant-id order.
 */
export function computeBalances(
  expenses: readonly Expense[],
  settlements: readonly Transfer[] = [],
): readonly NetBalance[] {
  return summarizeMemberBalances(expenses, settlements).map(({ participantId, net }) => ({ participantId, net }));
}

export function balancesSum(balances: readonly NetBalance[]): Minor {
  if (balances.length === 0) return ZERO_MINOR;
  return sumMinor(balances.map((balance) => balance.net));
}
