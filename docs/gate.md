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
| `Bash` (and `PowerShell`, since the corpus this was built on runs on Windows) | `npm-package`, `python-package` | `install`, `url-install` (a git or tarball URL), `fetch-and-run` (`npx`, `pnpx`, `bunx`, `pnpm dlx`, `uvx`, `pipx run`), `url-fetch-and-run` |
| `mcp__.*` | `mcp-server` | `mcp-call` |
| `Skill`, and `Bash` for `npx skills add <source>` | `skill` | `skill-call`, `install` (the source is the first word after `add` that is not a flag or the value of `-s`, `--skill`, `-a`, or `--agent`, as written minus any query, and minus a trailing `@skill` of `owner/repo@skill`, which picks one skill of that source; `owner/repo/folder` is read as a hosted folder, as the skills tool reads it; a variable or a path names nothing; a `file:`, `git+file:`, `link:`, `workspace:`, or `portal:` spec is a path, with or without a package name before it (`foo@file:...`, `foo @ file:...`), so it is counted under "replay cannot see" as `local-path` and no part of it is kept) |

`python -m pip`, `python -m pipx`, and `python -m uv` are read as the module's own command, and `pipx inject <venv> <package>` as an install of the package. A lockfile-only install (`npm ci`, `pip install -r`, `conda install --file`, a bare `npm install`) names nothing and crosses nothing; it is counted under "replay cannot see" by shape. So is a pipe into a shell and a command behind `xargs`. `uv run pip install x` is read as `pip install x` and recorded under `uv`, so a registry question refuses it (uv's pip runs in the project venv); any other program run through `uv run` is not read at all, and neither crosses nor counts.

## The source: raw transcripts, not the store

Replay reads raw transcripts under the allowlist, from the harness's folder and the store's `raw/` archive, one copy per relative path. It does not read Codex, Cursor, or Copilot: they keep sessions in their own formats, not as transcript files, so `--allow codex`, `--allow cursor`, and `--allow copilot` add nothing, and the report says so. A name's `origin` is keyed by name alone, so a package that also crossed as a server of the same name in one transcript shares that server's origin. The store loses what the checks need: form (`pulls` has no install or fetch-and-run, and is per call, not per command), flags and quoted words, permission mode, Skill input, and the earlier text "where the name came from" needs. Reading raw costs parse time, and raw is class `L`, so nothing of class `L` goes in the record: no path, working directory, or command text.

## What a name may be

Every name passes one function, `admitName` in `packages/cli/src/gate/checks.ts`, before it can reach `crossings.jsonl`, a registry question, or a removal match. A name outside its family's grammar is never written and never asked; it is counted under "replay cannot see" by the shape it has: `local-path` when it holds a path separator, a scheme, or an `@` past the scope; `masked-name` or `variable-name` when it is one; `unreadable-name` otherwise (a space, a `?`, a leading dot or dash, an empty word, or a length over the limit). A creator (`npm create x`) that reads as a URL or `org/repo` counts as `unreadable-name`.

| Class | Grammar |
|-------|---------|
| `npm-package` | npm's: `name` or `@scope/name`, letters, digits, `.`, `_`, `~`, `-`, at most 214 characters |
| `python-package` | PEP 508's project name: letters, digits, `.`, `_`, `-`, starting and ending with a letter or digit |
| `mcp-server` | the harness's server segment: letters, digits, `_`, `.`, `-`, at most 128 characters |
| `skill` (`skill-call`) | letters, digits, `_`, `.`, `-`, and `:` for a plugin's prefix, at most 128 characters |
| `skill` (`install`) | `owner/repo`, optionally into a folder, or a URL. The owner starts with a letter or digit and no segment is `.` or `..` |
| a URL form (`url-install`, `url-fetch-and-run`) | an `http`, `https`, `ssh`, or `git` URL (host, port, path; `ssh` and `git` also take npm's scp spelling `host:owner/repo`, and a path segment may start with `@`, a scope's, but an `@` that ends a segment or sits inside one is a ref or a path, so the word counts as `local-path`), a hosted shorthand (`github:org/repo`), `org/repo`, or `host:path` with a host of at least two characters. The owner of `org/repo` starts with a letter or digit, and no path segment is `.` or `..`. A host starts with a letter, a digit, or a mask. Credentials, query, and fragment are removed first (a user before the host is a credential even when the word has no path, never a ref); a mask the redactor placed stays. pip's `name @ url`, with spaces, or `name@git+url`, is read as the URL |

A version that is not a URL's ref is also refused when it holds a slash, a backslash, `:`, or `@`; the whole crossing is then counted as `local-path`. A version holding any other character than word characters and the range operators (`.^~*+<>=!,|`, spaces, `-`), such as `#`, `&`, `?`, `;`, or `%`, counts as `unreadable-name`.

A URL's ref (the `#...` fragment, or a git URL's `@ref`, which starts at the first `@` past the host that does not follow a `/`) is kept as `version` only when it is a plain ref: letters, digits, and `.`, `_`, `^`, `~`, `*`, `+`, `-`, optionally after `semver:`. Anything else (a path, `key=value`, a query) is dropped: the crossing stays, with no version.

A word that follows a Python name and is not an operator (`foo bar baz`, `a#secret-token`) is outside PEP 508 and counts as `unreadable-name`; an environment marker (`;python_version<3`) is dropped. pnpm's `foo@catalog:` and `foo@jsr:1.0.0`, a leading `npm:`, and a leading `jsr:@scope/name` name the package (a dotted version after `jsr:` or `npm:`, as in `jsr:@scope/name@1.0.0`, `npm:@scope/name@1.0.0`, or the alias `foo@npm:bar@1.0.0`, is masked as an email by the redactor first, so it counts as unread), and `org/repo#feature/x` is a shorthand with a ref. The words a manager's flag owns are not read as names. The flags are listed in `VALUE_FLAGS` in `checks.ts`, minus `FLAG_WITHOUT_VALUE` (pnpm's `-w`, poetry's, uv's, and uvx's `-n`, pipx's `-f`, which are switches); a value flag that list does not hold is read as part of the command, so its bare `a/b` value still reads as `org/repo` and is recorded as a `url-install` of that spelling.

## `crossings.jsonl`

Written beside `observations.jsonl`, atomically, and the only file replay writes. One `run` row (the books), then `registry` rows (the cache of `--registry-state`), then one `crossing` row per crossing in time order. Classes are those of `docs/sessions-store.md`.

| Field | Class | Values |
|-------|-------|--------|
| `kind`, `v`, `day` | P | row kind, gate version, UTC day |
| `class`, `form`, `program`, `versionForm`, `statusReports` | P | closed vocabulary; `program` is `npm`, `pnpm`, `yarn`, `bun`, `npx`, `pnpx`, `bunx`, `pip`, `python -m pip`, `python -m pipx`, `python -m uv`, `uv`, `uvx`, `pipx`, `poetry`, `pdm`, `rye`, `pipenv`, `conda`, `mamba`, `micromamba`, `mcp`, and `skill`; `versionForm` is `pinned`, `range`, `tag`, `url`, `unstated` |
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

Off by default. With `--registry-state`, replay asks `npm view` or `pip index versions`, in the call's own folder, and only for a crossing made with `npm`, `npx`, `pip`, or `python -m pip`: those read the config `npm` and `pip` read, so the answer comes through the registry that manager would contact. A crossing made with `pnpm` (it also reads a global `rc` of its own that `npm view` does not), `pnpx`, `bunx`, `yarn`, `bun`, `python -m pipx`, `python -m uv`, `uv`, `uvx`, `pipx`, `poetry`, `pdm`, `rye`, `pipenv`, `conda`, `mamba`, or `micromamba` is never asked, since its registry config may differ and a private name must not reach a public registry; it reads `not-read`. A name is also not asked when any crossing of it chose its own registry or config: a command that states `--registry`, `-i`, `--index-url`, `--extra-index-url`, `--index`, `--default-index`, a `jsr:` name (npm refuses the protocol), `--userconfig`, `--globalconfig`, `--prefix`, `-C`, `--dir`, a source flag (`-f`, `--find-links`, `--no-index`), a scoped `--@scope:registry`, a `--config.*registry` setting, or `-i` with its value attached; a command with an `NPM_CONFIG_`, `PIP_`, or `UV_` variable, or `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_CONFIG_DIRS`, `APPDATA`, `PATH`, or `VIRTUAL_ENV`, set in the same call; a call with a `sudo` word, a venv's `activate`, or a manager run by path (`.venv/bin/pip`, also quoted or `.bat`), each of which reads another config; or a command that follows a `cd` (or `Set-Location`, `pushd`, `Push-Location`, `Pop-Location`) in the same call. The question would go through the default config from the call's recorded folder and could send a private name to a public registry, so every row of that name reads `not-read`, kept answers included. An answer reaches a row only when that row's own program was asked: `npm install x` then `yarn add x` gives the `yarn` row `not-read`. Answers are cached in the file for 30 days (`REGISTRY_MAX_DAYS` in `replay.ts`): a row older than that, by the run's clock, counts as absent, is asked again, and is replaced. This is the one option that goes beyond local reads: the managers keep their own caches, so it writes outside `crossings.jsonl`, and it answers as of the run, not as of each crossing. A replay without it prints "registry state not read" and every registry field reads `not-read`; it never guesses.

## What replay cannot see

A command run from a script, alias, or Makefile; a manifest edit a later bare install picked up; what a person saw or approved; an MCP server started and never called; folders off the allowlist; logs the harness already cleaned up; a session in Codex, Cursor, or Copilot, which replay does not read. `oars gate report` ends with this list and the counts by shape.

## Measured

One run over a real harness folder on a Windows box (no `--registry-state`, an empty store): 9,139 transcripts across about a month (2026-10-01 to 2026-11-04), 534,097 calls, 25,167 crossings, in 160 seconds, peak resident memory 439 MB. By class and form: `mcp-server` 21,761, `npm-package` `fetch-and-run` 2,141, `skill` `skill-call` 1,062, `npm-package` `install` 120, `python-package` `install` 83; none of the URL forms, and no `npx skills add`, appeared. Commands counted under "replay cannot see": 1,033 pipes into a shell, 210 lockfile-only installs, 129 `local-path`, 19 `variable-name`, 1 `unreadable-name`.

Against the store's `raw/` archive of the same folders, the harness folder held every transcript but one, so the harness folder alone answers the same questions. About 200 workflow `journal.jsonl` files sit beside the transcripts and are not read.

Read by hand (30 crossings drawn at random from sessions that pass the exclusion check, plus 16 drawn by form): the class and form matched what the command said in all of them. Three other readings did not hold:

- A package crossing's `origin` is the first place the name is mentioned, as a word. A short brand-like name that also appears in prose reads as a mention (one `repo-file` origin in 30 was a product name in a plan).
- Of the 926 main-session `npx` fetch-and-run crossings, 839 name a bin their folder's `node_modules/.bin` held when this was measured (54 do not, and 33 ran in a folder that is gone): 94 percent of those whose folder still exists. Those most likely ran a local tool and fetched nothing. This is a known limit: the record keeps them as `fetch-and-run`, since the log does not show whether a fetch happened.
- An MCP server's `origin` read `tool-output` when the harness listed it only as `mcp__<server>__<tool>` names, and an MCP action's own "unknown tool" read as the server not existing. Both are fixed.

## Not in this release

Pool reads, sign-in, deposit prompts, blocking, and any hook. `install`, the policy file, and notes come in the next brief.
