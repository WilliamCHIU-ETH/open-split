import { LedgerError, LedgerErrorCode } from "./errors.ts";

declare const minorBrand: unique symbol;

/**
 * Integer amount in a currency's minor units (cents, or yen, depending on the currency).
 * Branded so a bare `bigint` count cannot be passed where money is required.
 * Never store this as a JS `number`: binary floats cannot represent decimal currency.
 */
export type Minor = bigint & { readonly [minorBrand]: "Minor" };

export function minor(units: bigint): Minor {
  return units as Minor;
}

export function toMinorUnits(value: Minor): bigint {
  return value;
}

/**
 * The only `number` → money conversion in the engine.
 * Callers outside core must not keep the `number`; convert at the boundary and continue with `Minor`.
 */
export function minorFromSafeInteger(value: number): Minor {
  if (!Number.isSafeInteger(value)) {
    throw new LedgerError(
      LedgerErrorCode.unsafeInteger,
      `Money must be a safe integer number of minor units. Received ${String(value)}.`,
    );
  }
  return minor(BigInt(value));
}

export function formatMinor(value: Minor): string {
  return value.toString(10);
}

export const ZERO_MINOR: Minor = minor(0n);

export function addMinor(left: Minor, right: Minor): Minor {
  return minor(left + right);
}

export function subMinor(left: Minor, right: Minor): Minor {
  return minor(left - right);
}

export function sumMinor(values: readonly Minor[]): Minor {
  let total = 0n;
  for (const value of values) {
    total += value;
  }
  return minor(total);
}

export function compareMinor(left: Minor, right: Minor): -1 | 0 | 1 {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function absMinor(value: Minor): Minor {
  return value < 0n ? minor(-value) : value;
}

export function isZeroMinor(value: Minor): boolean {
  return value === 0n;
}
