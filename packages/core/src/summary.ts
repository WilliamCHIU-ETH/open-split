import { allocate, type ParticipantId } from "./allocate.ts";
import type { Expense } from "./balance.ts";
import { LedgerError, LedgerErrorCode } from "./errors.ts";
import { addMinor, compareMinor, minor, sumMinor, toMinorUnits, ZERO_MINOR, type Minor } from "./money.ts";
import type { Transfer } from "./settle.ts";

export interface MemberSummary {
  readonly participantId: ParticipantId;
  readonly paid: Minor;
  readonly share: Minor;
}

export interface CategorizedExpense extends Expense {
  readonly category?: string | null;
}

export interface CategorySummary {
  readonly category: string | null;
  readonly total: Minor;
  readonly count: number;
}

/** Returns the category's whole-number percentage, rounded down, or 0n for zero total spending. */
export function categoryPercent(total: Minor, totalSpent: Minor): bigint {
  const categoryUnits = toMinorUnits(total);
  const spentUnits = toMinorUnits(totalSpent);
  if (categoryUnits < 0n || spentUnits < 0n) {
    throw new LedgerError(LedgerErrorCode.negativeAmount, "Category total and total spending must be non-negative.");
  }
  return spentUnits === 0n ? 0n : (categoryUnits * 100n) / spentUnits;
}

export function summarizeMembers(expenses: readonly Expense[]): readonly MemberSummary[] {
  return summarizeMemberBalances(expenses, []).map(({ participantId, paid, share }) => ({ participantId, paid, share }));
}

export interface MemberBalanceSummary extends MemberSummary {
  readonly settledPaid: Minor;
  readonly settledReceived: Minor;
  readonly net: Minor;
}

export function summarizeMemberBalances(
  expenses: readonly Expense[],
  settlements: readonly Transfer[],
): readonly MemberBalanceSummary[] {
  const members = new Map<ParticipantId, {
    paid: Minor;
    share: Minor;
    settledPaid: Minor;
    settledReceived: Minor;
  }>();

  function totalsFor(participantId: ParticipantId) {
    const existing = members.get(participantId);
    if (existing) return existing;
    const totals = { paid: ZERO_MINOR, share: ZERO_MINOR, settledPaid: ZERO_MINOR, settledReceived: ZERO_MINOR };
    members.set(participantId, totals);
    return totals;
  }

  for (const expense of expenses) {
    if (expense.payerId.length === 0) {
      throw new LedgerError(LedgerErrorCode.invalidParticipant, "Payer id must be non-empty.");
    }
    const shares = allocate(expense);
    const payer = totalsFor(expense.payerId);
    payer.paid = addMinor(payer.paid, expense.amount);
    for (const share of shares) {
      const member = totalsFor(share.participantId);
      member.share = addMinor(member.share, share.amount);
    }
  }

  for (const { fromId, toId, amount } of settlements) {
    if (fromId.length === 0 || toId.length === 0) {
      throw new LedgerError(LedgerErrorCode.invalidParticipant, "Settlement ids must be non-empty.");
    }
    if (fromId === toId) {
      throw new LedgerError(LedgerErrorCode.duplicateParticipant, "Settlement parties must be distinct.");
    }
    if (amount <= 0n) {
      throw new LedgerError(LedgerErrorCode.nonPositiveAmount, "Settlement amount must be positive.");
    }
    const payer = totalsFor(fromId);
    const receiver = totalsFor(toId);
    payer.settledPaid = addMinor(payer.settledPaid, amount);
    receiver.settledReceived = addMinor(receiver.settledReceived, amount);
  }

  return [...members.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([participantId, totals]) => ({
      participantId,
      ...totals,
      net: minor(totals.paid - totals.share + totals.settledPaid - totals.settledReceived),
    }));
}

export function summarizeLedger({ expenses, settlements }: {
  readonly expenses: readonly CategorizedExpense[];
  readonly settlements: readonly Transfer[];
}) {
  const members = summarizeMemberBalances(expenses, settlements);
  const categories = summarizeCategories(expenses);
  return { members, categories, totalSpent: sumMinor(expenses.map(({ amount }) => amount)) };
}

/** Missing and null categories share one bucket, last among equal totals. */
export function summarizeCategories(expenses: readonly CategorizedExpense[]): readonly CategorySummary[] {
  const categories = new Map<string | null, CategorySummary>();
  for (const expense of expenses) {
    const category = expense.category ?? null;
    const current = categories.get(category);
    categories.set(category, {
      category,
      total: addMinor(current?.total ?? ZERO_MINOR, expense.amount),
      count: (current?.count ?? 0) + 1,
    });
  }

  return [...categories.values()].sort((left, right) => {
    const byTotal = compareMinor(right.total, left.total);
    if (byTotal !== 0) return byTotal;
    if (left.category === right.category) return 0;
    if (left.category === null) return 1;
    if (right.category === null) return -1;
    return left.category < right.category ? -1 : left.category > right.category ? 1 : 0;
  });
}
