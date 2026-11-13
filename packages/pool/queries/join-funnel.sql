-- Where the first runs of `oars pool join` stop, step by step, counted from the `join-step` events (docs/telemetry.md). Run it against the remote database by hand, from packages/pool in a POSIX shell:
--   npx wrangler d1 execute oars-pool --remote --json --command="$(cat queries/join-funnel.sql)"
-- A remote --file is a D1 import and prints only totals, not rows, so the query goes in through --command, with the equals sign because the file opens with a comment and a bare value starting with a dash reads as a flag. `--local --file queries/join-funnel.sql` reads the local database.
--
-- THE ONE EDIT: name the covenant version between the quotes on the `params` line below. Left empty, it reads the version the pool served most recently. Beside queries/covenant-funnel.sql, which counts the acceptances this funnel leads to.
--
-- One row for each step, in the order the join runs them: signin, region, terms, batch, outbox, covenant, send.
-- version     the covenant version read, and start_day the UTC day the pool first served it (`covenant_served`).
-- installs    distinct install ids whose first `join-step` event reached the pool on or after start_day. The same number on every row: the cohort.
-- reached     of those, installs with a step event of `done` or `skipped` for this step (a resumed run skips what stands, so a step finished on an earlier run counts as reached). `none` (covenant and send of a run with no session ready to deposit) is neither: nothing was done, and it never counts as reached.
-- stopped     of those, installs with a `stopped` event for this step and none of `done` or `skipped`: where the run ended and has not yet been resumed past.
--
-- The count reads the nightly rollup (`telemetry_install_days`), so an event is counted from the night after it arrived and not before. An install with telemetry off sends nothing and is not counted. An install that is reinstalled with a new install id counts again.
-- A day past the rollup's 800 batch read limit (docs/pool.md, Bounds) undercounts. Day grain: the day is the one the batch arrived (UTC).
-- Not joined: an install is not linked to an account or a deposit, so this funnel ends at the send step. The share of first runs that reach a counting deposit is the `send` row's reached over installs here, read beside the counting accounts of queries/covenant-funnel.sql.
WITH
  params AS (SELECT '' AS named),
  chosen AS (
    SELECT COALESCE(NULLIF(params.named, ''), (SELECT version FROM covenant_served ORDER BY first_served_at DESC, version DESC LIMIT 1)) AS version FROM params
  ),
  started AS (
    SELECT chosen.version AS version, date(covenant_served.first_served_at / 1000, 'unixepoch') AS start_day
    FROM chosen JOIN covenant_served ON covenant_served.version = chosen.version
  ),
  steps(place, step) AS (
    VALUES (1, 'signin'), (2, 'region'), (3, 'terms'), (4, 'batch'), (5, 'outbox'), (6, 'covenant'), (7, 'send')
  ),
  cells AS (
    SELECT
      telemetry_install_days.install AS install,
      telemetry_install_days.day AS day,
      substr(json_extract(cell.value, '$.metric'), 11, instr(substr(json_extract(cell.value, '$.metric'), 11), '.') - 1) AS step,
      substr(json_extract(cell.value, '$.metric'), 11 + instr(substr(json_extract(cell.value, '$.metric'), 11), '.')) AS state
    FROM telemetry_install_days, json_each(telemetry_install_days.measures) AS cell
    WHERE substr(json_extract(cell.value, '$.metric'), 1, 10) = 'join-step.'
  ),
  firsts AS (
    SELECT install, MIN(day) AS first_day FROM cells GROUP BY install
  ),
  cohort AS (
    SELECT firsts.install AS install FROM firsts JOIN started ON firsts.first_day >= started.start_day
  ),
  seen AS (
    SELECT cells.install AS install, cells.step AS step,
      MAX(cells.state IN ('done', 'skipped')) AS reached,
      MAX(cells.state = 'stopped') AS stopped
    FROM cells JOIN cohort ON cohort.install = cells.install
    GROUP BY cells.install, cells.step
  )
SELECT
  chosen.version AS version,
  started.start_day AS start_day,
  steps.step AS step,
  (SELECT COUNT(*) FROM cohort) AS installs,
  (SELECT COUNT(*) FROM seen WHERE seen.step = steps.step AND seen.reached = 1) AS reached,
  (SELECT COUNT(*) FROM seen WHERE seen.step = steps.step AND seen.reached = 0 AND seen.stopped = 1) AS stopped
FROM chosen JOIN started ON started.version = chosen.version, steps
ORDER BY steps.place;
