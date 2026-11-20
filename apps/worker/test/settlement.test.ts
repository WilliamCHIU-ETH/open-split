/// <reference types="node" />

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL } from "node:url";
import { balancesResultSchema, groupDetailSchema, groupSummarySchema, settlementPreviewSchema } from "@open-split/contracts";
import { expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";

function sqliteBinding(sqlite: DatabaseSync) {
  function prepare(query: string) {
    return {
      bind(...params: SQLInputValue[]) {
        function all() {
          const results = sqlite.prepare(query).all(...params);
          const changes = sqlite.prepare("SELECT changes() AS changes").get()?.changes;
          return { results, success: true, meta: { changes } };
        }
        return { all, run: all, raw: async () => all().results.map((row) => Object.values(row)) };
      },
    };
  }

  return {
    prepare,
    async batch(statements: ReturnType<ReturnType<typeof prepare>["bind"]>[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.all());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

it("records partial settlements, projects summaries, and audits voids and payment profile changes", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const migration of ["0001_slice1.sql", "0002_slice2.sql", "0003_slice3.sql"]) {
      sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
    // Seed session hashes so the HTTP flow uses the same session middleware as production.
    const session = "test-session";
    const outsider = "outsider-session";
    for (const [id, token] of [["usr_owner", session], ["usr_other", outsider]] as const) {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      sqlite.prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 0, 0)").run(id, id);
      sqlite.prepare("INSERT INTO auth_identities VALUES (?, ?, 'line', ?, 0)").run(id, id, id);
      sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, 0)")
        .run(id, id, Buffer.from(hash).toString("hex"), Date.now() + 60_000);
    }
    const env = { DB: sqliteBinding(sqlite), ENVIRONMENT: "production", AUTH_DEV_IDENTITIES: "false" } as Env;
    const app = createApp();

    async function request(method: string, path: string, status: number, body?: object, token = session) {
      const response = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }, env);
      const data: unknown = await response.json();
      expect(response.status, JSON.stringify(data)).toBe(status);
      return data;
    }

    const { id: groupId, ownerMemberId } = await request("POST", "/api/groups", 201, {
      name: "旅行", defaultCurrency: "JPY",
    }) as { id: string; ownerMemberId: string };
    const group = `/api/groups/${groupId}`;
    await request("GET", `${group}/summary`, 403, undefined, outsider);
    const { id: friend, claim } = await request("POST", `${group}/members`, 201, {
      displayName: "朋友", virtual: true,
    }) as { id: string; claim: { token: string } };

    const expense = {
      groupId, payerId: ownerMemberId, amount: "400", currency: "JPY",
      participantIds: [ownerMemberId, friend], split: { type: "equal" }, category: "餐飲",
    };
    await request("POST", `${group}/expenses`, 201, expense);
    const { id: voidExpense } = await request("POST", `${group}/expenses`, 201, {
      ...expense, category: "其他",
    }) as { id: string };
    await request("POST", `${group}/expenses/${voidExpense}/void`, 200);

    const plan = settlementPreviewSchema.parse(await request("GET", `${group}/settlement-plan`, 200));
    expect(plan).toEqual({
      currency: "JPY", transfers: [{ fromId: friend, toId: ownerMemberId, amount: "200" }],
      participantCount: 2, transferBound: 1,
    });
    const payment = { fromMemberId: friend, toMemberId: ownerMemberId, amount: "75", currency: "JPY", note: "先付" };
    await request("POST", `${group}/settlements`, 422, { ...payment, currency: "TWD" });
    await request("POST", `${group}/settlements`, 422, { ...payment, fromMemberId: "mem_elsewhere" });
    const { id: partial } = await request("POST", `${group}/settlements`, 201, payment) as { id: string };
    const { id: remaining } = await request("POST", `${group}/settlements`, 201, {
      ...payment, amount: "125",
    }) as { id: string };

    const summary = groupSummarySchema.parse(await request("GET", `${group}/summary`, 200));
    expect(summary.totalSpent).toBe("400");
    expect(summary.categories).toEqual([{ category: "餐飲", total: "400", count: 1 }]);
    expect(summary.members).toHaveLength(2);
    expect(summary.members).toEqual(expect.arrayContaining([
      { memberId: ownerMemberId, paid: "400", share: "200", settledPaid: "0", settledReceived: "200", net: "0" },
      { memberId: friend, paid: "0", share: "200", settledPaid: "200", settledReceived: "0", net: "0" },
    ]));
    expect(await request("GET", `${group}/settlement-plan`, 200)).toMatchObject({
      transfers: [], participantCount: 2, transferBound: 1,
    });

    await request("POST", `${group}/settlements/${remaining}/void`, 200);
    await request("POST", `${group}/settlements/${remaining}/void`, 409);
    const balances = balancesResultSchema.parse(await request("GET", `${group}/balances`, 200));
    expect(balances.balances).toContainEqual({ participantId: friend, net: "-125" });
    const afterVoid = groupSummarySchema.parse(await request("GET", `${group}/summary`, 200));
    expect(afterVoid.members.find((member) => member.memberId === friend)).toMatchObject({ net: "-125", settledPaid: "75" });

    const profile = `${group}/members/${friend}/payment-profile`;
    const first = await request("PUT", profile, 200, { label: "轉帳", details: "第一個帳號" });
    expect(await request("PUT", profile, 200, { label: "銀行", details: "另一個帳號" })).toEqual(first);
    await request("POST", `/api/claims/${claim.token}`, 200, undefined, outsider);
    await request("PUT", profile, 403, { label: "禁止", details: "改別人的帳號" });
    await request("DELETE", profile, 403);

    const detail = groupDetailSchema.parse(await request("GET", group, 200));
    expect(detail.balances).toEqual(balances.balances);
    expect(detail.members.find((member) => member.id === friend)?.paymentProfile)
      .toEqual({ label: "銀行", details: "另一個帳號" });
    expect(detail.settlements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: partial, voided: false, note: "先付" }),
      expect.objectContaining({ id: remaining, voided: true }),
    ]));
    await request("DELETE", profile, 200, undefined, outsider);
    const cleared = groupDetailSchema.parse(await request("GET", group, 200));
    expect(cleared.members.find((member) => member.id === friend)?.paymentProfile).toBeNull();

    const audit = sqlite.prepare("SELECT action, payload_json FROM activity_log WHERE group_id = ? ORDER BY rowid").all(groupId);
    expect(audit.filter(({ action }) => action === "settlement.voided")).toHaveLength(1);
    expect(audit.filter(({ action }) => action === "settlement.recorded")
      .map(({ payload_json }) => JSON.parse(String(payload_json)))).toContainEqual(expect.objectContaining(payment));
    expect(audit.filter(({ action }) => String(action).startsWith("payment_profile."))
      .map(({ payload_json }) => JSON.parse(String(payload_json)))).toEqual([
      expect.objectContaining({ label: "轉帳" }),
      expect.objectContaining({ label: "銀行" }),
      expect.objectContaining({ label: "銀行" }),
    ]);
    expect(JSON.stringify(audit)).not.toContain("帳號");
  } finally {
    sqlite.close();
  }
});
