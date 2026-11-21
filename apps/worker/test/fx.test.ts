import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { balancesResultSchema, expenseResultSchema, groupDetailSchema, groupSummarySchema, settlementPreviewSchema } from "@open-split/contracts";
import { expect, it } from "vitest";
import { createApp } from "../src/http/app.ts";
import { applyMigrations, createTestEnv } from "./helpers.ts";

async function seedUser(sqlite: DatabaseSync, id: string, displayName: string, token: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  sqlite.prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, 0, 0)").run(id, displayName);
  sqlite.prepare("INSERT INTO auth_identities VALUES (?, ?, 'line', ?, 0)").run(id, id, id);
  sqlite
    .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, 0)")
    .run(id, id, Buffer.from(hash).toString("hex"), Date.now() + 60_000);
}

it("migrates populated Slice 3 databases cleanly to 0004_slice4_5", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    applyMigrations(sqlite, ["0001_slice1.sql", "0002_slice2.sql", "0003_slice3.sql"]);
    const session = "slice3-session";
    await seedUser(sqlite, "usr_owner", "Bill", session);
    sqlite.prepare("INSERT INTO groups VALUES ('grp_1', 'Old Trip', 'TWD', 'usr_owner', 100)").run();
    sqlite.prepare("INSERT INTO group_members VALUES ('mem_1', 'grp_1', 'Bill', 'usr_owner', 'owner', NULL, NULL, 100)").run();
    sqlite.prepare("INSERT INTO group_members VALUES ('mem_2', 'grp_1', 'Bob', NULL, 'member', NULL, NULL, 100)").run();
    sqlite.prepare("INSERT INTO expenses VALUES ('exp_1', 'grp_1', 'mem_1', 1000, 'TWD', NULL, NULL, '食物', NULL, NULL, 'usr_owner', 100, 100, NULL)").run();
    sqlite.prepare("INSERT INTO expense_shares VALUES ('exp_1', 'mem_1', 500), ('exp_1', 'mem_2', 500)").run();

    applyMigrations(sqlite, ["0004_slice4_5.sql"]);

    const app = createApp();
    const env = createTestEnv(sqlite);

    const res = await app.request("/api/groups/grp_1", { headers: { authorization: `Bearer ${session}` } }, env);
    expect(res.status).toBe(200);
    const detail = groupDetailSchema.parse(await res.json());
    expect(detail.expenses[0]).toMatchObject({
      amount: "1000",
      currency: "TWD",
      convertedAmount: "1000",
      convertedCurrency: "TWD",
      fxRate: null,
    });
    expect(detail.balances).toEqual(
      expect.arrayContaining([
        { participantId: "mem_1", net: "500" },
        { participantId: "mem_2", net: "-500" },
      ]),
    );
  } finally {
    sqlite.close();
  }
});

it("converts foreign-currency expenses into group default currency, preserves conservation, and settles in group currency", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    applyMigrations(sqlite);
    const session = "owner-session";
    const aliceSession = "alice-session";
    await seedUser(sqlite, "usr_owner", "Bill", session);
    await seedUser(sqlite, "usr_alice", "Alice", aliceSession);

    const env = createTestEnv(sqlite);
    const app = createApp();

    async function req(method: string, path: string, status: number, body?: object, token = session) {
      const res = await app.request(
        path,
        {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        },
        env,
      );
      const data: unknown = await res.json();
      expect(res.status, JSON.stringify(data)).toBe(status);
      return data;
    }

    const { id: groupId, ownerMemberId } = (await req("POST", "/api/groups", 201, {
      name: "日本旅",
      defaultCurrency: "TWD",
    })) as { id: string; ownerMemberId: string };
    const { id: aliceMemberId } = (await req("POST", `/api/groups/${groupId}/members`, 201, {
      displayName: "Alice",
      virtual: false,
      userId: "usr_alice",
    })) as { id: string };
    const { id: bobMemberId } = (await req("POST", `/api/groups/${groupId}/members`, 201, {
      displayName: "Bob",
      virtual: true,
    })) as { id: string };

    // Reject missing fxRate on foreign currency, and reject fxRate on same currency.
    await req("POST", `/api/groups/${groupId}/expenses`, 422, {
      groupId,
      payerId: ownerMemberId,
      amount: "1000",
      currency: "JPY",
      participantIds: [ownerMemberId, aliceMemberId],
      split: { type: "equal" },
    });
    await req("POST", `/api/groups/${groupId}/expenses`, 422, {
      groupId,
      payerId: ownerMemberId,
      amount: "10000",
      currency: "TWD",
      fxRate: { numerator: 1, denominator: 1 },
      participantIds: [ownerMemberId, aliceMemberId],
      split: { type: "equal" },
    });

    // 1) 1000 JPY (exp 0) paid by Bill, split equally among 3 at 1 JPY = 0.21 TWD -> 210.00 TWD (21000 minor), 7000 each.
    const jpyExpense = expenseResultSchema.parse(
      await req("POST", `/api/groups/${groupId}/expenses`, 201, {
        groupId,
        payerId: ownerMemberId,
        amount: "1000",
        currency: "JPY",
        fxRate: { numerator: 21, denominator: 100 },
        participantIds: [ownerMemberId, aliceMemberId, bobMemberId],
        split: { type: "equal" },
        category: "拉麵",
      }),
    );
    expect(jpyExpense.convertedAmount).toBe("21000");
    expect(jpyExpense.convertedCurrency).toBe("TWD");
    expect(jpyExpense.shares).toEqual(
      expect.arrayContaining([
        { participantId: ownerMemberId, amount: "7000" },
        { participantId: aliceMemberId, amount: "7000" },
        { participantId: bobMemberId, amount: "7000" },
      ]),
    );

    // 2) 10.00 USD (1000 minor, exp 2) paid by Alice, exact split (7.00 USD + 3.00 USD + 0.00 USD) at 1 USD = 31.5 TWD (63/2) -> 31500 minor.
    const usdExpense = expenseResultSchema.parse(
      await req(
        "POST",
        `/api/groups/${groupId}/expenses`,
        201,
        {
          groupId,
          payerId: aliceMemberId,
          amount: "1000",
          currency: "USD",
          fxRate: { numerator: 63, denominator: 2 },
          participantIds: [ownerMemberId, aliceMemberId, bobMemberId],
          split: {
            type: "exact",
            amounts: { [ownerMemberId]: "700", [aliceMemberId]: "300", [bobMemberId]: "0" },
          },
          category: "機票",
        },
        aliceSession,
      ),
    );
    expect(usdExpense.convertedAmount).toBe("31500");
    expect(usdExpense.shares).toEqual(
      expect.arrayContaining([
        { participantId: ownerMemberId, amount: "22050" },
        { participantId: aliceMemberId, amount: "9450" },
        { participantId: bobMemberId, amount: "0" },
      ]),
    );
    expect(usdExpense.originalShares).toEqual(
      expect.arrayContaining([
        { participantId: ownerMemberId, amount: "700" },
        { participantId: aliceMemberId, amount: "300" },
        { participantId: bobMemberId, amount: "0" },
      ]),
    );

    const balances = balancesResultSchema.parse(await req("GET", `/api/groups/${groupId}/balances`, 200));
    expect(balances.currency).toBe("TWD");
    expect(balances.sum).toBe("0");
    // Bill: paid 21000 - share (7000 + 22050) = -8050
    // Alice: paid 31500 - share (7000 + 9450) = +15050
    // Bob: paid 0 - share (7000 + 0) = -7000
    expect(balances.balances).toEqual(
      expect.arrayContaining([
        { participantId: ownerMemberId, net: "-8050" },
        { participantId: aliceMemberId, net: "15050" },
        { participantId: bobMemberId, net: "-7000" },
      ]),
    );

    const summary = groupSummarySchema.parse(await req("GET", `/api/groups/${groupId}/summary`, 200));
    expect(summary.totalSpent).toBe("52500");

    // Settlement must stay in group default currency (TWD).
    await req("POST", `/api/groups/${groupId}/settlements`, 422, {
      fromMemberId: bobMemberId,
      toMemberId: aliceMemberId,
      amount: "7000",
      currency: "JPY",
    });

    const plan = settlementPreviewSchema.parse(await req("GET", `/api/groups/${groupId}/settlement-plan`, 200));
    expect(plan.currency).toBe("TWD");
    for (const transfer of plan.transfers) {
      await req("POST", `/api/groups/${groupId}/settlements`, 201, {
        fromMemberId: transfer.fromId,
        toMemberId: transfer.toId,
        amount: transfer.amount,
        currency: "TWD",
      });
    }

    const settled = balancesResultSchema.parse(await req("GET", `/api/groups/${groupId}/balances`, 200));
    expect(settled.balances.every((b) => b.net === "0")).toBe(true);

    // P2-3: Check actor attribution in activity log
    const activity = (await req("GET", `/api/groups/${groupId}/activity`, 200)) as {
      entries: { action: string; summary: string }[];
    };
    const stlEntry = activity.entries.find((e) => e.action === "settlement.recorded");
    expect(stlEntry?.summary).toContain("Bill");
  } finally {
    sqlite.close();
  }
});
