import { z } from "zod";
import { currencyCodeSchema, idSchema, positiveIntSchema, unsignedMinorSchema } from "./money.ts";

export const equalSplitSchema = z.strictObject({ type: z.literal("equal") });

export const exactSplitSchema = z.strictObject({
  type: z.literal("exact"),
  amounts: z.record(idSchema, unsignedMinorSchema),
});

export const percentageSplitSchema = z.strictObject({
  type: z.literal("percentage"),
  basisPoints: z.record(idSchema, positiveIntSchema),
});

export const sharesSplitSchema = z.strictObject({
  type: z.literal("shares"),
  weights: z.record(idSchema, positiveIntSchema),
});

export const splitSchema = z.discriminatedUnion("type", [
  equalSplitSchema,
  exactSplitSchema,
  percentageSplitSchema,
  sharesSplitSchema,
]);

export const expenseInputSchema = z.strictObject({
  groupId: idSchema,
  payerId: idSchema,
  amount: unsignedMinorSchema,
  currency: currencyCodeSchema,
  participantIds: z.array(idSchema).min(1),
  split: splitSchema,
  category: z.string().min(1).max(40).optional(),
  note: z.string().max(500).optional(),
});

export const shareWireSchema = z.strictObject({
  participantId: idSchema,
  amount: unsignedMinorSchema,
});

export const expenseResultSchema = z.strictObject({
  id: idSchema,
  shares: z.array(shareWireSchema),
});

export type ExpenseInput = z.infer<typeof expenseInputSchema>;
export type SplitWire = z.infer<typeof splitSchema>;
