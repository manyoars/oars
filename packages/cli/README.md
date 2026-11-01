# @manyoars/oars

The `oars` command line for Many Oars: sign in, deploy an agent, set its prices and make a test charge against it.

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
- `--issuer-url <url>` is the Keycloak realm URL. The default is `OARS_ISSUER_URL`. With neither, `login` uses the built-in Many Oars issuer once Many Oars has launched, which it learns from `https://manyoars.com/.well-known/oars.json` (`{"launched": true}`). The flag only switches the built-in issuer on; it never supplies a URL. Before launch, with no `--issuer-url` or `OARS_ISSUER_URL`, the command prints "Many Oars has not launched yet: pass --issuer-url or set OARS_ISSUER_URL." and exits 2.

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

`oars sessions` keeps a local, deterministic memory of your own Claude Code sessions. No model call, no network, nothing leaves the machine.

```bash
# Read the folders you name (a path, or its name under ~/.claude/projects). At least one --allow is required; there is no "all".
oars sessions deposit --allow ~/work/app --allow ~/work/tools --redact-domain corp.example

# Ask before you re-solve: the error as printed, a file, or a prompt class.
oars sessions recall --error "unexpected EOF while looking for matching \`''"
oars sessions recall --path src/main.ts --since 30

# Serve the same query to a running agent as one MCP tool, oars_recall (stdio):
#   claude mcp add oars-recall -- oars sessions recall --mcp
oars sessions recall --mcp

oars sessions books --by class --since 30   # tokens, wall time, turns, errors, verify-after-edit rate
oars sessions measure --last 50             # recurring errors per 100 sessions, cache-write per session, recall calls per session
oars sessions verify                        # consistency invariants on the stored skeletons
```

`deposit` is idempotent (an unchanged file is skipped by size and mtime) and appends to `<config>/oars/sessions/observations.jsonl`;
the schema is documented in `src/sessions/schema.ts`. Secrets (by pattern and entropy), emails, and the domains you name are masked
before anything is written (redaction runs on the full text, then the text is cut). The log is the local derived-records tier: redacted
text, never raw content. It keeps these text fields and no others: the first 300 characters of each prompt, the first informative line of a
tool error (160 characters), TLDR lines (400) and Confidence lines (120) from assistant text, WebSearch queries, fetched URLs, file
paths, and git branch names (the last four have no length limit), all redacted first; plus the project folder slug (not redacted, so it
carries your username and directory names; the log stays local), skill names, effort values, model names, and harness versions. Nothing is uploaded. Subagent transcripts (`<project>/<session>/subagents/`) are not deposited yet, so
their errors and tokens are missing from recall, books, and measure. For each session it also writes a skeleton (ids, timestamps, tool linkage, token counts, a SHA-256 in place of every content
field, and a Merkle root over the raw lines) that `verify` checks; the skeleton holds hashes only, never content.
`verify` exits 0 even when an invariant has exceptions; add `--strict` to exit 4 instead. `measure` prints the recurring-error count
per hundred sessions and, on a second line, the distinct recurring signatures in the window.

## The `--json` contract

With `--json`, stdout carries exactly one JSON document and a success exits 0.

- Success: `{"ok": true, ...}`. The rest depends on the command: `login` adds `email`; `deploy` adds `workloadId`, `prices`, `started`, `nextSteps` and, when this run minted it, `sdkKey`; `templates` adds `templates`; `status` adds `workload` and `billingMode`; `test-charge` adds `chargeId` and `status`; `sessions` commands add their own fields (`deposit` the counts, `recall` `matches`, `books` `rows`, `measure` `last` and `before`, `verify` `sessions`, `unreadable`, and `invariants`).
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
