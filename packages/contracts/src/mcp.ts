import { z } from "zod";
import { expenseInputSchema, expenseResultSchema } from "./expense.ts";
import { currencyCodeSchema, idSchema, signedMinorSchema, unsignedMinorSchema } from "./money.ts";

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
});

export const balanceWireSchema = z.strictObject({
  participantId: idSchema,
  net: signedMinorSchema,
});

export const transferWireSchema = z.strictObject({
  fromId: idSchema,
  toId: idSchema,
  amount: unsignedMinorSchema,
});

const emptyInput = z.strictObject({});

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
    input: z.strictObject({ name: z.string().min(1).max(80), defaultCurrency: currencyCodeSchema }),
    output: groupSchema,
  },
  {
    name: "add_member",
    slice: "2",
    input: z.strictObject({
      groupId: idSchema,
      displayName: z.string().min(1).max(80),
      virtual: z.boolean(),
    }),
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
    output: z.strictObject({ id: idSchema, voided: z.literal(true) }),
  },
  {
    name: "get_balances",
    slice: "1",
    input: z.strictObject({ groupId: idSchema }),
    output: z.strictObject({
      groupId: idSchema,
      currency: currencyCodeSchema,
      balances: z.array(balanceWireSchema),
      sum: signedMinorSchema,
    }),
  },
  {
    name: "preview_settlement",
    slice: "3",
    input: z.strictObject({ groupId: idSchema }),
    output: z.strictObject({ transfers: z.array(transferWireSchema) }),
  },
  {
    name: "record_settlement",
    slice: "3",
    input: z.strictObject({
      groupId: idSchema,
      fromMemberId: idSchema,
      toMemberId: idSchema,
      amount: unsignedMinorSchema,
      currency: currencyCodeSchema,
    }),
    output: z.strictObject({ id: idSchema }),
  },
  {
    name: "list_activity",
    slice: "1",
    input: z.strictObject({ groupId: idSchema }),
    output: z.strictObject({
      entries: z.array(
        z.strictObject({
          id: idSchema,
          action: z.string().min(1),
          entityId: idSchema,
        }),
      ),
    }),
  },
  {
    name: "set_payment_profile",
    slice: "3",
    input: z.strictObject({
      memberId: idSchema,
      label: z.string().min(1).max(40),
      details: z.string().min(1).max(500),
    }),
    output: z.strictObject({ id: idSchema }),
  },
] as const;

export type McpToolName = (typeof mcpToolContracts)[number]["name"];
