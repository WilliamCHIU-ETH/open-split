-- Slice 1 tables. Settlements, payment profiles, LINE push, and OAuth stay out until their slices.
-- Money columns are integer minor units.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  primary_email TEXT,
  mcp_allowed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX auth_identities_provider_subject ON auth_identities (provider, subject);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX sessions_token_hash ON sessions (token_hash);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  default_currency TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  display_name TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  role TEXT NOT NULL,
  claim_token_hash TEXT,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE invite_links (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  token_hash TEXT NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX invite_links_token_hash ON invite_links (token_hash);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  payer_member_id TEXT NOT NULL REFERENCES group_members(id),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  fx_numerator INTEGER,
  fx_denominator INTEGER,
  category TEXT,
  note TEXT,
  voided_at INTEGER,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE expense_shares (
  expense_id TEXT NOT NULL REFERENCES expenses(id),
  member_id TEXT NOT NULL REFERENCES group_members(id),
  amount_minor INTEGER NOT NULL,
  PRIMARY KEY (expense_id, member_id)
);

CREATE TABLE activity_log (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
