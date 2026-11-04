# Changelog

All notable changes to `@manyoars/oars`. Versions follow semver; a release is the tag `cli-v<version>`.

## Unreleased

- `oars gate` reads more exactly before the hook records live: names behind `bun create`, `python -m pipx` and `python -m uv`, `pnpx`, PEP 508 and package-manager protocol words, percent-encoded dots, and `skills add` shapes; a name is not sent to a registry when `HOME`, `XDG_CONFIG_HOME`, `sudo`, or a venv's `activate` could change its config (and `pnpm` is never asked); a resumed transcript no longer counts a call twice; `program` is a closed list (`PROGRAMS`), and `--allow codex` says what it does not read.
- `oars pool pull` now takes `--harness-version <version>` in place of `--stack` and fetches that version's signed bundle from `/bundle/<version>/<vocab>`. Nothing the pool serves is keyed by stack any more. The option is required (there is no default version), `--json` carries `harnessVersion` in place of `stack`, the problem code `slice_unverified` is now `bundle_unverified`, and a bundle of another vocabulary version is refused even when its signature holds.
- The pool counts fetches per account per ISO week (`fetch_cap`, 429 with `Retry-After`) in place of a capped read count, and a bundle carries an `ETag`: a conditional request that still matches gets a 304 and spends no fetch. A bundle no longer has a `capped` field, and `oars pool pull` no longer prints one. A deposit lifts the cap only when its batch counts toward access; until a wire carries a root, a claude-code batch does not.
- The pool serves a cell or read only at 5 accounts (`K_CELL`, up from 3), and a `live` read's floor counts only the sliced day's accounts: its `inputs` no longer cite the baseline cells, and a baseline under the floor on its own is `null`.
- `oars sessions`: a Slack token in an MCP name that is followed by a lone `_` is now masked whole, and a server named `pk`, `rk`, or `sk` keeps its name; the sessions docs now say that a crashed session's checkpoint may hold per-model totals that are not read.
- `oars sessions` capture version 11: the part of an MCP tool name after `mcp__` (Cursor: `mcp_`) is redacted wherever it is stored, package-manager and shell command forms are read more exactly (`pulls`, `segments`, `commits`, `steps`), and a typed line that only starts with an injected tag's name now opens a prompt. The next `deposit` captures every transcript again.
- `oars sessions` now records, per session and from the transcript only, the setup it ran with (permission mode, plugins, hook count, and instruction bytes), the tool funnel (tools offered, loaded, and removed), and the trust shape (interrupts, rejections, policy denials, and minutes the agent ran between human turns), as counts, names, and sizes; Codex and Copilot record the fields their transcripts hold, and Cursor none. The capture version moves to 12, so the next `oars sessions deposit` reads every transcript again.
- A deposit whose read of its own `store.lock` is refused at the end (an antivirus share violation on Windows) now removes the lock (retrying a share violation, and never losing the deposit's result if the removal is refused too) instead of leaving it for the 10-minute stale window, and a revert file of a Codex thread that a crash tore no longer makes the whole thread unreadable.
- `oars sessions exclusions` is new: it scans your sessions against a local term file (`OARS_EXCLUSION_TERMS`) and writes the excluded ones to a list, printing counts only. `oars sessions gold sample`, published in 0.3.0, now refuses a draw with no term file, and `--exclude-term` only adds to that file's terms instead of replacing it.
- A store lock whose holder hangs is no longer kept for good: the holder refreshes it for at most an hour; once it has aged 10 more minutes, the next deposit breaks it and prints one line naming the holder's pid.
- `oars keys create|list|revoke` manages your API keys. `keys create --workload <id>` mints a key limited to one workload (authorities `AGENT_OPERATE` and `AGENT_READ` only), so a scheduled agent can change its own schedule without being able to spend or reach another workload. The `make-me-money` skill shows the recipe.

## 0.3.0

- `oars sessions` keeps a local, deterministic memory of your own Claude Code sessions (and, with `--allow cursor`, Cursor sessions): `deposit`, `recall`, `books`, `measure`, `verify`, and an MCP server (`recall --mcp`), plus `gold sample`, `gold arms`, and `gold score`. oars makes no model call and no network call, except `gold arms`, which sends redacted text through your own Claude subscription.
- `oars sessions hook install` writes three fail-open hooks (`SessionStart`, `PostToolUseFailure`, `SessionEnd`) into a Claude Code settings file; `hook status` lists them and `hook uninstall` removes only the entries install wrote. Install is idempotent, and raises `cleanupPeriodDays` in that file to at least 365 (uninstall leaves it raised). `--schedule nightly` registers a daily deposit task on Windows.
- Every deposited transcript is also hard-linked (copied across volumes) into `<config>/oars/sessions/raw/`, on by default, so it outlives Claude Code's own cleanup. These are raw transcripts on your machine, and the files themselves are not uploaded.
- `oars purchasing` is hidden from `--help` and refuses with "Paid agents are not open yet" unless `OARS_ISSUER_URL` names a platform of your own; it never reads the launch flag.
- `oars login` with the built-in issuer not answering discovery (no answer, an error status, or a body that is not discovery JSON) now exits 2 with the not-launched message instead of exit 8 or 1; a failure on `--issuer-url` or `OARS_ISSUER_URL` keeps its current error.
- `verify` and `books` name the project folders that hold transcripts but are not on the saved allowlist, which are never read (`scope` in `verify --json` and `books --json`); the list never fails `verify --strict`.
- `verify` audits each session against its raw file (raw-file match, Merkle root, count bindings); it also reports every session on its own and scores each against your own other weeks on its harness (`selfBaseline`).

## 0.2.0

- `oars templates` lists the starter templates, and `oars deploy --template <id>` deploys one without an image of your own.
- `oars login` works with no flags once Many Oars has launched: the production issuer is built in, and
  `https://manyoars.com/.well-known/oars.json` (`{"launched": true}`) switches it on. The flag never supplies the URL.
  Before launch, `login` says "Many Oars has not launched yet: pass --issuer-url or set OARS_ISSUER_URL." and exits 2.
  `--issuer-url` and `OARS_ISSUER_URL` still win.
- An exit 6 ends with a "Needs you:" line that names the link for the step only a person can do, such as Stripe onboarding.
- `deploy` refuses a mix of flags with a message that uses the serial comma; a `--template` the catalog lacks exits 2 and an
  unreachable catalog exits 8, before anything is registered.

## 0.1.1

- README lists the commands and flags.

## 0.1.0

- First release: `login`, `logout`, `deploy`, `status`, and `test-charge`.
