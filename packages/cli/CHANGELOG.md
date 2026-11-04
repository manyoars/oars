# Changelog

All notable changes to `@manyoars/oars`. Versions follow semver; a release is the tag `cli-v<version>`.

## Unreleased

- `oars sessions exclusions` is new: it scans your sessions against a local term file (`OARS_EXCLUSION_TERMS`) and writes the excluded ones to a list, printing counts only. `oars sessions gold sample`, published in 0.3.0, now refuses a draw with no term file, and `--exclude-term` only adds to that file's terms instead of replacing it.
- `oars keys create|list|revoke` manages your API keys. `keys create --workload <id>` mints a key limited to one workload (authorities `AGENT_OPERATE` and `AGENT_READ` only), so a scheduled agent can change its own schedule without being able to spend or reach another workload. The `make-me-money` skill shows the recipe.

## 0.3.0

- `oars sessions` keeps a local, deterministic memory of your own Claude Code sessions (and, with `--allow cursor`, Cursor sessions): `deposit`, `recall`, `books`, `measure`, `verify`, and an MCP server (`recall --mcp`), plus `gold sample`, `gold arms`, and `gold score`. oars makes no model call and no network call, except `gold arms`, which sends redacted text through your own Claude subscription.
- `oars sessions hook install` writes three fail-open hooks (`SessionStart`, `PostToolUseFailure`, `SessionEnd`) into a Claude Code settings file; `hook status` lists them and `hook uninstall` removes only the entries install wrote. Install is idempotent, and raises `cleanupPeriodDays` in that file to at least 365 (uninstall leaves it raised). `--schedule nightly` registers a daily deposit task on Windows.
- Every deposited transcript is also hard-linked (copied across volumes) into `<config>/oars/sessions/raw/`, on by default, so it outlives Claude Code's own cleanup. These are raw transcripts on your machine, and the files themselves are not uploaded.
- `oars purchasing` is hidden from `--help` and refuses with "Paid agents are not open yet" unless `OARS_ISSUER_URL` names a platform of your own; it never reads the launch flag.
- `oars login` with the built-in issuer not answering discovery now exits 2 with the not-launched message instead of exit 8; a failure on `--issuer-url` or `OARS_ISSUER_URL` keeps its current error.
- `verify` and `books` name the project folders that hold transcripts but are not on the saved allowlist, so are never read (`scope` in `verify --json`); it never fails `verify --strict`.
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
