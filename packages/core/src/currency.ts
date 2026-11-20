import { allocate, type ParticipantId, type Share, type SplitSpec } from "./allocate.ts";
import { LedgerError, LedgerErrorCode } from "./errors.ts";
import { minor, toMinorUnits, type Minor } from "./money.ts";

/**
 * Canonical ISO 4217 minor-unit exponents supported by the ledger.
 * Unknown currencies are rejected so conversions never guess a scale.
 */
export const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  TWD: 2,
  JPY: 0,
  USD: 2,
  EUR: 2,
  HKD: 2,
  SGD: 2,
  GBP: 2,
  CNY: 2,
  KRW: 0,
  AUD: 2,
  CAD: 2,
  CHF: 2,
  THB: 2,
  VND: 0,
  MYR: 2,
  PHP: 2,
  IDR: 2,
  INR: 2,
  NZD: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  JOD: 3,
};

export const SUPPORTED_CURRENCIES: readonly string[] = Object.keys(CURRENCY_EXPONENTS);

export interface FxRateRatio {
  readonly numerator: number;
  readonly denominator: number;
}

export interface ConvertMinorInput {
  readonly amount: Minor;
  readonly fromCurrency: string;
  readonly toCurrency: string;
  readonly fxNumerator: number | null;
  readonly fxDenominator: number | null;
}

export interface ConvertedExpenseAllocation {
  readonly originalAmount: Minor;
  readonly convertedAmount: Minor;
  readonly originalShares: readonly Share[];
  readonly convertedShares: readonly Share[];
}

export function isSupportedCurrency(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, code);
}

export function currencyExponent(code: string): number {
  const exp = CURRENCY_EXPONENTS[code];
  if (exp === undefined) {
    throw new LedgerError(LedgerErrorCode.unknownCurrency, `Unsupported ISO 4217 currency: ${code}.`);
  }
  return exp;
}

/**
 * Convert `amount` from `fromCurrency` minor units into `toCurrency` minor units
 * using an exact positive integer major-unit exchange rate (`1 from = num/den to`).
 * Rounding is half-up on bigint values; floating point is never used.
 */
export function convertMinor(input: ConvertMinorInput): Minor {
  const units = toMinorUnits(input.amount);
  if (units < 0n) {
    throw new LedgerError(LedgerErrorCode.negativeAmount, "Amount to convert must be >= 0 minor units.");
  }
  const fromExp = currencyExponent(input.fromCurrency);
  const toExp = currencyExponent(input.toCurrency);

  if (input.fromCurrency === input.toCurrency) {
    if (input.fxNumerator !== null || input.fxDenominator !== null) {
      throw new LedgerError(LedgerErrorCode.invalidRate, "Same-currency expenses cannot include an fxRate.");
    }
    return input.amount;
  }

  if (
    input.fxNumerator === null ||
    input.fxDenominator === null ||
    !Number.isSafeInteger(input.fxNumerator) ||
    !Number.isSafeInteger(input.fxDenominator) ||
    input.fxNumerator <= 0 ||
    input.fxDenominator <= 0
  ) {
    throw new LedgerError(
      LedgerErrorCode.invalidRate,
      "Foreign-currency expenses require positive safe integer fxNumerator and fxDenominator.",
    );
  }

  const numeratorScaled = units * BigInt(input.fxNumerator) * 10n ** BigInt(toExp);
  const denominatorScaled = BigInt(input.fxDenominator) * 10n ** BigInt(fromExp);
  const halfUp = (numeratorScaled + denominatorScaled / 2n) / denominatorScaled;
  return minor(halfUp);
}

/**
 * Allocate an expense in its original currency and convert both total and shares into
 * `toCurrency`, preserving exact conservation (`sum(convertedShares) === convertedAmount`).
 * Ratio-based splits (`equal`, `percentage`, `shares`) allocate directly on `convertedAmount`;
 * `exact` splits convert the user-entered original shares proportionally via Hamilton largest-remainder.
 */
export function allocateConvertedExpense(input: {
  readonly amount: Minor;
  readonly fromCurrency: string;
  readonly toCurrency: string;
  readonly fxNumerator: number | null;
  readonly fxDenominator: number | null;
  readonly participantIds: readonly ParticipantId[];
  readonly split: SplitSpec;
}): ConvertedExpenseAllocation {
  const originalShares = allocate({
    amount: input.amount,
    participantIds: input.participantIds,
    split: input.split,
  });
  const convertedAmount = convertMinor({
    amount: input.amount,
    fromCurrency: input.fromCurrency,
    toCurrency: input.toCurrency,
    fxNumerator: input.fxNumerator,
    fxDenominator: input.fxDenominator,
  });

  if (input.fromCurrency === input.toCurrency) {
    return {
      originalAmount: input.amount,
      convertedAmount,
      originalShares,
      convertedShares: originalShares,
    };
  }

  if (input.split.type !== "exact") {
    const convertedShares = allocate({
      amount: convertedAmount,
      participantIds: input.participantIds,
      split: input.split,
    });
    return {
      originalAmount: input.amount,
      convertedAmount,
      originalShares,
      convertedShares,
    };
  }

  const totalOrig = toMinorUnits(input.amount);
  const totalConverted = toMinorUnits(convertedAmount);
  if (totalOrig === 0n || totalConverted === 0n) {
    return {
      originalAmount: input.amount,
      convertedAmount,
      originalShares,
      convertedShares: originalShares.map((share) => ({ participantId: share.participantId, amount: minor(0n) })),
    };
  }

  const rows = originalShares.map((share) => {
    const weight = toMinorUnits(share.amount);
    if (weight === 0n) {
      return { id: share.participantId, base: 0n, frac: 0n, positive: false };
    }
    const product = totalConverted * weight;
    return {
      id: share.participantId,
      base: product / totalOrig,
      frac: product % totalOrig,
      positive: true,
    };
  });

  const allocated = rows.reduce((acc, row) => acc + row.base, 0n);
  const remainder = totalConverted - allocated;
  const winners = rows
    .filter((row) => row.positive)
    .sort((left, right) => {
      if (left.frac === right.frac) {
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      }
      return left.frac > right.frac ? -1 : 1;
    });

  const extra = new Set<ParticipantId>();
  const extraCount = Number(remainder);
  for (let index = 0; index < extraCount; index += 1) {
    const winner = winners[index];
    if (!winner) {
      throw new LedgerError(LedgerErrorCode.internal, "Ran out of participants while scaling exact shares.");
    }
    extra.add(winner.id);
  }

  const convertedShares: Share[] = rows.map((row) => ({
    participantId: row.id,
    amount: minor(row.base + (extra.has(row.id) ? 1n : 0n)),
  }));

  return {
    originalAmount: input.amount,
    convertedAmount,
    originalShares,
    convertedShares,
  };
}

/**
 * Parse a decimal major-unit exchange rate (e.g. "31.5") or integer ratio ("315/10")
 * into a reduced positive safe-integer ratio without touching floating point.
 */
export function parseRateRatio(raw: string): FxRateRatio {
  const text = raw.trim();
  let num: bigint;
  let den: bigint;

  const slash = /^([0-9]+)\/([0-9]+)$/.exec(text);
  if (slash?.[1] && slash[2]) {
    num = BigInt(slash[1]);
    den = BigInt(slash[2]);
  } else {
    const dec = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text);
    if (!dec?.[1]) {
      throw new LedgerError(LedgerErrorCode.invalidRate, `Invalid exchange rate format: ${raw}.`);
    }
    const frac = dec[2] ?? "";
    if (frac.length > 9) {
      throw new LedgerError(LedgerErrorCode.invalidRate, "Exchange rate decimal precision cannot exceed 9 digits.");
    }
    den = 10n ** BigInt(frac.length);
    num = BigInt(`${dec[1]}${frac}`);
  }

  if (num <= 0n || den <= 0n) {
    throw new LedgerError(LedgerErrorCode.invalidRate, "Exchange rate numerator and denominator must be positive.");
  }

  const divisor = gcd(num, den);
  const reducedNum = num / divisor;
  const reducedDen = den / divisor;
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (reducedNum > max || reducedDen > max) {
    throw new LedgerError(LedgerErrorCode.invalidRate, "Exchange rate exceeds safe integer range.");
  }

  return { numerator: Number(reducedNum), denominator: Number(reducedDen) };
}

/** Parse a non-negative major-unit decimal string (e.g. "12.50" USD) into integer Minor units. */
export function parseMajorToMinor(raw: string, currency: string): Minor {
  const exp = currencyExponent(currency);
  const text = raw.trim().replaceAll(",", "");
  const match = /^([0-9]+)(?:\.([0-9]*))?$/.exec(text);
  if (!match?.[1]) {
    throw new LedgerError(LedgerErrorCode.invalidDecimalAmount, `Invalid amount: ${raw}.`);
  }
  const frac = match[2] ?? "";
  if (frac.length > exp) {
    throw new LedgerError(
      LedgerErrorCode.invalidDecimalAmount,
      `${currency} supports at most ${String(exp)} decimal places.`,
    );
  }
  const padded = frac.padEnd(exp, "0");
  return minor(BigInt(`${match[1]}${padded}`));
}

/** Format `Minor` into an ungrouped decimal string suitable for `<input>` fields (e.g. "12.50"). */
export function formatMinorDecimal(value: Minor, currency: string): string {
  const exp = currencyExponent(currency);
  const units = toMinorUnits(value);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  if (exp === 0) return `${negative ? "-" : ""}${abs.toString(10)}`;
  const digits = abs.toString(10).padStart(exp + 1, "0");
  const whole = digits.slice(0, digits.length - exp);
  const frac = digits.slice(digits.length - exp);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Format `Minor` with ISO 4217 decimal places, thousands separators, and currency code. */
export function formatMinorByCurrency(value: Minor, currency: string): string {
  const exp = currencyExponent(currency);
  const units = toMinorUnits(value);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const digits = exp === 0 ? abs.toString(10) : abs.toString(10).padStart(exp + 1, "0");
  const wholeRaw = exp === 0 ? digits : digits.slice(0, digits.length - exp);
  const frac = exp === 0 ? "" : `.${digits.slice(digits.length - exp)}`;
  const grouped = wholeRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}${grouped}${frac} ${currency}`;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const temp = a % b;
    a = b;
    b = temp;
  }
  return a;
}
