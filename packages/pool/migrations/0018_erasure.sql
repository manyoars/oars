-- Erasure (S11). The ledger never deletes (0009, 0011), so an erasure replaces content in place and leaves a tombstone, so the same content cannot come back through a later deposit, and an audit row that holds no content. Only the operator's own command writes either table.
-- `kind` is what was erased: `raw-object` (digest of the R2 key), `deposit` (digest of `account/id`), or `value` (digest of a leaked value). `reason` is the class: `raw`, `leaked-secret`, or `lawful-request`. `erased_on` is the UTC date.
CREATE TABLE erasure_tombstones (kind TEXT NOT NULL, digest TEXT NOT NULL, reason TEXT NOT NULL, erased_on TEXT NOT NULL, PRIMARY KEY (kind, digest)) STRICT, WITHOUT ROWID;
-- One row per run of the command: how many ledger rows and R2 objects it erased. `account` is the pool's own pseudonymous id and nothing else about anyone; no content is ever written here.
CREATE TABLE erasure_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, reason TEXT NOT NULL, erased_on TEXT NOT NULL, rows_erased INTEGER NOT NULL, objects_erased INTEGER NOT NULL, account TEXT) STRICT;
-- Both are append-only, as the ledger is: a later change that edits or drops a tombstone fails loudly.
CREATE TRIGGER erasure_tombstones_no_delete BEFORE DELETE ON erasure_tombstones BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER erasure_tombstones_no_update BEFORE UPDATE ON erasure_tombstones BEGIN SELECT RAISE(ABORT, 'tombstones are never changed'); END;
CREATE TRIGGER erasure_audit_no_delete BEFORE DELETE ON erasure_audit BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER erasure_audit_no_update BEFORE UPDATE ON erasure_audit BEGIN SELECT RAISE(ABORT, 'audit rows are never changed'); END;
-- A ledger row whose content was erased keeps its place and its counts; `erased_on` marks it, and it is the only column an erasure sets beyond the content itself.
ALTER TABLE deposits ADD COLUMN erased_on TEXT;
ALTER TABLE raw_objects ADD COLUMN erased_on TEXT;
