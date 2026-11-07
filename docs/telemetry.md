# Telemetry

`oars` records how it is used, on your machine, and says so. This page is the whole list of what it records, what it never records, when anything is sent, and how to stop it. The code is in `packages/cli/src/telemetry/`; the schema that decides what may be written is `schema.ts` there.

## What happens

- On the first run that is not a hook, `oars` prints a notice on stderr, once, and records that it did. A hook (`oars gate hook`, `hook-bin.js`) never prints it, and a hook's stdout is the same with telemetry as without.
- Each CLI command, and each fire of a hook (the bare `oars gate hook` included), then leaves an event in a spool: `<config>/oars/telemetry/events.jsonl` (`<config>` is `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere). The spool is append-only and capped at 1 MiB; at the cap the file becomes `events.1.jsonl`, replacing the one before, so the folder never holds more than 2 MiB. Rotation is best-effort: two oars processes that rotate at the same moment can drop the events of one rotated file. Two first runs at the same moment share one install id.
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

### `hook`

One per fire of a hook: the bare `oars gate hook` (recorded by its own process, written after its answer is printed), and the five hooks `hook-bin.js` runs. A hook's stdout and exit code are the same with telemetry on, off, or unwritable.

| Field | What it holds |
|---|---|
| `name` | Which hook: `session-start`, `pre-tool`, `post-tool`, `stop`, `nightly`, or `gate` (the bare `oars gate hook`). |
| `latencyMs` | How long the hook's handler took, in milliseconds, not counting node's own start. |
| `outcome` | `hit` (it printed context or a deny, or deposited), `miss` (it found nothing), `held` (it had something and the holdback arm kept it from the agent), or `error` (it failed open, or the process deadline ended it before it finished; that fire is written once, with no bytes). |
| `bytes` | The size of what the hook printed to stdout; 0 when nothing. |
| `harnessVersion`, `model` | When the hook saw them (the hook input's `model`, or the last 64 KB of the transcript the input names, the same bounded read a push makes; the path is never recorded): a public version or model name as the pool's vocabulary lists it, else `other`. Absent when the hook did not see one. |

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
| `batched`, `bytes` | Batches the pass wrote, and their total size in bytes. |
| `sent` | On a `send`: 1. |
| `excludedFolder`, `excludedTerm`, `excludedNoRaw`, `excludedNoTerms`, `excludedUnreadable` | How many sessions each session gate kept out: a folder not on the allowlist, an exclusion term, no raw to scan, no term file, and unreadable. A count each, never which folder or which term. |
| `notEnded`, `uncaptured`, `refused`, `withdrawn`, `discarded` | Sessions that had not ended, sessions with nothing to build, sessions the vocabulary refused, batches removed because their session no longer passes, and batches built under an older format. |

### `fetch`

One per `oars pool fetch` that reached the pool, whatever the pool answered: a refused fetch and a bundle that fails verification count as fetches, with no `reads`.

| Field | What it holds |
|---|---|
| `harness` | The harness fetched, from the pool's list (`claude-code`, `cursor`, `codex`, `copilot`, `gemini`, `grok`, `vscode-copilot`, or `other`). |
| `fetches` | 1. |
| `etagHits` | 1 when the pool answered 304 (the kept bundle is current). |
| `capHits` | 1 when the pool's weekly fetch cap refused it. |
| `reads` | The reads in the bundle fetched or kept. |

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
