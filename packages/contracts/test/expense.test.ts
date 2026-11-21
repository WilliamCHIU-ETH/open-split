import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  addMemberInputSchema,
  apiPaths,
  attachmentUploadIntentInputSchema,
  expenseInputSchema,
  groupDetailSchema,
  groupSummarySchema,
  mcpToolContracts,
  plannedHttpRoutes,
} from "../src/index.ts";

const dinner = {
  groupId: "grp_kyoto",
  payerId: "mem_me",
  amount: "3000",
  currency: "JPY",
  participantIds: ["mem_me", "mem_a2", "mem_a3", "mem_a4", "mem_a5"],
  split: { type: "equal" as const },
  note: "只有五個人吃",
};

describe("expenseInputSchema", () => {
  it("accepts the 3000 JPY equal-split story as minor-unit strings", () => {
    expect(expenseInputSchema.parse(dinner)).toMatchObject({ amount: "3000", currency: "JPY" });
  });

  it("accepts valid FX ratio and trims category, rejecting whitespace-only category and unknown currencies", () => {
    const parsed = expenseInputSchema.parse({
      ...dinner,
      fxRate: { numerator: 21, denominator: 100 },
      category: " 餐飲 ",
    });
    expect(parsed.fxRate).toEqual({ numerator: 21, denominator: 100 });
    expect(parsed.category).toBe("餐飲");

    expect(expenseInputSchema.safeParse({ ...dinner, category: "   " }).success).toBe(false);
    expect(expenseInputSchema.safeParse({ ...dinner, currency: "XYZ" }).success).toBe(false);
    expect(expenseInputSchema.safeParse({ ...dinner, fxRate: { numerator: 0, denominator: 1 } }).success).toBe(false);
  });

  it("rejects decimal money and JSON numbers", () => {
    expect(expenseInputSchema.safeParse({ ...dinner, amount: "3000.0" }).success).toBe(false);
    expect(expenseInputSchema.safeParse({ ...dinner, amount: 3000 }).success).toBe(false);
    expect(expenseInputSchema.safeParse({ ...dinner, amount: "01" }).success).toBe(false);
  });
});

describe("attachmentUploadIntentInputSchema", () => {
  it("accepts valid receipt upload metadata and rejects unsafe MIME or oversize payloads", () => {
    const valid = {
      groupId: "grp_kyoto",
      filename: " receipt.jpg ",
      mimeType: "image/jpeg",
      byteSize: 4096,
      sha256: "a".repeat(64),
    };
    expect(attachmentUploadIntentInputSchema.parse(valid).filename).toBe("receipt.jpg");
    expect(attachmentUploadIntentInputSchema.safeParse({ ...valid, mimeType: "image/svg+xml" }).success).toBe(false);
    expect(attachmentUploadIntentInputSchema.safeParse({ ...valid, byteSize: 10 * 1024 * 1024 + 1 }).success).toBe(false);
  });
});

describe("plannedHttpRoutes", () => {
  it("covers the same slice 1 ledger operations as MCP", () => {
    const http = new Set(plannedHttpRoutes.map((route) => `${route.method} ${route.path}`));
    const required = [
      "POST /api/groups",
      "POST /api/groups/:groupId/expenses",
      "PATCH /api/groups/:groupId/expenses/:expenseId",
      "POST /api/groups/:groupId/expenses/:expenseId/void",
      "GET /api/groups/:groupId/balances",
      "GET /api/groups/:groupId/activity",
    ];
    for (const route of required) {
      expect(http.has(route), route).toBe(true);
      expect(plannedHttpRoutes.find((item) => `${item.method} ${item.path}` === route)?.slice).toBe("1");
    }
    const slice1Tools = mcpToolContracts.filter((tool) => tool.slice === "1").map((tool) => tool.name);
    expect(slice1Tools).toEqual(
      expect.arrayContaining(["create_group", "add_expense", "update_expense", "void_expense", "get_balances", "list_activity"]),
    );
  });
});

describe("addMemberInputSchema", () => {
  it("requires a user id only when the member is not virtual", () => {
    expect(
      addMemberInputSchema.safeParse({ groupId: "grp_kyoto", displayName: "店員", virtual: true }).success,
    ).toBe(true);
    expect(
      addMemberInputSchema.safeParse({
        groupId: "grp_kyoto",
        displayName: "Bob",
        virtual: false,
        userId: "usr_bob",
      }).success,
    ).toBe(true);
    expect(
      addMemberInputSchema.safeParse({ groupId: "grp_kyoto", displayName: "Bob", virtual: false }).success,
    ).toBe(false);
    expect(
      addMemberInputSchema.safeParse({
        groupId: "grp_kyoto",
        displayName: "店員",
        virtual: true,
        userId: "usr_bob",
      }).success,
    ).toBe(false);
  });
});

describe("mcpToolContracts", () => {
  it("names each tool once and enforces groupId on every group-scoped entity tool", () => {
    const names = mcpToolContracts.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_groups",
        "get_group",
        "add_expense",
        "get_balances",
        "preview_settlement",
        "get_summary",
        "void_settlement",
        "create_attachment_upload",
        "list_attachments",
        "delete_attachment",
      ]),
    );

    const scopedKeys = ["memberId", "expenseId", "settlementId", "attachmentId"];
    for (const tool of mcpToolContracts) {
      const jsonSchema = z.toJSONSchema(tool.input) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const props = Object.keys(jsonSchema.properties ?? {});
      if (scopedKeys.some((key) => props.includes(key))) {
        expect(jsonSchema.required ?? [], `${tool.name} must require groupId`).toContain("groupId");
      }
    }
  });

  it("shares exact output schemas between HTTP and MCP (no stub drift)", () => {
    const byName = new Map(mcpToolContracts.map((tool) => [tool.name, tool]));
    expect(byName.get("get_group")?.output).toBe(groupDetailSchema);
    expect(byName.get("get_summary")?.output).toBe(groupSummarySchema);
  });
});

describe("apiPaths", () => {
  it("encodes path parameters cleanly", () => {
    expect(apiPaths.group("grp_1")).toBe("/api/groups/grp_1");
    expect(apiPaths.invite("tok/a")).toBe("/api/invites/tok%2Fa");
    expect(apiPaths.groupExpense("grp_1", "exp_2")).toBe("/api/groups/grp_1/expenses/exp_2");
  });
});
