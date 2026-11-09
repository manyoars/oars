-- Where a deposit came from. The pool stamps each ledger row from the credential that sent it, never from the batch: `machine` is the opaque id of the machine whose key sent it (null for the account's own credential), `host_class` is that machine's class (`local` for the account credential, which is a person at the machine), and `launcher` is its launcher (`unknown` for the account credential, which cannot say who started the session). A batch sent again under another credential is stamped again, so a row carries the provenance of the write that last set it.
-- `machine` has no foreign key: a ledger row is never deleted (migration 0009), so a later sweep of old machine rows must not be held up by, or reach into, the ledger.
-- `claimed_host_class` and `claimed_launcher` are the one place a batch is believed about itself: a batch held on a branch or pulled from a cloud session is sent later under the account credential, and its sender states the class and launcher it ran under. They are null when the batch states none. They never replace the stamp above and reach no tier.
-- Rows written before this migration read as the account credential's: no machine, `local`, `unknown`, no claim.
ALTER TABLE deposits ADD COLUMN machine TEXT;
ALTER TABLE deposits ADD COLUMN host_class TEXT NOT NULL DEFAULT 'local';
ALTER TABLE deposits ADD COLUMN launcher TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE deposits ADD COLUMN claimed_host_class TEXT;
ALTER TABLE deposits ADD COLUMN claimed_launcher TEXT;
-- The UTC day (`YYYY-MM-DD`) of the last deposit stored with the machine's key, null until it has one. A day and not a time: the account sees when a machine last deposited, not when in the day.
ALTER TABLE machines ADD COLUMN last_deposit_day TEXT;
-- How many days the key lives from its activation, as enrollment asked (`days`, 1 to 365), null for the pool's default. The default lives in the code (`KEY_LIFE_MS`), so changing it moves every machine that asked for none; the token's own 24 hours are not this.
ALTER TABLE machines ADD COLUMN key_days INTEGER;
