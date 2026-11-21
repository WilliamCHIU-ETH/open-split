import { z } from "zod";
import { expenseInputSchema } from "./expense.ts";
import {
  addMemberResultSchema,
  claimGrantSchema,
  createGroupResultSchema,
  expenseViewSchema,
  groupDetailSchema,
  groupListSchema,
  groupSummarySchema,
  inviteResultSchema,
  memberSchema,
  type AddMemberResult,
  type ClaimGrant,
  type CreateGroupResult,
  type ExpenseView,
  type GroupDetail,
  type GroupList,
  type GroupSummary,
  type InviteResult,
} from "./ledger.ts";
import { currencyCodeSchema, idSchema } from "./money.ts";

export {
  addMemberResultSchema,
  claimGrantSchema,
  createGroupResultSchema,
  expenseViewSchema,
  groupDetailSchema,
  groupListSchema,
  groupSummarySchema,
  inviteResultSchema,
  type AddMemberResult,
  type ClaimGrant,
  type CreateGroupResult,
  type ExpenseView,
  type GroupDetail,
  type GroupList,
  type GroupSummary,
  type InviteResult,
};

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

export const expenseWriteSchema = expenseInputSchema;

export type DevSignIn = z.infer<typeof devSignInSchema>;
export type CurrentSession = z.infer<typeof currentSessionSchema>;
export type DevUser = z.infer<typeof devUserSchema>;
export type InvitePreview = z.infer<typeof invitePreviewSchema>;
export type JoinResult = z.infer<typeof joinResultSchema>;
export type ClaimPreview = z.infer<typeof claimPreviewSchema>;
export type ClaimResult = z.infer<typeof claimResultSchema>;
