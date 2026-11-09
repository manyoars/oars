-- The raw yes is tied to the covenant it answered, and a withdrawal leaves a record (t1050; GDPR Articles 7(1), 7(3), 9(2)(a)).
-- `raw_consent` stays the time the standing yes was recorded; `raw_consent_version` is the covenant version that yes answered. A yes with no version (a row from before this column) reads as not asked.
-- A withdrawal clears both and writes the time and the version it withdrew into the two columns below, which a later yes does not clear: they are what an erasure of raw copies already held reads.
ALTER TABLE accounts ADD COLUMN raw_consent_version TEXT;
ALTER TABLE accounts ADD COLUMN raw_consent_withdrawn_at INTEGER;
ALTER TABLE accounts ADD COLUMN raw_consent_withdrawn_version TEXT;
