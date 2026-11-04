-- The fetch cap (t812): fetches per account per ISO week replace the capped read count. A 304 spends none.
ALTER TABLE accounts DROP COLUMN reads_served;
ALTER TABLE accounts ADD COLUMN fetch_week TEXT;
ALTER TABLE accounts ADD COLUMN fetches INTEGER NOT NULL DEFAULT 0;
-- One row that moves with every change to the pool's rows, so a bundle's ETag is known without reading them. A conditional request can then never cost a parse.
CREATE TABLE pool_generation (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL) STRICT;
INSERT INTO pool_generation (id, generation) VALUES (1, 0);
CREATE TRIGGER deposits_generation_insert AFTER INSERT ON deposits BEGIN UPDATE pool_generation SET generation = generation + 1; END;
CREATE TRIGGER deposits_generation_delete AFTER DELETE ON deposits BEGIN UPDATE pool_generation SET generation = generation + 1; END;
CREATE TRIGGER deposits_generation_update AFTER UPDATE OF skeleton ON deposits WHEN OLD.skeleton <> NEW.skeleton BEGIN UPDATE pool_generation SET generation = generation + 1; END;
