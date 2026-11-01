# The `oars sessions` store (version 3)

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
| `state.json` | Per file: size, mtime, capture version, and the `--redact-domain` set, so an unchanged file is skipped. |
| `salt` | The per-account salt that file targets are hashed with. Local-only, never shared. |
| `raw/<project>/<path>` | oars' own archive of every deposited transcript (below). |

## Two versions

- `CAPTURE_VERSION` (`cv` on every captured record) names the captured field list. Bump it only when that list changes: a bump
  re-reads every transcript.
- `EXTRACTOR_VERSION` (`v` on every derived record and skeleton) names the derivation rules (error normalization, prompt classes,
  tool-name sequences, recovery episodes). A bump re-derives from the log; no raw transcript is read.

A version-2 session (no `cv`) is still read: its already-derived `prompt` and `error` lines pass through until it is deposited again.

## Captured records

Every record carries `kind`, `cv`, `session`, and `rev`. Text is redacted (secrets by pattern and entropy, emails, and the domains
named with `--redact-domain`) before it is cut or written. A `local-only` field never leaves this machine, whatever later tier is
switched on; a `shareable` field is a name, version, count, duration, status, key name, or hash.

| Record | Fields | Class |
|--------|--------|-------|
| `session` (one per transcript) | `parent`, `agentType`, `spawnedBy` (set on a subagent transcript), `at`, `bytes`, `lines`, `badLines`, `userTurns`, `assistantTurns`, `tsFirst`, `tsLast`, `versions`, `models`, `tools`, `bashCmds`, `compactSummaries`, `contextFingerprint`, `costUsd`, `usage` | shareable |
| | `project` (the folder slug, with the username and directory names), `files`, `urls`, `searches`, `branches`, `tldrs` (400 chars), `confidences` (120 chars) | local-only |
| `user-prompt` (one per prompt) | `index`, `ts`, `wallSec`, `thinking`, `turns`, `model`, `efforts`, `skills`, `usage`, `contextFingerprint` | shareable |
| | `head` (the first 300 characters) | local-only |
| `tool` (one per tool call) | `n`, `ts`, `tool`, `status` (`ok`, `error`, or `none` when no result is in the file), `target`, `keys` (the input's key names), `durationMs`, `harnessVersion`, `agentType`, `side`, `prompt` | shareable |
| | `toolUseId`, `parent` (they join records inside this store only) | local-only |
| `error-line` (one per failed result) | `tool`, `ts`, `harnessVersion`, `side`, `prompt`, `after` | shareable |
| | `toolUseId`, `line` (the first informative line, redacted, not normalized, not cut) | local-only |

`target` is a 16-hex SHA-256 of the file path relative to the line's working directory, salted per account, for a call with a
`file_path`, `notebook_path`, or `path` input; the program and subcommand (`git push`, `npm run`) for a shell call, after any leading
`cd <dir> &&` hop, environment assignment, or `sudo`; else null.

## Subagent transcripts

`<project>/<session>/subagents/agent-*.jsonl` and `.../subagents/workflows/wf_*/agent-*.jsonl` are deposited as
`<parent>~agent-<id>` and `<parent>~wf_<id>~agent-<id>`, with the parent session id and the subagent type from the sibling
`.meta.json`. They are kept apart from the sessions, so per-session denominators (`measure`, G1) still count main sessions;
`books --by class` adds their tokens to the spawning prompt's class as the `delegated` column. Their errors are derived into the
same `error` records as a main session's, under the parent's `session`, with the agent's transcript in `agent` (local-only) and the
spawning prompt's `prompt` and `cls`: signatures, `measure`, and recall include them, and each signature counts the parent once.

## The raw archive

Each deposit (the `deposit` command and the Stop hook's) hard-links every transcript it reads into `raw/<project>/<path>`, so
the raw outlives the harness's own cleanup (`cleanupPeriodDays`) at no extra disk while both names exist. Across volumes, or on a
file system without hard links, it copies instead. A rerun leaves a present link alone and replaces a stale copy. The archive is
local only and is never read by `derive`.

## The cost-state check

`verify` checks that the harness's `cost-state` totals cover the recorded usage, not that they equal it. The totals cover only
the process that wrote them (from its `startTime`, so a resumed session's earlier lines are outside them), and they include the
session's subagent transcripts and side calls that no transcript records (such as a small-model call with no assistant line). The
invariant is that usage since `startTime`, main and subagent lines together, counted once per request id, never exceeds the totals.
