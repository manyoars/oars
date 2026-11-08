-- The pool serves two floors by cell class. `clusters` stays the weighted count of the accounts that have stood (S13), which a thresholded cell compares to its floor; `clusters_any` is the same weighting over every account that holds the cell,
-- standing or not, which a `clear` cell compares to a clear floor of 1 (a floor of 1 has no k to protect, so waiting for an account to stand protects nothing). Only `recount` writes it. A row written before this migration takes its standing count, a floor under what it will be once recounted.
ALTER TABLE cells ADD COLUMN clusters_any INTEGER NOT NULL DEFAULT 0;
UPDATE cells SET clusters_any = clusters;
-- The generation moves when a served count does, and `clusters_any` is one now.
DROP TRIGGER cells_generation_update;
CREATE TRIGGER cells_generation_update AFTER UPDATE ON cells WHEN OLD.sessions <> NEW.sessions OR OLD.clusters <> NEW.clusters OR OLD.clusters_any <> NEW.clusters_any OR OLD.ok <> NEW.ok OR OLD.failed <> NEW.failed OR OLD.tokens <> NEW.tokens OR OLD.duration_ms <> NEW.duration_ms BEGIN UPDATE pool_generation SET generation = generation + 1; END;
