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

export const claimGrantSchema = z.strictObject({
  claimPath: z.string().min(1),
  token: z.string().min(1),
});

export const addMemberResultSchema = memberSchema.extend({
  claim: claimGrantSchema.nullable(),
});

export const invitePreviewSchema = z.strictObject({
  groupId: idSchema,
  groupName: z.string().min(1),
  currency: currencyCodeSchema,
  alreadyMember: z.boolean(),
});

export const joinResultSchema = z.strictObject({
  groupId: idSchema,
  member: memberSchema,
  alreadyMember: z.boolean(),
});

export const claimPreviewSchema = z.strictObject({
  groupId: idSchema,
  groupName: z.string().min(1),
  currency: currencyCodeSchema,
  memberId: idSchema,
  displayName: z.string().min(1),
  status: z.enum(["open", "yours", "taken", "already_member"]),
});

export const claimResultSchema = z.strictObject({
  groupId: idSchema,
  member: memberSchema,
});

export const inviteTokenSchema = z.string().uuid();

export const claimTokenSchema = z.string().regex(/^[a-f0-9]{64}$/, "認領連結不正確。");

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
export type AddMemberResult = z.infer<typeof addMemberResultSchema>;
export type ClaimGrant = z.infer<typeof claimGrantSchema>;
export type InvitePreview = z.infer<typeof invitePreviewSchema>;
export type JoinResult = z.infer<typeof joinResultSchema>;
export type ClaimPreview = z.infer<typeof claimPreviewSchema>;
export type ClaimResult = z.infer<typeof claimResultSchema>;
