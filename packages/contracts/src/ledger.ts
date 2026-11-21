import { z } from "zod";
import { attachmentSummarySchema } from "./attachments.ts";
import { fxRateSchema, shareWireSchema, splitSchema } from "./expense.ts";
import { currencyCodeSchema, idSchema, signedMinorSchema, unsignedMinorSchema } from "./money.ts";
import { paymentProfileWriteSchema, settlementViewSchema } from "./settlement.ts";

export const groupSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1).max(80),
  defaultCurrency: currencyCodeSchema,
});

export const groupListSchema = z.strictObject({
  groups: z.array(groupSchema),
});

export const createGroupInputSchema = z.strictObject({
  name: z.string().min(1).max(80),
  defaultCurrency: currencyCodeSchema,
});

export const createGroupResultSchema = groupSchema.extend({
  ownerMemberId: idSchema,
});

export const memberSchema = z.strictObject({
  id: idSchema,
  groupId: idSchema,
  displayName: z.string().min(1).max(80),
  userId: idSchema.nullable(),
  role: z.enum(["owner", "member"]),
  virtual: z.boolean(),
  claimedAt: z.string().min(1).nullable(),
});

export const addMemberInputSchema = z
  .strictObject({
    groupId: idSchema,
    displayName: z.string().min(1).max(80),
    virtual: z.boolean(),
    userId: idSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.virtual && value.userId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["userId"],
        message: "虛擬成員不能連結使用者。",
      });
    }
    if (!value.virtual && value.userId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["userId"],
        message: "已登入的成員需要 userId。還沒有帳號的人請設 virtual。",
      });
    }
  });

export const claimGrantSchema = z.strictObject({
  claimPath: z.string().min(1),
  token: z.string().min(1),
});

export const addMemberResultSchema = memberSchema.extend({
  claim: claimGrantSchema.nullable(),
});

export const inviteResultSchema = z.strictObject({
  invitePath: z.string().min(1),
  token: z.string().min(1),
});

export const balanceWireSchema = z.strictObject({
  participantId: idSchema,
  net: signedMinorSchema,
});

export const balancesResultSchema = z.strictObject({
  groupId: idSchema,
  currency: currencyCodeSchema,
  balances: z.array(balanceWireSchema),
  sum: signedMinorSchema,
});

export const activityEntrySchema = z.strictObject({
  id: idSchema,
  action: z.string().min(1),
  entityId: idSchema,
  createdAt: z.string().min(1),
  summary: z.string().min(1),
  actorDisplayName: z.string().min(1).nullable(),
  via: z.enum(["web", "mcp"]),
  clientId: z.string().min(1).nullable(),
});

export const activityResultSchema = z.strictObject({
  entries: z.array(activityEntrySchema),
});

export const voidExpenseResultSchema = z.strictObject({
  id: idSchema,
  voided: z.literal(true),
});

export const expenseViewSchema = z.strictObject({
  id: idSchema,
  payerId: idSchema,
  amount: unsignedMinorSchema,
  currency: currencyCodeSchema,
  convertedAmount: unsignedMinorSchema,
  convertedCurrency: currencyCodeSchema,
  fxRate: fxRateSchema.nullable(),
  participantIds: z.array(idSchema).min(1),
  split: splitSchema,
  category: z.string().min(1).max(40).nullable(),
  note: z.string().max(500).nullable(),
  voided: z.boolean(),
  shares: z.array(shareWireSchema),
  originalShares: z.array(shareWireSchema),
  attachments: z.array(attachmentSummarySchema),
});

export const groupDetailSchema = z.strictObject({
  group: groupSchema,
  members: z.array(memberSchema.extend({ paymentProfile: paymentProfileWriteSchema.nullable() })),
  expenses: z.array(expenseViewSchema),
  settlements: z.array(settlementViewSchema),
  balances: z.array(balanceWireSchema),
});

export const groupSummarySchema = z.strictObject({
  currency: currencyCodeSchema,
  members: z.array(
    z.strictObject({
      memberId: idSchema,
      paid: unsignedMinorSchema,
      share: unsignedMinorSchema,
      settledPaid: unsignedMinorSchema,
      settledReceived: unsignedMinorSchema,
      net: signedMinorSchema,
    }),
  ),
  categories: z.array(
    z.strictObject({
      category: z.string().nullable(),
      total: unsignedMinorSchema,
      count: z.number().int().positive(),
    }),
  ),
  totalSpent: unsignedMinorSchema,
});

export type Group = z.infer<typeof groupSchema>;
export type GroupList = z.infer<typeof groupListSchema>;
export type CreateGroupResult = z.infer<typeof createGroupResultSchema>;
export type Member = z.infer<typeof memberSchema>;
export type ClaimGrant = z.infer<typeof claimGrantSchema>;
export type AddMemberResult = z.infer<typeof addMemberResultSchema>;
export type InviteResult = z.infer<typeof inviteResultSchema>;
export type BalancesResult = z.infer<typeof balancesResultSchema>;
export type ActivityResult = z.infer<typeof activityResultSchema>;
export type VoidExpenseResult = z.infer<typeof voidExpenseResultSchema>;
export type ExpenseView = z.infer<typeof expenseViewSchema>;
export type GroupDetail = z.infer<typeof groupDetailSchema>;
export type GroupSummary = z.infer<typeof groupSummarySchema>;
