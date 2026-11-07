# Telemetry

`oars` records how it is used, on your machine, and says so. This page is the whole list of what it records, what it never records, when anything is sent, and how to stop it. The code is in `packages/cli/src/telemetry/`; the schema that decides what may be written is `schema.ts` there.

## What happens

- On the first run that is not a hook, `oars` prints a notice on stderr, once, and records that it did. A hook (`oars gate hook`, `hook-bin.js`) never prints it, and a hook's stdout is the same with telemetry as without.
- Each CLI command except the bare `oars gate hook` (which skips the full CLI to stay inside its time budget) then leaves one event in a spool: `<config>/oars/telemetry/events.jsonl` (`<config>` is `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere). The spool is append-only and capped at 1 MiB; at the cap the file becomes `events.1.jsonl`, replacing the one before, so the folder never holds more than 2 MiB. Rotation is best-effort: two oars processes that rotate at the same moment can drop the events of one rotated file. Two first runs at the same moment share one install id.
- Recording never throws and never changes a command's exit code or output. A spool that cannot be written costs nothing but the event.
- Each event carries the install id: a random UUID made on the first run and kept in `<config>/oars/telemetry/install-id`. It comes from the system's random source, not from your machine, your account, or a path. Delete the file and the next run makes an unrelated one.

## What is sent, and when

The events in the spool are what telemetry sends, unchanged: `oars telemetry show` prints them exactly as stored. They are sent only while telemetry is on and the notice has been shown (`telemetrySendAllowed` in `consent.ts` is checked first: off, or notice not yet shown, means nothing sends), and only to the pool server named in `OARS_POOL_URL`, the setting `oars pool` reads. There is no default server: with none set, the events stay in the spool and nothing leaves your machine.

- **When.** The nightly task sends, and a command you run sends at most once a day, from a detached process that your command does not wait for. A session hook (`oars gate hook`, and the session-start, pre-tool, post-tool, and stop events of `hook-bin.js`) never sends; `hook-bin.js` sends only for its `nightly` event. The once-a-day mark is `<config>/oars/telemetry/last-send`. The nightly task sees `OARS_POOL_URL` only if it is in your user environment, not only in one shell.
- **How.** Events go to `POST /v1/telemetry` in batches of at most 250, each request with a 10 second timeout and no redirects followed. The server keeps each batch whole and indexes its events (`docs/pool.md`, "Telemetry storage"); it stores no IP address or user agent.
- **What clears the spool.** Only a 2xx answer clears the events that batch carried; a line written while the send ran stays. Any other answer, a timeout, or a refused connection keeps the spool as it was, and the next send tries again. Delivery is therefore at least once: a batch whose answer was lost is sent again, so a reader of the data dedupes on the install id and the event time.
- **Stopping it.** `oars telemetry off`, `OARS_TELEMETRY=0`, or `DO_NOT_TRACK=1` stops sending as well as recording. Unset `OARS_POOL_URL` to stop only the sending.

## Event types

Every event has the same envelope: `v` (the schema version, `1`), `id` (the install id), `at` (UTC time), `type`, `cli` (the oars version), `os` (`win32`, `darwin`, `linux`, or `other`), `data`, and `dropped` when the schema refused something (see below).

### `command`

One per CLI command, written when it ends.

| Field | What it holds |
|---|---|
| `path` | The command's name path as the program defines it, at most 4 names: `["pool", "fetch"]`. Empty for `--help`, `--version`, or a usage error, since no command ran. |
| `flags` | The names of the options given on the command line, as the program defines them: `["apiUrl", "json"]`. Never a value. |
| `durationMs` | How long the command took, in milliseconds. |
| `exitCode` | The exit code (0 to 255). |
| `errorClass` | Present on a non-zero exit: one of `usage`, `auth`, `invalid`, `conflict`, `rate-limited`, `unreachable`, `capped`, `unexpected`, chosen from the exit code. The error's text is never read. |

An invented example:

```json
{"v":1,"id":"3f2b8c1e-5d4a-4b7e-9c10-2a6f8e1d7b43","at":"2026-11-06T14:03:22.418Z","type":"command","cli":"0.4.0","os":"win32","data":{"path":["pool","fetch"],"flags":["server","harnessVersion"],"durationMs":412,"exitCode":10,"errorClass":"capped"}}
```

Later releases add event types here, one section each.

## What is never recorded or sent

No session content, prompt text, tool output, file path, directory name, URL, argument value, flag value, error message, environment variable, hostname, username, or account. The command path and flag names are the names the program itself declares, never text you typed after them, so `oars sessions recall --error "my private message"` records the flag name `error` and nothing of the message.

## The schema is the control

Every event passes a closed schema before it reaches the spool. A field the schema does not know is dropped; so is a value that does not fit its rule (a name is letters, digits, and hyphens only, which no path, URL, or sentence is; a number is a whole number in a fixed range; `errorClass` is one of the closed words above). Each drop is counted in the event's `dropped`. A test feeds a home path, command text, a prompt-shaped sentence, and a URL to every field of every event type and checks the spool for them.

## The report

`oars telemetry report` shows the user what telemetry measured about their own use. It reads the spool on this machine, needs no server and no account, writes nothing, and prints the last 7 days and the last 30. `--json` prints the same numbers as one document.

| Metric | What it is | Grouped by |
|---|---|---|
| `hook.<name>.latency` | how long the hook took: p50 and p95 in milliseconds | the harness version the hook ran under |
| `hook.<name>.hit` | the share of fires that found something (`hit` or `held`, over those and `miss`; a hook that failed counts in neither) | the harness version |
| `command.<name>.latency` and `command.<name>.failure` | how long a command took, and the share that exited non-zero, under the first name of its path (`pool` for `pool fetch`) | the oars version |
| `store.readFailure` and `store.verifyFailure` | the share of nightly snapshots that could not read the store, and that found a session that does not verify | the oars version |

The last store snapshot's counts are printed under the numbers. Each metric appears only once the event that carries it is in the spool, so a spool that holds only `command` events shows only the command metrics.

**Beside the fleet.** When `OARS_POOL_URL` names a pool server, the report asks it for `GET /v1/telemetry/fleet` and prints the fleet's percentile under each of the user's own cells that the server serves: the p50 and p95 of the fleet's latencies, or the median install's rate. A cell the server does not serve says `fleet: not served (fewer than 5 installs report this)`. With no server set, the report says `No pool server is configured (OARS_POOL_URL), so these are your numbers only.`; a server that refuses, cannot be reached, or answers something that is not a fleet read is named with its reason, and the user's numbers are printed all the same. The request is a bare GET: it sends no install id, no credential, and nothing from the spool, so asking for the report discloses nothing that sending does not (and it works with telemetry off, since it sends nothing). It is not part of the nightly or of any hook.

**What the fleet read may show.** A cell is served only where at least `K_CELL` (5) distinct installs report it in the window, the same floor in installs as the rest of the pool. It serves percentiles and no counts: no install count, event count, or total. Two served numbers therefore cannot be set against each other to show an install under the floor, and a window's percentile is not the sum of anything. A latency percentile is the upper edge of a histogram bucket, each 1.5 times the one before, so it is within a factor of 1.5 of the true value. The read serves per harness version (hooks) or per oars version (commands, store) and no total across versions. Nothing in it joins telemetry to a deposit or reaches a bundle.

**Where the fleet's numbers come from.** A nightly rollup (`docs/pool.md`, "Telemetry rollup") reads the day's kept batches from R2 into one row per install, account, and day, and the read serves from that table. Reading the record rather than Analytics Engine avoids a new secret and a new paid product: a Worker can write Analytics Engine but not read it. An event counts once however many batches carried it.

**The operator's read.** `GET /v1/telemetry/operator`, behind a secret only the pool's operator holds, lists installs and accounts whose event or batch counts over 30 days sit at least 5 robust deviations from the fleet's median (with fewer than 5 of them there is no baseline, so it lists none). It is for a person to read: it flags, limits, and blocks nothing, and it is never served to users. The same read gives the two measurables: the share of installs that reported a batch in the last 7 days over the installs that ever have, and the first day the fleet read served a cell from telemetry alone.

## Switches

- `oars telemetry status` shows whether it is on, which switch decided that, whether the notice was shown, and the spool's size.
- `oars telemetry off` stops recording and sending. The spool and the id stay until you delete the folder.
- `oars telemetry on` resumes, prints the notice, and records that it was shown.
- `OARS_TELEMETRY=0` (also `false`, `off`, `no`) or `DO_NOT_TRACK=1` (also `true`) turns it off for that process, and wins over `oars telemetry on`. Off also stops recording, not just sending.
- `oars telemetry show` prints the spool. `--json` prints the same events as one document.
- `oars telemetry report` prints your own numbers, and the fleet's beside them when a pool server answers (see "The report").

To remove everything telemetry keeps, delete `<config>/oars/telemetry/`.
