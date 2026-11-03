# The `oars sessions` store (version 8)

`oars sessions` keeps a local, deterministic memory of the operator's own Claude Code sessions: no model call, no network, nothing
uploads. `gold arms` is the one exception: it sends redacted text through your own Claude subscription. This page is the store's format. The types are in `packages/cli/src/sessions/schema.ts`; the commands are in the CLI README.

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
| `pipeline-runs.jsonl` | The step log: one row per run of a pipeline step (deposit, derive, index, verify, recall, read), appended when the step ends. See "The step log". |
| `cells.jsonl`, `motifs.jsonl` | Counts per motif, frame bucket, and day, and the motifs they name. Computed from the log, rewritten by `oars sessions read`, and safe to delete. See "Motifs, cells, and reads". |
| `reads/<pool>.jsonl` | One pool version's reads, written once and never rewritten, so a read cited by its ID stays what it was. |
| `raw/<project>/<path>` | oars' own archive of every deposited transcript (below). |

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
behind and its next deposit captures every transcript again. Version 6 (CAPTURE 6) adds `segments`, `pulls`, and `commits` to the tool
record (see "What a shell call captures"), and a version-5 store's next deposit captures every transcript again. Version 7 (CAPTURE 7)
adds `frame` to the session and prompt records and `steps` to the tool record (see "Frames and steps"), and moves `tool`, `tools`, and a shell-form
`target` from class P to class A; a version-6 store's next deposit captures every transcript again from the harness or `raw/`. Version 8 (CAPTURE 8 and EXTRACTOR 8) changes no
field name either: it changes what `tool`, `error-line`, and the session's `tools`, `bashCmds`, `tldrs`, and `confidences` hold. The harness writes
`api-request-blob` lines, copies of the request body with no `cwd`, `uuid`, or `timestamp`; capture read their blocks as conversation and wrote every call
a second time with status `none` (99.8% of the 55,801 `tool_use` blocks on those lines repeat a real call). It no longer reads them, and a call a
resumed transcript replays under the same tool-use id is written once. The skeleton still lists every line, so the counts and the root bind. A reader
folds an older store the same way (`fold.ts`): one `tool` record per session and tool-use id, the first, with the first status found and, when the first has no `ts`, the
`target`, `targetBase`, `ts`, and `harnessVersion` of the first copy that has one; the kept records are numbered from zero and each `error-line`'s `after`
moves to match, so `next` and `editFollowed` read the same calls as a current capture; and the session's `tools` and `bashCmds` are less the dropped calls. A call with no result is still a record, status `none`. What an open does with an older store:

| Log holds | Action on open | Action at the next deposit |
|-----------|----------------|----------------------------|
| `cv` 8, `v` current | read | skip unchanged files |
| `cv` 5 and the transcript is on disk or in `raw/` | read; a replayed `tool` record is folded (see above); `verify` counts it `cv-behind`, and `verify --strict` exits 4 on it | capture again at `rev + 1` |
| `cv` 5, neither the harness nor `raw/` has the transcript | read; a replayed `tool` record is folded (see above); `verify` counts it `cv-frozen` (not `cv-behind`), and `verify --strict` does not fail on it | none |
| `cv` 3 or 4 (or a version-2 session) and the transcript is on disk or in `raw/` | read through the compatibility reader (for `cv` 3, a field version 4 added reads as null, empty, or `unknown`; the prompt half of `contextFingerprint`, before its `.`, reads as `promptFingerprint`, and `-` reads as null; the environment half is dropped); `verify` counts it `cv-behind`, and `verify --strict` exits 4 on it | capture again at `rev + 1`; derived records regenerate under the current `EXTRACTOR_VERSION` on every open |
| `cv` 3 or 4, neither the harness nor `raw/` has the transcript (for a Cursor session, Cursor no longer lists the composer) | read through the compatibility reader; `verify` counts it `cv-frozen` (not `cv-behind`), and `verify --strict` does not fail on it | none |
| `derived.json` `v` older than `EXTRACTOR_VERSION` | read | rewritten at the next deposit (no reader depends on it today); derived records are regenerated from the log on every read |
| `cv` newer than this code | read the fields this code knows, and warn ("captured by a newer oars; upgrade oars" on `verify`, `measure`, and `books`) | refuse with "upgrade oars" (`oars sessions deposit` and the nightly run read the log and refuse when a session's latest capture has a newer `cv`; the Stop-hook path reads only `state.json`) |
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
| `session` (one per transcript) | `agentType` (set on a subagent transcript), `harness` (set on a Cursor session; absent reads as Claude Code), `bytes`, `lines`, `badLines`, `userTurns`, `assistantTurns`, `versions`, `models`, `bashCmds`, `compactSummaries`, `costUsd`, `usage`, `env` (below), `frame` | P |
| | `session`, `parent`, `spawnedBy` (join ids), `at`, `tsFirst`, `tsLast` (a pool would keep the UTC day), `promptFingerprint`, `repo`, `tools` (native names, which can hold a private MCP server's), `fileHashes`, `urls`, `searches`, `branches`, `tldrs` (400 chars), `confidences` (120 chars) | A |
| | `project` (the folder slug, with the username and directory names), `files` (the paths as written, redacted) | L |
| `user-prompt` (one per prompt) | `index`, `wallSec`, `thinking`, `turns`, `model`, `efforts`, `skills`, `usage` | P |
| | `session`, `ts` (a pool would keep the UTC day), `head` (the first 300 characters), `promptFingerprint` | A |
| `tool` (one per tool call) | `n`, `status` (`ok`, `error`, or `none` when no result is in the file; one record per tool-use id), `keys` (the input's key names), `durationMs`, `harnessVersion`, `agentType`, `side`, `prompt`, `targetBase`, `steps` | P |
| | `session`, `parent`, `toolUseId`, `ts` (a pool would keep the UTC day), `tool` (the native name, which can hold a private MCP server's), `target` in either form (a salted hash, or the first line's program and subcommand, where a word can be anything), and `segments`, `pulls`, and `commits` (a plain word, a private package name, and a sha can each identify private work) | A |
| `error-line` (one per failed result) | `harnessVersion`, `side`, `prompt`, `after` | P |
| | `session`, `toolUseId`, `tool` (the native name), `ts` (a pool would keep the UTC day), `line` (the first informative line, redacted, not normalized, cut to 1,000 characters) | A |
| `prompt` (derived, one per prompt) | `kind`, `v`, `rev`, `index`, `wallSec`, class (`cls`), `tools`, `shape`, `errors`, `thinking`, `sideTools`, `turns`, `model`, `efforts`, `skills`, `usage`, `recovery`, `explore`, `act`, and `bigrams` (the motif vector) | P |
| | `session`, `head` (the first 300 characters, redacted), `ts`, `promptFingerprint` (`contextFingerprint` on this derived record), and the outcome signals `verify`, `stopped`, `commits`, and `redo` (below) | A |
| `error` (derived, one per error) | `kind`, `v`, `rev`, `tool`, `harnessVersion`, `editFollowed`, `cls`, `prompt`, `next` (tool names), episode `outcome` and `calls` | P |
| | `session`, `agent` (the subagent transcript id, a join id), `ts`, `sig` (redacted at capture, normalized at derive), `example` (160 characters) | A |
| store files | `salt`, `state.json`, `raw/`, `hook-index.json` `projects` keys (folder slugs), `mcp-calls.jsonl` `cwd` (the server's working directory, unhashed) | L |
| | skeleton lines (`skeletons/<session>.json`: ids, usage, block hashes, each cost-state model's usage keys; a pool would hold only `merkleRoot` and `leaves`), `hook-calls.jsonl` `session`, `at`, and `error` (first line, redacted), `mcp-calls.jsonl` `query` and `at` (each `at` is finer than a UTC day; a pool would keep the UTC day) | A |
| | `hook-calls.jsonl` `event`, `hit`, `ms`; `mcp-calls.jsonl` `matches` | P |

A pool may hold a day-resolution date only: none of the A fields above reaches it. `sw` (the per-field local-only switch for text
fields on a hosted store) applies to `urls`, `searches`, `branches`, `tldrs`, `confidences`, `head`, `line`, `sig`, `example`, and `mcp-calls.jsonl` `query`.

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

CAPTURE 7 gives every call a shared coordinate, so calls compare across harnesses, models, versions, and dates. Nothing here is asked of a
network or a model: a value outside a closed list reads `<literal>` or is dropped, so these fields stay class P. The lists live in one file,
`src/sessions/public-vocabulary.ts`, and default to `<literal>` when unsure.

A `frame` sits on each prompt, and on the session for the calls before the first prompt: `{ harness, harnessVersion, model, effort, day, platform,
shell, stack }`. `day` is the UTC date. `stack` is a language mix, framework names, and a repository size bucket, each from a closed
list. `frameId`, beside it on the record, is a 16-hex hash of the frame, and a step names it.

`steps` sits on the tool record, one per call, or one per command of a shell call (`&&`, `||`, `;`, pipes, and subshells, with quoted separators
left alone, tied by `seg`). It is nested so `n`, the count bindings, and the Merkle checks do not move.

| Field | Holds |
|-------|-------|
| `n`, `seg` | The call's position in the transcript, and the step's position in the call. |
| `action` | One of the closed list in `src/sessions/actions.ts`, from one table per adapter. An unmapped name is `other`. |
| `native` | The harness's name for the tool when its table lists the name, or when every name it holds is public, else `<literal>`. |
| `identity` | By action: shell `{ program, sub, flags, pulls? }` (flag names, never their values, so `-c1-200` reads `-c` and `head -20` reads `-N`; a pull is `{ registry, name, version }`), MCP `{ server, tool }`, skill `{ skill }`, web `{ host }`, else null. Any value outside the allowlist is `<literal>`. |
| `status` | The call's status where it reports this segment; `none` where it does not, such as a segment a pipe hides. |
| `cost` | `{ tokens, durationMs }` on the first segment; later segments hold nulls. `tokens` are the response's output tokens shared evenly among its calls. |
| `parent` | On a subagent's step, the `n` of the call that spawned it in the main transcript; null when that call is not known. |
| `edges` | The edges arriving at this step, `{ kind, n, seg }` naming the source: `next` (order within a prompt's line of work), `spawned`, `retried` (same action and identity after that one failed), and `after-error`. `spawned` needs the subagent's `.meta.json`; `raw/` does not hold that file, so a re-capture takes `spawnedBy` from the log, and a subagent first seen in `raw/` has no such edge. |
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

## Motifs, cells, and reads

Derivation over the capture records, computed locally under `EXTRACTOR_VERSION` (9 adds them). The capture records stay the primary record: cells and reads can be dropped and computed again, and no rollup replaces what they came from.

- A **motif** is a window of one to four steps within one line of work, hashed with no salt and no frame, so one shape joins across accounts and frames. `shape` hashes actions only and `named` hashes actions and public identities. A `class` motif holds no steps and names a prompt class, which is how cost per class comes from cells. A one-step window is there because fit, adoption, and live count one action, and a prompt of one call has no longer window.
- A **cell** is order 0: `{motifId, frameBucket, day, sessions, clusters, ok, failed, tokens, durationMs, exposed}`. A frame bucket is harness, harness version by tens of patch, model, and effort; versions are bucketed because most prompts run a version not yet seen, so an exact version goes stale in days. `exposed` is false until consequence windows are written.
- A **read** is any derived value citing its inputs: `{readId, family, method, methodVersion, inputs, order, slice, value, n, clusters, interval, asOf, basis}`. `readId` is the hash of the rest, `order` is 1 + the highest order among `inputs` with a cell at 0, a read that cites nothing is refused, and `asOf.pool` pins the pool, so new data gives a new read even when the value comes out the same.

The eight families at order 1, in the order they are listed. None adjusts for its confounders, so a row is a count and not a finding.

| Family | Slice | Value | Not removed |
|--------|-------|-------|-------------|
| `recovery` | signature hash, failed action | sessions, errors, days, what followed | `editFollowed` is not success; refusals and hook denials are local policy |
| `fit` | motif, frame bucket | failure rate | a failure is not a misfit; prompt class |
| `cost` | prompt class, model, ISO week | tokens and seconds per prompt, error share | class drift, subagent work, task size |
| `change` | motif, harness, version bucket | share and failure rate in that bucket; a move between buckets is order 2 | effort, rule commits, class drift, date |
| `live` | motif, day | share of the day beside its share of the seven days before | the day's mix; no multiple-test control, so it flags nothing |
| `adoption` | motif | share of all steps, first and last day, days seen | the operator's own rules |
| `method` | shape of two or more steps, model | share among windows of its length | task assignment by tier, effort; no outcome label |
| `next-step` | prefix of one to three actions | counts of the next action | no outcome label, so the most common step is not the right one |

A read's slice and value hold closed vocabulary and numbers only: never a path, a prompt, or an error's text. A signature appears as its hash, computed the same way on any account. `clusters` is 1 on every row of one operator's store, and `oars sessions read` applies no floor, because every cell is the operator's own.

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

## The V15 exclusion list

One rule decides which sessions may enter the pool (A38): a session is excluded if any line of its main or
subagent transcript holds a listed term, scanned locally before anything is deposited. A session with no main transcript to scan
is excluded, and so is every session when the term file is missing or empty. A folder that cannot be read leaves its session
excluded as unreadable, never clean. The scan reads both the harness's `projects/`
folder and `raw/`, because either can be the only copy left.

The term list is a local file, one term per line, matched without regard to case, never in this repository. The
`OARS_EXCLUSION_TERMS` environment variable names it; the default is `session-commons/exclusion-terms.txt` beside the claude
`projects/` folder. `oars sessions exclusions [--out <file>]` writes the excluded sessions (project and session id, one JSON
object per line) to `session-commons/exclusion-list.jsonl` by default and prints counts only: sessions, excluded by reason,
and the files and sessions that held a term, by main or subagent and by source. The list is written readable by its owner only, since a
folder name can carry a term. It covers the harness's folders, `raw/`, and the sessions the store logged, so a logged session whose raw is gone
everywhere is listed as no raw; a directory that is not a session (no main transcript, and a name that is not a session id) is counted apart.
The pool's deposit is to call `assertDepositable` (`packages/cli/src/sessions/exclusion.ts`) first, which refuses an excluded session (t758).

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

## The outcome gold set

`oars sessions gold sample` writes `outcome-gold-<date>.md` to `<claude config>/session-commons/review/`: about 200 prompts in batches of 50, each with the redacted request, the result (commit message and diff stat where found, the transcript's own edit calls, or the actions of a prompt that edited nothing), and a `Judgment: yes|no` line. The draw is seeded and weighted by the square root of each class and model cell, with at most two prompts a session, so its base rate is the sample's, not the store's. `--exclude-term` leaves out any session that mentions a term in its transcript or a subagent's. A marker prompt, a `no-tools` prompt (its reply is the closing claim), and a Cursor session are not drawn. The signals go to the `.arms.json` file beside it. `oars sessions gold score <file>` prints, per model and pooled, each signal's AUROC with a DeLong 95% interval and the base rate, from whatever is judged so far. Both are local, and neither is ever committed. A signal is an observation, not a label, and no signal is combined with another.

`oars sessions gold arms <file>` fills the same sidecar and leaves the gold file alone, so judgments carry over. From the transcript it reads the closing reply, the turn's last `Confidence:` line, and the next prompt that is not a marker. Fresh single-turn readers then give three separate answers: `evaluator` reads what the judge reads and says whether the work did what was asked, `claim` reads the closing reply and says whether it claims success, and `later` reads the next prompt and says whether the person accepted the work, or that it cannot tell. Each runs through `claude -p` on your own subscription login, on one named model, with no tools, hooks, settings, or session file. Its fixed wording is hashed into the sidecar, and a rerun refuses a sidecar written under other words. The command checks the login first and refuses an API key or another provider. It saves after each answer and resumes, and it prints only how many prompts each arm covers; `gold score` reads each arm against the judgments. This is the one `sessions` command that calls a model. The text it sends is redacted and has no tools to act on.
