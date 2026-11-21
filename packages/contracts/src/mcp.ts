import { z } from "zod";
import {
  attachmentDeleteResultSchema,
  attachmentListSchema,
  attachmentUploadIntentInputSchema,
  attachmentUploadIntentResultSchema,
} from "./attachments.ts";
import { expenseInputSchema, expenseResultSchema } from "./expense.ts";
import { currencyCodeSchema, idempotencyKeySchema, idSchema, signedMinorSchema } from "./money.ts";
import {
  paymentProfileClearResultSchema,
  paymentProfileUpdateResultSchema,
  paymentProfileWriteSchema,
  settlementPreviewSchema,
  settlementRecordResultSchema,
  settlementVoidResultSchema,
  settlementWriteSchema,
} from "./settlement.ts";

export type McpScope = "mcp:read" | "mcp:write";

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

const emptyInput = z.strictObject({});

export const createGroupInputSchema = z.strictObject({
  name: z.string().min(1).max(80),
  defaultCurrency: currencyCodeSchema,
});

const groupDetailOutputStub = z.strictObject({
  group: groupSchema,
  members: z.array(memberSchema.extend({ paymentProfile: paymentProfileWriteSchema.nullable() })),
  expenses: z.array(z.record(z.string(), z.unknown())),
  settlements: z.array(z.record(z.string(), z.unknown())),
  balances: z.array(balanceWireSchema),
});

const groupSummaryOutputStub = z.strictObject({
  currency: currencyCodeSchema,
  members: z.array(
    z.strictObject({
      memberId: idSchema,
      paid: signedMinorSchema,
      share: signedMinorSchema,
      settledPaid: signedMinorSchema,
      settledReceived: signedMinorSchema,
      net: signedMinorSchema,
    }),
  ),
  categories: z.array(
    z.strictObject({
      category: z.string().nullable(),
      total: signedMinorSchema,
      count: z.number().int().positive(),
    }),
  ),
  totalSpent: signedMinorSchema,
});

export const mcpToolContracts = [
  {
    name: "list_groups",
    slice: "5",
    scope: "mcp:read" as McpScope,
    readOnly: true,
    description: "List all split groups that the authorized user belongs to.",
    input: emptyInput,
    output: z.strictObject({ groups: z.array(groupSchema) }),
  },
  {
    name: "get_group",
    slice: "5",
    scope: "mcp:read" as McpScope,
    readOnly: true,
    description: "Read group metadata, members, expenses, settlements, and net balances.",
    input: z.strictObject({ groupId: idSchema }),
    output: groupDetailOutputStub,
  },
  {
    name: "create_group",
    slice: "1",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Create a new group with a fixed ISO 4217 default currency.",
    input: createGroupInputSchema.safeExtend({ idempotencyKey: idempotencyKeySchema.optional() }),
    output: groupSchema.extend({ ownerMemberId: idSchema }),
  },
  {
    name: "add_member",
    slice: "2",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Add a virtual placeholder member or an existing user to a group.",
    input: addMemberInputSchema.safeExtend({ idempotencyKey: idempotencyKeySchema.optional() }),
    output: memberSchema.extend({
      claim: z.strictObject({ claimPath: z.string().min(1), token: z.string().min(1) }).nullable(),
    }),
  },
  {
    name: "create_invite",
    slice: "5",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Generate a group invite link for another person to join.",
    input: z.strictObject({ groupId: idSchema, idempotencyKey: idempotencyKeySchema.optional() }),
    output: z.strictObject({ invitePath: z.string().min(1), token: z.string().min(1) }),
  },
  {
    name: "add_expense",
    slice: "1",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Record an expense in minor-unit integers with optional FX rate and receipt attachmentIds.",
    input: expenseInputSchema.safeExtend({ idempotencyKey: idempotencyKeySchema.optional() }),
    output: expenseResultSchema,
  },
  {
    name: "update_expense",
    slice: "1",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Update an active expense in a group.",
    input: expenseInputSchema.safeExtend({ expenseId: idSchema, idempotencyKey: idempotencyKeySchema.optional() }),
    output: expenseResultSchema,
  },
  {
    name: "void_expense",
    slice: "1",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Void an expense while keeping audit history and receipt attachments.",
    input: z.strictObject({ groupId: idSchema, expenseId: idSchema, idempotencyKey: idempotencyKeySchema.optional() }),
    output: voidExpenseResultSchema,
  },
  {
    name: "get_balances",
    slice: "1",
    scope: "mcp:read" as McpScope,
    readOnly: true,
    description: "Read member net balances in the group's default currency (always sums to 0).",
    input: z.strictObject({ groupId: idSchema }),
    output: balancesResultSchema,
  },
  {
    name: "preview_settlement",
    slice: "3",
    scope: "mcp:read" as McpScope,
    readOnly: true,
    description: "Compute a minimal set of suggested transfers to settle all group balances.",
    input: z.strictObject({ groupId: idSchema }),
    output: settlementPreviewSchema,
  },
  {
    name: "get_summary",
    slice: "3",
    scope: "mcp:read" as McpScope,
    readOnly: true,
    description: "Read per-member totals and per-category spending breakdown in group default currency.",
    input: z.strictObject({ groupId: idSchema }),
    output: groupSummaryOutputStub,
  },
  {
    name: "record_settlement",
    slice: "3",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Record a repayment between two members in the group's default currency.",
    input: settlementWriteSchema.safeExtend({ groupId: idSchema, idempotencyKey: idempotencyKeySchema.optional() }),
    output: settlementRecordResultSchema,
  },
  {
    name: "void_settlement",
    slice: "3",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Void a recorded settlement in a group.",
    input: z.strictObject({ groupId: idSchema, settlementId: idSchema, idempotencyKey: idempotencyKeySchema.optional() }),
    output: settlementVoidResultSchema,
  },
  {
    name: "list_activity",
    slice: "1",
    scope: "mcp:read" as McpScope,
    readOnly: true,
    description: "List chronological ledger and membership audit entries for a group.",
    input: z.strictObject({ groupId: idSchema }),
    output: activityResultSchema,
  },
  {
    name: "set_payment_profile",
    slice: "3",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Set payout label and details for yourself or a virtual member in a group.",
    input: paymentProfileWriteSchema.safeExtend({
      groupId: idSchema,
      memberId: idSchema,
      idempotencyKey: idempotencyKeySchema.optional(),
    }),
    output: paymentProfileUpdateResultSchema,
  },
  {
    name: "clear_payment_profile",
    slice: "3",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Remove payout details for yourself or a virtual member in a group.",
    input: z.strictObject({ groupId: idSchema, memberId: idSchema, idempotencyKey: idempotencyKeySchema.optional() }),
    output: paymentProfileClearResultSchema,
  },
  {
    name: "list_attachments",
    slice: "5",
    scope: "mcp:read" as McpScope,
    readOnly: true,
    description: "List R2 receipt attachment metadata in a group (optionally filtered by expenseId).",
    input: z.strictObject({ groupId: idSchema, expenseId: idSchema.optional() }),
    output: attachmentListSchema,
  },
  {
    name: "create_attachment_upload",
    slice: "5",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Create a signed upload intent for a receipt attachment (JPEG/PNG/WEBP/PDF, <= 10 MiB).",
    input: attachmentUploadIntentInputSchema.safeExtend({ idempotencyKey: idempotencyKeySchema.optional() }),
    output: attachmentUploadIntentResultSchema,
  },
  {
    name: "delete_attachment",
    slice: "5",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Delete a receipt attachment from D1 and R2.",
    input: z.strictObject({ groupId: idSchema, attachmentId: idSchema, idempotencyKey: idempotencyKeySchema.optional() }),
    output: attachmentDeleteResultSchema,
  },
] as const;

export type McpToolName = (typeof mcpToolContracts)[number]["name"];
export type McpToolContract = (typeof mcpToolContracts)[number];
export type BalancesResult = z.infer<typeof balancesResultSchema>;
export type ActivityResult = z.infer<typeof activityResultSchema>;
export type Member = z.infer<typeof memberSchema>;
export type Group = z.infer<typeof groupSchema>;

export interface McpToolDefinition {
  readonly name: McpToolName;
  readonly description: string;
  readonly scope: McpScope;
  readonly readOnly: boolean;
  readonly inputSchema: Record<string, unknown>;
}

export function getMcpToolDefinitions(): McpToolDefinition[] {
  return mcpToolContracts.map((tool) => ({
    name: tool.name,
    description: tool.description,
    scope: tool.scope,
    readOnly: tool.readOnly,
    inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown>,
  }));
}
