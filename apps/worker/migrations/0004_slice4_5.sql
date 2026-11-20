-- Slice 4 & 5: FX converted minor amounts, original shares, R2 receipt attachments, and MCP idempotency keys.

ALTER TABLE expenses ADD COLUMN converted_amount_minor INTEGER;
UPDATE expenses SET converted_amount_minor = amount_minor WHERE converted_amount_minor IS NULL;

ALTER TABLE expense_shares ADD COLUMN original_amount_minor INTEGER;
UPDATE expense_shares SET original_amount_minor = amount_minor WHERE original_amount_minor IS NULL;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  expense_id TEXT REFERENCES expenses(id),
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  upload_token_hash TEXT,
  upload_expires_at INTEGER,
  deleted_at INTEGER,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX attachments_group_id ON attachments (group_id);
CREATE INDEX attachments_expense_id ON attachments (expense_id);
CREATE UNIQUE INDEX attachments_r2_key ON attachments (r2_key);

CREATE TABLE idempotency_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idempotency_user_action_key ON idempotency_keys (user_id, action, key);
