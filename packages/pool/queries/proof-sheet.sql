-- The proof sheet: the counts a buyer, a funder, or a country decision asks for, read from what the pool stores. Run it against the remote database by hand, from packages/pool in a POSIX shell:
--   npx wrangler d1 execute oars-pool --remote --json --command="$(cat queries/proof-sheet.sql)"
-- A remote --file is a D1 import and prints only totals, not rows, so the query goes in through --command. `--local --file queries/proof-sheet.sql` reads the local database. It prints counts and no verdict.
--
-- THE ONE EDIT: name the covenant version between the quotes on the `params` line below. Left empty, it reads the version the pool served most recently. A second edit, `floor`, is the public floor the pool runs at (5 unless PUBLIC_FLOOR says otherwise).
--
-- One row per number: metric, detail, value, and as_of (the UTC day of the newest row the number read, null when it read none).
-- installs                distinct install ids first seen on or after the day the pool first served the version, with no cap. An install seen on many days counts once.
-- accepted                accounts with an acceptance row for the version, input-source accounts left out.
-- depositing_4w           of the accepted accounts, those with a counting deposit (`counted_at` set, tier not `none`) at least 28 days after their own acceptance. as_of is the newest counting deposit of those accounts.
-- pack_grade_sessions     counting sessions (`account_weeks.sessions`, written only for a batch that counts) by harness, input-source accounts left out. The detail is the harness, `mixed` for an account-week that ran more than one, or `(none)` for one with an empty harness list,
--                         because the pool keeps the harness list per account-week and not per session. as_of is the newest week.
-- served_cells            stored cells with sessions and at least `floor` standing clusters. A clear cell can be served at a lower floor, so this is a lower bound on the served count, not the count itself.
--
-- D1 allows few terms in one compound SELECT, so the rows are built in nested groups.
-- Installs and accounts are not joined: `telemetry_install_days.account` has been empty on every row since the telemetry route stopped reading a credential, so no install-to-account number is printed. It prints no install id and no account id. Day grain, as in the funnel. A day past the rollup's 800 batch read limit undercounts.
WITH
  params AS (SELECT '' AS named, 5 AS floor),
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
  takers AS (
    SELECT covenant_acceptances.account AS account, covenant_acceptances.accepted_at AS accepted_at
    FROM covenant_acceptances
    JOIN chosen ON chosen.version = covenant_acceptances.version
    JOIN accounts ON accounts.id = covenant_acceptances.account AND accounts.source = 'user'
  ),
  depositors AS (
    SELECT takers.account AS account FROM takers WHERE EXISTS (
      SELECT 1 FROM deposits
      WHERE deposits.account = takers.account AND deposits.counted_at IS NOT NULL AND deposits.tier <> 'none' AND deposits.counted_at >= takers.accepted_at + 28 * 86400000
    )
  ),
  grades AS (
    SELECT CASE WHEN json_array_length(account_weeks.harnesses) = 0 THEN '(none)' WHEN json_array_length(account_weeks.harnesses) = 1 THEN json_extract(account_weeks.harnesses, '$[0]') ELSE 'mixed' END AS harness,
      SUM(account_weeks.sessions) AS sessions, MAX(account_weeks.week) AS newest
    FROM account_weeks JOIN accounts ON accounts.id = account_weeks.account AND accounts.source = 'user'
    GROUP BY 1
  )
SELECT * FROM (
  SELECT 'installs' AS metric, '(all)' AS detail, (SELECT COUNT(*) FROM firsts JOIN started ON firsts.first_day >= started.start_day) AS value, (SELECT MAX(day) FROM telemetry_install_days) AS as_of
  UNION ALL SELECT 'accepted', '(all)', (SELECT COUNT(*) FROM takers), (SELECT date(MAX(accepted_at) / 1000, 'unixepoch') FROM takers)
)
UNION ALL SELECT * FROM (
  SELECT 'depositing_4w' AS metric, '(all)' AS detail, (SELECT COUNT(*) FROM depositors) AS value, (SELECT date(MAX(counted_at) / 1000, 'unixepoch') FROM deposits WHERE counted_at IS NOT NULL AND tier <> 'none' AND account IN (SELECT account FROM depositors)) AS as_of
)
UNION ALL SELECT * FROM (
  SELECT 'pack_grade_sessions' AS metric, harness AS detail, sessions AS value, newest AS as_of FROM grades
  UNION ALL SELECT 'served_cells', '(all)', (SELECT COUNT(*) FROM cells, params WHERE cells.sessions > 0 AND cells.clusters >= params.floor), (SELECT MAX(day) FROM cells)
);
