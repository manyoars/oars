# Gate: replay and report

`oars gate replay` finds every package, MCP server, and skill your agents picked in session logs already on your disk, and `oars gate report` counts them. It records the pick. It is capture first and not a security product: it blocks nothing, installs nothing into your hooks, and calls nothing a verdict.

```
oars gate replay --allow ~/work/app          # writes crossings.jsonl into the sessions store
oars gate replay                             # no --allow: the allowlist a deposit saved
oars gate replay --allow app --registry-state   # also ask the package manager what the registry holds
oars gate report                             # counts from the last replay, and what replay cannot see
```

## What a crossing is

A tool call that takes something from outside the repository into the agent's session, named by the closed vocabulary in `packages/cli/src/gate/checks.ts`. The same code is what a later hook calls on a live tool call, so replay and a hook agree.

| Matcher | Class | Forms |
|---------|-------|-------|
| `Bash` (and `PowerShell`, since the corpus this was built on runs on Windows) | `npm-package`, `python-package` | `install`, `url-install` (a git or tarball URL), `fetch-and-run` (`npx`, `bunx`, `pnpm dlx`, `uvx`, `pipx run`), `url-fetch-and-run` |
| `mcp__.*` | `mcp-server` | `mcp-call` |
| `Skill`, and `Bash` for `npx skills add <source>` | `skill` | `skill-call`, `install` (the source is the first word after `add` that is not a flag or the value of `-s`, `--skill`, `-a`, or `--agent`, as written minus any query; a variable or a path names nothing; a `file:`, `git+file:`, `link:`, `workspace:`, or `portal:` spec is a path, with or without a package name before it (`foo@file:...`, `foo @ file:...`), so it is counted under "replay cannot see" as `local-path` and no part of it is kept) |

A lockfile-only install (`npm ci`, `pip install -r`, a bare `npm install`) names nothing and crosses nothing; it is counted under "replay cannot see" by shape. So is a pipe into a shell and a command behind `xargs`.

## The source: raw transcripts, not the store

Replay reads raw transcripts under the allowlist, from the harness's folder and the store's `raw/` archive, one copy per relative path. It does not read Codex or Cursor: their history is not raw transcripts. The store loses what the checks need: form (`pulls` has no install or fetch-and-run, and is per call, not per command), flags and quoted words, permission mode, Skill input, and the earlier text "where the name came from" needs. Reading raw costs parse time, and raw is class `L`, so nothing of class `L` goes in the record: no path, working directory, or command text.

## What a name may be

Every name passes one function, `admitName` in `packages/cli/src/gate/checks.ts`, before it can reach `crossings.jsonl`, a registry question, or a removal match. A name outside its family's grammar is never written and never asked; it is counted under "replay cannot see" by the shape it has: `local-path` when it holds a path separator, a scheme, or an `@` past the scope; `masked-name` or `variable-name` when it is one; `unreadable-name` otherwise (a space, a `?`, a leading dot or dash, an empty word, or a length over the limit).

| Class | Grammar |
|-------|---------|
| `npm-package` | npm's: `name` or `@scope/name`, letters, digits, `.`, `_`, `~`, `-`, at most 214 characters |
| `python-package` | PEP 508's project name: letters, digits, `.`, `_`, `-`, starting and ending with a letter or digit |
| `mcp-server` | the harness's server segment: letters, digits, `_`, `.`, `-`, at most 128 characters |
| `skill` (`skill-call`) | letters, digits, `_`, `.`, `-`, and `:` for a plugin's prefix, at most 128 characters |
| `skill` (`install`) | `owner/repo`, optionally into a folder, or a URL. The owner starts with a letter or digit and no segment is `.` or `..` |
| a URL form (`url-install`, `url-fetch-and-run`) | an `http`, `https`, `ssh`, or `git` URL (host, port, path; `ssh` and `git` also take npm's scp spelling `host:owner/repo`, and a path segment may start with `@`, a scope's, but an `@` that ends a segment or sits inside one is a ref or a path, so the word counts as `local-path`), a hosted shorthand (`github:org/repo`), `org/repo`, or `host:path` with a host of at least two characters. The owner of `org/repo` starts with a letter or digit, and no path segment is `.` or `..`. Credentials, query, and fragment are removed first (a user before the host is a credential even when the word has no path, never a ref); a mask the redactor placed stays. pip's `name @ url`, with spaces, is read as the URL |

A version that is not a URL's ref is also refused when it holds a slash, a backslash, `:`, or `@`; the whole crossing is then counted as `local-path`.

A URL's ref (the `#...` fragment, or a git URL's `@ref`, which starts at the first `@` past the host that does not follow a `/`) is kept as `version` only when it is a plain ref: letters, digits, and `.`, `_`, `^`, `~`, `*`, `+`, `-`, optionally after `semver:`. Anything else (a path, `key=value`, a query) is dropped: the crossing stays, with no version.

The words a manager's flag owns are not read as names. The flags are listed in `VALUE_FLAGS` in `checks.ts`; a value flag that list does not hold is read as part of the command, so its bare `a/b` value still reads as `org/repo` and is recorded as a `url-install` of that spelling.

## `crossings.jsonl`

Written beside `observations.jsonl`, atomically, and the only file replay writes. One `run` row (the books), then `registry` rows (the cache of `--registry-state`), then one `crossing` row per crossing in time order. Classes are those of `docs/sessions-store.md`.

| Field | Class | Values |
|-------|-------|--------|
| `kind`, `v`, `day` | P | row kind, gate version, UTC day |
| `class`, `form`, `program`, `versionForm`, `statusReports` | P | closed vocabulary; `program` is `npm`, `pnpm`, `yarn`, `bun`, `npx`, `pip`, `python -m pip`, `uv`, `uvx`, `pipx`; `versionForm` is `pinned`, `range`, `tag`, `url`, `unstated` |
| `origin` | P | where the name came from: `prompt`, `repo-file`, `web`, `tool-output`, `skill`, `harness`, or `none-seen` |
| `novelty` | P | `fleet` (first time anywhere in the replay), `repository`, `session`, `none` |
| `decidedBy` | P | `operator` when a main-line prompt named the package before its first crossing in that transcript, whatever source showed it first; else `agent` |
| `permission` | P | the harness's permission mode, or `other` or `unknown` |
| `status` | P | `ok`, `error`, `refused`, `none` |
| `next` | P | `proceeded`, `retried`, `routed-around`, `changed-name`, `stopped`, `no-result` (ten calls after a failure) |
| `removedLater`, `depth`, `miss` | P | a later removal in the same repository, `main` or `subagent`, and `not-found` when the result said the name did not exist |
| `againstLatest`, `registryState`, `registryAge` | P | read only with `--registry-state`; otherwise `not-read` |
| `arm`, `lineShown` | P | always `none` under replay: nothing is shown to an agent |
| `session`, `agent`, `toolUseId`, `ts` | A | join ids and a finer time |
| `name`, `version` | A | what the command stated. A package or server name can identify private work, as `pulls` already says |
| `registry` row: `kind`, `v`, `day`, `class`, `state` | P | row kind, gate version, UTC day the answer was read, package class, `found` or `not-found` |
| `registry` row: `name`, `latest`, `created` | A | the name asked, the registry's latest version, and the name's creation time. `created` is a full timestamp, so it is not class P |

`run` row: counts of transcripts, unreadable files, torn lines, calls, and crossings, the commands it could not name by shape, and whether the registry was read (class P).

There is no repository key in the record. Repository novelty is computed in memory during replay; a hook that wants it from this file will need a salted key.

## Registry state

Off by default. With `--registry-state`, replay asks `npm view` or `pip index versions`, in the call's own folder, and only for a crossing made with `npm`, `npx`, `pnpm`, `pip`, or `python -m pip`: those read the config `npm` and `pip` read, so the answer comes through the registry that manager would contact. A crossing made with `yarn`, `bun`, `uv`, `uvx`, `pipx`, `poetry`, `pdm`, `rye`, `pipenv`, `conda`, `mamba`, or `micromamba` is never asked, since its registry config may differ and a private name must not reach a public registry; it reads `not-read`. A name is also not asked when any crossing of it chose its own registry or config: a command that states `--registry`, `-i`, `--index-url`, `--extra-index-url`, `--index`, `--default-index`, `--userconfig`, `--globalconfig`, `--prefix`, `-C`, `--dir`, a source flag (`-f`, `--find-links`, `--no-index`), a scoped `--@scope:registry`, a `--config.*registry` setting, or `-i` with its value attached; a command with an `NPM_CONFIG_`, `PIP_`, or `UV_` variable set in the same call; or a command that follows a `cd` (or `Set-Location`, `pushd`, `Push-Location`, `Pop-Location`) in the same call. The question would go through the default config from the call's recorded folder and could send a private name to a public registry, so every row of that name reads `not-read`, kept answers included. An answer reaches a row only when that row's own program was asked: `npm install x` then `yarn add x` gives the `yarn` row `not-read`. Answers are cached in the file for 30 days (`REGISTRY_MAX_DAYS` in `replay.ts`): a row older than that, by the run's clock, counts as absent, is asked again, and is replaced. This is the one option that goes beyond local reads: the managers keep their own caches, so it writes outside `crossings.jsonl`, and it answers as of the run, not as of each crossing. A replay without it prints "registry state not read" and every registry field reads `not-read`; it never guesses.

## What replay cannot see

A command run from a script, alias, or Makefile; a manifest edit a later bare install picked up; what a person saw or approved; an MCP server started and never called; folders off the allowlist; logs the harness already cleaned up; a session in Codex or Cursor, which replay does not read. `oars gate report` ends with this list and the counts by shape.

## Not in this release

Pool reads, sign-in, deposit prompts, blocking, and any hook. `install`, the policy file, and notes come in the next brief.
