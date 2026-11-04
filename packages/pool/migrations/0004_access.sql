-- Access: a deposit buys access. `tier` is the batch's ingest tier, `counted_at` when it first counted toward access, and `accounts.access` the record: null, pending, or standing.
ALTER TABLE deposits ADD COLUMN tier TEXT NOT NULL DEFAULT 'skeleton';
ALTER TABLE deposits ADD COLUMN counted_at INTEGER;
ALTER TABLE accounts ADD COLUMN access TEXT;
