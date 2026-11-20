import fc from "fast-check";
import { minor, type Expense, type Minor } from "../src/index.ts";

const ids = ["ada", "bao", "chen", "dai", "erin", "fei"] as const;
const idArb = fc.constantFrom(...ids);
const participantsArb = fc.uniqueArray(idArb, { minLength: 1, maxLength: ids.length });
const amountArb = fc.bigInt({ min: 0n, max: 2_000_000n });

function basisPointsArb(ordered: readonly string[]): fc.Arbitrary<Record<string, number>> {
  const count = ordered.length;
  const cuts = Math.max(count - 1, 0);
  return fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: cuts, maxLength: cuts }).map((raw) => {
    let extras = 10_000 - count;
    const parts: number[] = [];
    for (const cut of raw) {
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
  });
}

function exactArb(amount: bigint, ordered: readonly string[]): fc.Arbitrary<Record<string, Minor>> {
  const count = ordered.length;
  const only = ordered[0];
  if (count === 1 && only) return fc.constant({ [only]: minor(amount) });
  return fc.array(fc.bigInt({ min: 0n, max: amount }), { minLength: count - 1, maxLength: count - 1 }).map((cuts) => {
    let remaining = amount;
    const parts: bigint[] = [];
    for (const cut of cuts) {
      const take = cut > remaining ? remaining : cut;
      parts.push(take);
      remaining -= take;
    }
    parts.push(remaining);
    const record: Record<string, Minor> = {};
    ordered.forEach((id, index) => {
      record[id] = minor(parts[index] ?? 0n);
    });
    return record;
  });
}

export const expenseArb: fc.Arbitrary<Expense> = fc
  .tuple(idArb, participantsArb, amountArb, fc.constantFrom("equal", "shares", "percentage", "exact"))
  .chain(([payerId, participants, amount, mode]): fc.Arbitrary<Expense> => {
    const ordered = [...participants].sort();
    const base = { payerId, amount: minor(amount), participantIds: ordered };
    if (mode === "equal") return fc.constant({ ...base, split: { type: "equal" as const } });
    if (mode === "shares") {
      return fc
        .array(fc.integer({ min: 1, max: 40 }), { minLength: ordered.length, maxLength: ordered.length })
        .map((weights) => ({
          ...base,
          split: {
            type: "shares" as const,
            weights: Object.fromEntries(ordered.map((id, index) => [id, weights[index] ?? 1])),
          },
        }));
    }
    if (mode === "percentage") {
      return basisPointsArb(ordered).map((basisPoints) => ({
        ...base,
        split: { type: "percentage" as const, basisPoints },
      }));
    }
    return exactArb(amount, ordered).map((amounts) => ({
      ...base,
      split: { type: "exact" as const, amounts },
    }));
  });
