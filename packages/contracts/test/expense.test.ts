import { describe, expect, it } from "vitest";
import { expenseInputSchema, mcpToolContracts, plannedHttpRoutes } from "../src/index.ts";

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

  it("rejects decimal money and JSON numbers", () => {
    expect(expenseInputSchema.safeParse({ ...dinner, amount: "3000.0" }).success).toBe(false);
    expect(expenseInputSchema.safeParse({ ...dinner, amount: 3000 }).success).toBe(false);
    expect(expenseInputSchema.safeParse({ ...dinner, amount: "01" }).success).toBe(false);
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

describe("mcpToolContracts", () => {
  it("names each tool once", () => {
    const names = mcpToolContracts.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("add_expense");
    expect(names).toContain("get_balances");
    expect(names).toContain("preview_settlement");
  });
});
