-- Cluster weighting (t937): the signals a cell's held count is clustered on, kept only from what the pool already receives. `first_seen` is when the pool first saw the account (epoch ms) and
-- `provider_created` is the provider's account creation time (GitHub's `created_at`; Google gives none). `account_repo_keys` is the repo keys an account's deposits carried and `deposit_hours`
-- the UTC day and hour the pool received each deposit. None of it is served: a read states only the clustered count. `cells.clusters` and `strata.clusters` now hold that weighted count.
ALTER TABLE accounts ADD COLUMN first_seen INTEGER;
ALTER TABLE accounts ADD COLUMN provider_created INTEGER;
CREATE TABLE account_repo_keys (account TEXT NOT NULL REFERENCES accounts(id), repo_key TEXT NOT NULL, PRIMARY KEY (account, repo_key)) STRICT, WITHOUT ROWID;
CREATE TABLE deposit_hours (account TEXT NOT NULL REFERENCES accounts(id), day TEXT NOT NULL, hour INTEGER NOT NULL, PRIMARY KEY (account, day, hour)) STRICT, WITHOUT ROWID;
-- An account that deposited before this migration was first seen no later than its earliest contributor day, so that day stands in for `first_seen` (its next login would otherwise date it after its own deposits and read it as young).
UPDATE accounts SET first_seen = (SELECT CAST(strftime('%s', MIN(day)) AS INTEGER) * 1000 FROM contributors WHERE contributors.account = accounts.id) WHERE first_seen IS NULL AND EXISTS (SELECT 1 FROM contributors WHERE contributors.account = accounts.id);
