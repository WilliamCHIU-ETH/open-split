import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Target D1 shape. Migrations are applied per vertical slice; this file may be ahead of them.
 * Money columns are SQLite INTEGER minor units. Drizzle's sqlite integer mode surfaces them as
 * JS numbers. Repository code must pass those through minorFromSafeInteger before any arithmetic.
 * Do not annotate a money field as `number` and then calculate with it.
 */

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  primaryEmail: text("primary_email"),
  // Default deny. MCP OAuth still requires group membership on top of this flag.
  mcpAllowed: integer("mcp_allowed", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const authIdentities = sqliteTable(
  "auth_identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider", { enum: ["line", "google"] }).notNull(),
    subject: text("subject").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("auth_identities_provider_subject").on(table.provider, table.subject)],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  defaultCurrency: text("default_currency").notNull(),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const groupMembers = sqliteTable("group_members", {
  id: text("id").primaryKey(),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id),
  displayName: text("display_name").notNull(),
  // Null until a virtual member is claimed by a real login. See ADR-0004.
  userId: text("user_id").references(() => users.id),
  role: text("role", { enum: ["owner", "member"] }).notNull(),
  claimTokenHash: text("claim_token_hash"),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const inviteLinks = sqliteTable("invite_links", {
  id: text("id").primaryKey(),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id),
  tokenHash: text("token_hash").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const expenses = sqliteTable("expenses", {
  id: text("id").primaryKey(),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id),
  payerMemberId: text("payer_member_id")
    .notNull()
    .references(() => groupMembers.id),
  amountMinor: integer("amount_minor").notNull(),
  currency: text("currency").notNull(),
  // Custom rate against the group default currency: converted = amountMinor * numerator / denominator.
  // Both null means no conversion. Slice 4. Integers only; never a float rate.
  fxNumerator: integer("fx_numerator"),
  fxDenominator: integer("fx_denominator"),
  category: text("category"),
  note: text("note"),
  voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const expenseShares = sqliteTable(
  "expense_shares",
  {
    expenseId: text("expense_id")
      .notNull()
      .references(() => expenses.id),
    memberId: text("member_id")
      .notNull()
      .references(() => groupMembers.id),
    amountMinor: integer("amount_minor").notNull(),
  },
  (table) => [primaryKey({ columns: [table.expenseId, table.memberId] })],
);

export const settlements = sqliteTable("settlements", {
  id: text("id").primaryKey(),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id),
  fromMemberId: text("from_member_id")
    .notNull()
    .references(() => groupMembers.id),
  toMemberId: text("to_member_id")
    .notNull()
    .references(() => groupMembers.id),
  amountMinor: integer("amount_minor").notNull(),
  currency: text("currency").notNull(),
  note: text("note"),
  voidedAt: integer("voided_at", { mode: "timestamp_ms" }),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const paymentProfiles = sqliteTable("payment_profiles", {
  id: text("id").primaryKey(),
  memberId: text("member_id")
    .notNull()
    .references(() => groupMembers.id),
  label: text("label").notNull(),
  // Free text the payee shows friends. Not a payment processor token. No money moves.
  details: text("details").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const activityLog = sqliteTable("activity_log", {
  id: text("id").primaryKey(),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id),
  actorUserId: text("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

// Silent push target for an optional LINE Official Account. Not a chatbot webhook.
export const linePushTargets = sqliteTable("line_push_targets", {
  id: text("id").primaryKey(),
  groupId: text("group_id")
    .notNull()
    .references(() => groups.id),
  destinationId: text("destination_id").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const oauthClients = sqliteTable("oauth_clients", {
  id: text("id").primaryKey(),
  clientName: text("client_name").notNull(),
  redirectUrisJson: text("redirect_uris_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const oauthAuthorizationCodes = sqliteTable("oauth_authorization_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
});

export const oauthAccessTokens = sqliteTable("oauth_access_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const ledgerTables = [
  users,
  authIdentities,
  sessions,
  groups,
  groupMembers,
  inviteLinks,
  expenses,
  expenseShares,
  settlements,
  paymentProfiles,
  activityLog,
  linePushTargets,
  oauthClients,
  oauthAuthorizationCodes,
  oauthAccessTokens,
];
