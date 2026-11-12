-- The V17(2) counts, read from what the pool stores. Run it against the remote database by hand, from packages/pool in a POSIX shell:
--   npx wrangler d1 execute oars-pool --remote --json --command="$(cat queries/covenant-funnel.sql)"
-- A remote --file is a D1 import and prints only totals, not rows, so the query goes in through --command, with the equals sign because the file opens with a comment and a bare value starting with a dash reads as a flag. `--local --file queries/covenant-funnel.sql` reads the local database. It prints counts and no verdict: one `(all)` row first, then one row for each request country.
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
-- country             `(all)` for the whole version, then one row for each request country (`covenant_acceptances.request_country`, the country Cloudflare reported when the account accepted). A country with fewer than
--                     `min_accounts` accepted accounts (5, the second edit on the `params` line, the same number as the public floor) prints as `other`, so no row stands for a few people. An acceptance with no country is its own row, `(none)`.
--                     A country row counts acceptances only: `installs` and `installs_before_cap` are null on it, because an install is stored with no country.
-- raw_yes             accepted accounts with a standing raw-copy yes (`accounts.raw_consent` set now; a withdrawn yes is not counted), and raw_yes_share is raw_yes over accepted to three places, null when no one accepted.
--
-- Not joined: installs and accounts are two counts from one start time, with no link between them. Day grain: an install first seen on start_day counts even if it was seen before the pool served the version that day.
WITH
  params AS (SELECT '' AS named, 5 AS min_accounts),
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
    SELECT covenant_acceptances.account AS account, covenant_acceptances.accepted_at AS accepted_at, covenant_acceptances.request_country AS country,
      accounts.raw_consent IS NOT NULL AS raw,
      EXISTS (
        SELECT 1 FROM deposits
        WHERE deposits.account = covenant_acceptances.account AND deposits.counted_at IS NOT NULL AND deposits.tier <> 'none' AND deposits.counted_at >= covenant_acceptances.accepted_at + 28 * 86400000
      ) AS depositing
    FROM covenant_acceptances
    JOIN chosen ON chosen.version = covenant_acceptances.version
    JOIN accounts ON accounts.id = covenant_acceptances.account AND accounts.source = 'user'
  ),
  labeled AS (
    SELECT
      CASE
        WHEN takers.country IS NULL THEN '(none)'
        WHEN (SELECT COUNT(*) FROM takers AS same WHERE same.country = takers.country) >= (SELECT min_accounts FROM params) THEN takers.country
        ELSE 'other'
      END AS country,
      takers.account AS account,
      takers.depositing AS depositing,
      takers.raw AS raw
    FROM takers
  )
SELECT * FROM (
  SELECT
    chosen.version AS version,
    started.start_day AS start_day,
    '(all)' AS country,
    (SELECT COUNT(*) FROM capped) AS installs,
    (SELECT COUNT(*) FROM cohort) AS installs_before_cap,
    (SELECT COUNT(*) FROM takers) AS accepted,
    (SELECT COUNT(*) FROM takers WHERE depositing) AS depositing_4w,
    (SELECT COUNT(*) FROM takers WHERE raw) AS raw_yes,
    ROUND(1.0 * (SELECT COUNT(*) FROM takers WHERE raw) / NULLIF((SELECT COUNT(*) FROM takers), 0), 3) AS raw_yes_share
  FROM chosen LEFT JOIN started ON started.version = chosen.version
  UNION ALL
  SELECT chosen.version, started.start_day, labeled.country, NULL, NULL, COUNT(*), SUM(labeled.depositing), SUM(labeled.raw), ROUND(1.0 * SUM(labeled.raw) / COUNT(*), 3)
  FROM chosen LEFT JOIN started ON started.version = chosen.version, labeled
  GROUP BY labeled.country
) ORDER BY CASE country WHEN '(all)' THEN 0 ELSE 1 END, country;
