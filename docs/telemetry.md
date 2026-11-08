# Telemetry

`oars` records how it is used, on your machine, and says so. This page is the whole list of what it records, what it never records, when anything is sent, and how to stop it. The code is in `packages/cli/src/telemetry/`; the schema that decides what may be written is `schema.ts` there.

## What happens

- On the first run that is not a hook, `oars` prints a notice on stderr, once, and records that it did. A hook (`oars gate hook`, `hook-bin.js`) never prints it, and a hook's stdout is the same with telemetry as without.
- Each CLI command, and each fire of a hook (the bare `oars gate hook` included), then leaves an event in a spool: `<config>/oars/telemetry/events.jsonl` (`<config>` is `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere). The spool is append-only and capped at 1 MiB; at the cap the file becomes `events.1.jsonl`, replacing the one before, so the two spool files together hold at most 2 MiB. Rotation is best-effort: two oars processes that rotate at the same moment can drop the events of one rotated file. Two first runs at the same moment share one install id.
- The detached sender (`hook-bin.js nightly`, started by a session-end hook or a command) leaves a `store-health` and a `run-cost` event, `oars pool deposit` leaves a `wire` event for each harness it built batches for and `--send` a `wire-send` event for each send, and a failure oars did not plan for leaves a `crash` event. Each is described below.
- Recording never throws and never changes a command's exit code or output. A spool that cannot be written costs nothing but the event.
- Each event carries the install id: a random UUID made on the first run and kept in `<config>/oars/telemetry/install-id`. It comes from the system's random source, not from your machine, your account, or a path. Delete the file and the next run makes an unrelated one.

## What is sent, and when

The events in the spool are what telemetry sends, unchanged: `oars telemetry show` prints them exactly as stored. They are sent only while telemetry is on and the notice has been shown (`telemetrySendAllowed` in `consent.ts` is checked first: off, or notice not yet shown, means nothing sends), and only to the Many Oars pool (`https://pool.manyoars.com`) or the pool server named in `OARS_POOL_URL`, the setting `oars pool` reads. With none set, the sender tries the Many Oars pool, which is not deployed yet: until it is, every send fails and the spool is kept for the next try.

- **When.** oars installs no scheduler. The detached sender sends, at most about once an hour: a session-end hook starts it after its deposit, and so does any other `oars` command, and a command also starts a telemetry-only send at most once a day. Neither is waited for. A session hook (`oars gate hook`, and the session-start, prompt, pre-tool, and post-tool events of `hook-bin.js`) never sends, and the stop hook only starts the sender; `hook-bin.js` sends only for its `nightly` event, which is the sender's entry. The once-a-day mark is `<config>/oars/telemetry/last-send`. The sender inherits the environment of the hook or command that started it, so it uses `OARS_POOL_URL` from that environment; set it in your user environment for a consistent target, otherwise it tries the Many Oars pool.
- **How.** Events go to `POST /v1/telemetry` in batches of at most 250, each request with a 10 second timeout and no redirects followed. The server keeps each batch whole and indexes its events (`docs/pool.md`, "Telemetry storage"); it stores no IP address or user agent.
- **What clears the spool.** Only a 2xx answer clears the events that batch carried; a line written while the send ran stays. Any other answer, a timeout, or a refused connection keeps the spool as it was, and the next send tries again. Delivery is therefore at least once: a batch whose answer was lost is sent again, so a reader of the data dedupes on the install id and the event time.
- **Stopping it.** `oars telemetry off`, `OARS_TELEMETRY=0`, or `DO_NOT_TRACK=1` stops sending as well as recording. There is no setting that stops only the sending: the events are the spool, and the spool is what is sent.

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

### `hook`

One per fire of a hook: the bare `oars gate hook` (recorded by its own process, written after its answer is printed), and the five hooks `hook-bin.js` runs. A hook's stdout and exit code are the same with telemetry on, off, or unwritable.

| Field | What it holds |
|---|---|
| `name` | Which hook: `session-start`, `prompt` (the `UserPromptSubmit` hook), `pre-tool`, `post-tool`, `stop`, `nightly`, or `gate` (the bare `oars gate hook`). |
| `latencyMs` | How long the hook's handler took, in milliseconds, not counting node's own start. |
| `outcome` | `hit` (it printed context or a deny, or deposited), `miss` (it found nothing), `held` (it had something and the holdback arm kept it from the agent; a session start that held its positions table but still printed its context block is `held`, with that block's bytes), or `error` (it failed open, or the process deadline ended it before it finished; that fire is written once, with no bytes and no harness version or model; a fire whose answer was settled before the deadline keeps its outcome and bytes). |
| `bytes` | The size of what the hook printed to stdout; 0 when nothing. |
| `harness` | The harness the hook ran under, from the closed list the other events use (`claude-code`, `cursor`, `codex`, `copilot`, `gemini`, `grok`, `opencode`, `pi`, `vscode-copilot`), else `other`. Every hook fire carries it, a deadline-ended fire included, except a `nightly` run: the nightly is the detached sender, which runs under no harness, so it carries none and reads as an `unrecorded` harness. An event written before the field existed has none either and is read the same way, never dropped (the schema version stays `1`: the field is additive). |
| `harnessVersion`, `model` | When the hook saw them (the hook input's `model`, or the last 64 KB of the transcript the input names, the same bounded read a push makes; the path is never recorded): a public version or model name as the pool's vocabulary lists it, else `other`. Absent when the hook did not see one: a `nightly` run (it has no hook input) and a deadline-ended fire carry neither. |

### `recall`

One per recall: `oars sessions recall` (every form), the `oars_recall` MCP tool an agent calls, and the push a `pre-tool` hook makes. Counts and closed words only: the query's text, an entity or pattern it named, and the answer it rendered are never recorded.

| Field | What it holds |
|---|---|
| `form` | How it was asked: `pattern`, `entity`, `question`, `text`, or `legacy` (`--error`, `--path`, `--class`). |
| `mode` | `pull` (someone asked) or `push` (a hook offered it). |
| `families` | The read families the answer served, from the closed list (`recovery`, `fit`, `cost`, `change`, `live`, `adoption`, `method`, `next-step`, `tool-day`, `version-boundary`, `substitution`, `interaction`, `day-move`, `entity`). |
| `kind` | `hit` or `miss`. |
| `reads`, `evidence`, `tokens` | How many reads and evidence rows the answer cites, and its size in tokens (a count for comparing arms, not a bill). |
| `arm` | The exposure record the recall also keeps on this machine: `shown`, or `held` (a push the holdback arm kept from the agent). A pull is always `shown`. |

### `deposit`

One per `oars pool deposit` pass (`step` is `build`), and one per batch sent (`step` is `send`). Counts only: no folder, term, session id, name, or batch content.

| Field | What it holds |
|---|---|
| `step` | `build` (a pass that wrote batches to the outbox) or `send` (one batch sent with `--send`). |
| `sessions` | Sessions in the store the pass counted. |
| `batched`, `bytes` | Batches the pass wrote and their total size in bytes; on a `send`, the size of the batch sent. |
| `sent` | On a `send`: 1. |
| `excludedFolder`, `excludedTerm`, `excludedNoRaw`, `excludedNoTerms`, `excludedUnreadable` | How many sessions each session gate kept out: a folder not on the allowlist, an exclusion term, no raw to scan, no term file, and unreadable. A count each, never which folder or which term. |
| `notEnded`, `uncaptured`, `refused`, `withdrawn`, `discarded` | Sessions that had not ended, sessions with nothing to build, sessions the vocabulary refused, batches removed because their session no longer passes, and batches built under an older format. |

### `fetch`

One per `oars pool fetch` that reached the pool, whatever the pool answered: a refused fetch and a bundle that fails verification count as fetches, with no `reads`.

| Field | What it holds |
|---|---|
| `harness` | The harness fetched, from the pool's list (`claude-code`, `cursor`, `codex`, `copilot`, `gemini`, `grok`, `opencode`, `pi`, `vscode-copilot`, or `other`). |
| `fetches` | 1. |
| `etagHits` | 1 when the pool answered 304 (the kept bundle is current). |
| `capHits` | 1 when the pool's weekly fetch cap refused it. |
| `reads` | The reads in the bundle fetched or kept. |

### `store-health`

One per sender run: a snapshot of the session store, counts and sizes only. If the store cannot be read, the event holds `readFailed: 1` and nothing else, and the run goes on.

| Field | What it holds |
|---|---|
| `readFailed` | `1` when the store could not be read. |
| `sessions`, `subagents`, `skeletons` | How many main sessions, subagent transcripts, and skeleton files the store holds. |
| `unparseable` | Transcript lines that did not parse, plus skeleton files that could not be read. |
| `rawBytes` | The size of the store's `raw/` folder, in bytes. |
| `verifyChecked`, `verifyFailed` | How many of `oars sessions verify`'s checks ran, and how many found a violation. |
| `captureVersions`, `extractorVersions` | What the store holds, not what this build writes: the distinct capture versions (`cv`) of its captured sessions, and the distinct extractor versions (`ev`), each sorted ascending. The extractor version is the one each pipeline step last ran at, so an upgrade leaves only the new version once every step has run again. A store with a session behind this build lists two capture versions. |
| `harnessVersions`, `models` | The harness versions and model names the store holds, each only if it is on the public model or version list (`public-vocabulary.ts`), else the word `other`. |
| `outboxBytes`, `egressBytes` | The bytes the pool outbox holds, and the bytes of batches sent in the last seven days (summed from the `wire-send` events below, which the spool keeps only up to its cap, so a very busy week can read low). |

```json
{"v":1,"id":"3f2b8c1e-5d4a-4b7e-9c10-2a6f8e1d7b43","at":"2026-11-07T03:00:41.210Z","type":"store-health","cli":"0.4.0","os":"win32","data":{"sessions":212,"subagents":96,"skeletons":308,"unparseable":2,"rawBytes":48211904,"verifyChecked":14,"verifyFailed":0,"captureVersions":[17,18],"extractorVersions":[12],"harnessVersions":["2.1.30","2.1.37","other"],"models":["claude-opus-4-5","claude-sonnet-4-5"],"outboxBytes":1204331,"egressBytes":0}}
```

### `run-cost`

One per sender run: what it cost.

| Field | What it holds |
|---|---|
| `totalMs`, `parseMs` | The whole run's time, and the part spent reading and parsing transcripts, in milliseconds. |
| `peakRssMb` | The process's peak memory, in megabytes. |
| `failed` | `1` when the run failed or reported an error, else `0`. A count of these events and of those with `failed: 1` is the count of sender runs and failures. |

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

## The report

`oars telemetry report` shows the user what telemetry measured about their own use. It reads the spool on this machine, needs no server and no account, writes nothing, and prints the last 7 days and the last 30. `--json` prints the same numbers as one document.

| Metric | What it is | Grouped by |
|---|---|---|
| `hook.<name>.latency` | how long the hook took: p50 and p95 in milliseconds | the harness and its version, `claude-code/2.1.5`: one version number under two harnesses is two cells |
| `hook.<name>.hit` | the share of fires that found something (`hit` or `held`, over those and `miss`; a hook that failed counts in neither) | the harness and its version |
| `command.<name>.latency` and `command.<name>.failure` | how long a command took, and the share that exited non-zero, under the first name of its path (`pool` for `pool fetch`) | the oars version |
| `store.readFailure` and `store.verifyFailure` | the share of sender snapshots that could not read the store, and that found a session that does not verify | the oars version |

Your latency percentiles are counted in the same buckets as the fleet's (each bucket's upper edge, within a factor of 1.5 of the exact value), so a latency of yours and the fleet's read on one scale. When a fleet read answers, your windows end with the day it is as of (yesterday, UTC), the day its windows end; with none, they end now. The last store snapshot's counts are printed under the numbers. Each metric appears only once the event that carries it is in the spool, so a spool that holds only `command` events shows only the command metrics.

**Beside the fleet.** When `OARS_POOL_URL` names a pool server, the report asks it for `GET /v1/telemetry/fleet` and prints the fleet's percentile under each of the user's own cells that the server serves: the p50 and p95 of the fleet's latencies, or the median install's rate. A cell the server does not serve says `fleet: not served (fewer than 5 installs report this)`. With no server set, the report says `No pool server is configured (OARS_POOL_URL), so these are your numbers only.`; a server that refuses, cannot be reached, or answers something that is not a fleet read is named with its reason, and the user's numbers are printed all the same. The request is a bare GET: it sends no install id, no credential, and nothing from the spool, so asking for the report discloses nothing that sending does not (and it works with telemetry off, since it sends nothing). It is not part of the sender or of any hook.

**What the fleet read may show.** A cell is served only where at least the public floor (`PUBLIC_FLOOR`, 5 by default) distinct installs report it in the window, the same floor in installs as the rest of the pool. It serves percentiles and no counts: no install count, event count, or total. Two served numbers therefore cannot be set against each other to show an install under the floor, and a window's percentile is not the sum of anything. A latency percentile is the upper edge of a histogram bucket, each 1.5 times the one before, so it is within a factor of 1.5 of the true value; the histograms are merged with every install weighing the same, so one install that fires thousands of times does not become the fleet's number. The read serves per harness and harness version (hooks) or per oars version (commands, store) and no total across versions. The local report reads a hook fire from before the `harness` field as `unrecorded/<version>`; fleet rows rolled up before this release keep the bare version, which matches no cell of the report, until they age out of the 30-day window. Nothing in it joins telemetry to a deposit or reaches a bundle.

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
