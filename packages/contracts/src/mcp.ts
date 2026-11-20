import { z } from "zod";
import { expenseInputSchema, expenseResultSchema } from "./expense.ts";
import { currencyCodeSchema, idSchema, signedMinorSchema } from "./money.ts";
import {
  paymentProfileUpdateResultSchema,
  paymentProfileWriteSchema,
  settlementPreviewSchema,
  settlementRecordResultSchema,
  settlementWriteSchema,
} from "./settlement.ts";

export const groupSchema = z.strictObject({
  id: idSchema,
  name: z.string().min(1).max(80),
  defaultCurrency: currencyCodeSchema,
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
});

export const activityResultSchema = z.strictObject({
  entries: z.array(activityEntrySchema),
});

export const voidExpenseResultSchema = z.strictObject({
  id: idSchema,
  voided: z.literal(true),
});

const emptyInput = z.strictObject({});

export const createGroupInputSchema = z.strictObject({
  name: z.string().min(1).max(80),
  defaultCurrency: currencyCodeSchema,
});

export const mcpToolContracts = [
  {
    name: "list_groups",
    slice: "5",
    input: emptyInput,
    output: z.strictObject({ groups: z.array(groupSchema) }),
  },
  {
    name: "create_group",
    slice: "1",
    input: createGroupInputSchema,
    output: groupSchema,
  },
  {
    name: "add_member",
    slice: "2",
    input: addMemberInputSchema,
    output: memberSchema,
  },
  {
    name: "create_invite",
    slice: "6",
    input: z.strictObject({ groupId: idSchema }),
    output: z.strictObject({ invitePath: z.string().min(1), token: z.string().min(1) }),
  },
  {
    name: "add_expense",
    slice: "1",
    input: expenseInputSchema,
    output: expenseResultSchema,
  },
  {
    name: "update_expense",
    slice: "1",
    input: expenseInputSchema.extend({ expenseId: idSchema }),
    output: expenseResultSchema,
  },
  {
    name: "void_expense",
    slice: "1",
    input: z.strictObject({ expenseId: idSchema }),
    output: voidExpenseResultSchema,
  },
  {
    name: "get_balances",
    slice: "1",
    input: z.strictObject({ groupId: idSchema }),
    output: balancesResultSchema,
  },
  {
    name: "preview_settlement",
    slice: "3",
    input: z.strictObject({ groupId: idSchema }),
    output: settlementPreviewSchema,
  },
  {
    name: "record_settlement",
    slice: "3",
    input: settlementWriteSchema.safeExtend({ groupId: idSchema }),
    output: settlementRecordResultSchema,
  },
  {
    name: "list_activity",
    slice: "1",
    input: z.strictObject({ groupId: idSchema }),
    output: activityResultSchema,
  },
  {
    name: "set_payment_profile",
    slice: "3",
    input: paymentProfileWriteSchema.extend({ memberId: idSchema }),
    output: paymentProfileUpdateResultSchema,
  },
] as const;

export type McpToolName = (typeof mcpToolContracts)[number]["name"];
export type BalancesResult = z.infer<typeof balancesResultSchema>;
export type ActivityResult = z.infer<typeof activityResultSchema>;
export type Member = z.infer<typeof memberSchema>;
export type Group = z.infer<typeof groupSchema>;
