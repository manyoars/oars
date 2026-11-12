-- The count of deposits eligible for pull-deposits today (docs/pool-deposit-title.md, section 5). Run it the way covenant-funnel.sql shows.
-- It is an upper bound: SQL cannot compare text_sha256 with the held screen, a session can hold several Raw Copies, and pairing and the build rules come after.
WITH ok AS (SELECT a.id FROM accounts a WHERE a.restricted_at IS NULL AND a.raw_consent_version IS NOT NULL AND EXISTS (SELECT 1 FROM covenant_acceptances c WHERE c.account = a.id AND c.version IN ('2.0-4c538c50d706', '2.1-ec0ca3f6ff73') AND c.text_sha256 IS NOT NULL AND c.input IS NOT NULL))
SELECT (SELECT COUNT(*) FROM ok) AS accounts, (SELECT COUNT(*) FROM raw_objects r JOIN ok ON ok.id = r.account WHERE r.erased_on IS NULL) AS raw_copies,
  (SELECT COUNT(*) FROM deposits d JOIN ok ON ok.id = d.account WHERE d.erased_on IS NULL AND d.tier <> 'none') AS deposits;
