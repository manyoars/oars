# @manyoars/oars

oars keeps a local, searchable record of your coding agent sessions, across Claude Code, Cursor, Codex, and other harnesses. Ask it about an error and it shows how many past sessions hit it, when, and which tools came next. More at [manyoars.com](https://manyoars.com/).

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

Accounts are not open yet: `oars login` uses the Many Oars issuer by default, and until Many Oars sign-in at `login.manyoars.com` (and its pool at `pool.manyoars.com`) is deployed it exits 2 with an error that names `login.manyoars.com`.

## Commands

`oars --help` lists the commands below (`oars help <command>` shows one command's flags). `oars --version` prints the version.

These flags work on every command:

- `--json` prints one JSON document on stdout instead of text (see below).
- `--api-url <url>` sets the platform API. The default is `OARS_API_URL`, else `https://api.manyoars.com`.
- `--idempotency-key <key>` is the base of the idempotency key (default: a fresh UUID). Rerun a failed command with the same key to replay it.

### login

Signs in with your browser (RFC 8628 device flow) and stores the login.

- `--no-browser` prints the link and code without opening a browser.
- `--issuer-url <url>` is the Keycloak realm URL. The default is `OARS_ISSUER_URL`. With neither, `login` uses the built-in Many Oars issuer, `https://login.manyoars.com/realms/aor`; nothing has to be switched on first. When the built-in issuer does not answer discovery (Many Oars and its pool at `pool.manyoars.com` may not be deployed yet), with no `--issuer-url` or `OARS_ISSUER_URL`, the command prints "Cannot reach Many Oars sign-in at login.manyoars.com (Many Oars and its pool at pool.manyoars.com may not be deployed yet). Pass --issuer-url or set OARS_ISSUER_URL to use another issuer." and exits 2.

### logout

Revokes the stored login and deletes it.

### keys

`oars keys` manages the API keys of your account.

- `oars keys create --name <name>` creates a key and prints its secret once; the platform keeps no copy. The default authorities are `AGENT_OPERATE` and `AGENT_READ`; `--authority <name>` (repeatable) sets others, and `--expires-in-days <n>` sets an expiry. `--expires-in-days` takes 1 to 365; without it the platform sets the expiry, and `oars keys list` shows it. Replace a key before it expires.
- `--workload <id>` limits the key to one workload you created. Such a key may carry only `AGENT_OPERATE` and `AGENT_READ` (more is a 400, `API_KEY_WORKLOAD_SCOPE_EXCEEDS_CAP`), and it works on that workload only.
- A retry with the same `--idempotency-key` returns no secret: the command exits 5 and names the key, and you revoke it and create another.
- Creating or revoking a key needs a signed-in person. With `OARS_API_KEY` set, any API key gets 403 `HUMAN_SESSION_REQUIRED` (exit 3) and logging in again does not help: unset it and use the `oars login` session.
- `oars keys list` lists the keys with their prefix, scope, and expiry. A secret never comes back.
- `oars keys revoke <keyId>` ends a key at once. There is no `rotate`: revoke the key and create another.

### telemetry

oars records how it is used, on this machine, and says so: on the first run that is not a hook it prints a notice on stderr, once. Each command leaves an event in a local spool under `<config>/oars/telemetry/`: the command path, the names of the flags given (never their values), the duration, the exit code, a closed error class, the oars version, the OS, and the time. So does each fire of a hook (the bare `oars gate hook` included, written after its answer is printed: which hook, how long, hit, miss, held, or error, and the bytes it printed), each recall (how it was asked and which read families it served, as counts), each deposit pass or sent batch (sessions counted, batches, bytes, and how many sessions each gate kept out, never which), and each fetch (an ETag hit, a cap hit). Five more kinds of event are recorded, each only counts, sizes, and closed words: once a night, a `store-health` snapshot of the session store and a `run-cost` event (time and peak memory); a `crash` event when oars fails in a way it did not plan for (the error's class and a hash of its stack, never its message); and, for each `oars pool deposit` pass, one `wire` event per harness (which fields its batches held and how many bytes each took) and, with `--send`, a `wire-send` event (the HTTP status, the pool's refusal code, and the size). Nothing else is recorded: no session content, prompt text, file path, URL, or argument. Every field of every event, with an example, is in [docs/telemetry.md](https://github.com/manyoars/oars/blob/main/docs/telemetry.md). oars sends the events in batches to the pool server in `OARS_POOL_URL` if you set one, else to the Many Oars pool (`https://pool.manyoars.com`), which is not deployed yet: until it is, a send fails and the events stay in the spool. A per-install random id (not derived from your machine or account) is in each event.

- `oars telemetry status` says whether it is on, which switch decided that, whether the notice was shown, and how large the spool is.
- `oars telemetry off` stops recording and sending; `oars telemetry on` resumes it and prints the notice again.
- `oars telemetry show` prints the spool exactly as stored, oldest first.
- `oars telemetry report` prints your own numbers from the spool (hook latency percentiles, hit rates, and store health over the last 7 and 30 days) with no server and no account, and the fleet's percentile beside each when `OARS_POOL_URL` names a server that serves it.
- `OARS_TELEMETRY=0` or `DO_NOT_TRACK=1` turns it off for the process, and wins over `oars telemetry on`.

Every event type, with an example, is in [docs/telemetry.md](https://github.com/manyoars/oars/blob/main/docs/telemetry.md).

### sessions

`oars sessions` keeps a local, deterministic memory of your own coding-agent sessions. The session commands make no model call and no network call, except `gold arms`, which sends redacted text through your own Claude subscription. oars also records telemetry events (a command's path, its flag names, how long it took, its exit code, and its error class, with a random install id, the oars version, the OS, and the time; never session content, prompts, paths, URLs, or argument values), which oars sends in batches to the pool server in `OARS_POOL_URL`, else to the Many Oars pool (not deployed yet, so a send fails and the spool is kept) ([what telemetry records and how to turn it off](https://github.com/manyoars/oars/blob/main/docs/telemetry.md)).

What it captures: by default, the sessions of every Claude Code project folder and the sessions of Cursor, Codex, Copilot CLI, Gemini CLI, Grok Build, OpenCode, Pi, and VS Code Copilot Chat, plus OpenTelemetry GenAI agent traces (OTLP JSON files) from the folder `OARS_OTEL_TRACES` names (else `<config>/oars/otel-traces`), when there is one. `--allow` narrows that to the folders and stores you name (`--allow cursor`, `codex`, `copilot`, `gemini`, `grok`, `opencode`, `pi`, `vscode-copilot`, `otel` name the stores), and `--deny` keeps one out. Where it stores them: `<config>/oars/sessions/` on your machine (`<config>` is `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere). The `raw/` folder in it is on by default and holds raw transcripts (a hard link or copy of each deposited one). Secret masking applies to the log, not to `raw/`: those files are unredacted and keep whatever the transcript held, secrets included. They stay on your machine: apart from `gold arms`, no session command uploads them, telemetry carries nothing from them, and after a yes to the raw prompt (`oars pool raw`) and covenant acceptance, the nightly task uploads a redacted copy of each (never the file itself), except from a folder set to skeleton only or off. To remove them, see [Remove everything](#remove-everything).

Apart from that and telemetry (on by default, off with `oars telemetry off`, `OARS_TELEMETRY=0`, or `DO_NOT_TRACK=1`; it sends to the pool server in `OARS_POOL_URL`, else to the Many Oars pool at `pool.manyoars.com`, which is not deployed yet, so until it is a send fails and the events stay in the spool), oars itself sends nothing, except what you opted into with a pool server: after you accept its covenant, the nightly task (registered on Windows only) sends closed-vocabulary session skeletons, and, only after a separate yes to the raw prompt, a locally redacted (best-effort) copy of each full transcript; `oars pool outbox` prints what is queued when you run it, but the nightly task builds new batches and sends them in the same run without printing them first, and a folder can be switched to skeleton only or off; the hooks and the MCP tool add recall text to the running session, and your harness sends that to its model like any other context.

```bash
# Read every folder; or only the ones you name (a path, or its name under ~/.claude/projects); --deny keeps one out.
oars sessions deposit --redact-domain corp.example
oars sessions deposit --allow ~/work/app --allow ~/work/tools --deny ~/work/tools/secret

# Look up an error as printed, a file, or a prompt class.
oars sessions recall --error "unexpected EOF while looking for matching \`''"
oars sessions recall --path src/main.ts --since 30   # sees the first 100 sorted paths of a session
oars sessions recall --family recovery --class edit-verify --since 30  # a read family; only recovery and fit take --class and --since
oars sessions recall --entity Monitor                # what is known about a public name: a package, a tool, an MCP server, an action, or a model
oars sessions recall --text "wrong input"            # look for text in the local record (counts all time)
oars sessions recall --pattern <readId> --pattern <readId>  # what happened from here, from the read IDs of your steps so far (repeatable; counts all time)
oars sessions recall --error "..." --session <id>    # name the asking session, so what it did next can be read for this recall

# Serve the same query to a running agent as one MCP tool, oars_recall (stdio):
oars sessions recall --mcp

oars sessions recall --counts --day 2026-11-03   # push and pull, shown and held, as counts
oars sessions lineage <recallId or readId>       # walk back through the evidence, one line per hop
oars sessions read                          # derived reads of your own sessions, largest sample first in each family, with what the store cannot read
oars sessions read --family version-boundary # order 2: what moved between two harness version buckets; also substitution, interaction, and day-move
oars sessions read --family lead-lag         # order 3: a labeled experiment behind an out-of-time check
oars sessions read --family fit --slice model=claude-opus-5-5 --json
oars sessions books --by class --since 30   # tokens, wall time, turns, errors, verify-after-edit rate, and the outcome signals
oars sessions books --by pull               # the same per package, MCP server, plugin, or skill a prompt pulled
oars sessions books --by harness            # the same, grouped by Claude Code, Cursor, Codex, Copilot, Gemini, Grok Build, OpenCode, Pi, and VS Code Copilot Chat (deposit the others with --allow cursor, --allow codex, --allow copilot, --allow gemini, --allow grok, --allow opencode, --allow pi, --allow vscode-copilot, or --allow otel)
oars sessions measure --last 50             # recurring errors per 100 sessions, cache-write per session, recall calls per session
oars sessions measure --last 50 --repo <root>  # the same, for one repository's sessions
oars sessions verify                        # consistency invariants on the stored skeletons and capture records
oars sessions exclusions                    # list sessions excluded by the local term file (counts only; OARS_EXCLUSION_TERMS names the file)
oars sessions gold sample                   # about 200 prompts to judge blind; needs the term file (`OARS_EXCLUSION_TERMS`), and `--exclude-term <text>` adds to it; `gold arms <file>` adds the claim and fresh readers on your Claude subscription; `gold score <file>` reads each arm against the judgments
```

`deposit` is idempotent (a file is skipped only when its size, mtime, capture version, salt, and `--redact-domain` set are all unchanged; a store written by an older capture version is captured again from the harness's transcript or from `raw/`, and one written by a newer oars is refused) and appends to `<config>/oars/sessions/observations.jsonl`:
one record per session, user prompt, tool call, and failed tool result, where each tool call also holds its steps in a canonical action vocabulary and each prompt a frame (harness, model, day, and public stack names); signatures, prompt classes, and recovery episodes are derived
from that log alone, so a change to a derivation rule never re-reads a transcript. The store format, every field with its class, the two version stamps, and the raw archive are in [`docs/sessions-store.md`](https://github.com/manyoars/oars/blob/main/docs/sessions-store.md);
the types are in `src/sessions/schema.ts`. Secrets (by pattern and entropy), emails, and the domains you name are masked
before a line is written (redaction runs on the full text, then the text is cut); lines written before a domain was added stay in the append-only file until it is compacted, and readers use only the latest version of each session. The log is the local derived-records tier: redacted
text, never raw content. It keeps these text fields and no others: the first 300 characters of each prompt, the first informative line of a
tool error (cut to 1,000 characters in the error-line record, 160 characters in a derived example), TLDR lines (400) and Confidence lines (120) from assistant text, WebSearch queries, fetched URLs, file
paths, and git branch names (the last four have no length limit), all redacted first; plus the project folder slug (not redacted, so it
carries your username and directory names; the log stays local), skill names, effort values, model names, harness versions, tool names (including MCP server names), a shell call's program and subcommand, and tool-input key names. A tool call's file target is a salted hash, never the path. Apart from `gold arms`, no `oars sessions` command uploads anything, and telemetry carries none of these fields; `oars pool` and the nightly task send skeletons that carry some of these names after redaction (skill, effort, model, harness version, tool, and MCP server names, a shell call's program, subcommand, and flag names, tool-input key names, a pulled package's name (and its version only when a public list holds it), and a web host (sent as it is after redaction; the pool hashes it on arrival), each after redaction; see `docs/pool.md`, "Wire field register").
Subagent transcripts (`<project>/<session>/subagents/`) are deposited with their parent session and subagent type; `books --by class`
shows their tokens as the `delegated` column, and their errors are in the signatures, `measure`, and recall under the session that
spawned them, so per-session counts still count main sessions. Every deposited transcript is also
hard-linked (copied across volumes) into `<config>/oars/sessions/raw/`, so it outlives the harness's own cleanup. For each session it also writes a skeleton (ids, timestamps, tool linkage, token counts, a SHA-256 in place of every content
field, and a Merkle root over the raw lines) that `verify` checks; the skeleton holds hashes only, never content.
`verify` exits 0 even when an invariant has exceptions; add `--strict` to exit 4 instead. `verify` also reports every session on its own (`--json`: `sessionResults`, each session's ten rows with a status of `pass`, `fail`, or `not run`) and audits each session against its raw file (`audit`): the raw-file match for a hard link and for a copy (a copy of a different size counts as possible tampering), the Merkle root recomputed over the first `leaves` lines, and the count bindings (`leaves`, `session.lines`, and the skeleton's lines plus `badLines` must agree). Each session lands on one of five results: `root matches and the counts bind`, `changed since deposit`, `root mismatch`, `counts do not bind`, or `not run` (no raw file, no skeleton, no capture record, or a raw file that cannot be read). `root mismatch` and `counts do not bind` fail `--strict`; sessions under 10 `leaves` are flagged. `verify` also scores each session against the operator's own other weeks on its harness (`--json`: `selfBaseline`, layer 2 at T0, local): the session's UTC week is the week of its `tsFirst`; a baseline is that harness's other weeks with at least 1,000 tool calls that ended by now, combined by calls; the result is `F` from the median distance over seven histograms (a dimension with no counts on a side is dropped). It is `not run`, scoring nothing, for a null `tsFirst`, a week under 1,000 calls, or fewer than 4 baseline weeks. A low `F` lowers a weight and rejects nothing. `verify` also names the project folders that hold transcripts but are not on the saved allowlist, so are never read (`--json`: `scope`, with `folders`, `transcripts`, and `names`); it is scope, not a failure, and never fails `--strict`. `books` prints the same line. `measure` prints the recurring-error count
per hundred sessions and, on a second line, the distinct recurring signatures in the window.
#### Many folders: `--allow` prefixes, globs, and `--allow-file`

An `--allow` entry is a folder (or its slug), a folder prefix with a trailing slash (`~/work/` reads that folder and every project under it), or a glob (`*` any run of characters, `?` one character, matched against the project-folder name Claude Code derives from the path). `--allow-file <list>` reads entries from a file, one per line (blank lines and `#` comments skipped), so hundreds of folders need no batching and no long command line. A leading `~` is expanded to your home folder, in a list file or quoted entry too. Both repeat and combine. With neither, a deposit reads every folder. `--deny <entry>` (or `!<entry>` in a list file) keeps the folders it names out, in any of those forms; it is saved, and it wins over every `--allow` until that exact entry is named with `--allow` again. Naming it again lifts the denial and nothing else when the saved list names no folder (every folder stays in scope); when the saved list names folders, the entry joins them. Entries a deposit saves are what the SessionEnd hook, the nightly task, `oars pool deposit`, and `oars gate replay` reuse; with none saved, they read every folder. An `--allow-file` that names nothing is refused.

#### Recall in a running session: hooks

`oars sessions hook install` writes five entries into one Claude Code settings file. Each is a deterministic, local, fail-open call into the store (no model, no network); an error inside a hook exits 0 with no output, so a hook never blocks or fails a session.

| Event | Does | Timeout written at install |
|---|---|---|
| `SessionStart` | injects `oars sessions recall --context` for the session's cwd as additional context: the top 5 errors by sessions within the latest 300 sessions of the repository (the `measure --last 300 --repo` window) and what usually followed. Then, when any position qualifies, a table of the positions where earlier sessions split on the next step (a leading step at 20 to 80 percent of at least 20 observations; names and counts only, at most 600 bytes), from the kept pool bundle for the session's harness and version first and this store's pool second (the local half is derived over that harness and version bucket only, or over the harness's versions when the transcript states none). The table is one `recalls.jsonl` row and falls under the 10 percent holdback | under 500 ms |
| `UserPromptSubmit` | the same table again, only when it differs from the one this session was last sent (shown or held), so an unchanged table costs a prompt nothing (the check reads the last 64 KB of the recall log, shared by every session, so in a long or parallel session the last table row can fall out of the window and an unchanged table is sent again) | under 500 ms |
| `PreToolUse` (no matcher: every tool) | the gate hook's role: it fires after the call is decided, so it is a warning and does not claim to move the next step. For a call whose tool and input key names match a shape that fails at least half its calls (of at least 20 calls in at least 3 sessions), and at least twice as often as its action does, injects its counts as additional context, once per session and shape (the check reads the last 64 KB of the recall log, about 44 rows, so a very long session can be told again, and the arm redraws when the nightly index moves), and records the recall. 10 percent of those sessions and shapes are held back: a held arm records what it would have shown and injects nothing. Starts node per call | under 500 ms |
| `PostToolUseFailure` (matcher: every tool the action table maps, and `mcp__.*`) | the recovery edge: for a failed call it reads what followed this failure (same action and error class) in the kept pool bundle, else in this store, and adds "after a failed X (code), the next step was Y xN". It stays silent when the top next step is the failed action again (a retry), when a local edge has fewer than 5 followed steps, and when nothing followed. A call the cells do not cover keeps the older line, "seen in N sessions; what followed: X", under the same holdback, silent on a strict retry lead. Every served or held line is a `recalls.jsonl` row; 10 percent of sessions are held. For Bash and PowerShell a shell pre-filter in the registered command reads the event first and starts node only when it carries `Exit code` | pre-filter: shell builtins only, no node start; whole path under 1 s |
| `SessionEnd` | deposits that one transcript (idempotent by size and mtime), only from a folder the saved allowlist holds (every folder until a deposit names some, less any `--deny`). Once per session: `Stop` fires after every turn and would append a new revision of the growing transcript each time. A session the harness ends without `SessionEnd` is picked up by the nightly deposit | under 5 s |

Claude Code fires `PostToolUse` on success only; a failed Bash call arrives as `PostToolUseFailure`, so that is the event registered. The pre-filter is a `read`, a `case`, and a `printf | node` in the shell the harness runs hooks in (Git Bash on Windows), so it needs no `findstr` and no extra dependency. Writers of the store (`SessionEnd`, the nightly run, `deposit`) take `store.lock`, so parallel sessions cannot lose each other's `state.json` entries; a lock older than ten minutes is broken.

```bash
# The default is the user settings file; --scope project or --file names another.
oars sessions hook install                              # ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR)
oars sessions hook install --scope file --file ./.claude/settings.local.json
oars sessions hook install --scope project              # ./.claude/settings.json
oars sessions hook install --file my-settings.json --keep-retention
oars sessions hook status                               # user, project, and the nightly task
oars sessions hook uninstall --scope user               # removes only the entries install wrote
```

Install merges: existing hooks (a Stop hook that rotates sessions, say) stay, even inside a group that also holds ours or under a name that contains `hook-bin`; re-running replaces only its own entries (the commands ending `hook-bin.js" <session-start|post-tool|stop>`), and a per-turn `Stop` entry of ours from the first build is removed. A settings file that exists but cannot be read is an error that changes nothing. The harness deletes raw transcripts after `cleanupPeriodDays` (30 when unset), which would erase what `deposit` reads, so install raises it to at least 365 in the file it writes, prints the old and new value, and never lowers a higher one. `--keep-retention` leaves it alone and says so. Uninstall does not touch `cleanupPeriodDays`. For a `claude --settings <file>` launch, install into that file with `--scope file`.

#### Nightly schedule (Windows)

On Windows, `oars sessions hook install` registers the Task Scheduler task `OarsSessionsNightly` (daily, 03:00) unless it is already there; `--schedule nightly` registers it by itself, with no settings file. The task runs the full deposit over the saved `--allow` and `--redact-domain` entries and refreshes the recurrence index the hooks read. `--schedule off` removes it and records the choice in the store (`<config>/oars/sessions/schedule.json`), so a later plain install leaves it off until `--schedule nightly` registers it again and clears the record; `hook status` shows whether it is registered. A machine that refuses the task still gets the hooks, and the install says how to retry. Alone, `--schedule` writes no settings file.

#### Reading `measure` before and after

`measure` has no cutoff, so its windows move with every deposit. To pin an "after" reading, run `oars sessions measure --last 300 --since <iso time of the install>` (add `--repo <root>` to window one repository's sessions): the current window is the first 300 sessions started at or after that time and the prior window is the 300 before it. Without `--since` the window is the last N. `measure` also prints hook recall calls per session and hook hits per session, and hook deposits per session, counted from `hook-calls.jsonl` in the store.

#### Remove everything

`oars sessions hook uninstall --scope user` (or the scope you installed); `oars sessions hook install --schedule off`; delete the store folder `<config>/oars/sessions/` (observations, skeletons, state, the hook index, `hook-calls.jsonl`, and `raw/`, which holds the unredacted transcripts). `gold sample` also writes its prompt file and sidecar to `~/.claude/session-commons/review/` (or `$CLAUDE_CONFIG_DIR/session-commons/review/`, or your `--out-dir`); delete those too. oars also writes `<config>/oars/telemetry/` (the telemetry spool and install id; delete it too) and, after `oars login`, `<config>/oars/credentials.json` (`oars logout` deletes it). `cleanupPeriodDays` stays at the value install set unless you change it.

### Gate: what your agents picked

```
oars gate replay                       # find installs, fetch-and-runs, MCP servers, and skills in logs on disk, and ask npm or pip what the registry holds
oars gate replay --no-registry-state   # the same, without asking the registry
oars gate report                       # counts over crossings.jsonl, by who recorded each, and what replay cannot see
oars gate install                      # add the hook to Claude Code at user scope, so crossings are recorded as they happen
oars gate uninstall                    # remove only that hook entry
oars gate policy                       # print the policy in force (warn, block, or off per class)
```

Replay is local and read-only on your transcripts; it writes `crossings.jsonl` and the novelty index `gate-index.txt` into the sessions store and nothing else (npm and pip also keep their own caches, unless `--no-registry-state`). The hook (`oars gate hook`, run by Claude Code, not by you) appends to `crossings.jsonl` as each crossing happens, plus `gate-index.txt`, `gate-registry.jsonl`, and the empty `gate-ask-*.lock` files in the same store (a registry ask the hook had to cut is finished by a helper process that ends on its own timeouts, and the package manager keeps its own cache outside the store), and always exits 0. With no policy file it adds a note about a name first published in the last 30 days or an npm name the registry does not hold; `gate-policy.json` changes that per class, and a block needs `block` written by you. A block is a labeled deny, and a crossing goes nowhere unless you opt in (no opt-in exists yet). `report` reads only `crossings.jsonl`. Both record picks and neither judges them; a note or label states a fact about the registry and nothing else. See `docs/gate.md` in the repository.

### pool

`oars pool` uses the Many Oars pool, `https://pool.manyoars.com`, which is not deployed yet (a request to it fails with exit 8), or a pool server you name with `--server <url>` or `OARS_POOL_URL`. Every other command works without it.

- `oars pool login --provider github|google` asks the pool to start the provider's device flow, prints the user code and link, and polls the pool until you approve; every request prints before it is sent. The pool holds the OAuth client and its secret, so the CLI needs no client ID or secret, and the provider's tokens never reach this machine.
- `oars pool deposit` writes a batch of session skeletons (a closed list of fields, each value redacted first; a host is hashed by the pool on arrival) to an outbox for each session that passes your folder allowlist and the exclusion check, and stops: it sends nothing itself. `--send <hash>` sends one batch that `outbox` printed and that is unchanged on disk, once this account has accepted the pool covenant (`--accept-covenant <version>`, or an earlier acceptance); before that it reads the covenant, sends no batch, and exits 3 with `covenant_not_accepted`. A hash that was never shown, or a batch that changed, is refused before any request. The nightly task is the other sender: after the pool says your account accepted its covenant, it sends new batches, and raw copies only if you said yes to the raw prompt (`oars pool raw --consent yes`). With no sign-in, no acceptance, or an unreachable server it sends nothing.
- `deposit`, `outbox`, and `fetch` need `oars pool login` first; without it they exit 3 and name the server.
- `oars pool coverage [--org-size <band>] [--repo-visibility public|private|unknown]` sets the two coverage bands only you can state, read locally and never from the network; an unset band goes on the wire as `unknown`.
- `oars pool outbox` prints each batch exactly as it would be sent, with its SHA-256, and `--explain` adds each field's rule.
- `oars pool fetch --harness-version <version>` fetches that version's signed bundle, verifies it against the key pinned at login, and keeps it locally. It prints the public and disclosure floors the bundle states (and any read family on a floor of its own) and holds no floor of its own: the pool sets them, so a change is a deploy and never a new release of oars.

## The `--json` contract

With `--json`, stdout carries exactly one JSON document and a success exits 0.

- Success: `{"ok": true, ...}`. The rest depends on the command: `login` adds `email`; `keys create` adds `key` and `secret`, `keys list` adds `keys`, and `keys revoke` adds `keyId` and `revoked`; `sessions` commands add their own fields (`deposit` the counts, `recall` `matches`, `books` `rows`, `measure` `last` and `before`, `verify` `sessions`, `unreadable`, `invariants`, `sessionResults`, and `audit`).
- Failure: `{"ok": false, "step": "...", "problem": {...}}`, where `problem` is the platform's problem document (`title`, `detail`, `code`, `actionUrl` when it sent them).

Without `--json`, a failure prints the problem to stderr instead.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | unexpected error |
| 2 | usage error |
| 3 | authentication failed (login expired or denied, HTTP 401 or 403) |
| 4 | the platform rejected the input, or `sessions verify --strict` found exceptions |
| 5 | conflict (an idempotency key already used) |
| 7 | rate limited |
| 8 | the server could not be reached (the platform, the issuer, or a pool server) |
| 10 | `pool fetch` hit the pool's weekly fetch cap; the bundle on disk is untouched, and the message says when to try again |

## Source

[github.com/manyoars/oars](https://github.com/manyoars/oars/tree/main/packages/cli), [Apache-2.0](https://github.com/manyoars/oars/blob/main/LICENSE).
