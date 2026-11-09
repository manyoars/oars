-- The V17(2) counts, read from what the pool stores. Run it against the remote database by hand:
--   npx wrangler d1 execute oars-pool --remote --file queries/covenant-funnel.sql
-- (add --json for a machine-readable answer; `--local` reads the local database.) It prints one row of counts and no verdict.
--
-- THE ONE EDIT: name the covenant version between the quotes on the `params` line below. Left empty, it reads the version the pool served most recently.
--
-- version             the covenant version read, and start_day the UTC day the pool first served it (`covenant_served`).
-- installs            distinct install ids whose earliest day in `telemetry_install_days` is on or after start_day, capped at the first 300 by that day, then by install id (so a day that
--                     straddles the cap is cut by id, which is a random UUID and so an arbitrary but repeatable choice).
-- installs_before_cap the same count before the cap.
-- accepted            accounts with an acceptance row for the version (`covenant_acceptances`), input-source accounts left out as the panel leaves them out.
-- depositing_4w       of those, accounts with a counting deposit (`counted_at` set, tier not `none`) at least 28 days after their own acceptance time.
--
-- Not joined: installs and accounts are two counts from one start time, with no link between them. Day grain: an install first seen on start_day counts even if it was seen before the pool served the version that day.
WITH
  params AS (SELECT '' AS named),
  chosen AS (
    SELECT COALESCE(NULLIF(params.named, ''), (SELECT version FROM covenant_served ORDER BY first_served_at DESC, version DESC LIMIT 1)) AS version FROM params
  ),
  started AS (
    SELECT chosen.version AS version, date(covenant_served.first_served_at / 1000, 'unixepoch') AS start_day
    FROM chosen JOIN covenant_served ON covenant_served.version = chosen.version
  ),
  firsts AS (
    SELECT install, MIN(day) AS first_day FROM telemetry_install_days GROUP BY install
  ),
  cohort AS (
    SELECT firsts.install AS install, firsts.first_day AS first_day FROM firsts JOIN started ON firsts.first_day >= started.start_day
  ),
  capped AS (
    SELECT install FROM cohort ORDER BY first_day, install LIMIT 300
  ),
  takers AS (
    SELECT covenant_acceptances.account AS account, covenant_acceptances.accepted_at AS accepted_at
    FROM covenant_acceptances
    JOIN chosen ON chosen.version = covenant_acceptances.version
    JOIN accounts ON accounts.id = covenant_acceptances.account AND accounts.source = 'user'
  )
SELECT
  chosen.version AS version,
  started.start_day AS start_day,
  (SELECT COUNT(*) FROM capped) AS installs,
  (SELECT COUNT(*) FROM cohort) AS installs_before_cap,
  (SELECT COUNT(*) FROM takers) AS accepted,
  (SELECT COUNT(*) FROM takers WHERE EXISTS (
    SELECT 1 FROM deposits
    WHERE deposits.account = takers.account AND deposits.counted_at IS NOT NULL AND deposits.tier <> 'none' AND deposits.counted_at >= takers.accepted_at + 28 * 86400000
  )) AS depositing_4w
FROM chosen LEFT JOIN started ON started.version = chosen.version;
