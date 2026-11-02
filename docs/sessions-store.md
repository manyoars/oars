# The `oars sessions` store (version 4)

`oars sessions` keeps a local, deterministic memory of the operator's own Claude Code sessions: no model call, no network, nothing
uploads. This page is the store's format. The types are in `packages/cli/src/sessions/schema.ts`; the commands are in the CLI README.

## Layout

Under `<config>/oars/sessions/` (`%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere):

| Path | What it holds |
|------|---------------|
| `observations.jsonl` | The append-only log of captured records. A changed transcript is deposited again under a higher `rev`; readers keep only the highest `rev` of each session. |
| `derived.json` | The derived records, rewritten from the log alone at the end of every deposit. |
| `hook-index.json` | The recurring error signatures per project and overall, read by the hooks. |
| `skeletons/<session>.json` | One per transcript: ids, timestamps, tool linkage, token counts, a SHA-256 for every content field, and a Merkle root over the raw lines. Hashes only, never content. `verify` checks these. |
| `state.json` | Per file: size, mtime, the `rev`, capture version (`v`), `sid`, and the `--redact-domain` set, so an unchanged file is skipped. |
| `salt` | This machine's salt, which file targets are hashed with. Local-only (class `L`), never shared. Its `sid` (the first 8 hex characters of its SHA-256) is stamped on every capture record. |
| `pipeline-runs.jsonl` | The step log: one row per run of a pipeline step (deposit, derive, index, verify, recall), appended when the step ends. See "The step log". |
| `raw/<project>/<path>` | oars' own archive of every deposited transcript (below). |

## Two versions

- `CAPTURE_VERSION` (`cv` on every captured record) names the captured field list. Bump it only when that list changes: a bump
  re-reads every transcript. The skeleton is written at capture and carries `CAPTURE_VERSION` in its `v`.
- `EXTRACTOR_VERSION` (`v` on every derived record) names the derivation rules (error normalization, prompt classes,
  tool-name sequences, recovery episodes). A bump re-derives from the log; no raw transcript is read.

Version 4 (CAPTURE 4, t714) adds `sid`, `repo`, `fileHashes`, `env`, `promptFingerprint`, `targetBase`, the repository-root path base, and
a 1,000-character cap on an error line, and a cap of 100 on `files` and `fileHashes` per session (p99 was 61, max 209, on the 8,253-session
copy store). What an open does with an older store:

| Log holds | Action on open | Action at the next deposit |
|-----------|----------------|----------------------------|
| `cv` 4, `v` current | read | skip unchanged files |
| `cv` 3 (or a version-2 session) and the transcript is on disk or in `raw/` | read through the compatibility reader (a field version 4 added reads as null, empty, or `unknown`; the prompt half of `contextFingerprint`, before its `.`, reads as `promptFingerprint`, and `-` reads as null; the environment half is dropped) | capture again at `rev + 1`; derived records regenerate under the current `EXTRACTOR_VERSION` on every open |
| `cv` 3, neither the harness nor `raw/` has the transcript | read through the compatibility reader; `verify` counts it `cv-behind` | none |
| `derived.json` `v` older than `EXTRACTOR_VERSION` | read | rewritten at the next deposit (no reader depends on it today); derived records are regenerated from the log on every read |
| `cv` newer than this code | read the fields this code knows, and warn ("captured by a newer oars; upgrade oars" on `verify`, `measure`, and `books`) | refuse with "upgrade oars" |
| a file's recorded `sid` differs from the salt in force | read | capture that file again from the harness or `raw/` |

A version-2 session (no `cv`) is still read: its already-derived `prompt` and `error` lines pass through until it is deposited again.

## Captured records

Every record carries `kind`, `cv`, `sid`, `session`, and `rev` (a version-3 record reads with `sid` null). Text is redacted (secrets by
pattern and entropy, emails, and the domains named with `--redact-domain`) before it is cut or written. Each field has one class
(the umbrella repository's D1 spec, Section 1.1):

- `L` local-only: stays on this machine at every tier. Raw transcripts, the unhashed paths, the project folder slug, the salt, `state.json`.
- `A` account store: this machine today; the account's own store from the hosted tier. Redacted text (cut to its limit), join ids, and every salted hash.
- `P` pooled: names, versions, counts, durations, status, key names, and day-resolution dates. The only class that may ever reach a pooled index; it holds no free text, URL, path, path hash, session id, or branch.

| Record | Fields | Class |
|--------|--------|-------|
| every capture record | `kind`, `cv`, `rev`, `sid` | P |
| `session` (one per transcript) | `agentType` (set on a subagent transcript), `bytes`, `lines`, `badLines`, `userTurns`, `assistantTurns`, `versions`, `models`, `tools`, `bashCmds`, `compactSummaries`, `costUsd`, `usage`, `env` (below) | P |
| | `session`, `parent`, `spawnedBy` (join ids), `at`, `tsFirst`, `tsLast` (a pool would keep the UTC day), `promptFingerprint`, `repo`, `fileHashes`, `urls`, `searches`, `branches`, `tldrs` (400 chars), `confidences` (120 chars) | A |
| | `project` (the folder slug, with the username and directory names), `files` (the paths as written, redacted) | L |
| `user-prompt` (one per prompt) | `index`, `wallSec`, `thinking`, `turns`, `model`, `efforts`, `skills`, `usage` | P |
| | `session`, `ts` (a pool would keep the UTC day), `head` (the first 300 characters), `promptFingerprint` | A |
| `tool` (one per tool call) | `n`, `tool`, `status` (`ok`, `error`, or `none` when no result is in the file), `keys` (the input's key names), `durationMs`, `harnessVersion`, `agentType`, `side`, `prompt`, `targetBase`, and `target` for a shell call | P |
| | `session`, `parent`, `toolUseId`, `ts` (a pool would keep the UTC day), and `target` for a path call | A |
| `error-line` (one per failed result) | `tool`, `harnessVersion`, `side`, `prompt`, `after` | P |
| | `session`, `toolUseId`, `ts` (a pool would keep the UTC day), `line` (the first informative line, redacted, not normalized, cut to 1,000 characters) | A |
| `prompt` (derived, one per prompt) | `kind`, `v`, `rev`, `index`, `wallSec`, class (`cls`), `tools`, `shape`, `errors`, `thinking`, `sideTools`, `turns`, `model`, `efforts`, `skills`, `usage`, `recovery`, `explore`, `act`, `bigrams` (the motif vector) | P |
| | `session`, `head` (the first 300 characters, redacted), `ts`, `promptFingerprint` (`contextFingerprint` on this derived record) | A |
| `error` (derived, one per error) | `kind`, `v`, `rev`, `tool`, `harnessVersion`, `editFollowed`, `cls`, `prompt`, `next` (tool names), episode `outcome` and `calls` | P |
| | `session`, `agent` (the subagent transcript id, a join id), `ts`, `sig` (redacted at capture, normalized at derive), `example` (160 characters) | A |
| store files | `salt`, `state.json`, `raw/` | L |
| | skeleton lines (`skeletons/<session>.json`: ids, usage, block hashes; a pool would hold only `merkleRoot` and `leaves`), `hook-calls.jsonl` `session` and `error` (first line, redacted), `mcp-calls.jsonl` `query` | A |
| | `hook-calls.jsonl` `event`, `hit`, `ms`; `mcp-calls.jsonl` `matches` | P |

A pool may hold a day-resolution date only: none of the A fields above reaches it. `sw` (the per-field local-only switch for text
fields on a hosted store) applies to `urls`, `searches`, `branches`, `tldrs`, `confidences`, `head`, `line`, `sig`, `example`, and `mcp-calls.jsonl` `query`.

`env` (class P) is `{ harness, oars, node, os }`: the last harness version the transcript names, the oars package that captured it, the
Node.js version, and `process.platform`. A library version is recorded only when a transcript states it, and none is read today.
`promptFingerprint` is the hash of the `prompt_snapshot` attachment (version 3's `contextFingerprint` also mixed in the `environment`
snapshot, whose platform and shell now belong to `env`).

### Hashing

`target` is a 16-hex SHA-256 of `<salt>\n<path>` (a newline between the two) for a call with a `file_path`, `notebook_path`, or `path`
input; the program and subcommand (`git push`, `npm run`) for a shell call, after any leading `cd <dir> &&` hop, environment assignment,
or `sudo`; else null.
The path is taken **relative to the repository root** of the line's `cwd` (the nearest ancestor holding `.git`; a linked worktree
under `<root>/.claude/worktrees/<name>/` resolves to `<root>` and its segment is dropped), so one file hashes alike from every
subdirectory and worktree. `targetBase` is `repo` then. A path no repository holds keeps the version-3 base: relative to the `cwd`
when it lies under it, else as written, and `targetBase` is `cwd`. `repo` on the session is the salted hash of the repository's identity:
the normalized `origin` remote URL read from the repository's `config` (scheme, credentials, a trailing `.git` and slash stripped, host
lower-cased; a linked worktree's `.git` file is followed to the common `config`), so two clones share it; with no `config` or no `origin`
it is the lower-cased absolute root path of the first `cwd` a repository holds. It is salted; `fileHashes` is the salted hash of each file
path a tool touched, sorted.

The **salt** is this machine's, created on first use (`localSalt` in `store.ts`). The one seam for the account's salt is
`SessionsRuntime.accountSalt`: a provider returning `{ salt, sid }`. When it returns another `sid`, each file recorded under the old one is
captured again from the harness or `raw/` at the next deposit, and nothing else changes. How a second machine adopts the account's salt is
an open question (M4); until it is settled two machines of one account hash the same file differently, and `sid` makes that visible
(`verify` reports a store holding more than one).

`verify` also checks the version-4 fields: no session is `cv-behind`, one `sid` across the store, every `fileHash` is a path target of a
tool call, and `targetBase` is set on a path target and on nothing else.

## The step log

`pipeline-runs.jsonl` is the pipeline's own books of work (runtime-commons pipeline spec, Sections 3.1 and 4): a store-level file beside
`hook-calls.jsonl` (that file counts hook behavior, this one counts pipeline work), append-only, one JSON line per run of a step,
written when the step ends. It carries no `cv` of its own, so it needs no capture bump. It is local: nothing uploads it.

| Key | Class | Meaning |
|-----|-------|---------|
| `at` | A (P at UTC day) | When the step ended (ISO time). |
| `run` | A | A local run id; the `deposit`, `derive`, and `index` rows of one nightly or manual run share it. |
| `trigger` | P | `stop` (the SessionEnd hook, argument `stop`; never `session-end`), `nightly` (the scheduled task), `manual` (the verbs), `session-start` and `post-tool` (the lookup hooks). `weekly` is named by A21 and not built; `sync`, `cron`, `release`, `run-end`, and `run-start` are hosted: all are in the schema only. |
| `step` | P | `deposit`, `derive`, `index`, `verify`, or `recall`; the nightly and manual runs log a `derive` row and then an `index` row (the hook index write). `label` is in the schema but nothing local runs it yet. |
| `status` | P | `ok`, `error`, or `skipped` (an earlier step of the run failed). |
| `ms` | P | Wall time of the step; a `deposit` row excludes the derive and index passes it ends with, which have their own rows. |
| `in`, `out` | P | Counts by kind: `deposit` writes `out` as `session`, `subagent`, `user-prompt`, `tool`, `error-line`; `derive` as `signature` and `summary`; `index` as `signature` and `project`; `verify` as `checked`, `passed`, `cvBehind`, `stuck`, with `in` as `session` and `subagent` counts; `recall` as `matches`. |
| `cv`, `ev` | P | The capture and extractor versions the step ran at. `lv` (the labeler) appears on `label` rows only. |
| `key` | A | A 16-hex hash, so a repeat is visible, built from the step's inputs and never from the state it leaves, so a failed row and the ok row of the same work carry one key. `deposit`: `cv`, `ev`, the trigger, the allow entries (the SessionEnd hook: that one transcript's path), and the redact domains (the SessionEnd hook reads none, so its key has none); this replaces the spec's file, size, and mtime with the inputs the run was asked for, which are known before the work. A `stop` for a folder off the allowlist or a transcript that is gone is an `ok` row with nothing written and its own key (an attempted deposit that wrote nothing; no row is logged when the hook got no transcript path). `derive` and `index`: each session's and subagent's highest `rev`, and `ev`; a derive that could not read the store has `ev` alone. `verify`: each session's and subagent's `rev` and `cv`, and `ev`; a failed run, whose store could not be read, has the session asked for and `ev`. `recall`: the query and `ev` (the lookup hooks: the cwd for `session-start`, the failure's signature for `post-tool`; the spec names none, since a lookup writes nothing). Null only on a `skipped` row. |
| `error` | A | The first informative line of the failure, redacted like every other text in the store; null when `ok`. |

A failed step logs `error`, and the run's later steps are logged `skipped`; the next trigger retries the same key. A failed deposit leaves
`state.json` as it was; a derive that fails after its deposit wrote the records logs `deposit` `ok`, `derive` `error`, and `index` `skipped`; an index write that fails logs `deposit` and `derive` `ok`, then `index` `error` (the records and
`state.json` stand; the next deposit rebuilds the derived files and the index). A key that fails on three runs in a row is `stuck`, counted per step and trigger: an `ok` run of the same step and trigger ends its open
streaks, and an `ok` run on the same key under another trigger ends that key's streak too, so a nightly deposit that fails every night is stuck although the `stop` deposits between nights succeed. A usage error (`deposit` with nothing
to read) is no failed run and leaves no row. `verify` counts a stuck key (a `verify` streak is not listed: a verify that got here succeeded), prints `FAIL  <step> is stuck: key <key> failed 3 runs in a row: <error>`, fails
`--strict` with it, and writes the count in its own row. A row that cannot be appended never changes the step's outcome: the step's value or
its own error reaches the caller. A lookup hook logs an `ok` `recall` row only when it read the index and searched it; a missing, torn, or unreadable index counts as no index and logs no row, and an `error` row means the search itself failed. `recall --context` is the manual recall verb and logs a `manual` row keyed by the cwd and harness. A
state.json that cannot be read fails the step like any other failure: its row is still written, with the line masked by no domains.

`oars sessions measure` prints the counters of spec 3.2 that this log can answer, under the G1 signals, over the whole log (`--last` and `--since` filter the G1 table only; the step counters are all-time): runs of each step (ok, error,
skipped) and mean ms, per step and `ev`; capture records deposited by kind; records derived by type (the newest derive); what the index holds (the newest index); invariants passed of checked and
`cv-behind` sessions (the newest verify); recall queries and matches; failed runs by step and `ev`; and the stuck steps. `--json`
carries the same numbers under `steps`. A malformed or torn line is skipped when the log is read.

## Subagent transcripts

`<project>/<session>/subagents/agent-*.jsonl` and `.../subagents/workflows/wf_*/agent-*.jsonl` are deposited as
`<parent>~agent-<id>` and `<parent>~wf_<id>~agent-<id>`, with the parent session id and the subagent type from the sibling
`.meta.json`. They are kept apart from the sessions, so per-session denominators (`measure`, G1) still count main sessions;
`books --by class` adds their tokens to the spawning prompt's class as the `delegated` column. Their errors are derived into the
same `error` records as a main session's, under the parent's `session`, with the agent's transcript in `agent` (class A, a join id) and the
spawning prompt's `prompt` and `cls`: signatures, `measure`, and recall include them, and each signature counts the parent once.

## The raw archive

Each deposit (the `deposit` command and the Stop hook's) hard-links every transcript it reads into `raw/<project>/<path>`, so
the raw outlives the harness's own cleanup (`cleanupPeriodDays`) at no extra disk while both names exist. Across volumes, or on a
file system without hard links, it copies instead. A rerun leaves a present link alone and replaces a stale copy. The archive is
local only and is never read by `derive`.

## The cost-state check

`verify` checks that the harness's `cost-state` totals equal the recorded usage within their scope: the process that wrote them
(from its `startTime`, so a resumed session's earlier lines are outside them) and the session's subagent transcripts, counted
once per request id. A recorded sum above a total fails. A total above the sum is not a failure; it is printed as observed,
under `harness side calls` when a `modelUsage` model has no assistant line (001cf645 has a `claude-haiku` entry and no haiku
line), else under `other`. Checks that hold only once a scope is applied are counted under `resume scope` and `subagent
transcripts`, each with one example session.
