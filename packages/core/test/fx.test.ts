import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  allocateConvertedExpense,
  applyTransfers,
  balancesSum,
  computeBalances,
  convertMinor,
  currencyExponent,
  formatMinorByCurrency,
  formatMinorDecimal,
  isSupportedCurrency,
  LedgerError,
  LedgerErrorCode,
  minor,
  parseMajorToMinor,
  parseRateRatio,
  settledToZero,
  simplifyDebts,
  SUPPORTED_CURRENCIES,
  toMinorUnits,
  transferBound,
} from "../src/index.ts";
import { expenseArb } from "./expense-arbitrary.ts";

describe("ISO 4217 currency helpers", () => {
  it("knows standard exponents and rejects unknown currency codes", () => {
    expect(isSupportedCurrency("TWD")).toBe(true);
    expect(isSupportedCurrency("JPY")).toBe(true);
    expect(isSupportedCurrency("KWD")).toBe(true);
    expect(isSupportedCurrency("XYZ")).toBe(false);

    expect(currencyExponent("TWD")).toBe(2);
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KRW")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);

    expect(() => currencyExponent("XXX")).toThrowError(LedgerError);
    try {
      currencyExponent("XXX");
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe(LedgerErrorCode.unknownCurrency);
    }
  });

  it("formats and parses major decimal units cleanly without floating point", () => {
    expect(toMinorUnits(parseMajorToMinor("12.50", "USD"))).toBe(1250n);
    expect(toMinorUnits(parseMajorToMinor("1,234.5", "TWD"))).toBe(123450n);
    expect(toMinorUnits(parseMajorToMinor("1000", "JPY"))).toBe(1000n);
    expect(toMinorUnits(parseMajorToMinor("1.234", "KWD"))).toBe(1234n);

    expect(formatMinorDecimal(minor(1250n), "USD")).toBe("12.50");
    expect(formatMinorDecimal(minor(-5n), "USD")).toBe("-0.05");
    expect(formatMinorDecimal(minor(1000n), "JPY")).toBe("1000");
    expect(formatMinorDecimal(minor(1234n), "KWD")).toBe("1.234");

    expect(formatMinorByCurrency(minor(123450n), "TWD")).toBe("1,234.50 TWD");
    expect(formatMinorByCurrency(minor(-1250n), "USD")).toBe("−12.50 USD");
    expect(formatMinorByCurrency(minor(1500n), "JPY")).toBe("1,500 JPY");

    expect(() => parseMajorToMinor("12.345", "USD")).toThrowError(LedgerError);
    expect(() => parseMajorToMinor("10.5", "JPY")).toThrowError(LedgerError);
    expect(() => parseMajorToMinor("-10", "TWD")).toThrowError(LedgerError);
  });

  it("parses and reduces decimal or fraction FX rates", () => {
    expect(parseRateRatio("31.5")).toEqual({ numerator: 63, denominator: 2 });
    expect(parseRateRatio("0.21")).toEqual({ numerator: 21, denominator: 100 });
    expect(parseRateRatio("315/10")).toEqual({ numerator: 63, denominator: 2 });
    expect(parseRateRatio("150")).toEqual({ numerator: 150, denominator: 1 });

    expect(() => parseRateRatio("0")).toThrowError(LedgerError);
    expect(() => parseRateRatio("10/0")).toThrowError(LedgerError);
    expect(() => parseRateRatio("-1.5")).toThrowError(LedgerError);
    expect(() => parseRateRatio("1.0000000001")).toThrowError(LedgerError);
  });
});

describe("convertMinor", () => {
  it("converts across currencies with different ISO 4217 exponents using half-up rounding", () => {
    // 1000 JPY (exp 0) * 0.21 TWD/JPY = 210.00 TWD = 21000 minor
    expect(
      toMinorUnits(
        convertMinor({
          amount: minor(1000n),
          fromCurrency: "JPY",
          toCurrency: "TWD",
          fxNumerator: 21,
          fxDenominator: 100,
        }),
      ),
    ).toBe(21000n);

    // 10.00 USD (1000 minor, exp 2) * 150 JPY/USD = 1500 JPY (exp 0)
    expect(
      toMinorUnits(
        convertMinor({
          amount: minor(1000n),
          fromCurrency: "USD",
          toCurrency: "JPY",
          fxNumerator: 150,
          fxDenominator: 1,
        }),
      ),
    ).toBe(1500n);

    // 1.000 KWD (1000 minor, exp 3) * 3.25 USD/KWD = 3.25 USD = 325 minor (exp 2)
    expect(
      toMinorUnits(
        convertMinor({
          amount: minor(1000n),
          fromCurrency: "KWD",
          toCurrency: "USD",
          fxNumerator: 325,
          fxDenominator: 100,
        }),
      ),
    ).toBe(325n);

    // Exact 0.5 minor unit rounds half-up: 1 JPY * (1/200) TWD/JPY = 0.005 TWD = 0.5 minor -> 1
    expect(
      toMinorUnits(
        convertMinor({
          amount: minor(1n),
          fromCurrency: "JPY",
          toCurrency: "TWD",
          fxNumerator: 1,
          fxDenominator: 200,
        }),
      ),
    ).toBe(1n);

    // Slightly below 0.5 rounds down: 100 / 201 < 0.5 -> 0
    expect(
      toMinorUnits(
        convertMinor({
          amount: minor(1n),
          fromCurrency: "JPY",
          toCurrency: "TWD",
          fxNumerator: 1,
          fxDenominator: 201,
        }),
      ),
    ).toBe(0n);
  });

  it("enforces rate presence rules for same vs foreign currency", () => {
    expect(
      toMinorUnits(
        convertMinor({
          amount: minor(500n),
          fromCurrency: "TWD",
          toCurrency: "TWD",
          fxNumerator: null,
          fxDenominator: null,
        }),
      ),
    ).toBe(500n);

    expect(() =>
      convertMinor({
        amount: minor(500n),
        fromCurrency: "TWD",
        toCurrency: "TWD",
        fxNumerator: 1,
        fxDenominator: 1,
      }),
    ).toThrowError(LedgerError);

    expect(() =>
      convertMinor({
        amount: minor(500n),
        fromCurrency: "USD",
        toCurrency: "TWD",
        fxNumerator: null,
        fxDenominator: null,
      }),
    ).toThrowError(LedgerError);

    expect(() =>
      convertMinor({
        amount: minor(-1n),
        fromCurrency: "USD",
        toCurrency: "TWD",
        fxNumerator: 31,
        fxDenominator: 1,
      }),
    ).toThrowError(LedgerError);
  });
});

describe("allocateConvertedExpense and FX ledger invariants", () => {
  it("proportionally scales exact splits and preserves zero-share participants", () => {
    const result = allocateConvertedExpense({
      amount: minor(1000n), // 10.00 USD
      fromCurrency: "USD",
      toCurrency: "TWD",
      fxNumerator: 63,
      fxDenominator: 2, // 31.5 -> 315.00 TWD = 31500 minor
      participantIds: ["alice", "bob", "chao"],
      split: {
        type: "exact",
        amounts: { alice: minor(700n), bob: minor(300n), chao: minor(0n) },
      },
    });
    expect(toMinorUnits(result.convertedAmount)).toBe(31500n);
    expect(result.originalShares.map((s) => toMinorUnits(s.amount))).toEqual([700n, 300n, 0n]);
    expect(result.convertedShares.map((s) => toMinorUnits(s.amount))).toEqual([22050n, 9450n, 0n]);
  });

  it("conserves converted minor units across all split types and mixed currencies", () => {
    const currencyArb = fc.constantFrom(...SUPPORTED_CURRENCIES);
    const rateArb = fc.integer({ min: 1, max: 50_000 }).chain((num) =>
      fc.integer({ min: 1, max: 1000 }).map((den) => ({ num, den })),
    );

    fc.assert(
      fc.property(
        currencyArb,
        currencyArb,
        rateArb,
        fc.array(expenseArb, { minLength: 1, maxLength: 6 }),
        (groupCurrency, foreignCurrency, rate, expenses) => {
          const convertedLedgerExpenses = expenses.map((expense) => {
            const fromCurrency = foreignCurrency;
            const useFx = fromCurrency !== groupCurrency;
            const allocated = allocateConvertedExpense({
              amount: expense.amount,
              fromCurrency,
              toCurrency: groupCurrency,
              fxNumerator: useFx ? rate.num : null,
              fxDenominator: useFx ? rate.den : null,
              participantIds: expense.participantIds,
              split: expense.split,
            });
            const origTotal = allocated.originalShares.reduce((s, r) => s + toMinorUnits(r.amount), 0n);
            const convTotal = allocated.convertedShares.reduce((s, r) => s + toMinorUnits(r.amount), 0n);
            expect(origTotal).toBe(toMinorUnits(allocated.originalAmount));
            expect(convTotal).toBe(toMinorUnits(allocated.convertedAmount));
            expect(allocated.convertedShares.every((s) => toMinorUnits(s.amount) >= 0n)).toBe(true);

            return {
              payerId: expense.payerId,
              amount: allocated.convertedAmount,
              participantIds: expense.participantIds,
              split: {
                type: "exact" as const,
                amounts: Object.fromEntries(allocated.convertedShares.map((s) => [s.participantId, s.amount])),
              },
            };
          });

          const balances = computeBalances(convertedLedgerExpenses);
          expect(toMinorUnits(balancesSum(balances))).toBe(0n);
          const transfers = simplifyDebts(balances);
          expect(transfers.length).toBeLessThanOrEqual(transferBound(balances.length));
          expect(settledToZero(applyTransfers(balances, transfers))).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("round-trips formatMinorDecimal -> parseMajorToMinor", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPORTED_CURRENCIES),
        fc.bigInt({ min: 0n, max: 1_000_000_000n }),
        (currency, units) => {
          const m = minor(units);
          const text = formatMinorDecimal(m, currency);
          expect(toMinorUnits(parseMajorToMinor(text, currency))).toBe(units);
        },
      ),
      { numRuns: 100 },
    );
  });
});
