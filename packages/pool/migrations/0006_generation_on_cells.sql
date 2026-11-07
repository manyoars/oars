-- The generation follows the stored cells, not the ledger. A write to a `deposits` row changes no served cell, so a trigger there would move the ETag and answer a conditional read with a spurious 200.
DROP TRIGGER deposits_generation_insert;
DROP TRIGGER deposits_generation_delete;
DROP TRIGGER deposits_generation_update;
-- A cell or stratum changes the bundle only through the counts it serves; a write that leaves them as they were moves nothing.
CREATE TRIGGER cells_generation_insert AFTER INSERT ON cells BEGIN UPDATE pool_generation SET generation = generation + 1; END;
CREATE TRIGGER cells_generation_delete AFTER DELETE ON cells BEGIN UPDATE pool_generation SET generation = generation + 1; END;
CREATE TRIGGER cells_generation_update AFTER UPDATE ON cells WHEN OLD.sessions <> NEW.sessions OR OLD.clusters <> NEW.clusters OR OLD.ok <> NEW.ok OR OLD.failed <> NEW.failed OR OLD.tokens <> NEW.tokens OR OLD.duration_ms <> NEW.duration_ms BEGIN UPDATE pool_generation SET generation = generation + 1; END;
CREATE TRIGGER strata_generation_insert AFTER INSERT ON strata BEGIN UPDATE pool_generation SET generation = generation + 1; END;
CREATE TRIGGER strata_generation_delete AFTER DELETE ON strata BEGIN UPDATE pool_generation SET generation = generation + 1; END;
CREATE TRIGGER strata_generation_update AFTER UPDATE ON strata WHEN OLD.sessions <> NEW.sessions OR OLD.clusters <> NEW.clusters BEGIN UPDATE pool_generation SET generation = generation + 1; END;
