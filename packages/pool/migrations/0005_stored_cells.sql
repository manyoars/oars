-- The stored form. `deposits` is the ledger plane: a batch's projected skeleton, its deltas (the wire carries none yet, so `[]`), and `ingest`, the mark of the write that last set the row, which guards that write's cell increments. Rows here are never deleted (migration 0009 refuses it).
ALTER TABLE deposits ADD COLUMN deltas TEXT NOT NULL DEFAULT '[]';
ALTER TABLE deposits ADD COLUMN ingest TEXT NOT NULL DEFAULT '';
-- The index plane: aggregate cells only, each `clusters` a held count that only grows with new clusters. `key` is `motifId/frameBucket/day/exposed`; `harness_bucket` is its frame bucket's second field, so one version's read touches only its own rows.
CREATE TABLE motifs (motif_id TEXT PRIMARY KEY, motif TEXT NOT NULL) STRICT;
CREATE TABLE cells (key TEXT PRIMARY KEY, harness_bucket TEXT NOT NULL, motif_id TEXT NOT NULL, frame_bucket TEXT NOT NULL, day TEXT NOT NULL, exposed INTEGER NOT NULL, sessions INTEGER NOT NULL, clusters INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL, failed INTEGER NOT NULL, tokens REAL NOT NULL, duration_ms REAL NOT NULL) STRICT;
CREATE INDEX cells_by_harness ON cells (harness_bucket);
-- Rule 3's strata (spec Section 4): one row per (dimension, value) over every harness version.
CREATE TABLE strata (key TEXT PRIMARY KEY, dimension TEXT NOT NULL, value TEXT NOT NULL, sessions INTEGER NOT NULL, clusters INTEGER NOT NULL DEFAULT 0) STRICT;
-- The ledger plane's `contributor` record: one per (cell or stratum, account, UTC day of ingest). It tells a new cluster from a returning one.
CREATE TABLE contributors (kind TEXT NOT NULL, key TEXT NOT NULL, account TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (kind, key, account, day)) STRICT, WITHOUT ROWID;
