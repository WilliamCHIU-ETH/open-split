-- Slice 2: remember how an expense was split, and look claim tokens up by hash.
-- Null split_json is a slice 1 equal split. Money stays integer minor units.

ALTER TABLE expenses ADD COLUMN split_json TEXT;

CREATE UNIQUE INDEX group_members_claim_token_hash ON group_members (claim_token_hash);
