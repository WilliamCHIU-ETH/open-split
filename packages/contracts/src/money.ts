import { minor, type Minor } from "@open-split/core";
import { z } from "zod";

/** JSON money is a string of integer minor units so parsers never see a binary float. */
export const unsignedMinorSchema = z
  .string()
  .regex(
    /^(0|[1-9][0-9]*)$/,
    "Money must be a base-10 integer string of minor units, with no sign, decimal point, or leading zeros.",
  );

export const signedMinorSchema = z
  .string()
  .regex(
    /^-?(0|[1-9][0-9]*)$/,
    "Signed minor units must be a base-10 integer string with no decimal point.",
  );

export const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Currency must be an ISO 4217 code.");

export const idSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,80}$/, "Id must start with a letter and use only letters, digits, _ and -.");

export const positiveIntSchema = z.number().int().positive();

export function parseUnsignedMinor(wire: string): Minor {
  return minor(BigInt(unsignedMinorSchema.parse(wire)));
}

export function parseSignedMinor(wire: string): Minor {
  return minor(BigInt(signedMinorSchema.parse(wire)));
}
