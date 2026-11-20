import { describe, expect, it } from "vitest";
import { LedgerError, minor, minorFromSafeInteger, sumMinor, toMinorUnits } from "../src/index.ts";

describe("minor units", () => {
  it("converts only safe integers", () => {
    expect(toMinorUnits(minorFromSafeInteger(3000))).toBe(3000n);
    expect(toMinorUnits(minorFromSafeInteger(-20))).toBe(-20n);
    expect(() => minorFromSafeInteger(1.5)).toThrow(LedgerError);
    expect(() => minorFromSafeInteger(Number.NaN)).toThrow(LedgerError);
  });

  it("adds without floating point", () => {
    expect(toMinorUnits(sumMinor([minor(1n), minor(2n), minor(3n)]))).toBe(6n);
    expect(toMinorUnits(sumMinor([]))).toBe(0n);
  });
});
