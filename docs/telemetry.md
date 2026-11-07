# Telemetry

`oars` records how it is used, on your machine, and says so. This page is the whole list of what it records, what it never records, when anything is sent, and how to stop it. The code is in `packages/cli/src/telemetry/`; the schema that decides what may be written is `schema.ts` there.

## What happens

- On the first run that is not a hook, `oars` prints a notice on stderr, once, and records that it did. A hook (`oars gate hook`, `hook-bin.js`) never prints it, and a hook's stdout is the same with telemetry as without.
- Each CLI command except the bare `oars gate hook` (which skips the full CLI to stay inside its time budget) then leaves one event in a spool: `<config>/oars/telemetry/events.jsonl` (`<config>` is `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere). The spool is append-only and capped at 1 MiB; at the cap the file becomes `events.1.jsonl`, replacing the one before, so the folder never holds more than 2 MiB. Rotation is best-effort: two oars processes that rotate at the same moment can drop the events of one rotated file. Two first runs at the same moment share one install id.
- The nightly task (`hook-bin.js nightly`) leaves a `store-health` and a `run-cost` event, `oars pool deposit` leaves a `wire` event for each harness it built batches for and `--send` a `wire-send` event for each send, and a failure oars did not plan for leaves a `crash` event. Each is described below.
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

### `store-health`

One per nightly run: a snapshot of the session store, counts and sizes only. If the store cannot be read, the event holds `readFailed: 1` and nothing else, and the nightly run goes on.

| Field | What it holds |
|---|---|
| `readFailed` | `1` when the store could not be read. |
| `sessions`, `subagents`, `skeletons` | How many main sessions, subagent transcripts, and skeleton files the store holds. |
| `unparseable` | Transcript lines that did not parse, plus skeleton files that could not be read. |
| `rawBytes` | The size of the store's `raw/` folder, in bytes. |
| `verifyChecked`, `verifyFailed` | How many of `oars sessions verify`'s checks ran, and how many found a violation. |
| `captureVersions`, `extractorVersions` | What the store holds, not what this build writes: the distinct capture versions (`cv`) of its captured sessions, and the distinct extractor versions (`ev`), each sorted ascending. The extractor version is the one each pipeline step last ran at, so an upgrade leaves only the new version once every step has run again. A store with a session behind this build lists two capture versions. |
| `harnessVersions`, `models` | The harness versions and model names the store holds, each only if it is on the public list the pool wire uses, else the word `other`. |
| `outboxBytes`, `egressBytes` | The bytes the pool outbox holds, and the bytes of batches sent in the last seven days (summed from the `wire-send` events below, which the spool keeps only up to its cap, so a very busy week can read low). |

```json
{"v":1,"id":"3f2b8c1e-5d4a-4b7e-9c10-2a6f8e1d7b43","at":"2026-11-07T03:00:41.210Z","type":"store-health","cli":"0.4.0","os":"win32","data":{"sessions":212,"subagents":96,"skeletons":308,"unparseable":2,"rawBytes":48211904,"verifyChecked":14,"verifyFailed":0,"captureVersions":[17,18],"extractorVersions":[12],"harnessVersions":["2.1.30","2.1.37","other"],"models":["claude-opus-4-5","claude-sonnet-4-5"],"outboxBytes":1204331,"egressBytes":0}}
```

### `run-cost`

One per nightly run: what it cost.

| Field | What it holds |
|---|---|
| `totalMs`, `parseMs` | The whole run's time, and the part spent reading and parsing transcripts, in milliseconds. |
| `peakRssMb` | The process's peak memory, in megabytes. |
| `failed` | `1` when the run failed or reported an error, else `0`. A count of these events and of those with `failed: 1` is the count of nightly runs and failures. |

```json
{"v":1,"id":"3f2b8c1e-5d4a-4b7e-9c10-2a6f8e1d7b43","at":"2026-11-07T03:00:44.002Z","type":"run-cost","cli":"0.4.0","os":"win32","data":{"totalMs":3790,"parseMs":2410,"peakRssMb":412,"failed":0}}
```

### `crash`

One per failure oars did not plan for (anything that is not one of its own errors or commander's usage errors). The failure is handled as before: the same message on stderr, the same exit code.

| Field | What it holds |
|---|---|
| `errorClass` | `Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`, `EvalError`, `URIError`, `AggregateError`, or `other`, chosen from the error's built-in base class. |
| `stackHash` | 16 hex characters: a hash of the stack's frames with every file path reduced to a hash of its place inside the package (or of the whole path when it is not inside one). The error's message is never read, because it can hold a path. |

```json
{"v":1,"id":"3f2b8c1e-5d4a-4b7e-9c10-2a6f8e1d7b43","at":"2026-11-07T14:22:09.771Z","type":"crash","cli":"0.4.0","os":"linux","data":{"errorClass":"TypeError","stackHash":"9be41c07a2d5f630"}}
```

### `wire`

One per harness, per `oars pool deposit` pass: which fields of the pool wire's field register the batches carried, and what they cost. The names are only those of the register (`oars pool outbox --explain` lists it); a value is never recorded, only its size. The three lists run side by side: entry *n* of each is about the same field.

| Field | What it holds |
|---|---|
| `harness` | The harness that wrote the batches, or `other`. |
| `batches`, `bytes` | How many batches the pass wrote for it, and their total size in bytes. |
| `fields` | The register's field names the batches held, sorted. |
| `present` | For each field, in how many of the batches it appeared (a narrow field is rare here). |
| `fieldBytes` | For each field, the bytes of its values across the batches. A field that holds others counts them too, so a parent is never smaller than its children. |

```json
{"v":1,"id":"3f2b8c1e-5d4a-4b7e-9c10-2a6f8e1d7b43","at":"2026-11-07T03:05:12.004Z","type":"wire","cli":"0.4.0","os":"win32","data":{"harness":"claude-code","batches":4,"bytes":83120,"fields":["action","harness","steps"],"present":[4,4,4],"fieldBytes":[912,52,61402]}}
```

### `wire-send`

One per send of one batch (`oars pool deposit --send`). Refusals are counted by the pool's own code.

| Field | What it holds |
|---|---|
| `sent` | `1` when the pool took the batch (HTTP 201), else `0`. |
| `status` | The HTTP status. |
| `code` | The pool's problem code on a refusal, as lowercase words joined with underscores. Anything that is not shaped like a code is dropped. |
| `bytes` | The size of the batch that was sent. |

```json
{"v":1,"id":"3f2b8c1e-5d4a-4b7e-9c10-2a6f8e1d7b43","at":"2026-11-07T03:06:30.915Z","type":"wire-send","cli":"0.4.0","os":"win32","data":{"sent":0,"status":429,"code":"rate_limited","bytes":20780}}
```

Later releases add event types here, one section each.

## What is never recorded or sent

No session content, prompt text, tool output, file path, directory name, URL, argument value, flag value, error message, environment variable, hostname, username, or account. The command path and flag names are the names the program itself declares, never text you typed after them, so `oars sessions recall --error "my private message"` records the flag name `error` and nothing of the message.

## The schema is the control

Every event passes a closed schema before it reaches the spool. A field the schema does not know is dropped; so is a value that does not fit its rule (a name is letters, digits, and hyphens only, which no path, URL, or sentence is; a number is a whole number in a fixed range; `errorClass` is one of the closed words above). Each drop is counted in the event's `dropped`. A test feeds a home path, command text, a prompt-shaped sentence, and a URL to every field of every event type and checks the spool for them.

## Switches

- `oars telemetry status` shows whether it is on, which switch decided that, whether the notice was shown, and the spool's size.
- `oars telemetry off` stops recording and sending. The spool and the id stay until you delete the folder.
- `oars telemetry on` resumes, prints the notice, and records that it was shown.
- `OARS_TELEMETRY=0` (also `false`, `off`, `no`) or `DO_NOT_TRACK=1` (also `true`) turns it off for that process, and wins over `oars telemetry on`. Off also stops recording, not just sending.
- `oars telemetry show` prints the spool. `--json` prints the same events as one document.

To remove everything telemetry keeps, delete `<config>/oars/telemetry/`.
