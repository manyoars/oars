-- The ledger plane has no expiry: `deposits` and `contributors` rows are never deleted. These triggers make the database refuse it, so a delete path added later fails loudly instead of quietly shrinking what the pool can audit.
-- A legally required erasure would be one later migration that drops these two triggers (and says why); nothing else lifts the rule.
CREATE TRIGGER deposits_no_delete BEFORE DELETE ON deposits BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
CREATE TRIGGER contributors_no_delete BEFORE DELETE ON contributors BEGIN SELECT RAISE(ABORT, 'ledger rows are never deleted'); END;
