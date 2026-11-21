import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ledgerTables } from "../src/db/schema.ts";

const expected = [
  "users",
  "auth_identities",
  "sessions",
  "groups",
  "group_members",
  "invite_links",
  "expenses",
  "expense_shares",
  "settlements",
  "payment_profiles",
  "attachments",
  "idempotency_keys",
  "activity_log",
  "line_push_targets",
  "oauth_clients",
  "oauth_authorization_codes",
  "oauth_access_tokens",
];

describe("ledger schema", () => {
  it("lists the target D1 tables", () => {
    expect(ledgerTables.map((table) => getTableName(table)).sort()).toEqual([...expected].sort());
  });
});
