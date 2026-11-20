import { expect, it } from "vitest";
import { mcpToolContracts, settlementPreviewSchema, settlementWriteSchema } from "../src/index.ts";

const payment = {
  fromMemberId: "mem_sender",
  toMemberId: "mem_receiver",
  amount: "75",
  currency: "JPY",
  note: "先付一部分",
};

it("shares settlement validation and the plan response between MCP and HTTP", () => {
  const record = mcpToolContracts.find((tool) => tool.name === "record_settlement");
  const preview = mcpToolContracts.find((tool) => tool.name === "preview_settlement");
  expect(preview?.output).toBe(settlementPreviewSchema);
  expect(record?.input.parse({ ...payment, groupId: "grp_trip" })).toMatchObject(payment);
  expect(settlementWriteSchema.parse(payment)).toEqual(payment);
  for (const invalid of [
    { amount: "0" }, { amount: "-1" }, { amount: "1.0" }, { amount: 75 },
    { note: "字".repeat(201) }, { toMemberId: payment.fromMemberId },
  ]) {
    expect(settlementWriteSchema.safeParse({ ...payment, ...invalid }).success).toBe(false);
    expect(record?.input.safeParse({ ...payment, groupId: "grp_trip", ...invalid }).success).toBe(false);
  }
});
