-- Installs since a covenant version was first served, counted from the first run each install sends. Run it against the remote database by hand, from packages/pool in a POSIX shell:
--   npx wrangler d1 execute oars-pool --remote --json --command="$(cat queries/first-run-installs.sql)"
-- A remote --file is a D1 import and prints only totals, not rows, so the query goes in through --command, with the equals sign because the file opens with a comment and a bare value starting with a dash reads as a flag. `--local --file queries/first-run-installs.sql` reads the local database. It prints counts and no verdict.
--
-- THE ONE EDIT: name the covenant version between the quotes on the `params` line below. Left empty, it reads the version the pool served most recently.
--
-- One row for all installs, `(all)`, then one row for each listing surface the CLI named on a first run (`npm-global`, `npx`, `claude-plugin`, `codex-plugin`, `gemini-extension`, `unknown`).
-- version             the covenant version read, and start_day the UTC day the pool first served it (`covenant_served`).
-- first_run_installs  distinct install ids whose first `first-run` event reached the pool on or after start_day. An install counts once, on the day of its earliest first-run event.
-- ci_installs         of those, installs whose first run reported that it ran in CI; non_ci_installs is the rest. The two add up to first_run_installs.
--
-- The count reads the nightly rollup (`telemetry_install_days`), so a run is counted from the night after it arrived and not before. An install that sends no first-run event (telemetry off, or the settings file kept without
-- its install id) is not counted, and an install that is reinstalled with a new install id counts again. An install whose first-run events named two surfaces is counted under the first name alphabetically.
-- A day past the rollup's 800 batch read limit (docs/pool.md, Bounds) undercounts, and an install whose first run fell in the unread batches is not counted.
-- Day grain: the day is the one the batch arrived (UTC), so an install that first ran on start_day counts even if it ran before the pool served the version that day.
-- Not joined: this count and the acceptance count (queries/covenant-funnel.sql) are two counts from one start time, with no link between an install and an account.
WITH
  params AS (SELECT '' AS named),
  chosen AS (
    SELECT COALESCE(NULLIF(params.named, ''), (SELECT version FROM covenant_served ORDER BY first_served_at DESC, version DESC LIMIT 1)) AS version FROM params
  ),
  started AS (
    SELECT chosen.version AS version, date(covenant_served.first_served_at / 1000, 'unixepoch') AS start_day
    FROM chosen JOIN covenant_served ON covenant_served.version = chosen.version
  ),
  cells AS (
    SELECT
      telemetry_install_days.install AS install,
      telemetry_install_days.day AS day,
      substr(json_extract(cell.value, '$.metric'), 11) AS surface,
      json_extract(cell.value, '$.hits') > 0 AS in_ci
    FROM telemetry_install_days, json_each(telemetry_install_days.measures) AS cell
    WHERE substr(json_extract(cell.value, '$.metric'), 1, 10) = 'first-run.'
  ),
  firsts AS (
    SELECT install, MIN(day) AS first_day, MIN(surface) AS surface, MAX(in_ci) AS in_ci FROM cells GROUP BY install
  ),
  cohort AS (
    SELECT firsts.install AS install, firsts.surface AS surface, firsts.in_ci AS in_ci FROM firsts JOIN started ON firsts.first_day >= started.start_day
  )
SELECT
  chosen.version AS version,
  started.start_day AS start_day,
  '(all)' AS surface,
  (SELECT COUNT(*) FROM cohort) AS first_run_installs,
  (SELECT COUNT(*) FROM cohort WHERE in_ci = 1) AS ci_installs,
  (SELECT COUNT(*) FROM cohort WHERE in_ci = 0) AS non_ci_installs
FROM chosen LEFT JOIN started ON started.version = chosen.version
UNION ALL
SELECT
  chosen.version AS version,
  started.start_day AS start_day,
  cohort.surface AS surface,
  COUNT(*) AS first_run_installs,
  SUM(cohort.in_ci = 1) AS ci_installs,
  SUM(cohort.in_ci = 0) AS non_ci_installs
FROM chosen JOIN started ON started.version = chosen.version JOIN cohort
GROUP BY cohort.surface
ORDER BY surface;
