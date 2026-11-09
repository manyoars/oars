-- The covenant record. `accounts.covenant` still holds the one version an account has accepted now, and the deposit gate still reads it; a new version overwrites it, so it cannot say who accepted what or when.
-- `covenant_acceptances` is the history: one row per account and version, the epoch ms of the first acceptance. Acceptance is the consent to upload, so the version and the time are kept and a later version adds a row beside the earlier one.
CREATE TABLE covenant_acceptances (account TEXT NOT NULL REFERENCES accounts(id), version TEXT NOT NULL, accepted_at INTEGER NOT NULL, PRIMARY KEY (account, version)) STRICT, WITHOUT ROWID;
-- `covenant_served` holds, once per version, the epoch ms the pool first served it (the first `GET /v1/covenant` or acceptance with that version in force). It is the start of the funnel's cohort, and nothing else records when a Worker secret was set.
CREATE TABLE covenant_served (version TEXT PRIMARY KEY, first_served_at INTEGER NOT NULL) STRICT, WITHOUT ROWID;
-- Both are append-only, as the ledger is: a first time never moves, and a later change that edits or drops a row fails loudly.
CREATE TRIGGER covenant_acceptances_no_delete BEFORE DELETE ON covenant_acceptances BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER covenant_acceptances_no_update BEFORE UPDATE ON covenant_acceptances BEGIN SELECT RAISE(ABORT, 'acceptance rows are never changed'); END;
CREATE TRIGGER covenant_served_no_delete BEFORE DELETE ON covenant_served BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER covenant_served_no_update BEFORE UPDATE ON covenant_served BEGIN SELECT RAISE(ABORT, 'served rows are never changed'); END;
