# The `oars sessions` store (version 8)

`oars sessions` keeps a local, deterministic memory of the operator's own Claude Code sessions: no model call, no network, nothing
uploads. `gold arms` is the one exception: it sends redacted text through your own Claude subscription. This page is the store's format. The types are in `packages/cli/src/sessions/schema.ts`; the commands are in the CLI README.

## Layout

Under `<config>/oars/sessions/` (`%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere):

| Path | What it holds |
|------|---------------|
| `observations.jsonl` | The log of captured records, appended to and compacted (below). A changed transcript is deposited again under a higher `rev`; readers keep only the highest `rev` of each session. |
| `derived.json` | The derived records, rewritten from the log alone at the end of every deposit. |
| `hook-index.json` | The recurring error signatures per project and overall, read by the hooks. |
| `skeletons/<session>.json` | One per transcript: ids, timestamps, tool linkage, token counts, a SHA-256 for every content field, and a Merkle root over the raw lines. Hashes only, never content. `verify` checks these. |
| `state.json` | Per file: size, mtime, the `rev`, capture version (`v`), `sid`, and the `--redact-domain` set, so an unchanged file is skipped. |
| `salt` | This machine's salt, which file targets are hashed with. Local-only (class `L`), never shared. Its `sid` (the first 8 hex characters of its SHA-256) is stamped on every capture record. |
| `pipeline-runs.jsonl` | The step log: one row per run of a pipeline step (deposit, derive, index, verify, recall, read), appended when the step ends. See "The step log". |
| `cells.jsonl`, `motifs.jsonl` | Counts per motif, frame bucket, and day, and the motifs they name. Computed from the log, rewritten by `oars sessions read`, and safe to delete. See "Motifs, cells, and reads". |
| `reads/<pool>.jsonl` | One pool version's reads, written once and never rewritten, so a read cited by its ID stays what it was. |
| `raw/<project>/<path>` | oars' own archive of every deposited transcript (below). |
| `commit-survival.jsonl` | What became of each commit older than `SURVIVAL_DAYS`, appended on a change of state. See "Commit survival". |

## The log's growth and compaction

Every append to `observations.jsonl`, from a hook or a deposit, runs under `store.lock`. A changed transcript adds a full new `rev` of that session, and a
`CAPTURE_VERSION` bump re-captures every transcript, so during that deposit the log holds about two copies of the store. The size is not limited by a string: every reader
streams the log line by line, so a log past Node's 536,870,888-character string limit still loads.

At the end of a whole-store deposit, after `state.json` is written and before the derived records are rebuilt, `compactLog` (`store.ts`) drops every line a higher `rev` of its session
replaces, so the log settles back to the size of the live records. A hook deposit never compacts.

- **What stays.** Only a superseded line goes. A line this version cannot read stays, since a later oars may read it, and a kept line is written back byte for byte. What `loadStore` returns does not change.
- **What triggers it.** What the log holds, not what the run captured, so a run that died after its re-capture is compacted by the next deposit, even one with nothing left to capture. A log with nothing superseded is read once and not rewritten.
- **How it stays safe.** The rewrite goes to `observations.jsonl.<pid>.tmp`, is synced, and replaces the log by `rename`, all under the store lock, which its holder keeps refreshed so a long deposit is not judged stale. A crash before the rename leaves the old log whole and a temp file no reader opens, which the next compaction removes.
- **When it gives up.** Compaction leaves the log as it was and writes one line to stderr, and the next deposit tries again, if the log's size changed during the rewrite (a waiter broke the lock) or if Windows keeps refusing the rename for 30 seconds because a reader holds the log open. A failed compaction does not fail the deposit: the records are safe and an uncompacted log still loads.

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
record (see "What a shell call captures"), and a version-5 store's next deposit captures every transcript again. Version 8 (CAPTURE 8 and EXTRACTOR 8) changes no
field name either: it changes what `tool`, `error-line`, and the session's `tools`, `bashCmds`, `tldrs`, and `confidences` hold. The harness writes
`api-request-blob` lines, copies of the request body with no `cwd`, `uuid`, or `timestamp`; capture read their blocks as conversation and wrote every call
a second time with status `none` (99.8% of the 55,801 `tool_use` blocks on those lines repeat a real call). It no longer reads them, and a call a
resumed transcript replays under the same tool-use id is written once. The skeleton still lists every line, so the counts and the root bind. A reader
folds an older store the same way (`fold.ts`): one `tool` record per session and tool-use id, the first, with the first status found and, when the first has no `ts`, the
`target`, `targetBase`, `ts`, and `harnessVersion` of the first copy that has one; the kept records are numbered from zero and each `error-line`'s `after`
moves to match, so `next` and `editFollowed` read the same calls as a current capture; and the session's `tools` and `bashCmds` are less the dropped calls. A call with no result is still a record, status `none`. Version 9 (CAPTURE 9, t755)
adds `frame` and `frameId` to the session and prompt records and `steps` to the tool record (see "Frames and steps"), and moves `tool`, `tools`, and a shell-form
`target` from class P to class A; a version-8 store's next deposit captures every transcript again from the harness or `raw/`. What an open does with an older store:

| Log holds | Action on open | Action at the next deposit |
|-----------|----------------|----------------------------|
| `cv` 9, `v` current | read | skip unchanged files |
| `cv` 5 to 8 and the transcript is on disk or in `raw/` | read; a replayed `tool` record is folded (see above); `verify` counts it `cv-behind`, and `verify --strict` exits 4 on it | capture again at `rev + 1` |
| `cv` 5 to 8, neither the harness nor `raw/` has the transcript | read; a replayed `tool` record is folded (see above); `verify` counts it `cv-frozen` (not `cv-behind`), and `verify --strict` does not fail on it | none |
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
| `session` (one per transcript) | `agentType` (set on a subagent transcript), `harness` (set on a Cursor session; absent reads as Claude Code), `bytes`, `lines`, `badLines`, `userTurns`, `assistantTurns`, `versions`, `models`, `bashCmds`, `compactSummaries`, `costUsd`, `usage`, `env` (below), `frame`, `frameId` | P |
| | `session`, `parent`, `spawnedBy`, `spawnedIn` (join ids), `at`, `tsFirst`, `tsLast`, `promptFingerprint`, `repo`, `tools` (native names, which can hold a private MCP server's), `fileHashes`, `urls`, `searches`, `branches`, `tldrs` (400 chars), `confidences` (120 chars) | A |
| | `project` (the folder slug, with the username and directory names), `files` (the paths as written, redacted) | L |
| `user-prompt` (one per prompt) | `index`, `wallSec`, `thinking`, `turns`, `model`, `efforts`, `skills`, `usage`, `frame`, `frameId` | P |
| | `session`, `ts`, `head` (the first 300 characters), `promptFingerprint` | A |
| `tool` (one per tool call) | `n`, `status` (`ok`, `error`, or `none` when no result is in the file; one record per tool-use id), `keys` (the input's key names), `durationMs`, `harnessVersion`, `agentType`, `side`, `prompt`, `targetBase`, `steps` | P |
| | `session`, `parent`, `toolUseId`, `ts`, `tool` (the native name, which can hold a private MCP server's), `target` in either form (a salted hash, or the first line's program and subcommand, where a word can be anything), and `segments`, `pulls`, and `commits` (a plain word, a private package name, and a sha can each identify private work) | A |
| `error-line` (one per failed result) | `harnessVersion`, `side`, `prompt`, `after` | P |
| | `session`, `toolUseId`, `tool` (the native name), `ts`, `line` (the first informative line, redacted, not normalized, cut to 1,000 characters) | A |
| `prompt` (derived, one per prompt) | `kind`, `v`, `rev`, `index`, `wallSec`, class (`cls`), `tools`, `shape`, `errors`, `thinking`, `sideTools`, `turns`, `model`, `efforts`, `skills`, `usage`, `recovery`, `explore`, `act`, and `bigrams` (the motif vector) | P |
| | `session`, `head` (the first 300 characters, redacted), `ts`, `promptFingerprint` (`contextFingerprint` on this derived record), and the outcome signals `verify`, `stopped`, `commits`, and `redo` (below) | A |
| `error` (derived, one per error) | `kind`, `v`, `rev`, `tool`, `harnessVersion`, `editFollowed`, `cls`, `prompt`, `next` (tool names), episode `outcome` and `calls` | P |
| | `session`, `agent` (the subagent transcript id, a join id), `toolUseId` (a join id), `ts`, `sig` (redacted at capture, normalized at derive), `example` (160 characters) | A |
| store files | `salt`, `state.json`, `raw/`, `hook-index.json` `projects` keys (folder slugs), `mcp-calls.jsonl` `cwd` (the server's working directory, unhashed) | L |
| | skeleton lines (`skeletons/<session>.json`: ids, usage, block hashes, each cost-state model's usage keys), `hook-calls.jsonl` `session`, `at`, and `error` (first line, redacted), `mcp-calls.jsonl` `query` and `at` (each `at` is finer than a UTC day) | A |
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

### Frames and steps

CAPTURE 9 gives every call a shared coordinate, so calls compare across harnesses, models, versions, and dates. Nothing here is asked of a
network or a model: a value outside a closed list reads `<literal>` or is dropped, so these fields stay class P. The lists live in one file,
`src/sessions/public-vocabulary.ts`, and default to `<literal>` when unsure.

A `frame` sits on each prompt, and on the session for the calls before the first prompt: `{ harness, harnessVersion, model, effort, day, platform,
shell, stack }`. `day` is the UTC date. `stack` is a language mix, framework names, and a repository size bucket, each from a closed
list. `frameId`, beside it on the record, is a 16-hex hash of the frame, and a step names it. `shell` and `stack` are read across the whole
transcript, so they belong to the file at this `rev`: capturing a transcript that has grown can change them, and with them the `frameId` of its
earlier prompts.

`steps` sits on the tool record, one per call, or one per command of a shell call, the last 50 as with `segments` (`&&`, `||`, `;`, pipes, and
subshells, with quoted separators left alone, tied by `seg`). It is nested so `n`, the count bindings, and the Merkle checks do not move.

| Field | Holds |
|-------|-------|
| `n`, `seg` | The call's position in the transcript, and the step's position in the call. |
| `action` | One of the closed list in `src/sessions/actions.ts`, from one table per adapter. An unmapped name is `other`. |
| `native` | The harness's name for the tool when its table lists the name, or when every name it holds is public, else `<literal>`. |
| `identity` | By action: shell `{ program, sub, flags, pulls? }` (flag names, never their values, so `-c1-200` reads `-c` and `head -20` reads `-N`; a pull is `{ registry, name, version }`), MCP `{ server, tool }` (a server name is a label the user picks, so `tool` is `<literal>` unless the allowlist lists that tool under that server, and on a harness whose spelling cannot say where the server name ends, as Cursor's `mcp_<server>_<tool>`), skill `{ skill }`, web `{ host }`, else null. Any value outside the allowlist is `<literal>`. |
| `status` | The call's status where it reports this segment; `none` where it does not, such as a segment a pipe hides. Every segment of an `&&` chain holds the call's status, because the result does not say which failed, so `error` there does not mean that segment failed, and a later clean run of it still gets a `retried` edge. |
| `cost` | `{ tokens, durationMs }` on the first segment; later segments hold nulls. `tokens` are the response's output tokens shared evenly among its calls. |
| `parent` | On a subagent's step, the `n` of the call that spawned it, in the transcript its session record names as `spawnedIn` (the main session, or a sibling subagent, since a subagent can spawn another); null when that call is not known. |
| `edges` | The edges arriving at this step, `{ kind, n, seg }` naming the source: `next` (order within a prompt's line of work), `spawned`, `retried` (same native name and same redacted command or target, after that one failed), and `after-error`. `spawned` needs the subagent's `.meta.json`; `raw/` does not hold that file, so a re-capture takes `spawnedBy` from the log, and a subagent first seen in `raw/` has no such edge. |
| `frameId` | The frame of the call's prompt. |

Comparing counts across capture versions misleads: a new version can re-read the same transcript into different rows. Compare within one `cv`.

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

`verify` also reports every session on its own (`--json`: `sessionResults`, each session's ten rows with a status of `pass`, `fail`, or `not run`), audits each session against its raw file (`audit`, layer 4 at T0: the raw-file match, the Merkle root recomputed over the first `leaves` lines, and the count bindings), and scores each session against the operator's own other weeks (`selfBaseline`, layer 2: `not run` below 1,000 tool calls in the week or 4 baseline weeks); `root mismatch` and `counts do not bind` fail `--strict`.

### Commit survival

`oars sessions deposit` and the nightly run, never a hook, read the repository of each allowlisted folder and append one line per changed
sha to `commit-survival.jsonl`: `{ sha, state, day }`, with `sha` as captured (class A), `state` (class P), and a day-resolution `day`
(class P). Only a call in a main transcript whose `ts` is more than `SURVIVAL_DAYS` (7) old counts, so a sha `commits` could not read and a
subagent's commit are not observed. `git commit -q` prints no `[branch sha]` line, so a quiet commit's sha is read only when a read-back is
the call's final command; a store that commits quietly observes few of its commits. The latest line of a sha wins. It is a separate file, so
what `verify` checks is untouched.

| `state` | Rule | What it does not say |
|---------|------|---------------------|
| `reverted` | A commit on the default branch says `This reverts commit <full sha>`, and that revert was not itself reverted. Checked first. | A hand-written or partial undo, and a revert that names a squash's sha rather than this one, are not seen. A revert of a merge marks the merge commit only, so the commits it brought in still read `survived`. |
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
| `passed` | `verifyPassed` | `verify` passed, of prompts that edited and whose `verify` is readable (not `na`, not `masked`, not absent; `none` counts, since no runner read as passing) |
| `stop` | `stopped` | A stop, of prompts carrying `stopped` |
| `redo` | `redone` | A redo, of prompts carrying `redo` |
| `commits` | `commits` | The prompts' `commits`, with or without a sha |
| `settled` | `settled` | Distinct shas whose state is `survived`, `reverted`, or `unreachable` |
| `survived` | `survived` | `survived`, of `settled` |

Below `BOOKS_MIN_PROMPTS` (30) in its denominator a share prints as `too few`, and `--json` gives its `share` as null beside its `count` and
`of`. A settled commit counts toward that minimum the way a prompt does. `--by pull` has one row per `ecosystem:name` from the calls' `pulls`, a
prompt counts once in each row it pulled, so the rows overlap, and a prompt that pulled nothing is in none. Every column reads the main line
only: subagent work is left out.

## Motifs, cells, and reads

Derivation over the capture records, computed locally under `EXTRACTOR_VERSION` (9 adds them). The capture records stay the primary record: cells and reads can be dropped and computed again, and no rollup replaces what they came from.

- A **motif** is a window of one to four steps within one line of work, hashed with no salt and no frame, so one shape joins across accounts and frames. `shape` hashes actions only and `named` hashes actions and public identities. A `class` motif holds no steps and names a prompt class, which is how cost per class comes from cells. A one-step window is there because fit, adoption, and live count one action, and a prompt of one call has no longer window.
- A **cell** is order 0: `{motifId, frameBucket, day, sessions, clusters, ok, failed, tokens, durationMs, exposed}`. A frame bucket is harness, harness version by tens of patch, model, and effort; versions are bucketed because most prompts run a version not yet seen, so an exact version goes stale in days. `exposed` is false until consequence windows are written.
- A **read** is any derived value citing its inputs: `{readId, family, method, methodVersion, inputs, order, slice, value, n, clusters, interval, asOf, basis}`. `readId` is the hash of the rest, `order` is 1 + the highest order among `inputs` with a cell at 0, a read that cites nothing is refused, and `asOf.pool` pins the pool, whose version hashes the extractor version, each family's method version, every cell, and the error rows recovery reads, so new data or a new rule gives a new read even when the value comes out the same.

The families at order 1, in the order they are listed. None adjusts for its confounders, so a row is a count and not a finding.

| Family | Slice | Value | Not removed |
|--------|-------|-------|-------------|
| `recovery` | signature hash, failed action | sessions, errors, days, what followed | `editFollowed` is not success; refusals and hook denials are local policy |
| `fit` | motif, frame bucket | failure rate | a failure is not a misfit; prompt class |
| `cost` | prompt class, model, ISO week | tokens and seconds per prompt, error share | class drift, subagent work, task size; a prompt with no wall time adds no seconds but still counts, so seconds per prompt understates |
| `change` | motif, harness, version bucket | share and failure rate in that bucket; a move between buckets is order 2 | effort, rule commits, class drift, date |
| `live` | motif, day | share of the day beside its share of the seven days before | the day's mix; no multiple-test control, so it flags nothing |
| `adoption` | motif | share of all steps, first and last day, days seen | the operator's own rules |
| `method` | shape of two or more steps, model | share among windows of its length | task assignment by tier, effort; no outcome label |
| `next-step` | prefix of one to three actions | counts of the next action | no outcome label, so the most common step is not the right one |
| `tool-day` | motif, day | failure rate, and share of the day's steps | the day's mix of work, effort, rule commits |

A read's slice and value hold closed vocabulary and numbers only: never a path, a prompt, or an error's text. A signature appears as its hash, computed the same way on any account. `clusters` is 1 on every row of one operator's store, and `oars sessions read` applies no floor at order 1, because every cell is the operator's own.

### Reads over reads

A read above order 1 takes its inputs from the orders below and its interval from theirs: a difference takes each side from the inputs that could push it there (MOVER), so a skewed rate stays skewed. A read with an input under 30 trials does not exist, and `n` and `clusters` state its weakest input. A share rests on its day's or bucket's steps and a failure rate on the tool's calls, so a tool that falls away keeps its share move: zero of a day's steps is a measurement. Inputs count a step as independent and steps cluster in sessions, so these intervals run narrow.

| Family | Order | Slice | Value | Not removed |
|--------|-------|-------|-------|-------------|
| `version-boundary` | 2 | motif, harness, two neighboring version buckets, metric | before, after, and the move in share or failure rate | date, effort, rule commits, class drift |
| `substitution` | 2 | rising tool, falling tool, the boundary | each share move, and the falling tool's move among the steps that are not the rising tool's | date, class drift, rule commits |
| `interaction` | 2 | motif, frame, two tiers | each tier's failure rate, and the gap beyond how those tiers differ on every other tool | task assignment by tier, prompt class |
| `day-move` | 2 | motif, metric, two adjacent days | before, after, and the move; a share move exists for a tool on either day, a failure move only for one with 30 calls on both | not screened, so a row is an input and not a finding |
| `lead-lag` | 3 | lead, lag, level | slope, its check, and the score | see below |

The first three state only moves past a screen, each with `tested`, the comparisons it was screened among. A move also has to reach 0.01 to be stated, so a read of nothing means nothing moved that far among the comparisons above the floor.

`lead-lag` asks whether a tool's failure rate moving comes before its share moving. It is labeled `experimental` in every output, its heading and its value both, and no agent path serves it. It is fit on the earlier 70 percent of days and scored on the rest, with a pair dated by the day its outcome is known and at least 30 pairs on each side. `check` is `passed` only if the slope's interval excludes zero, it beats predicting no move on the later days (`skill` above 0), and its sign agrees with the later days better than chance (the agreement's Wilson low above 0.5). A pair shares no day: a failure move ending on one day is paired with the share move starting on the next, because a burst of failing calls lifts that day's failure rate and share at once and would otherwise read as a lead. It runs on days because each model has one version here with no release date, and two version boundaries are too few to cut in time. Not removed: shares sum to one, a change of habit moves many tools at once, and every row states `clusters: 1`.

`oars sessions read` also states what the store cannot read, which tells a question it cannot ask from one that found nothing: a model version boundary (a cell holds no version of a model), a harness boundary with one version bucket or none above the floor, an interaction with one tier, and lead-lag with too few pairs. Each pool's reads file is pinned to `METHODS` as well as the extractor, so a family added later is not hidden by a file written before it. Transfer (how far an answer carries) is not read yet: it needs recalls held back from an arm.

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
keeps its excess keys under `other`. Class A, with the rest of the skeleton lines.

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
  - A nested repository (`parent/oars`) ranks by its parent's window while `measure --repo parent/oars` counts only itself, so the
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

## The Codex source

`oars sessions deposit --allow codex` reads OpenAI Codex CLI rollouts into the same store. The records carry `harness: "codex"`, take the same
field classes, redaction, and 1,000-character `line` cap as every other source (the rollout is rebuilt as the lines `captureSession` reads), and
`recall`, `measure`, `books`, and `verify` read them with no special case. Sources are a table (`sources.ts`): a new harness is one entry plus its reader.

**Fixture-derived, never run live.** This reader was written from the public Codex source (openai/codex @ ac558e2, Apache-2.0: `codex-rs/history`,
`codex-rs/rollout`, `codex-rs/protocol`) and tested only on synthetic fixtures; no Codex store has ever been read by it. OpenAI's documentation names the location but no format
(https://developers.openai.com/codex/config-advanced, read 2026-11-03: "By default, Codex saves local session transcripts under CODEX_HOME (for example,
`~/.codex/history.jsonl`)"; nothing in it describes the rollout files or promises them), and ccusage's Codex guide says "Codex log support is experimental while
the Codex CLI log format continues to evolve" (https://github.com/ryoppippi/ccusage, `docs/guide/codex/index.md:5` @ b4e6193; MIT, `apps/ccusage/LICENSE`). Where ccusage differs from this reader: it takes a comma-separated `CODEX_HOME` (`rust/adapters/codex/src/paths.rs:236-239`, guide `:26`), reads a bare JSONL folder when neither `sessions/` nor `archived_sessions/` exists (guide `:26`), and skips a `.zst` copy when the plain one exists (`paths.rs:92-93`; this reader decompresses a `.zst`-only rollout and lists a plain and a compressed copy of one id once). No ccusage code was copied. Codex also has command hooks, and their input is the structured alternative: it carries `session_id`, `transcript_path`, `cwd`, and `model`, for a tool call `tool_name`, `tool_input`, an untyped `tool_response`, and `tool_use_id` (`codex-rs/hooks/src/schema.rs:324-343`), for a prompt `UserPromptSubmit.prompt` (`:568-583`), and for a reply `Stop.last_assistant_message` (`:589-601`), with `SessionStart` and `SessionEnd` (`:500-511`, `:516-524`). It is not used here because no hook input holds token usage (no struct in that file has a usage or token field), a hook sees only what runs after it is installed and never the history already on disk, and the sessions store's consent model is an allowlist read at deposit time, with no watcher and nothing added to a harness's hooks. So a Codex release can change the rollout format; an unreadable rollout is warned about by name and skipped, never fatal. The one hand run that would
settle it: on a machine with a Codex account, run one `codex exec` task that makes one prompt, runs one command that exits nonzero (for example
`ls /nonexistent`), and applies one patch, then `oars sessions deposit --allow codex` and `oars sessions verify --strict`. It is settled only if the
session count is nonzero, there are zero violations, the session has a prompt and usage, and it holds an `error` tool record for that command with a
matching error line. A rollout whose shell outcomes were all lost would still show a session count and zero violations, which is why those are required.

- **Where.** `$CODEX_HOME`, else `~/.codex` (`%USERPROFILE%\.codex` on Windows; `codex-rs/utils/home-dir/src/lib.rs:5-18`): `sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl` and
  `archived_sessions/`; a reverted thread's file is `rollout-<time>-<thread>_<rollout>.jsonl` (`rollout/src/rollout_file_name.rs:12-14`, `:41-47`, `:66-73`), deposited as `<thread>_<rollout>` under the thread, so a thread counts once. Revert exists for a Paginated thread only: it writes a new file that holds the records written after the revert and references the retained prefix of the old file through `session_meta.history_base` (`thread-store/src/local/revert_thread.rs:15-18`, `:198-200`; `protocol.rs:3508-3510`), and its first record takes `history_base.end_ordinal_exclusive` as its ordinal (`rollout/src/ordinal.rs:29-31`). The new file is a subagent of the thread, so the turns after a revert show under `subagents` and, as for any subagent, carry no prompt records (only a main session derives them). The old file stays intact and still holds the turns the revert dropped; this reader does not follow `history_base`, so those turns stay counted. A `.jsonl.zst` rollout is decompressed read-only. Opt-in like Cursor: discovered by default, opened only when `--allow codex` (or a matching glob) names it; the nightly run repeats a saved allow.
- **What a rollout holds** (`codex-rs/rollout/src/policy.rs`, by `session_meta.history_mode`). `paginated` is the mode the CLI writes by default
  (`thread-store/src/local/mod.rs:512-515`; absent `history_mode` means `legacy`, `protocol.rs:949-951`): it persists `item_completed` events holding a `TurnItem`
  (`items.rs:50`) in place of `user_message`, `agent_message`, `patch_apply_end`, and `mcp_tool_call_end` (`policy.rs:142-156`; the items are chosen in `persisted_item_completed_event`, `:232`, `Paginated` arm `:253`), and stamps every record with an `ordinal`
  (`ordinal.rs:28`). `legacy` persists those four events and no ordinals (`ordinal.rs:37`). Both modes persist `session_meta`, `turn_context`, `token_count`, and
  `response_item` (`policy.rs:27-29` `response_item`, `:43` `turn_context`, `:49` `session_meta`, `:134` `token_count`); `exec_command_end` and `error` are never persisted. This reader reads both: an `item_completed` `UserMessage` and
  `AgentMessage` (`items.rs:85`, `:160`) are the prompt and the reply (their text parts are tagged by their own variant: `{type: text}` in a `UserMessage`, `user_input.rs:16`, but `{type: Text}` in an `AgentMessage`, `items.rs:131-135`), a `FileChange` (`core/src/tools/events.rs:610-617`) settles its patch by `status`, and an
  `McpToolCall` (`core/src/mcp_tool_call.rs:1189-1207`) its MCP call by `status`, `error`, and `result.isError`.
- **Mapping.** `session_meta` gives the id, cwd, and `cli_version`; `turn_context.model` the model; `user_message` a prompt and `agent_message` a
  response; `token_count.last_token_usage` the usage (cached input is a subset of input, so it is split out as cache read; `cache_write_input_tokens` is cache creation and is also inside `input_tokens`, so it is taken out of input too: input 100 = cached 40 + write 60, `codex-api/src/sse/responses.rs:889-911`). A shell call
  (`shell`, `shell_command`, `exec_command`, `local_shell`, `container.exec`, `write_stdin`, and a `local_shell_call`) is settled by its `function_call_output` text: the
  real exit code from `Exit code: N` (`core/src/tools/mod.rs:107`) or `Process exited with code N` (`core/src/tools/context.rs:556`), and the text after the
  `Output:` line is the error line's source; a process still running has no code and no outcome until a `write_stdin` poll (`session_id`, `handlers/shell_spec.rs:113`) sees it exit, which settles both calls; `execution error: ...` (`core/src/tools/events.rs:438`) is a call that failed to spawn and is an error, while a declined one (`exec command rejected by user`, `:456`) has no outcome. An older Codex wrote a JSON `{output, metadata.exit_code}`
  wrapper (`rust-v0.46.0`, `core/src/tools/mod.rs:186`), which is unwrapped. `apply_patch` is an edit, with the files its input names and its
  `patch_apply_end` outcome (Legacy) or `FileChange` item (Paginated); a patch with no end event, or a declined one, has no outcome, because a rejected patch comes back as plain output text (`tools/handlers/apply_patch.rs`). An MCP call is settled by its `mcp_tool_call_end` (Legacy, `protocol.rs:3047`) or `McpToolCall` item (Paginated): `result.Err`, `error`, or `isError`, is a failure carrying its text.
  A `function_call` with a `namespace` (`models.rs:1154`) is never read as Codex's own shell or patch tool, but `functions` and an empty namespace are no namespace: upstream makes them the plain tool (`protocol/src/tool_name.rs:6-7`, `:46-50`; `core/src/tools/mod.rs:51-53`; `core/src/tools/router.rs:285`). Any other namespace is joined to the name the way upstream flattens it, with nothing between (`core/src/tools/mod.rs:55-60`; `codex-mcp/src/tools.rs:296`), so an MCP namespace that ends in `__` gives `mcp__<server>__<tool>`, the form Claude Code writes (`tools.rs:253`). A name that already starts with its namespace is kept as written (`models.rs:3409-3410`). A namespace without a trailing `__` gets one from the reader (`collaboration__spawn_agent`, from `models.rs:3485-3486`); that is this reader's own choice, not upstream's flat name. A spawned agent's rollout (`session_meta.parent_thread_id`, `protocol.rs:3464`) is deposited as a subagent of that thread, counted under `subagents` and not `sessions`. So is a rollout whose `session_meta.source` (`:3477`) is `{subagent: ...}` or `{internal: ...}` even with no `parent_thread_id`: upstream's `is_non_root_agent` is `Internal(_) | SubAgent(_)` (`:3280-3285`), `parent_thread_id` is Some for `ThreadSpawn` only (`:3376-3386`), and serde writes the source lowercase and externally tagged (`:3141-3144`, `:3223-3226`; no JSON example of it was found in the files read, so the shape rests on those attributes). Its parent is `session_id`, the root thread (`:3451-3452`), else itself. A review delegate is started by `run_codex_thread_one_shot` (`core/src/tasks/review.rs:128-136`) with its parent's config unchanged and no `ephemeral` or persistence setting in that file or `core/src/codex_delegate.rs`; it hands its parent's thread id to the new session (`codex_delegate.rs:138`), and the session persists unless `config.ephemeral` (`core/src/session/session.rs:1105`), so its rollout is written and normally carries `parent_thread_id`. Records below `subagent_history_start_ordinal` (`:3511-3516`) are the parent's prefix, copied into the file (`ordinal.rs:86-89`), and dropped; a Paginated fork copies none, since its `history_base` points at the parent (`:3508-3510`). Only the first `session_meta` is the rollout's own; later ones are copied from fork history (`recorder.rs:1157-1158`, `:1173`). A Legacy fork has no ordinals, so its leading records that equal the parent's rollout, payload for payload with timestamps excluded, are dropped; when the parent rollout is not in the store, the fork's records are all kept. Timestamps are each line's own; a missing or earlier one never steps back.
- **Absent.** Cost, per-call duration, and message ids (a request id is synthesized per response so `verify --strict` holds). A `thread_rolled_back` event is persisted (`rollout/src/policy.rs:134-136`) and this reader ignores it, so the prompts and usage of rolled-back turns stay counted: a known limit.
  Another non-shell call (`update_plan`, `read_file`) has no structured failure signal in this format and is recorded as `ok`. A `token_count`
  with no assistant line before it (a reasoning-only response) has nothing to attach to, so its usage is not counted. Torn lines are counted as
  unparseable; a file with no parseable line is unreadable. Idempotent per rollout (`codex/<uuid>` in `state.json`, size and mtime).

## The outcome gold set

`oars sessions gold sample` writes `outcome-gold-<date>.md` to `<claude config>/session-commons/review/`: about 200 prompts in batches of 50, each with the redacted request, the result (commit message and diff stat where found, the transcript's own edit calls, or the actions of a prompt that edited nothing), and a `Judgment: yes|no` line. The draw is seeded and weighted by the square root of each class and model cell, with at most two prompts a session, so its base rate is the sample's, not the store's. `--exclude-term` leaves out any session that mentions a term in its transcript or a subagent's. A marker prompt, a `no-tools` prompt (its reply is the closing claim), and a session from any other harness (every `SOURCES` name: Cursor, Codex) are not drawn. The signals go to the `.arms.json` file beside it. `oars sessions gold score <file>` prints, per model and pooled, each signal's AUROC with a DeLong 95% interval and the base rate, from whatever is judged so far. Both are local, and neither is ever committed. A signal is an observation, not a label, and no signal is combined with another.

`oars sessions gold arms <file>` fills the same sidecar and leaves the gold file alone, so judgments carry over. From the transcript it reads the closing reply, the turn's last `Confidence:` line, and the next prompt that is not a marker. Fresh single-turn readers then give three separate answers: `evaluator` reads what the judge reads and says whether the work did what was asked, `claim` reads the closing reply and says whether it claims success, and `later` reads the next prompt and says whether the person accepted the work, or that it cannot tell. Each runs through `claude -p` on your own subscription login, on one named model, with no tools, hooks, settings, or session file. Its fixed wording is hashed into the sidecar, and a rerun refuses a sidecar written under other words. The command checks the login first and refuses an API key or another provider. It saves after each answer and resumes, and it prints only how many prompts each arm covers; `gold score` reads each arm against the judgments. This is the one `sessions` command that calls a model. The text it sends is redacted and has no tools to act on.
