import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  LedgerError,
  LedgerErrorCode,
  balancesSum,
  categoryPercent,
  computeBalances,
  minor,
  settledToZero,
  simplifyDebts,
  summarizeCategories,
  summarizeLedger,
  summarizeMembers,
  sumMinor,
  toMinorUnits,
  transferBound,
  type Expense,
} from "../src/index.ts";
import { expenseArb } from "./expense-arbitrary.ts";

const expensesArb = fc.array(expenseArb, { maxLength: 8 });
const settlementPartyArb = fc.constantFrom("ada", "bao", "chen", "guest");
const settlementPartiesArb = fc.tuple(settlementPartyArb, settlementPartyArb)
  .filter(([fromId, toId]) => fromId !== toId);
const settlementsArb = fc.array(
  fc.tuple(
    settlementPartiesArb,
    fc.bigInt({ min: 1n, max: 2_000_000n }),
  ).map(([[fromId, toId], amount]) => ({
    fromId,
    toId,
    amount: minor(amount),
  })),
  { maxLength: 8 },
);
const categorizedExpensesArb = fc.array(
  fc.tuple(expenseArb, fc.constantFrom("food", "travel", null, undefined)).map(([expense, category]) =>
    category === undefined ? expense : { ...expense, category },
  ),
  { maxLength: 8 },
);

describe("settle-up invariants", () => {
  it("records a bounded set of suggested transfers and settles everyone", () => {
    fc.assert(
      fc.property(expensesArb, (expenses) => {
        const balances = computeBalances(expenses);
        const transfers = simplifyDebts(balances);
        expect(transfers.length).toBeLessThanOrEqual(transferBound(balances.length));
        expect(settledToZero(computeBalances(expenses, transfers))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("conserves balances with arbitrary recorded settlements", () => {
    fc.assert(
      fc.property(expensesArb, settlementsArb, (expenses, settlements) => {
        expect(balancesSum(computeBalances(expenses, settlements))).toBe(0n);
      }),
      { numRuns: 100 },
    );
  });

  it("reconciles member totals with balances before and after settlements", () => {
    fc.assert(
      fc.property(expensesArb, settlementsArb, (expenses, settlements) => {
        const summaries = summarizeMembers(expenses);
        expect(summaries.map(({ participantId, paid, share }) => ({ participantId, net: paid - share })))
          .toEqual(computeBalances(expenses));

        const members = new Map(summaries.map((summary) => [summary.participantId, summary]));
        for (const { participantId, net } of computeBalances(expenses, settlements)) {
          const member = members.get(participantId);
          let expected = (member?.paid ?? 0n) - (member?.share ?? 0n);
          for (const { fromId, toId, amount } of settlements) {
            if (fromId === participantId) expected += amount;
            if (toId === participantId) expected -= amount;
          }
          expect(net).toBe(expected);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("reconciles ledger summaries with balances and category totals", () => {
    fc.assert(
      fc.property(categorizedExpensesArb, settlementsArb, (expenses, settlements) => {
        const { members, categories, totalSpent } = summarizeLedger({ expenses, settlements });
        for (const { participantId, paid, share, settledPaid, settledReceived, net } of members) {
          expect(settledPaid).toBe(sumMinor(settlements.filter((row) => row.fromId === participantId).map((row) => row.amount)));
          expect(settledReceived).toBe(sumMinor(settlements.filter((row) => row.toId === participantId).map((row) => row.amount)));
          expect(net).toBe(paid - share + settledPaid - settledReceived);
        }
        expect(members.map(({ participantId, net }) => ({ participantId, net })))
          .toEqual(computeBalances(expenses, settlements));
        expect(totalSpent).toBe(sumMinor(categories.map(({ total }) => total)));
      }),
      { numRuns: 100 },
    );
  });

  it("floors each category percentage within zero and one hundred", () => {
    fc.assert(
      fc.property(categorizedExpensesArb, (expenses) => {
        const { categories, totalSpent } = summarizeLedger({ expenses, settlements: [] });
        const spentUnits = toMinorUnits(totalSpent);
        for (const { total } of categories) {
          const percent = categoryPercent(total, totalSpent);
          expect(percent).toBeGreaterThanOrEqual(0n);
          expect(percent).toBeLessThanOrEqual(100n);
          if (spentUnits > 0n) {
            const scaledTotal = toMinorUnits(total) * 100n;
            expect(percent * spentUnits).toBeLessThanOrEqual(scaledTotal);
            expect(scaledTotal).toBeLessThan((percent + 1n) * spentUnits);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("handles zero spending and a category covering all spending", () => {
    fc.assert(
      fc.property(categorizedExpensesArb, (expenses) => {
        const { totalSpent } = summarizeLedger({ expenses, settlements: [] });
        expect(categoryPercent(totalSpent, minor(0n))).toBe(0n);
        expect(categoryPercent(totalSpent, totalSpent)).toBe(totalSpent === 0n ? 0n : 100n);
      }),
      { numRuns: 100 },
    );
  });

  it("accounts for every expense in the category totals", () => {
    fc.assert(
      fc.property(categorizedExpensesArb, (expenses) => {
        const categories = summarizeCategories(expenses);
        expect(categories.reduce((sum, row) => sum + row.total, 0n))
          .toBe(expenses.reduce((sum, expense) => sum + toMinorUnits(expense.amount), 0n));
        expect(categories.reduce((sum, row) => sum + row.count, 0)).toBe(expenses.length);
      }),
      { numRuns: 100 },
    );
  });

  it("clears the remaining debt after a partial settlement", () => {
    fc.assert(
      fc.property(expensesArb, (expenses) => {
        const [first] = simplifyDebts(computeBalances(expenses));
        fc.pre(first !== undefined && first.amount > 1n);
        const recorded = [{ ...first, amount: minor(toMinorUnits(first.amount) / 2n) }];
        const remaining = computeBalances(expenses, recorded);
        expect(settledToZero(remaining)).toBe(false);
        const transfers = simplifyDebts(remaining);
        expect(settledToZero(computeBalances(expenses, [...recorded, ...transfers]))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

describe("settle-up examples", () => {
  it.each([[-1n, 0n], [1n, -1n]] as const)("rejects negative category percentage inputs (%s, %s)", (total, totalSpent) => {
    const calculate = () => categoryPercent(minor(total), minor(totalSpent));
    expect(calculate).toThrow(LedgerError);
    expect(calculate).toThrow(expect.objectContaining({ code: LedgerErrorCode.negativeAmount }));
  });

  const expense: Expense = {
    payerId: "chen",
    amount: minor(5n),
    participantIds: ["bao", "ada"],
    split: { type: "equal" },
  };

  it("includes settlement-only parties in sorted balances", () => {
    expect(computeBalances([expense], [
      { fromId: "zoe", toId: "guest", amount: minor(7n) },
      { fromId: "ada", toId: "chen", amount: minor(2n) },
    ])).toEqual([
      { participantId: "ada", net: -1n },
      { participantId: "bao", net: -2n },
      { participantId: "chen", net: 3n },
      { participantId: "guest", net: -7n },
      { participantId: "zoe", net: 7n },
    ]);
  });

  it.each([
    ["", "bao", 1n, LedgerErrorCode.invalidParticipant],
    ["ada", "", 1n, LedgerErrorCode.invalidParticipant],
    ["ada", "ada", 1n, LedgerErrorCode.duplicateParticipant],
    ["ada", "bao", 0n, LedgerErrorCode.nonPositiveAmount],
    ["ada", "bao", -1n, LedgerErrorCode.nonPositiveAmount],
  ] as const)("rejects an invalid settlement (%s, %s, %s)", (fromId, toId, amount, code) => {
    const record = () => computeBalances([], [{ fromId, toId, amount: minor(amount) }]);
    expect(record).toThrow(LedgerError);
    expect(record).toThrow(expect.objectContaining({ code }));
  });

  it("reports the payer and allocated shares separately", () => {
    expect(summarizeMembers([expense, {
      ...expense,
      payerId: "ada",
      split: { type: "exact", amounts: { ada: minor(1n), bao: minor(4n) } },
    }])).toEqual([
      { participantId: "ada", paid: 5n, share: 4n },
      { participantId: "bao", paid: 0n, share: 6n },
      { participantId: "chen", paid: 5n, share: 0n },
    ]);
  });

  it("sorts category totals and merges missing and null categories", () => {
    expect(summarizeCategories([
      { ...expense, category: "food" },
      expense,
      { ...expense, category: "travel", amount: minor(10n) },
      { ...expense, category: null },
      { ...expense, category: "food" },
      { ...expense, category: "books" },
    ])).toEqual([
      { category: "food", total: 10n, count: 2 },
      { category: "travel", total: 10n, count: 1 },
      { category: null, total: 10n, count: 2 },
      { category: "books", total: 5n, count: 1 },
    ]);
  });
});
