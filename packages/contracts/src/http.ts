import { z } from "zod";
import { expenseInputSchema, shareWireSchema, splitSchema } from "./expense.ts";
import { groupSchema, memberSchema, transferWireSchema } from "./mcp.ts";
import { currencyCodeSchema, idSchema, unsignedMinorSchema } from "./money.ts";

export const devSignInSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "名稱需以小寫英文開頭。"),
  provider: z.enum(["line", "google"]),
});

export const devSessionSchema = z.strictObject({
  token: z.string().min(1),
  userId: idSchema,
  displayName: z.string().min(1),
  provider: z.enum(["line", "google"]),
  subject: z.string().min(1),
});

export const devAvailabilitySchema = z.strictObject({
  enabled: z.literal(true),
});

export const currentSessionSchema = devSessionSchema.omit({ token: true });

export const devUserSchema = currentSessionSchema;

export const devUserListSchema = z.strictObject({
  users: z.array(devUserSchema),
});

export const groupListSchema = z.strictObject({
  groups: z.array(groupSchema),
});

export const createGroupResultSchema = groupSchema.extend({
  ownerMemberId: idSchema,
});

export const expenseViewSchema = z.strictObject({
  id: idSchema,
  payerId: idSchema,
  amount: unsignedMinorSchema,
  currency: currencyCodeSchema,
  participantIds: z.array(idSchema).min(1),
  split: splitSchema,
  category: z.string().min(1).max(40).nullable(),
  note: z.string().max(500).nullable(),
  voided: z.boolean(),
  shares: z.array(shareWireSchema),
});

export const groupDetailSchema = z.strictObject({
  group: groupSchema,
  members: z.array(memberSchema),
  expenses: z.array(expenseViewSchema),
});

export const inviteResultSchema = z.strictObject({
  invitePath: z.string().min(1),
  token: z.string().min(1),
});

export const settlementPreviewSchema = z.strictObject({
  transfers: z.array(transferWireSchema),
});

export const expenseWriteSchema = expenseInputSchema;

export type DevSignIn = z.infer<typeof devSignInSchema>;
export type CurrentSession = z.infer<typeof currentSessionSchema>;
export type DevUser = z.infer<typeof devUserSchema>;
export type ExpenseView = z.infer<typeof expenseViewSchema>;
export type GroupDetail = z.infer<typeof groupDetailSchema>;
export type SettlementPreview = z.infer<typeof settlementPreviewSchema>;
