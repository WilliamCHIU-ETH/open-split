-- Slice 3: recorded settlements and one payment profile per member.

CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  from_member_id TEXT NOT NULL REFERENCES group_members(id),
  to_member_id TEXT NOT NULL REFERENCES group_members(id),
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  note TEXT,
  voided_at INTEGER,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE INDEX settlements_group_id ON settlements (group_id);

CREATE TABLE payment_profiles (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES group_members(id),
  label TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX payment_profiles_member_id ON payment_profiles (member_id);
