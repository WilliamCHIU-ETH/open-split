import { describe, expect, it } from "vitest";
import { expenseInputSchema, mcpToolContracts } from "../src/index.ts";

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

describe("mcpToolContracts", () => {
  it("names each tool once", () => {
    const names = mcpToolContracts.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("add_expense");
    expect(names).toContain("get_balances");
    expect(names).toContain("preview_settlement");
  });
});
