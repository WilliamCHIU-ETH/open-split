import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allocate, minor, toMinorUnits, type Share } from "../src/index.ts";

const ids = ["ada", "bao", "chen", "dai", "erin", "fei"] as const;
const idArb = fc.constantFrom(...ids);
const participantsArb = fc.uniqueArray(idArb, { minLength: 1, maxLength: ids.length });
const unitsArb = fc.bigInt({ min: 0n, max: 2_000_000n });

function basisPointsFor(ordered: readonly string[], cuts: readonly number[]): Record<string, number> {
  let extras = 10_000 - ordered.length;
  const parts: number[] = [];
  for (const cut of cuts) {
    const take = Math.min(Math.max(cut, 0), extras);
    parts.push(take);
    extras -= take;
  }
  parts.push(extras);
  const record: Record<string, number> = {};
  ordered.forEach((id, index) => {
    record[id] = (parts[index] ?? 0) + 1;
  });
  return record;
}

/**
 * Largest-remainder check that does not reimplement the winner order.
 * Every share is floor(total * weight / weightSum) or one minor unit more,
 * and those extra units are exactly the leftover. Their sum is the original total.
 */
function remainderWasConserved(
  totalUnits: bigint,
  weights: ReadonlyMap<string, bigint>,
  shares: readonly Share[],
): boolean {
  let weightSum = 0n;
  for (const weight of weights.values()) weightSum += weight;
  if (weightSum <= 0n || shares.length !== weights.size) return false;
  let floorSum = 0n;
  let extras = 0;
  let got = 0n;
  for (const share of shares) {
    const weight = weights.get(share.participantId);
    if (weight === undefined || weight <= 0n) return false;
    const floor = (totalUnits * weight) / weightSum;
    const units = toMinorUnits(share.amount);
    const extra = units - floor;
    if (extra !== 0n && extra !== 1n) return false;
    if (extra === 1n) extras += 1;
    floorSum += floor;
    got += units;
  }
  return got === totalUnits && floorSum + BigInt(extras) === totalUnits;
}

describe("shares and percentage rounding", () => {
  it("gives the leftover minor unit to the largest fractional share", () => {
    const shares = allocate({
      amount: minor(1001n),
      participantIds: ["c", "a", "b"],
      split: { type: "shares", weights: { a: 1, b: 1, c: 2 } },
    });
    expect(shares.map((share) => [share.participantId, toMinorUnits(share.amount)])).toEqual([
      ["a", 250n],
      ["b", 250n],
      ["c", 501n],
    ]);
  });

  it("conserves a percentage that does not divide the amount", () => {
    const shares = allocate({
      amount: minor(10n),
      participantIds: ["a", "b"],
      split: { type: "percentage", basisPoints: { a: 3333, b: 6667 } },
    });
    expect(shares.map((share) => [share.participantId, toMinorUnits(share.amount)])).toEqual([
      ["a", 3n],
      ["b", 7n],
    ]);
  });

  it("keeps share weights from creating or dropping a minor unit", () => {
    fc.assert(
      fc.property(
        participantsArb,
        unitsArb,
        fc.array(fc.integer({ min: 1, max: 40 }), { minLength: ids.length, maxLength: ids.length }),
        (participants, totalUnits, weightList) => {
          const ordered = [...participants].sort();
          const weights = Object.fromEntries(ordered.map((id, index) => [id, weightList[index] ?? 1]));
          const shares = allocate({
            amount: minor(totalUnits),
            participantIds: ordered,
            split: { type: "shares", weights },
          });
          expect(
            remainderWasConserved(
              totalUnits,
              new Map(Object.entries(weights).map(([id, weight]) => [id, BigInt(weight)])),
              shares,
            ),
          ).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps percentage basis points from creating or dropping a minor unit", () => {
    fc.assert(
      fc.property(
        participantsArb,
        unitsArb,
        fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: ids.length, maxLength: ids.length }),
        (participants, totalUnits, cuts) => {
          const ordered = [...participants].sort();
          const basisPoints = basisPointsFor(ordered, cuts.slice(0, Math.max(ordered.length - 1, 0)));
          const shares = allocate({
            amount: minor(totalUnits),
            participantIds: ordered,
            split: { type: "percentage", basisPoints },
          });
          expect(
            remainderWasConserved(
              totalUnits,
              new Map(Object.entries(basisPoints).map(([id, points]) => [id, BigInt(points)])),
              shares,
            ),
          ).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("matches an equal split when every share weight is 1", () => {
    fc.assert(
      fc.property(participantsArb, unitsArb, (participants, totalUnits) => {
        const ordered = [...participants].sort();
        const weights = Object.fromEntries(ordered.map((id) => [id, 1]));
        const byShares = allocate({
          amount: minor(totalUnits),
          participantIds: ordered,
          split: { type: "shares", weights },
        });
        const byEqual = allocate({
          amount: minor(totalUnits),
          participantIds: ordered,
          split: { type: "equal" },
        });
        expect(byShares).toEqual(byEqual);
      }),
      { numRuns: 100 },
    );
  });
});
