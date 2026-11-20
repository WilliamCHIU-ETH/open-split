import { describe, expect, it } from "vitest";
import {
  LedgerError,
  LedgerErrorCode,
  allocate,
  applyTransfers,
  balancesSum,
  computeBalances,
  minor,
  settledToZero,
  simplifyDebts,
  toMinorUnits,
  transferBound,
} from "../src/index.ts";

describe("allocate", () => {
  it("gives the leftover minor unit to the earliest id", () => {
    const shares = allocate({
      amount: minor(1000n),
      participantIds: ["c", "a", "b"],
      split: { type: "equal" },
    });
    expect(shares.map((share) => [share.participantId, toMinorUnits(share.amount)])).toEqual([
      ["a", 334n],
      ["b", 333n],
      ["c", 333n],
    ]);
  });

  it("rejects a percentage that is not 10000 basis points", () => {
    expect(() =>
      allocate({
        amount: minor(100n),
        participantIds: ["a", "b"],
        split: { type: "percentage", basisPoints: { a: 5000, b: 4000 } },
      }),
    ).toThrow(LedgerError);
  });

  it("rejects an exact split that does not add up", () => {
    try {
      allocate({
        amount: minor(10n),
        participantIds: ["a", "b"],
        split: { type: "exact", amounts: { a: minor(4n), b: minor(4n) } },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe(LedgerErrorCode.exactMismatch);
    }
  });
});

describe("balances and settlement", () => {
  it("splits 3000 JPY equally across the five people who ate", () => {
    const eaters = ["a2", "a3", "a4", "a5", "me"];
    const balances = computeBalances([
      {
        payerId: "me",
        amount: minor(3000n),
        participantIds: eaters,
        split: { type: "equal" },
      },
    ]);
    expect(toMinorUnits(balancesSum(balances))).toBe(0n);
    expect(balances.find((row) => row.participantId === "me")?.net).toEqual(minor(2400n));
    expect(balances.filter((row) => row.participantId !== "me").every((row) => row.net === minor(-600n))).toBe(
      true,
    );

    const transfers = simplifyDebts(balances);
    expect(transfers).toHaveLength(4);
    expect(transfers.length).toBeLessThanOrEqual(transferBound(balances.length));
    expect(transfers.every((transfer) => transfer.toId === "me" && transfer.amount === minor(600n))).toBe(
      true,
    );
    expect(settledToZero(applyTransfers(balances, transfers))).toBe(true);
  });

  it("clears a hand-worked three-person ledger", () => {
    const balances = [
      { participantId: "a", net: minor(500n) },
      { participantId: "b", net: minor(-200n) },
      { participantId: "c", net: minor(-300n) },
    ];
    const transfers = simplifyDebts(balances);
    expect(transfers).toEqual([
      { fromId: "c", toId: "a", amount: minor(300n) },
      { fromId: "b", toId: "a", amount: minor(200n) },
    ]);
    expect(settledToZero(applyTransfers(balances, transfers))).toBe(true);
  });

  it("refuses to simplify a ledger that does not conserve money", () => {
    expect(() => simplifyDebts([{ participantId: "a", net: minor(1n) }])).toThrow(LedgerError);
  });
});
