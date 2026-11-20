import { z } from "zod";
import { currencyCodeSchema, idSchema, unsignedMinorSchema } from "./money.ts";

const positiveMinorSchema = unsignedMinorSchema.refine((value) => value !== "0", "結清金額必須大於 0。");

const settlementFields = {
  fromMemberId: idSchema,
  toMemberId: idSchema,
  amount: positiveMinorSchema,
  currency: currencyCodeSchema,
};

const settlementNoteSchema = z.string().max(200);

export const settlementWriteSchema = z.strictObject({
  ...settlementFields,
  note: settlementNoteSchema.optional(),
}).refine((value) => value.fromMemberId !== value.toMemberId, {
  path: ["toMemberId"],
  message: "付款人與收款人必須是不同的成員。",
});

export const settlementRecordResultSchema = z.strictObject({ id: idSchema });

export const settlementVoidResultSchema = z.strictObject({ id: idSchema, voided: z.literal(true) });

export const settlementViewSchema = z.strictObject({
  ...settlementFields,
  id: idSchema,
  note: settlementNoteSchema.nullable(),
  voided: z.boolean(),
  voidedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  createdByUserId: idSchema,
});

export const transferWireSchema = z.strictObject({
  fromId: idSchema,
  toId: idSchema,
  amount: positiveMinorSchema,
});

export const settlementPreviewSchema = z.strictObject({
  currency: currencyCodeSchema,
  transfers: z.array(transferWireSchema),
  participantCount: z.number().int().nonnegative(),
  transferBound: z.number().int().nonnegative(),
});

export const paymentProfileWriteSchema = z.strictObject({
  label: z.string().min(1).max(40),
  details: z.string().min(1).max(500),
});

export const paymentProfileUpdateResultSchema = z.strictObject({ id: idSchema });

export const paymentProfileClearResultSchema = z.strictObject({ ok: z.literal(true) });

export type SettlementWrite = z.infer<typeof settlementWriteSchema>;
export type SettlementView = z.infer<typeof settlementViewSchema>;
export type SettlementPreview = z.infer<typeof settlementPreviewSchema>;
export type PaymentProfileWrite = z.infer<typeof paymentProfileWriteSchema>;
