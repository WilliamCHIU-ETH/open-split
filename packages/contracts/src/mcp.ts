import { z } from "zod";
import {
  attachmentDeleteResultSchema,
  attachmentListSchema,
  attachmentUploadIntentInputSchema,
  attachmentUploadIntentResultSchema,
} from "./attachments.ts";
import { expenseInputSchema, expenseResultSchema } from "./expense.ts";
import {
  activityEntrySchema,
  activityResultSchema,
  addMemberInputSchema,
  addMemberResultSchema,
  balanceWireSchema,
  balancesResultSchema,
  createGroupInputSchema,
  createGroupResultSchema,
  groupDetailSchema,
  groupListSchema,
  groupSchema,
  groupSummarySchema,
  inviteResultSchema,
  memberSchema,
  voidExpenseResultSchema,
  type ActivityResult,
  type BalancesResult,
  type Group,
  type Member,
} from "./ledger.ts";
import { idempotencyKeySchema, idSchema } from "./money.ts";
import {
  paymentProfileClearResultSchema,
  paymentProfileUpdateResultSchema,
  paymentProfileWriteSchema,
  settlementPreviewSchema,
  settlementRecordResultSchema,
  settlementVoidResultSchema,
  settlementWriteSchema,
} from "./settlement.ts";

export {
  activityEntrySchema,
  activityResultSchema,
  addMemberInputSchema,
  balanceWireSchema,
  balancesResultSchema,
  createGroupInputSchema,
  groupSchema,
  memberSchema,
  voidExpenseResultSchema,
  type ActivityResult,
  type BalancesResult,
  type Group,
  type Member,
};

export type McpScope = "mcp:read" | "mcp:write";

const emptyInput = z.strictObject({});

export const mcpToolContracts = [
  {
    name: "list_groups",
    slice: "5",
    scope: "mcp:read" as McpScope,
    readOnly: true,
    description: "List all split groups that the authorized user belongs to.",
    input: emptyInput,
    output: groupListSchema,
  },
  {
    name: "get_group",
    slice: "5",
    scope: "mcp:read" as McpScope,
    readOnly: true,
    description: "Read group metadata, members, expenses, settlements, and net balances.",
    input: z.strictObject({ groupId: idSchema }),
    output: groupDetailSchema,
  },
  {
    name: "create_group",
    slice: "1",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Create a new group with a fixed ISO 4217 default currency.",
    input: createGroupInputSchema.safeExtend({ idempotencyKey: idempotencyKeySchema.optional() }),
    output: createGroupResultSchema,
  },
  {
    name: "add_member",
    slice: "2",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Add a virtual placeholder member or an existing user to a group.",
    input: addMemberInputSchema.safeExtend({ idempotencyKey: idempotencyKeySchema.optional() }),
    output: addMemberResultSchema,
  },
  {
    name: "create_invite",
    slice: "5",
    scope: "mcp:write" as McpScope,
    readOnly: false,
    description: "Generate a group invite link for another person to join.",
    input: z.strictObject({ groupId: idSchema, idempotencyKey: idempotencyKeySchema.optional() }),
    output: inviteResultSchema,
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
    output: groupSummarySchema,
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
