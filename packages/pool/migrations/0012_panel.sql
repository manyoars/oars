-- The panel: accounts that deposited in the last four weeks. `source` marks an account that is an input and not a depositor (an operator-fleet or seed account); the default is a user. `panel` holds the last count and the UTC day it was taken, so a fetch reads one row and the ledger is read once a day.
ALTER TABLE accounts ADD COLUMN source TEXT NOT NULL DEFAULT 'user';
CREATE TABLE panel (id INTEGER PRIMARY KEY CHECK (id = 1), day TEXT NOT NULL, accounts INTEGER NOT NULL) STRICT;
CREATE INDEX deposits_recent ON deposits (counted_at) WHERE counted_at IS NOT NULL AND tier <> 'none';
