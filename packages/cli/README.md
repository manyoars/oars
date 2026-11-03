# @manyoars/oars

The `oars` command line for Many Oars: sign in, deploy an agent, set its prices, make a test charge against it, and keep a local memory of your own Claude Code sessions (`oars sessions`).

Accounts and paid agents are not open yet; `oars login` says so until launch.

Node 24 or later. ESM only.

## Install

```sh
npm install --global @manyoars/oars
oars --help
```

Or run it once without installing:

```sh
npx @manyoars/oars <command>
```

## Commands

`oars --help` lists the commands below (`oars help <command>` shows one command's flags). `oars --version` prints the version.

These flags work on every command:

- `--json` prints one JSON document on stdout instead of text (see below).
- `--api-url <url>` sets the platform API. The default is `OARS_API_URL`, else `https://api.manyoars.com`.
- `--idempotency-key <key>` is the base of every step's idempotency key (default: a fresh UUID). Rerun a failed command with the same key to resume.

### login

Signs in with your browser (RFC 8628 device flow) and stores the login.

- `--no-browser` prints the link and code without opening a browser.
- `--issuer-url <url>` is the Keycloak realm URL. The default is `OARS_ISSUER_URL`. With neither, `login` uses the built-in Many Oars issuer once Many Oars has launched, which it learns from `https://manyoars.com/.well-known/oars.json` (`{"launched": true}`). The flag only switches the built-in issuer on; it never supplies a URL. Before launch, or when the built-in issuer does not answer discovery, with no `--issuer-url` or `OARS_ISSUER_URL`, the command prints "Many Oars has not launched yet: pass --issuer-url or set OARS_ISSUER_URL." and exits 2.

### logout

Revokes the stored login and deletes it.

### templates

`oars templates` lists the starter templates `oars deploy --template` takes: each id, name, description, and starter prices. Needs a login.

### deploy

Registers a workload, creates its prices, and deploys it. Pass exactly one of `--template`, `--image`, or `--manifest`. It stops at the first failed step and exits 9 (see below). A `--template` id the catalog lacks exits 2, and an unreachable catalog exits 8, before anything is registered.

- `--image <ref>` deploys an image pinned by digest (`name@sha256:...`). Companions: `--name <name>`, `--port <n>` (default 8080), `--public`, `--cpu-millicores <n>` (default 250), `--memory-mib <n>` (default 256).
- `--manifest <file>` deploys a JSON workload manifest.
- `--always-on` keeps the public service running instead of idling. It works with every source.
- `--template <id>` deploys a starter template from the catalog (`oars templates`): it registers the entry's manifest, creates every starter price, then deploys. `--price <ref>` (repeatable) creates only the named ones; `--no-prices` creates none. `--name`, `--port`, `--public`, `--cpu-millicores`, `--memory-mib`, and `--price-file` do not combine with it.
- `--price-file <file>` is a JSON array of prices to create (with `--image` or `--manifest`).
- `--secret <NAME=value>` and `--secret-from-env <NAME>` add a workload secret; both repeat. Prefer `--secret-from-env`, which keeps the value out of your shell history.
- `--no-start` registers and prices the workload without deploying it.

The SDK key is shown once, so save it when `deploy` prints it.

### status

`oars status <workloadId>` shows a workload and its billing mode.

### test-charge

`oars test-charge <workloadId>` makes a TEST-mode charge against one of the workload's prices.

- `--price <ref>` picks the price. The default is the workload's only active price.

### sessions

`oars sessions` keeps a local, deterministic memory of your own Claude Code sessions. oars makes no model call and no network call, except `gold arms`, which sends redacted text through your own Claude subscription.

What it captures: the Claude Code sessions in the folders you name with `--allow`, and Cursor sessions if you pass `--allow cursor`. Where it stores them: `<config>/oars/sessions/` on your machine (`<config>` is `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere). The `raw/` folder in it is on by default and holds raw transcripts (a hard link or copy of each deposited one). Secret masking applies to the log, not to `raw/`: those files are unredacted and keep whatever the transcript held, secrets included. They stay on your machine and, apart from `gold arms`, nothing is uploaded. To remove them, see [Remove everything](#remove-everything).

Apart from that, oars itself sends nothing; the hooks and the MCP tool add recall text to the running session, and your harness sends that to its model like any other context.

```bash
# Read the folders you name (a path, or its name under ~/.claude/projects). At least one --allow is required; there is no "all".
oars sessions deposit --allow ~/work/app --allow ~/work/tools --redact-domain corp.example

# Look up an error as printed, a file, or a prompt class.
oars sessions recall --error "unexpected EOF while looking for matching \`''"
oars sessions recall --path src/main.ts --since 30   # sees the first 100 sorted paths of a session

# Serve the same query to a running agent as one MCP tool, oars_recall (stdio):
oars sessions recall --mcp

oars sessions read                          # derived reads of your own sessions, largest sample first in each family
oars sessions read --family fit --slice model=claude-opus-5-5 --json
oars sessions books --by class --since 30   # tokens, wall time, turns, errors, verify-after-edit rate, and the outcome signals
oars sessions books --by pull               # the same per package, MCP server, plugin, or skill a prompt pulled
oars sessions books --by harness            # the same, grouped by Claude Code and Cursor (deposit Cursor with --allow cursor)
oars sessions measure --last 50             # recurring errors per 100 sessions, cache-write per session, recall calls per session
oars sessions measure --last 50 --repo <root>  # the same, for one repository's sessions
oars sessions verify                        # consistency invariants on the stored skeletons and capture records
oars sessions gold sample --exclude-term <text>   # about 200 prompts to judge blind; `gold arms <file>` adds the claim and fresh readers on your Claude subscription; `gold score <file>` reads each arm against the judgments
```

`deposit` is idempotent (a file is skipped only when its size, mtime, capture version, salt, and `--redact-domain` set are all unchanged; a store written by an older capture version is captured again from the harness's transcript or from `raw/`, and one written by a newer oars is refused) and appends to `<config>/oars/sessions/observations.jsonl`:
one record per session, user prompt, tool call, and failed tool result, where each tool call also holds its steps in a canonical action vocabulary and each prompt a frame (harness, model, day, and public stack names); signatures, prompt classes, and recovery episodes are derived
from that log alone, so a change to a derivation rule never re-reads a transcript. The store format, every field with its class, the two version stamps, and the raw archive are in [`docs/sessions-store.md`](https://github.com/manyoars/oars/blob/main/docs/sessions-store.md);
the types are in `src/sessions/schema.ts`. Secrets (by pattern and entropy), emails, and the domains you name are masked
before a line is written (redaction runs on the full text, then the text is cut); lines written before a domain was added stay in the append-only file until it is compacted, and readers use only the latest version of each session. The log is the local derived-records tier: redacted
text, never raw content. It keeps these text fields and no others: the first 300 characters of each prompt, the first informative line of a
tool error (cut to 1,000 characters in the error-line record, 160 characters in a derived example), TLDR lines (400) and Confidence lines (120) from assistant text, WebSearch queries, fetched URLs, file
paths, and git branch names (the last four have no length limit), all redacted first; plus the project folder slug (not redacted, so it
carries your username and directory names; the log stays local), skill names, effort values, model names, harness versions, tool names (including MCP server names), a shell call's program and subcommand, and tool-input key names. A tool call's file target is a salted hash, never the path. Apart from `gold arms`, nothing is uploaded.
Subagent transcripts (`<project>/<session>/subagents/`) are deposited with their parent session and subagent type; `books --by class`
shows their tokens as the `delegated` column, and their errors are in the signatures, `measure`, and recall under the session that
spawned them, so per-session counts still count main sessions. Every deposited transcript is also
hard-linked (copied across volumes) into `<config>/oars/sessions/raw/`, so it outlives the harness's own cleanup. For each session it also writes a skeleton (ids, timestamps, tool linkage, token counts, a SHA-256 in place of every content
field, and a Merkle root over the raw lines) that `verify` checks; the skeleton holds hashes only, never content.
`verify` exits 0 even when an invariant has exceptions; add `--strict` to exit 4 instead. `verify` also reports every session on its own (`--json`: `sessionResults`, each session's ten rows with a status of `pass`, `fail`, or `not run`) and audits each session against its raw file (`audit`): the raw-file match for a hard link and for a copy (a copy of a different size counts as possible tampering), the Merkle root recomputed over the first `leaves` lines, and the count bindings (`leaves`, `session.lines`, and the skeleton's lines plus `badLines` must agree). Each session lands on one of five results: `root matches and the counts bind`, `changed since deposit`, `root mismatch`, `counts do not bind`, or `not run` (no raw file, no skeleton, no capture record, or a raw file that cannot be read). `root mismatch` and `counts do not bind` fail `--strict`; sessions under 10 `leaves` are flagged. `verify` also scores each session against the operator's own other weeks on its harness (`--json`: `selfBaseline`, layer 2 at T0, local): the session's UTC week is the week of its `tsFirst`; a baseline is that harness's other weeks with at least 1,000 tool calls that ended by now, combined by calls; the result is `F` from the median distance over seven histograms (a dimension with no counts on a side is dropped). It is `not run`, scoring nothing, for a null `tsFirst`, a week under 1,000 calls, or fewer than 4 baseline weeks. A low `F` lowers a weight and rejects nothing. `measure` prints the recurring-error count
per hundred sessions and, on a second line, the distinct recurring signatures in the window.
#### Many folders: `--allow` prefixes, globs, and `--allow-file`

An `--allow` entry is a folder (or its slug), a folder prefix with a trailing slash (`~/work/` reads that folder and every project under it), or a glob (`*` any run of characters, `?` one character, matched against the project-folder name Claude Code derives from the path). `--allow-file <list>` reads entries from a file, one per line (blank lines and `#` comments skipped), so hundreds of folders need no batching and no long command line. A leading `~` is expanded to your home folder, in a list file or quoted entry too. Both repeat and combine. Entries a deposit saves are what the SessionEnd hook and the nightly task reuse; a folder you have never named is never read.

#### Recall in a running session: hooks

`oars sessions hook install` writes three entries into one Claude Code settings file. Each is a deterministic, local, fail-open call into the store (no model, no network); an error inside a hook exits 0 with no output, so a hook never blocks or fails a session.

| Event | Does | Budget |
|---|---|---|
| `SessionStart` | injects `oars sessions recall --context` for the session's cwd as additional context: the top 5 errors by sessions within the latest 300 sessions of the repository (the `measure --last 300 --repo` window) and what usually followed | under 500 ms |
| `PostToolUseFailure` (matcher `Bash\|PowerShell`) | for a failed tool call whose error starts with `Exit code N` normalizes the first informative line as `deposit` does and, on a hit, adds "seen in N sessions; what followed: X". A shell pre-filter in the registered command reads the event first and starts node only when it carries `Exit code` | pre-filter: shell builtins only, no node start; whole path under 1 s |
| `SessionEnd` | deposits that one transcript (idempotent by size and mtime), only from a folder an earlier `--allow` named. Once per session: `Stop` fires after every turn and would append a new revision of the growing transcript each time. A session the harness ends without `SessionEnd` is picked up by the nightly deposit | under 5 s |

Claude Code fires `PostToolUse` on success only; a failed Bash call arrives as `PostToolUseFailure`, so that is the event registered. The pre-filter is a `read`, a `case`, and a `printf | node` in the shell the harness runs hooks in (Git Bash on Windows, where a fresh `node` alone costs 250 ms or more), so it needs no `findstr` and no extra dependency. Writers of the store (`SessionEnd`, the nightly run, `deposit`) take `store.lock`, so parallel sessions cannot lose each other's `state.json` entries; a lock older than ten minutes is broken.

```bash
# Nothing is written unless you name the file (default --scope file), or say --scope user|project.
oars sessions hook install --scope file --file ./.claude/settings.local.json
oars sessions hook install --scope user                 # ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR)
oars sessions hook install --scope project              # ./.claude/settings.json
oars sessions hook install --file my-settings.json --keep-retention
oars sessions hook status                               # user, project, and the nightly task
oars sessions hook uninstall --scope user               # removes only the entries install wrote
```

Install merges: existing hooks (a Stop hook that rotates sessions, say) stay, even inside a group that also holds ours or under a name that contains `hook-bin`; re-running replaces only its own entries (the commands ending `hook-bin.js" <session-start|post-tool|stop>`), and a per-turn `Stop` entry of ours from the first build is removed. A settings file that exists but cannot be read is an error that changes nothing. The harness deletes raw transcripts after `cleanupPeriodDays` (30 when unset), which would erase what `deposit` reads, so install raises it to at least 365 in the file it writes, prints the old and new value, and never lowers a higher one. `--keep-retention` leaves it alone and says so. Uninstall does not touch `cleanupPeriodDays`. For a `claude --settings <file>` launch, install into that file with `--scope file`.

#### Nightly schedule (Windows)

`oars sessions hook install --schedule nightly` registers the Task Scheduler task `OarsSessionsNightly` (daily, 03:00) that runs the full deposit over the saved `--allow` and `--redact-domain` entries and refreshes the recurrence index the hooks read. `--schedule off` removes it; `hook status` shows whether it is registered. Alone, `--schedule` writes no settings file.

#### Reading `measure` before and after

`measure` has no cutoff, so its windows move with every deposit. To pin an "after" reading, run `oars sessions measure --last 300 --since <iso time of the install>` (add `--repo <root>` to window one repository's sessions): the current window is the first 300 sessions started at or after that time and the prior window is the 300 before it. Without `--since` the window is the last N. `measure` also prints hook recall calls per session and hook hits per session, and hook deposits per session, counted from `hook-calls.jsonl` in the store.

#### Remove everything

`oars sessions hook uninstall --scope user` (or the scope you installed); `oars sessions hook install --schedule off`; delete the store folder `<config>/oars/sessions/` (observations, skeletons, state, the hook index, `hook-calls.jsonl`, and `raw/`, which holds the unredacted transcripts). `gold sample` also writes its prompt file and sidecar to `~/.claude/session-commons/review/` (or `$CLAUDE_CONFIG_DIR`, or your `--out-dir`); delete those too. Nothing else is created. `cleanupPeriodDays` stays at the value install set unless you change it.

## The `--json` contract

With `--json`, stdout carries exactly one JSON document and a success exits 0.

- Success: `{"ok": true, ...}`. The rest depends on the command: `login` adds `email`; `deploy` adds `workloadId`, `prices`, `started`, `nextSteps` and, when this run minted it, `sdkKey`; `templates` adds `templates`; `status` adds `workload` and `billingMode`; `test-charge` adds `chargeId` and `status`; `sessions` commands add their own fields (`deposit` the counts, `recall` `matches`, `books` `rows`, `measure` `last` and `before`, `verify` `sessions`, `unreadable`, `invariants`, `sessionResults`, and `audit`).
- Failure: `{"ok": false, "step": "...", "problem": {...}}`, where `problem` is the platform's problem document (`title`, `detail`, `code`, `actionUrl` when it sent them). A `deploy` that stopped after registering also carries `workloadId`, `rerun` and, if that run minted it, `sdkKey`.

Without `--json`, a failure prints the problem to stderr instead.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | unexpected error |
| 2 | usage error |
| 3 | authentication failed (login expired or denied, SDK key invalid, HTTP 401 or 403) |
| 4 | the platform rejected the input, or `sessions verify --strict` found exceptions |
| 5 | conflict (an idempotency key or workload already used) |
| 6 | a person must act first (account, payment method, credits, or compute cap); the last stderr line starts "Needs you:" and names the link |
| 7 | rate limited |
| 8 | the platform could not be reached |
| 9 | `deploy` stopped part way; rerun the printed command to resume |

## Source

[github.com/manyoars/oars](https://github.com/manyoars/oars/tree/main/packages/cli), [Apache-2.0](https://github.com/manyoars/oars/blob/main/LICENSE).
