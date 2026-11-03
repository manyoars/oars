# The `oars sessions` store (version 5)

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
| `commit-survival.jsonl` | What became of each commit older than `SURVIVAL_DAYS`, appended on a change of state. See "Commit survival". |

## Two versions

- `CAPTURE_VERSION` (`cv` on every captured record) names the captured field list. Bump it when the captured field list changes or a
  stored value of an existing captured record or skeleton changes: a bump re-reads every transcript. The skeleton is written at capture and
  carries `CAPTURE_VERSION` in its `v`.
- `EXTRACTOR_VERSION` (`v` on every derived record) names the derivation rules (error normalization, prompt classes, tool-name sequences,
  recovery episodes, prompt outcome signals). A bump re-derives from the log; no raw transcript is read.

Version 4 (CAPTURE 4, t714) adds `sid`, `repo`, `fileHashes`, `env`, `promptFingerprint`, `targetBase`, the repository-root path base, and a
1,000-character cap on an error line, and a cap of 100 on `files` and `fileHashes` per session (p99 was 61, max 209, on the 8,253-session
copy store); `recall --path` sees the first 100 sorted paths of a session. Version 5 (CAPTURE 5, t733) changes no field name: it changes the
stored `models` value of an existing skeleton to carry the cost-state keys (see the cost-state paragraph below), so a version-4 store is
behind and its next deposit captures every transcript again. Version 6 (CAPTURE 6, t746) adds `segments`, `pulls`, and `commits` to the tool
record (see "What a shell call captures"), and a version-5 store's next deposit captures every transcript again. What an open does with an older store:

| Log holds | Action on open | Action at the next deposit |
|-----------|----------------|----------------------------|
| `cv` 5, `v` current | read | skip unchanged files |
| `cv` 3 or 4 (or a version-2 session) and the transcript is on disk or in `raw/` | read through the compatibility reader (for `cv` 3, a field version 4 added reads as null, empty, or `unknown`; the prompt half of `contextFingerprint`, before its `.`, reads as `promptFingerprint`, and `-` reads as null; the environment half is dropped); `verify` counts it `cv-behind`, and `verify --strict` exits 4 on it | capture again at `rev + 1`; derived records regenerate under the current `EXTRACTOR_VERSION` on every open |
| `cv` 3 or 4, neither the harness nor `raw/` has the transcript (for a Cursor session, Cursor no longer lists the composer) | read through the compatibility reader; `verify` counts it `cv-frozen` (not `cv-behind`), and `verify --strict` does not fail on it | none |
| `derived.json` `v` older than `EXTRACTOR_VERSION` | read | rewritten at the next deposit (no reader depends on it today); derived records are regenerated from the log on every read |
| `cv` newer than this code | read the fields this code knows, and warn ("captured by a newer oars; upgrade oars" on `verify`, `measure`, and `books`) | refuse with "upgrade oars" (`oars sessions deposit` and the nightly run read the log and refuse when a session's latest capture has a newer `cv`; the Stop-hook path reads only `state.json`) |
| a file's recorded `sid` differs from the salt in force | read | capture that file again from the harness or `raw/` |

A version-2 session (no `cv`) is still read: its already-derived `prompt` and `error` lines pass through until it is deposited again.

## Captured records

Every record carries `kind`, `cv`, `sid`, `session`, and `rev` (a version-3 record reads with `sid` null). Text is redacted (secrets by
pattern and entropy, emails, and the domains named with `--redact-domain`) before it is cut or written. Each field has one class
(the umbrella repository's D1 spec, Section 1.1). The store uploads nothing, so a class says what a field may hold, not where it goes:

- `L` the most sensitive: raw transcripts, the unhashed paths, the project folder slug, the salt, `state.json`.
- `A` redacted text (cut to its limit), join ids, and every salted hash.
- `P` the least sensitive: names, versions, counts, durations, status, key names, and day-resolution dates. It holds no free text, URL, path, path hash, session id, or branch.

| Record | Fields | Class |
|--------|--------|-------|
| every capture record | `kind`, `cv`, `rev`, `sid` | P |
| `session` (one per transcript) | `agentType` (set on a subagent transcript), `harness` (set on a Cursor session; absent reads as Claude Code), `bytes`, `lines`, `badLines`, `userTurns`, `assistantTurns`, `versions`, `models`, `tools`, `bashCmds`, `compactSummaries`, `costUsd`, `usage`, `env` (below) | P |
| | `session`, `parent`, `spawnedBy` (join ids), `at`, `tsFirst`, `tsLast`, `promptFingerprint`, `repo`, `fileHashes`, `urls`, `searches`, `branches`, `tldrs` (400 chars), `confidences` (120 chars) | A |
| | `project` (the folder slug, with the username and directory names), `files` (the paths as written, redacted) | L |
| `user-prompt` (one per prompt) | `index`, `wallSec`, `thinking`, `turns`, `model`, `efforts`, `skills`, `usage` | P |
| | `session`, `ts`, `head` (the first 300 characters), `promptFingerprint` | A |
| `tool` (one per tool call) | `n`, `tool`, `status` (`ok`, `error`, or `none` when no result is in the file), `keys` (the input's key names), `durationMs`, `harnessVersion`, `agentType`, `side`, `prompt`, `targetBase`, and `target` for a shell call | P |
| | `session`, `parent`, `toolUseId`, `ts`, `target` for a path call, and `segments`, `pulls`, and `commits` (a plain word, a private package name, and a sha can each identify private work) | A |
| `error-line` (one per failed result) | `tool`, `harnessVersion`, `side`, `prompt`, `after` | P |
| | `session`, `toolUseId`, `ts`, `line` (the first informative line, redacted, not normalized, cut to 1,000 characters) | A |
| `prompt` (derived, one per prompt) | `kind`, `v`, `rev`, `index`, `wallSec`, class (`cls`), `tools`, `shape`, `errors`, `thinking`, `sideTools`, `turns`, `model`, `efforts`, `skills`, `usage`, `recovery`, `explore`, `act`, and `bigrams` (the motif vector) | P |
| | `session`, `head` (the first 300 characters, redacted), `ts`, `promptFingerprint` (`contextFingerprint` on this derived record), and the outcome signals `verify`, `stopped`, `commits`, and `redo` (below) | A |
| `error` (derived, one per error) | `kind`, `v`, `rev`, `tool`, `harnessVersion`, `editFollowed`, `cls`, `prompt`, `next` (tool names), episode `outcome` and `calls` | P |
| | `session`, `agent` (the subagent transcript id, a join id), `ts`, `sig` (redacted at capture, normalized at derive), `example` (160 characters) | A |
| store files | `salt`, `state.json`, `raw/`, `hook-index.json` `projects` keys (folder slugs), `mcp-calls.jsonl` `cwd` (the server's working directory, unhashed) | L |
| | skeleton lines (`skeletons/<session>.json`: ids, usage, block hashes, each cost-state model's usage keys; a pool would hold only `merkleRoot` and `leaves`), `hook-calls.jsonl` `session`, `at`, and `error` (first line, redacted), `mcp-calls.jsonl` `query` and `at` (each `at` is finer than a UTC day; a pool would keep the UTC day) | A |
| | `hook-calls.jsonl` `event`, `hit`, `ms`; `mcp-calls.jsonl` `matches` | P |

A `P` date is at day resolution only: the finer timestamps above are all class `A`. `sw` (the per-field local-only switch for text
fields) applies to `urls`, `searches`, `branches`, `tldrs`, `confidences`, `head`, `line`, `sig`, `example`, and `mcp-calls.jsonl` `query`.

`env` (class P) is `{ harness, oars, node, os }`: the last harness version the transcript names, the oars package that captured it, the
Node.js version, and `process.platform`. A library version is recorded only when a transcript states it, and none is read today.
`promptFingerprint` is the hash of the `prompt_snapshot` attachment (version 3's `contextFingerprint` also mixed in the `environment`
snapshot, whose platform and shell now belong to `env`).

### What a shell call captures

`target` stays what it was: the first line's program and subcommand, the retry identity. Three optional fields read the whole command, on every
line and at every shell separator, after heredoc and here-string bodies are dropped and the command is redacted. A shell's own argument
(`bash -c "..."`) is read too. No registry is asked and nothing runs, so each field is what the command and its result say.

| Field | On | Holds | What it does not say |
|-------|----|-------|---------------------|
| `segments` | every shell call | One `{ run, read }` per command, the last 50. `run` is the program's basename and its plain words, at most 12, each cut to 30 characters: no flag, path, variable, or quoted text. `read` is whether the call's status reports that command: false when a pipe follows it, when a later `;`, `&`, newline, or `\|\|` overrides it, or when it runs in the background. | An unquoted word is kept, so `echo hello there` is kept as written, redacted. |
| `pulls` | a call that names one | `{ ecosystem, name, version }` with ecosystem `npm` (npm, pnpm, yarn, bun, `npx`, `bunx`, `dlx`), `pypi` (pip, `python -m pip`, uv, `uvx`, pipx), `cargo`, `go`, `gem`, `brew`, `skill` (`npx skills add`), `plugin` (`claude plugin install`, `codex plugin add`), or `mcp` (the full server name from `mcp__<server>__`, on every MCP call). `version` is as stated, or null. A scoped name stays whole. A lockfile install, a local path, and a variable name nothing. | A name is not a verified package, a run of `npx` may hit a local bin, and a failed install still names its pull. A command behind `xargs` or in a script is not read. |
| `commits` | a clean shell call that ran `git commit` | One entry per commit, in order: the sha, or null. The sha comes from the `[branch sha]` line, or from a `git rev-parse HEAD` or one-commit `git log` that is the call's final command, joined by `&&` or `\|` in the same repository with nothing between that moves `HEAD`. A count stands without a sha, and a `-q` commit with no such read-back has none. A dry run or help call is no commit, and neither is one refused with `nothing to commit`, `fatal:`, or `error:`. | A commit behind `;` whose hook failed with other text still counts, since the call came back clean. A failed call records no commit even when its own result proves one: `git commit -m x && git push` with a rejected push holds a `[branch sha]` line, yet `commits` undercounts it and the `redo` window stays open. |

### Prompt outcome signals

Each derived `prompt` record (`EXTRACTOR_VERSION` 6) carries four deterministic signals, kept separate: no composite, no score. A version-2
line, read as written, has none of them. They read the main line only, with a resumed session's repeated calls dropped; a subagent
transcript's calls are not read.

| Field | Values | Rule | What it does not say |
|-------|--------|------|---------------------|
| `verify` | `passed`, `failed`, `masked`, `none`, `na`, or absent | The last build, test, type-check, or lint runner in `segments` after the prompt's last edit (`isRunner` in `derive.ts`), less a backgrounded call, whose result says only that it started. `passed` and `failed`: the call's status reports that runner. `masked`: a pipe or a later command hides its exit, so the exit is unknown. `none`: no runner ran, or its call has no result. `na`: the prompt edited nothing. Absent: the walk reached a shell call captured before `segments`, which could have been a runner. A failed edit is not an edit. | `passed` means a clean exit, not that the suite covers the change. `failed` includes a call that was rejected or denied and never ran, and a chained command after the runner failing: `npm test && git push`. The runner list is a rule over program names, so a repository's own script name is not seen. |
| `stopped` | `interrupt`, `rejected`, null | `rejected`: a main-line error line starts `The user doesn't want to proceed with this tool use` or `The user doesn't want to take this action`. `interrupt`: the next prompt record starts `[Request interrupted by user`. A rejection wins, since the harness writes the marker right after it. | A classifier or hook denial is not a stop: it is policy, and the model carries on. |
| `commits` | a count | The entries in the prompt's captured `commits`. A record captured before CAPTURE 6 counts a clean call whose `target` is `git commit`. | That older count is a floor: `target` holds only the first line's first program and subcommand. A commit made by a script or an alias is not seen. |
| `redo` | true, false | A later prompt in the session edits a path hash this prompt edited, within `REDO_WINDOW` (3) prompts, with no commit that `commits` can see between them. | A commit a script made does not end the window, and a planned second edit of one file reads the same as rework. |

The interrupt marker is a user line, so capture keeps it as a prompt record of its own, with no tools. It counts toward `REDO_WINDOW`'s
distance and in a share of prompts; its own `stopped` is null and its `verify` is `na`.

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

`verify` also checks the version-4 fields: no version-3 or later session is `cv-behind` (one whose transcript is gone from the harness and
`raw/`, or, for a Cursor session, whose composer is gone from Cursor, is counted `cv-frozen` instead and never fails `--strict`, since it
cannot be captured again), one `sid` across the store, every `fileHash` is a path target of a tool call, and `targetBase` is set on a path
target and on nothing else.

### Commit survival

`oars sessions deposit` and the nightly run, never a hook, read the repository of each allowlisted folder and append one line per changed
sha to `commit-survival.jsonl`: `{ sha, state, day }`, with `sha` as captured (class A), `state` (class P), and a day-resolution `day`
(class A). Only a call in a main transcript whose `ts` is more than `SURVIVAL_DAYS` (7) old counts, so a sha `commits` could not read and a
subagent's commit are not observed. `git commit -q` prints no `[branch sha]` line, so a quiet commit's sha is read only when a read-back is
the call's final command; a store that commits quietly observes few of its commits. The latest line of a sha wins. It is a separate file, so
what `verify` checks is untouched.

| `state` | Rule | What it does not say |
|---------|------|---------------------|
| `reverted` | A commit on the default branch says `This reverts commit <full sha>`, and that revert was not itself reverted. Checked first. | A hand-written or partial undo, and a revert that names a squash's sha rather than this one, are not seen. |
| `survived` | An ancestor of the default branch. | The lines may since have been rewritten by ordinary later work. |
| `unreachable` | The repository holds the commit, but the default branch does not reach it. | Not a failure: a squash merge, a rebase on landing, and an open branch all read this way. |
| `unknown` | The repository is absent or shallow, it has no default branch this code can name, git failed, or it does not hold the sha. | A session that committed in another repository reads this way, since only its own project's repository is read. |

The repository is the first `cwd` in the session's transcript whose slug is the allowlisted project, then its root (`makeRepoRoot`). A later
`cd` is never followed, and a folder outside this run's allowlist is never read. Git is read-only and asks no network, so the default
branch (`origin/HEAD`, else `origin/main`, `origin/master`, `main`, `master`) is as of the last fetch. A failed read never fails the deposit,
and an `unknown` never replaces a known state, so a passing failure does not undo an observation.

### What `books` adds

`oars sessions books --by class|model|harness|pull` adds these columns, in text and `--json`. The signals stay separate, and the text ends
with a line saying they are associations in one operator's logs, not measured lift.

| Column | `--json` | Count, of what |
|--------|----------|----------------|
| `passed` | `verifyPassed` | `verify` passed, of prompts that edited and whose `verify` is readable (not `na`, not absent) |
| `stop` | `stopped` | A stop, of prompts carrying `stopped` |
| `redo` | `redone` | A redo, of prompts carrying `redo` |
| `commits` | `commits` | The prompts' `commits`, with or without a sha |
| `settled` | `settled` | Distinct shas whose state is `survived`, `reverted`, or `unreachable` |
| `survived` | `survived` | `survived`, of `settled` |

Below `BOOKS_MIN_PROMPTS` (30) in its denominator a share prints as `too few`, and `--json` gives its `share` as null beside its `count` and
`of`. A settled commit counts toward that minimum the way a prompt does. `--by pull` has one row per `ecosystem:name` from the calls' `pulls`, a
prompt counts once in each row it pulled, so the rows overlap, and a prompt that pulled nothing is in none. Every column reads the main line
only: subagent work is left out.

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
| `in`, `out` | P | Counts by kind. `deposit`: `in` is `transcript` (the count asked for), `out` is `session`, `subagent`, `user-prompt`, `tool`, and `error-line`. `derive`: `in` is `session`, `subagent`, `user-prompt`, and `tool`; `out` is `signature` and `summary`. `index`: `in` is `session`, `subagent`, and `error`; `out` is `signature` and `project`. `verify`: `in` is `session` and `subagent`; `out` is `checked`, `passed`, `cvBehind`, `cvFrozen`, and `stuck`. `recall`: `in` is `query`; `out` is `matches`. |
| `cv`, `ev` | P | The capture and extractor versions the step ran at. `lv` (the labeler) appears on `label` rows only. |
| `key` | A | A 16-hex hash, so a repeat is visible, built from the step's inputs and never from the state it leaves, so a failed row and the ok row of the same work carry one key. `deposit`: `cv`, `ev`, the trigger, the allow entries (the SessionEnd hook: that one transcript's path), and the redact domains (the SessionEnd hook reads none, so its key has none); this replaces the spec's file, size, and mtime with the inputs the run was asked for, which are known before the work. A `stop` for a folder off the allowlist or a transcript that is gone is an `ok` row with nothing written and its own key (an attempted deposit that wrote nothing; no row is logged when the hook got no transcript path). `derive` and `index`: each session's and subagent's highest `rev`, and `ev`; a derive that could not read the store has `ev` alone. `verify`: each session's and subagent's `rev` and `cv`, and `ev`; a failed run, whose store could not be read, has the session asked for and `ev`. `recall`: the query and `ev` (the lookup hooks: the cwd for `session-start`, the failure's signature for `post-tool`; the spec names none, since a lookup writes nothing). Null only on a `skipped` row. |
| `error` | A | The first informative line of the failure, at most 300 characters, with the home folder reduced to `<home>` (in either slash form and any letter case) and redacted like every other text in the store; null when `ok`. |

A failed step logs `error`, and the run's later steps are logged `skipped`; the next trigger retries the same key. A failed
deposit leaves `state.json` as it was; a derive that fails after its deposit wrote the records logs `deposit` `ok`, `derive`
`error`, and `index` `skipped`; an index write that fails logs `deposit` and `derive` `ok`, then `index` `error` (the records
and `state.json` stand; the next deposit rebuilds the derived files and the index). A key that fails on three runs in a row
is `stuck`, counted per step and trigger: an `ok` run of the same step and trigger ends its open streaks, and an `ok` run on
the same key under another trigger ends that key's streak too, so a nightly deposit that fails every night is stuck although
the `stop` deposits between nights succeed. A usage error (`deposit` with nothing to read) is no failed run and leaves no
row. `verify` counts a stuck key (a `verify` streak is not listed: a verify that got here succeeded), prints `FAIL  <step> is
stuck: key <key> failed <runs> runs in a row: <error>`, fails `--strict` with it, and writes the count in its own row. The
stuck check is store-wide; `--session` narrows the invariants and the key only. A row that cannot be appended never changes
the step's outcome: the step's value or its own error reaches the caller. A lookup hook logs an `ok` `recall` row only when
it read the index and searched it; a missing, torn, or unreadable index counts as no index and logs no row, and an `error`
row means the search itself failed. An MCP recall is counted in `mcp-calls.jsonl`, not here. `recall --context` is the manual
recall verb and logs a `manual` row keyed by the cwd and harness. A state.json that cannot be read fails the step like any
other failure: its row is still written, with the line masked by no domains.

`oars sessions measure` prints the counters of spec 3.2 that this log can answer, under the G1 signals, over the whole log (`--last`, `--since`, and `--repo` filter the G1 table only; the step counters are all-time and not repository-scoped): runs of each step (ok, error,
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
under `harness side calls` only on a usage key that a `modelUsage` model with no assistant line reported a nonzero amount on (001cf645 has a
`claude-haiku` entry and no haiku line), else under `other`. Checks that hold only once a scope is applied are counted under `resume scope` and `subagent
transcripts`, each with one example session.

The skeleton's cost state records, per `modelUsage` model (sorted by name), the usage keys its entry reported a nonzero amount on: `input`,
`cacheWrite`, `cacheRead`, `output`. A side model whose cache keys are absent or zero (the haiku case) therefore explains an excess only on
`input` and `output`, and an excess on `cacheRead` stays `other`. The field changes the stored `models` value of an existing skeleton, so it
bears on `CAPTURE_VERSION`, not `EXTRACTOR_VERSION`: the rule is that a captured field changing bumps `CAPTURE_VERSION`, and derived values
alone bump `EXTRACTOR_VERSION`. It is `CAPTURE_VERSION` 5 (t733). t700 added `models` with no bump because no version-3 store had shipped; a
version-4 store is on operators' machines now, so the next deposit captures every transcript again and writes the keys. The compatibility
reader still fills a skeleton written without them (a bare model name, or no `models`) with no keys, so a transcript that is gone from disk
keeps its excess keys under `other`. Class A, with the rest of the skeleton lines (a pool would not hold them).

## More than one repository in a store

One store can hold several repositories, and neither the G1 reading nor the SessionStart block should move because another one deposits.

- `oars sessions measure --repo <root>` counts only the sessions of the repository `<root>` sits in. It uses the test recall uses: a
  project folder belongs when its slug is the root's slug or extends it, so worktrees (`<root>/.claude/worktrees/<name>`) and
  subfolders count. Without the flag the output is the whole store, as before.
  The MCP recall calls it counts are scoped too: each call now records the folder the server ran in, and `--repo` drops a call whose
  folder is another repository. A call written before that field existed has no folder and counts for every repository.
- `oars sessions books --repo <root>` takes the same flag and the same test: it books only the prompts of that repository's sessions, with
  the subagent tokens they spawned, so `books --by class` stays one repository's number when others deposit.
- SessionStart recall ranks by the latest 300 sessions of the repository, not of the whole store. The index groups project folders
  into repositories by slug: a worktree folds into its repository, and a folder that extends another stored folder joins the shortest.
  Three consequences:
  - Sibling folders whose slugs share a prefix (`app` and `app-two`) share one window.
  - A nested repository (`tradeaor/oars`) ranks by its parent's window while `measure --repo tradeaor/oars` counts only itself, so the
    two readings differ.
  - A stored parent folder is a prefix of its children, so one allow-listed session from the parent (the home folder, or the folder
    holding several checkouts) folds those repositories into one window and the isolation reverts to the whole store. Keep such a
    folder off the allow list.
- An installed hook command starts with `[ -f "<hook-bin>" ] || exit 0;`, so a settings file that outlives its build (a cloud worker, a
  clone with no build) exits 0 and prints nothing instead of failing the session. The command still ends in `hook-bin.js" <event>`,
  which is how uninstall finds it.
- `hook install` at `--scope project` or `--scope file` reads the user file's `cleanupPeriodDays` too. When the target file sets no number, a user
  value at or above the 365 floor means nothing is written. A number the target file sets itself overrides the user's, so the user's value only
  counts when the file sets none. The floor is per target file: a lower number in the file is raised to 365, and the user's value is
  never copied into a project file, which can be committed.

## The Cursor source

`oars sessions deposit` also reads a Cursor store, so a Cursor history and a Claude Code history land in one local store. The records
carry `harness: "cursor"`; a record with no `harness` is Claude Code's (`harnessOf`), so the Cursor source itself needs no capture bump and no Claude Code record changes.

- **Where it is read from.** Cursor's `User` folder: `%APPDATA%\Cursor\User` on Windows, `~/Library/Application Support/Cursor/User` on
  macOS, `$XDG_CONFIG_HOME/Cursor/User` (else `~/.config/Cursor/User`) on Linux. `deposit` finds it on its own and skips it silently when
  it is absent. It opens the two SQLite files read-only through the built-in `node:sqlite` (Node 24 or later, no dependency), loaded only
  when a Cursor store exists.
- **Opt-in.** Reading it needs consent like any other source: pass `--allow cursor` (or a glob that matches it, such as `*`). The nightly
  schedule's allow list is where to add it. Without it the store is not opened.
- **What maps to what.** One session per composer: `workspaceStorage/<hash>/state.vscdb` (`composer.composerData`) names the composers of a
  workspace, and `workspace.json` names its folder; `globalStorage/state.vscdb` (`cursorDiskKV`) holds the messages (`bubbleId:<composer>:<bubble>`)
  and `composerData:<composer>`. A user bubble is a prompt, an assistant bubble a response; `modelInfo.modelName` is the model; `tokenCount`
  feeds `usage`; `toolFormerData` (name, params, status, error) is a tool call, and its path parameters are the files touched. The workspace
  folder is the cwd: a Git repository takes the same `repo` identity and root base as a Claude Code cwd, any other folder its own class-L path,
  and a composer with no workspace gets none.
- **Same field classes.** The transcript is rebuilt as the lines `captureSession` already reads, so redaction, the 1,000-character `line` cap,
  `fileHashes`, and the per-account `sid` salt are the Claude Code code path, not a copy.
- **Idempotent.** `state.json` keeps one entry per composer (`cursor/<composerId>`) whose cursor is the message count and `lastUpdatedAt`;
  a second deposit adds nothing, and a composer that gained messages is captured again.
- **Absent fields.** The store has no cache read or write tokens, thinking tokens, subagents, hooks, cost-state, git branch, or Cursor
  version, so they take the empty value (0, `[]`, or null; `env.harness` is null). A bubble's time is its `createdAt`, else
  `timingInfo.clientStartTime` when that is an epoch time at or after the composer's start (a smaller value is a relative clock and is
  ignored); a user bubble with neither takes the next assistant bubble's, and any other takes the previous one's, so wall time per prompt is coarse.
  A shell command Cursor records as `completed` with a nonzero `exitCodeV2` is a failed `Bash` call, and a tool `error` is read from its JSON
  wrapper (the model-visible message, else the client-visible one). Nothing goes to `raw/` (there is no transcript file), and the Stop hook does not read Cursor.
- **Not read.** `aiService.prompts` (only `text` and `commandType`) and `aiService.generations` are not read: they carry no session id and no
  time, so they cannot be joined to a composer. On the 2026-11-02 copy, 183 of 788 distinct prompt texts match no captured prompt; that is a
  stated gap, not a silent one. The `session` record carries `harness: cursor`; the skeleton does not (`Skeleton` has no such field), and
  names its source only through the `cursor-` session prefix.
  A terminal call Cursor ended `..._EXECUTION_ABORTED` has no outcome (`none`, as a cancelled edit), a tool call has no duration (the
  store stamps a result with the call's own time), a composer id that is not `[A-Za-z0-9._-]+` is skipped and counted, and a composer with no
  `createdAt` accepts no relative `clientStartTime`.
- **Reading it back.** `recall` and `measure` read the records as they are. `books --by harness` groups the prompts by harness.
