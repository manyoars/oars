-- The raw tier (t883): a redacted transcript goes to R2, never to D1. D1 holds one ledger row per object and the account's recorded raw consent, which is its own answer, apart from the covenant.
ALTER TABLE accounts ADD COLUMN raw_consent INTEGER;
CREATE TABLE raw_objects (account TEXT NOT NULL REFERENCES accounts(id), sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, capture_version TEXT NOT NULL, redaction_version TEXT NOT NULL, stored_at INTEGER NOT NULL, PRIMARY KEY (account, sha256)) STRICT;
-- Ledger plane: never deleted (0009). Nothing reads this table to serve.
CREATE TRIGGER raw_objects_no_delete BEFORE DELETE ON raw_objects BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
