-- The wire's versions and its extensions bag, stored with each deposit (conclusion section 17, rules 1 to 4). `format`, `vocab_version`, and `fields_version` are what the batch said it was; `extensions` is the bag, the fields and literals this server did not read, as sent; `other_values` counts the values it read as `other`. Ledger class: kept, never deleted, and read by nothing that serves a bundle. A row from before this migration is format 2, with no versions and an empty bag.
ALTER TABLE deposits ADD COLUMN format INTEGER NOT NULL DEFAULT 2;
ALTER TABLE deposits ADD COLUMN vocab_version TEXT NOT NULL DEFAULT '';
ALTER TABLE deposits ADD COLUMN fields_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deposits ADD COLUMN extensions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE deposits ADD COLUMN other_values INTEGER NOT NULL DEFAULT 0;
