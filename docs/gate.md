# Gate: install, hook, replay, and report

`oars gate replay` finds every package, MCP server, and skill your agents picked in session logs already on your disk, and `oars gate report` counts them. It records the pick. It is capture first, and it calls nothing a verdict. `oars gate install` adds one hook that records each pick as it happens, into the same file, and adds a note about a young or missing name by default, and blocks only if you write `block` in the policy file (see "Notes, labels, and the policy file").

```
oars gate replay --allow ~/work/app          # writes crossings.jsonl into the sessions store
oars gate replay                             # no --allow: the allowlist a deposit saved
oars gate replay --allow app --registry-state   # also ask the package manager what the registry holds
oars gate report                             # counts over crossings.jsonl, and what replay cannot see
oars gate install                            # wire the recording hook into Claude Code, user scope
oars gate policy                             # print the policy in force and where it came from
oars gate uninstall                          # remove that one entry
```

## What a crossing is

A tool call that takes something from outside the repository into the agent's session, named by the closed vocabulary in `packages/cli/src/gate/checks.ts`. The same code is what `oars gate hook` calls on a live tool call, so replay and a hook agree.

| Matcher | Class | Forms |
|---------|-------|-------|
| `Bash` (and `PowerShell`, since the corpus this was built on runs on Windows) | `npm-package`, `python-package` | `install`, `url-install` (a git or tarball URL), `fetch-and-run` (`npx`, `pnpx`, `bunx`, `pnpm dlx`, `uvx`, `pipx run`), `url-fetch-and-run`, `local-bin-run` (below) |
| `mcp__.*` | `mcp-server` | `mcp-call` |
| `Skill`, and `Bash` for `npx skills add <source>` | `skill` | `skill-call`, `install` (the source is the first word after `add` that is not a flag or the value of `-s`, `--skill`, `-a`, or `--agent`, as written minus any query, and minus a trailing `@skill` of `owner/repo@skill`, which picks one skill of that source; `owner/repo/folder` is read as a hosted folder, as the skills tool reads it; a variable or a path names nothing; a `file:`, `git+file:`, `link:`, `workspace:`, or `portal:` spec is a path, with or without a package name before it (`foo@file:...`, `foo @ file:...`), so it is counted under "replay cannot see" as `local-path` and no part of it is kept) |

`python -m pip`, `python -m pipx`, and `python -m uv` are read as the module's own command, and `pipx inject <venv> <package>` as an install of the package. A lockfile-only install (`npm ci`, `pip install -r`, `conda install --file`, a bare `npm install`) names nothing and crosses nothing; it is counted under "replay cannot see" by shape. So is a pipe into a shell and a command behind `xargs`. `uv run pip install x` is read as `pip install x` and recorded under `uv`, so a registry question refuses it (uv's pip runs in the project venv); any other program run through `uv run` is not read at all, and neither crosses nor counts.

An `npx <name>` with no version, whose folder (or a parent's, up to 12 levels) holds `node_modules/.bin/<name>` (or its `.cmd` or `.ps1` shim; a scoped name is read by its last segment), runs the project's own copy and fetches nothing. It is recorded as `local-bin-run`, not `fetch-and-run`, and is never asked of the registry. A pinned or tagged version, a call that chose its folder or registry (an earlier `cd`, a `--registry`), and a row with no known folder stay `fetch-and-run`, because the bin cannot say what the command would have fetched. Replay and the hook apply the one rule (`gate/local-bin.ts`), each against the folder as it is when it runs. A crossing seen by both keeps the hook's reading, so a bin installed or removed since does not change what the row says.

## The source: raw transcripts, not the store

Replay reads raw transcripts under the allowlist, from the harness's folder and the store's `raw/` archive, one copy per relative path. It does not read Codex, Cursor, Copilot, Gemini CLI, or Grok Build: they keep sessions in their own formats, not as transcript files, so `--allow codex`, `--allow cursor`, `--allow copilot`, `--allow gemini`, and `--allow grok` add nothing, and the report says so. A name's `origin` is keyed by name alone, so a package that also crossed as a server of the same name in one transcript shares that server's origin. The store loses what the checks need: form (`pulls` has no install or fetch-and-run, and is per call, not per command), flags and quoted words, permission mode, Skill input, and the earlier text "where the name came from" needs. Reading raw costs parse time, and raw is class `L`, so nothing of class `L` goes in the record: no path, working directory, or command text.

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

A word that follows a Python name and is not an operator (`foo bar baz`, `a#secret-token`) is outside PEP 508 and counts as `unreadable-name`; an environment marker (`;python_version<3`) is dropped. pnpm's `foo@catalog:` and `foo@jsr:1.0.0`, a leading `npm:`, and a leading `jsr:@scope/name` name the package (a plain dotted version after `jsr:` or `npm:`, as in `jsr:@scope/name@1.0.0`, `npm:@scope/name@1.0.0`, or the alias `foo@npm:bar@1.0.0`, reads as pinned; a prerelease there, `foo@npm:bar@1.0.0-beta.1`, is masked as an email by the redactor first, so it counts as unread), and `org/repo#feature/x` is a shorthand with a ref. The words a manager's flag owns are not read as names. The flags are listed in `VALUE_FLAGS` in `checks.ts`, minus `FLAG_WITHOUT_VALUE` (pnpm's `-w`, poetry's, uv's, and uvx's `-n`, pipx's `-f`, which are switches); a value flag that list does not hold is read as part of the command, so its bare `a/b` value still reads as `org/repo` and is recorded as a `url-install` of that spelling.

## `oars gate install` and `uninstall`

`install` writes one `PreToolUse` entry into Claude Code's user settings file (`settings.json` in the Claude config folder), matcher `Bash|PowerShell|Skill|mcp__.*`, command `command -v oars >/dev/null 2>&1 || exit 0; out=$(oars gate hook 2>/dev/null) && printf '%s' "$out"; exit 0`. The command calls the installed `oars`, never `npx`, does nothing when `oars` is not on the `PATH`, passes on what `oars gate hook` prints (a note or a deny) so the harness reads it, and always exits 0 with empty output whatever else `oars` returns (exit 2 from a PreToolUse hook blocks the tool call, and an older `oars` with no `gate hook` exits 2, so its output is dropped), so a settings file that outlives the install is harmless. An entry written by an earlier build discarded the hook's output, so a note or deny never reached the harness; it stays silent until `oars gate install` runs again, which replaces it (no migration runs on its own). Rerunning changes nothing and says so. Every other key and hook in the file is kept as parsed JSON (key order and formatting are not promised); a file that does not parse, a `hooks` that is not an object, or a `PreToolUse` that is not a list is refused with nothing written. The write is a temp file and a rename, and the command prints what changed. `uninstall` removes only the entry whose command is exactly the one above (or the earlier one), and any other vendor's hook beside it stays. Install does not touch project settings or managed settings. If a record already exists with no novelty index, it says so: run `oars gate replay --allow <folder>` once so repository novelty is right.

## `oars gate hook`

What the harness runs before each matching tool call. It reads the call's JSON on stdin, runs the same `checkCall` replay runs, and appends one `crossing` row (`via: hook`) per crossing to `crossings.jsonl`. A call that crosses nothing writes nothing and touches no network. Its stdout is empty and its exit code is 0 on every path (malformed stdin, a missing or full store, a thrown error) unless a policy line applies (next section). It never grants a permission, asks the operator, or rewrites the call's input, so a call it does not block runs as it would have.

It writes only what cannot be recovered later: the identity keys, the time, the version as stated, the permission mode, depth and agent, novelty, and the registry state at that moment. The registry state is the hook's own kept answer first (`gate-registry.jsonl`, kept until the end of the next UTC day; a not-found answer is trusted for 10 minutes), else one question through the same asker replay uses, for the same managers and under the same exclusions (a call that chose its registry or folder is not asked), cut at 650 ms of the process clock, node's own start included. A cut ask does not end there: the hook hands the name to a detached helper (`hook-fill-main.js`) that finishes the question with the installed manager, contacts nothing the manager would not, and writes a found or not-found answer to the cache, so the next sight of the name reads it inside the budget. At most one helper runs per name (an empty `gate-ask-*.lock` file in the store, honored for 5 minutes), and a failed ask writes nothing. The helper ends on its own timeouts (15 seconds), and the manager keeps its own cache outside the store, as it does for replay. Where the name came from, who decided, what happened next, routing around, a later removal, and a `not-found` miss are not known to a hook and read `not-read` until a replay fills them in. The hook reads no transcript. `arm`, `lineShown`, `lineHeld`, and `policy` are the hook's own and are described below.

It is sub-second by construction: the entry (`bin.ts`) loads only the hook for `oars gate hook`, a registry ask that is not answered in time reads `not-read` for that sight, and the process ends by itself 900 ms after it starts, writing the row it has. Novelty (the first time a name is seen in the session, the repository, and the whole record) comes from a small kept index, `gate-index.txt`, of hashes, one line per name and scope; the log is never scanned. A damaged index reads `not-read` for novelty and is left as it is. A line cut off by a killed hook costs only that line. Measured from the built CLI over 100 runs against a store holding 100,000 prior crossings and a 100,001-line index, half of them naming a different real package so the registry is asked: p50 245 ms, p95 722 ms, max 791 ms, every run exit 0 with empty stdout (free RAM 4.2 GB, Windows). On that machine `npm view` takes about 1.6 s, longer than the 650 ms cut, so none of the 50 asking rows came back with an answer (all `not-read`); that run was made before the helper existed. With it, the first sight of a name on a slow box reads `not-read` and a later sight reads the answer the helper kept. The registry fields also fill in from a replay with `--registry-state`. The tests run the installed command with `oars` off the `PATH`.

## Notes, labels, and the policy file

The hook says nothing unless a class fires, and with no policy file both classes are on `warn`. A policy file, `gate-policy.json` in the sessions store, sets one of `warn`, `block`, or `off` per class, plus a holdback share. It is written by the operator and by nothing else, in a closed vocabulary; `oars gate policy` prints the policy in force and whether it came from no file (`default`), a file (`file`), or a file that did not fit (`invalid`).

```json
{ "classes": { "young-name": "warn", "not-found": "block" }, "youngDays": 30, "holdbackPercent": 10 }
```

| Class | Fires when | Allowed | Default |
|-------|-----------|---------|---------|
| `young-name` | the registry's first publish of the name is fewer than `youngDays` (default 30) days old, read from the kept or asked answer | `warn`, `off` | `warn` |
| `not-found` | the manager's own configuration answered that the registry does not hold the name (never on `not-read`, a cut ask, or an unreachable registry; a Python name never reads `not-found`, since pip prints one line for a missing name and for a down index) | `warn`, `block`, `off` | `warn` |

A missing file reads as the defaults. A file that cannot be read, is not JSON, has a key, class, or action outside the table (a `block` on `young-name` is outside it), or a day count outside 1 to 365 or a share that is not a whole number from 0 to 100, also reads as the defaults: the hook keeps its valid JSON and exit code, the row records `policy: invalid`, and `oars gate report` counts it. Nothing blocks until the operator writes `block`.

What the hook says is one of three fixed lines, and each states a fact about the registry and nothing else:

| Line id | Shown as |
|---------|----------|
| `young-name-note` | Registry note: `<name>` was first published `<age>` ago in the registry your package manager uses. |
| `not-found-note` | Registry note: `<name>` was not found in the registry your package manager uses. |
| `not-found-block` | Blocked by your gate policy: `<name>` was not found in the registry your package manager uses. |

A note is added context for the agent (`additionalContext`); a name already seen in the session gets none. A block is a PreToolUse deny whose reason is the third line, a label stating the fact, and it can only follow a `not-found` answer with the policy on `block`. The hook never approves a call, never asks, and never rewrites its input. Any error on the path stays fail-open and inside the budget.

**The holdback** applies to notes only. With the share at `holdbackPercent` (default 10), a note that would show is withheld on a random draw, and the row records `arm: held` and the line it withheld in `lineHeld`. A block is never held back. `oars gate report` counts `shown` apart from `held`, and the line ids apart, so the two arms can be compared line by line; a row cannot be backfilled, which is why `lineHeld` is written at the time.

**Local exposure.** A crossing is a local record of its exposure (the arm, the line id, and what a replay later merges). It goes nowhere unless the operator opts in, and no opt-in exists yet. There is no prompt, no sign-in, no pool read, and no wire field for it.

## `crossings.jsonl`

Written beside `observations.jsonl`, by replay atomically and by the hook as an append. One `run` row (the books, from the last replay), then `registry` rows (the cache of `--registry-state`), then one `crossing` row per crossing. Classes are those of `docs/sessions-store.md`.

One row stands for one crossing: its key is the session, the tool use id, the class, and the name. A hook row and a replay row for the same key are merged when replay next runs: the hook's fields (the time, the registry state, novelty, the permission mode) win, and replay's transcript-derived fields (`origin`, `decidedBy`, `status`, `next`, `removedLater`, `miss`) fill in wherever the hook read `not-read`. The merged row reads `via: both`. `via` is `hook`, `replay`, or `both`. The same name twice in one call counts once. A hook row with no replay stays `not-read` in those fields, and `report` says so.

| Field | Class | Values |
|-------|-------|--------|
| `kind`, `v`, `day`, `via` | P | row kind, gate version, UTC day, and what wrote the row: `hook`, `replay`, or `both` |
| `class`, `form`, `program`, `versionForm`, `statusReports` | P | closed vocabulary (`form` is `install`, `url-install`, `fetch-and-run`, `url-fetch-and-run`, `local-bin-run`, `mcp-call`, or `skill-call`); `program` is `npm`, `pnpm`, `yarn`, `bun`, `npx`, `pnpx`, `bunx`, `pip`, `python -m pip`, `python -m pipx`, `python -m uv`, `uv`, `uvx`, `pipx`, `poetry`, `pdm`, `rye`, `pipenv`, `conda`, `mamba`, `micromamba`, `mcp`, and `skill`; `versionForm` is `pinned`, `range`, `tag`, `url`, `unstated` |
| `origin` | P | where the name came from: `prompt`, `repo-file`, `web`, `tool-output`, `skill`, `harness`, `none-seen`, or `not-read` on a hook row until a replay reads the transcript |
| `novelty` | P | `fleet` (first time anywhere in the record), `repository`, `session`, `none`, or `not-read` when a hook found the index damaged or unseeded |
| `decidedBy` | P | `operator` when a main-line prompt named the package before its first crossing in that transcript, whatever source showed it first; else `agent`; `not-read` on a hook row until a replay |
| `permission` | P | the harness's permission mode, or `other` or `unknown` |
| `status` | P | `ok`, `error`, `refused`, `none`; `not-read` on a hook row until a replay |
| `next` | P | `proceeded`, `retried`, `routed-around`, `changed-name`, `stopped`, `no-result` (ten calls after a failure); `not-read` on a hook row until a replay |
| `removedLater`, `depth`, `miss` | P | a later removal in the same repository, `main` or `subagent`, and `not-found` when the result said the name did not exist; `removedLater` and `miss` are `not-read` on a hook row until a replay |
| `againstLatest`, `registryState`, `registryAge` | P | one reading of the registry, read by a replay with `--registry-state`, or by the hook at the crossing; otherwise `not-read`. A merged row takes all three from the hook when it read them, else all three from the replay; a `local-bin-run` row keeps `not-read`, since it was never asked |
| `arm`, `lineShown`, `lineHeld` | P | `arm` is `shown` or `held` for a note that would show, else `none` (every block, and every row with nothing to say); `lineShown` and `lineHeld` are ids from a closed table (`none`, `young-name-note`, `not-found-note`, `not-found-block`); a held note records the line it withheld in `lineHeld` and `none` in `lineShown`; a replay row reads `none` in all three until it merges with a hook row |
| `policy` | P | `default` (no policy file), `file` (one that fit), or `invalid` (one that was there and did not fit, so the defaults stood); absent on a replay row |
| `session`, `agent`, `toolUseId`, `ts` | A | join ids and a finer time |
| `name`, `version` | A | what the command stated. A package or server name can identify private work, as `pulls` already says |
| `registry` row: `kind`, `v`, `day`, `class`, `state` | P | row kind, gate version, UTC day the answer was read, package class, `found` or `not-found` |
| `registry` row: `name`, `latest`, `created`, `ts`, `folder` | A | the name asked, the registry's latest version, the name's creation time, when the answer was read to the millisecond, and a truncated SHA-256 of the folder the ask ran in (a kept not-found answers only that folder, since its config can name another registry; a row with none is not fresh). `created` and `ts` are full timestamps, so they are not class P |

`run` row: counts of transcripts, unreadable files, torn lines, calls, and crossings, the commands it could not name by shape, and whether the registry was read (class P).

There is no repository key in the record. Repository novelty is kept as hashes in `gate-index.txt`, which replay seeds from every transcript it reads and the hook then extends; the file holds no name, path, or command text. Replay and the hook name a repository the same way (the slug Claude Code gives its project folder, a worktree counted as its repository) when a session starts at the repository root. A session started in a subfolder does not agree: replay can only see that subfolder's project folder, while the hook walks up to the folder holding `.git`. A name replay saw in such a session reads `repository` to the hook, not `session` or `none`, until the hook has itself seen it in that repository. Making them agree would need replay to resolve each call's working directory, which can be gone by then.

## Registry state

Off by default. With `--registry-state`, replay asks `npm view` or `pip index versions`, in the call's own folder, and only for a crossing made with `npm`, `npx`, `pip`, or `python -m pip`: those read the config `npm` and `pip` read, so the answer comes through the registry that manager would contact. A crossing made with `pnpm` (it also reads a global `rc` of its own that `npm view` does not), `pnpx`, `bunx`, `yarn`, `bun`, `python -m pipx`, `python -m uv`, `uv`, `uvx`, `pipx`, `poetry`, `pdm`, `rye`, `pipenv`, `conda`, `mamba`, or `micromamba` is never asked, since its registry config may differ and a private name must not reach a public registry; it reads `not-read`. A Python name never reads `not-found`: `pip index versions` prints the same "No matching distribution" line for a missing name and for an unreachable index, so that line reads `unreachable` and a pip crossing never gets a not-found note or block. A name is also not asked when any crossing of it chose its own registry or config: a command that states `--registry`, `-i`, `--index-url`, `--extra-index-url`, `--index`, `--default-index`, a `jsr:` name (npm refuses the protocol), `--userconfig`, `--globalconfig`, `--prefix`, `-C`, `--dir`, a source flag (`-f`, `--find-links`, `--no-index`), a scoped `--@scope:registry`, a `--config.*registry` setting, or `-i` with its value attached; a command with an `NPM_CONFIG_`, `PIP_`, or `UV_` variable, or `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_CONFIG_DIRS`, `APPDATA`, `PATH`, or `VIRTUAL_ENV`, set in the same call; a call with a `sudo` word, a venv's `activate`, a manager run by path (`.venv/bin/pip`, also quoted or `.bat`), a sourced file (`source`, `.`, or `workon`), an environment set without an `=` (`Set-Item Env:`, `[Environment]::SetEnvironmentVariable`), or `npm config set`, each of which reads or sets another config; or a command that follows a `cd` (or `Set-Location`, `pushd`, `Push-Location`, `Pop-Location`) in the same call. The question would go through the default config from the call's recorded folder and could send a private name to a public registry, so every row of that name reads `not-read`, kept answers included. An answer reaches a row only when that row's own program was asked: `npm install x` then `yarn add x` gives the `yarn` row `not-read`. Answers are cached in the file for 30 days (`REGISTRY_MAX_DAYS` in `replay.ts`): a row older than that, by the run's clock, counts as absent, is asked again, and is replaced. This is the one option that goes beyond local reads: the managers keep their own caches, so it writes outside `crossings.jsonl`, and it answers as of the run, not as of each crossing. A replay without it prints "registry state not read" and every registry field reads `not-read`; it never guesses.

## `oars gate report`

Reads only `crossings.jsonl` and prints counts, in the closed vocabulary above, with no judgment words: who wrote the rows (`Recorded by`), crossings by class and form (with distinct names), where the name came from, novelty, who decided, what happened next, the registry fields, the notes by arm (`Notes`), the line shown and the line held, and which policy stood for the rows the hook wrote (`Policy`: default, file, or invalid, so a policy file that did not fit is counted). Each crossing counts once, whether the hook, replay, or both saw it, and a field a hook row has not had filled in counts as `not-read`. With no replay run it prints hook-only counts and says the transcript-derived fields are not read yet.

## What replay cannot see

A command run from a script, alias, or Makefile; a manifest edit a later bare install picked up; what a person saw or approved; an MCP server started and never called; folders off the allowlist; logs the harness already cleaned up; a session in Codex, Cursor, Copilot, Gemini CLI, or Grok Build, which replay does not read. `oars gate report` ends with this list and the counts by shape.

## Measured

One run over a real harness folder on a Windows box (no `--registry-state`, an empty store): 9,139 transcripts across about a month (2026-10-01 to 2026-11-04), 534,097 calls, 25,167 crossings, in 160 seconds, peak resident memory 439 MB. By class and form: `mcp-server` 21,761, `npm-package` `fetch-and-run` 2,141, `skill` `skill-call` 1,062, `npm-package` `install` 120, `python-package` `install` 83; none of the URL forms, and no `npx skills add`, appeared. Commands counted under "replay cannot see": 1,033 pipes into a shell, 210 lockfile-only installs, 129 `local-path`, 19 `variable-name`, 1 `unreadable-name`.

Against the store's `raw/` archive of the same folders, the harness folder held every transcript but one, so the harness folder alone answers the same questions. About 200 workflow `journal.jsonl` files sit beside the transcripts and are not read.

Read by hand (30 crossings drawn at random from sessions that pass the exclusion check, plus 16 drawn by form): the class and form matched what the command said in all of them. Three other readings did not hold:

- A package crossing's `origin` is the first place the name is mentioned, as a word. A short brand-like name that also appears in prose reads as a mention (one `repo-file` origin in 30 was a product name in a plan).
- Of the 926 main-session `npx` fetch-and-run crossings, 839 name a bin their folder's `node_modules/.bin` held when this was measured (54 do not, and 33 ran in a folder that is gone): 94 percent of those whose folder still exists. Those most likely ran a local tool and fetched nothing, so they are now recorded as `local-bin-run`. A replay reads the folder as it is on the day it runs: a bin removed since reads as a fetch, and a folder that is gone reads as a fetch.
- An MCP server's `origin` read `tool-output` when the harness listed it only as `mcp__<server>__<tool>` names, and an MCP action's own "unknown tool" read as the server not existing. Both are fixed.

## Not in this release

Pool reads, sign-in, deposit prompts, any opt-in to send a crossing anywhere, and any committed or managed-settings hook. Installing the hook for real stays the operator's call.
