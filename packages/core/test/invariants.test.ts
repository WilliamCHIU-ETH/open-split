import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allocate,
  applyTransfers,
  balancesSum,
  computeBalances,
  settledToZero,
  simplifyDebts,
  toMinorUnits,
  transferBound,
} from "../src/index.ts";
import { expenseArb } from "./expense-arbitrary.ts";

describe("ledger invariants", () => {
  it("does not create or lose a minor unit when rounding", () => {
    fc.assert(
      fc.property(expenseArb, (expense) => {
        const shares = allocate({
          amount: expense.amount,
          participantIds: expense.participantIds,
          split: expense.split,
        });
        const total = shares.reduce((sum, share) => sum + toMinorUnits(share.amount), 0n);
        expect(total).toBe(toMinorUnits(expense.amount));
        expect(shares.every((share) => toMinorUnits(share.amount) >= 0n)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("keeps balances summing to zero", () => {
    fc.assert(
      fc.property(fc.array(expenseArb, { minLength: 0, maxLength: 8 }), (expenses) => {
        expect(toMinorUnits(balancesSum(computeBalances(expenses)))).toBe(0n);
      }),
      { numRuns: 100 },
    );
  });

  it("settles everyone to zero with at most participants − 1 transfers", () => {
    fc.assert(
      fc.property(fc.array(expenseArb, { minLength: 0, maxLength: 8 }), (expenses) => {
        const balances = computeBalances(expenses);
        const transfers = simplifyDebts(balances);
        expect(transfers.length).toBeLessThanOrEqual(transferBound(balances.length));
        expect(settledToZero(applyTransfers(balances, transfers))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
