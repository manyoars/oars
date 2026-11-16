# @manyoars/fleet-runner

Private (not published). The runner core for a commissioned run: it takes an order file, runs every cell and repeat through a harness adapter, voids and reruns by the run-task-set spec (section 9), writes the run book (section 7), signs a complete one, files each side and arm's valid sessions in its own store folder, and runs the `real-work-table` read over each.

The runner is proved with a scripted fake, and the Claude Code on Bedrock adapter with a stub `claude`, so no test needs a key, a network, or spend. No real run has been made.

| File | What it does |
| --- | --- |
| `src/order.ts` | The order file: types and `parseOrder`, which rejects a mixed task-set version, a retest without two pinned sides, a harness the fleet manifest does not name, and repeats under 1. |
| `fleet-manifest.json` | The fleet manifest (`fleet-1`): the harnesses, their pinned versions, and model IDs. `deposit-fleet` reads it when `--fleet <file>` is absent, and tests load it as `FLEET`. It holds no key and no path. |
| `src/manifest.ts` | The fleet manifest (`fleet-1`) and the task-set manifest (`<folder>/manifest.json`). |
| `src/plan.ts` | `planOrder`: the ordered runs and the cells; a retest alternates sides. |
| `src/harness.ts` | The adapter interface: `prepare`, `run`, `check`. |
| `src/fake-harness.ts` | The scripted fake; each void cause can be injected per run. |
| `src/claude-bedrock.ts` | The real adapter, Claude Code on Bedrock: `makeClaudeBedrock(settings, { env })` with typed `ClaudeBedrockSettings`; refuses to start without `AWS_BEARER_TOKEN_BEDROCK` and a region. `src/stub-claude.mjs` stands in for `claude` in its tests. |
| `src/runner.ts` | `runOrder`: void detection, in-place reruns, the run cap. |
| `src/sign.ts` | The sign step and the verify command: `ssh-keygen -Y sign -n manyoars-runbook` and `-Y verify`, refusing a run book whose header status is not `complete`. |
| `src/stores.ts` | `makeStager` (copies a valid run's transcript out of its temp folder), `buildStores` (one store folder per side and arm through the CLI's `deposit`), `readStores` (`tableOf` over each with `--min-sessions 3`). |
| `src/deposit-fleet.ts` | `npm run deposit-fleet`: the later deposit step. Verifies a signed, complete run book, waits out the 6-hour idle rule, and runs `oars pool deposit`, `oars pool outbox`, and `oars pool deposit --send-all` per store with that store's config root in the child's environment, stopping a store at the first non-zero exit. A dry run until `--confirm`. It reads `fleet-manifest.json`, or the file `--fleet <file>` names, and refuses a run book from another manifest version. |
| `src/preflight.ts` | `npm run preflight`: before the first paid run, checks this machine with no model call and no spend: `claude` and its pinned version, Node, git, npm, the task-set folder, the fixture tag, `AWS_REGION`, and that `AWS_BEARER_TOKEN_BEDROCK` is set (never its value). |
| `src/first-run-read.ts` | `npm run first-run-read`: reads the files one real run leaves behind and prints `yes`, `no`, or `cannot tell` for the scrub and questions (a) to (f), with the evidence. Only prints; decides no void, edits no record. |
| `FLEET.md` | The one-time owner steps, the order of commands from run to deposit, and "Before the first paid run" (preflight, the owner's yes, one task, and the first-run read). |
| `<runId>.stdout.jsonl` | What an adapter saves in `transcriptOutDir` beside the transcript copy: the harness's stdout, byte for byte, except that the key's value is replaced by `[redacted]`. It is the first-run read's `--output`. |
| `src/runbook.ts` | The run book as JSON Lines with a fixed key order, no transcript text, and no signature. |

Before the first paid run:

```
npm run preflight -w packages/fleet-runner -- --taskset <folder> --fleet <file> --fixture-source <path or URL> [--run-book <file> --allowed-signers <file>]
npm run first-run-read -w packages/fleet-runner -- --transcript <file> --output <file> --run-book <file> --model-id <Bedrock ID> [--run-id <id>] [--marker <text>] [--allow-server <name>]... [--allow-skill <name>]...
```

Run an order through the fake:

```
npm run run-fake -w packages/fleet-runner -- [--order <file>] [--taskset <folder>] [--fleet <file>] [--out <folder>] [--terms <file>] [--change-task-set-at <run number>]
```

With no flags it runs a demo retest, then writes beside the run book: `<order>.stores/<side>-<arm>/` (a sessions store and its projects folder per side and arm, valid runs only) and `<order>.<side>-<arm>.rows.json` (the read, one file per side and arm), `<order>.stores/owners.json` (the owner list the read takes), and, without `--terms`, `<order>.demo-terms.txt` (the invented exclusion list). It prints one line per output file. `--terms` names the exclusion term list the read applies (the demo writes an invented one). Every path is explicit; no code here reads `APPDATA`. Exit code 0 is a complete order, 1 an incomplete or voided one, 2 a bad input. `--change-task-set-at 3` makes run 3 report another task-set version.

The order file names the operator's pool account id as `account`; each valid run's pool session id in the run book is `contentHash([account, harness session id])`, the id `oars pool deposit` gives that account and session. Each store folder is its own config root (`<out>/<order id>.stores/<folder>/oars/sessions`). See `FLEET.md` for the deposit.

Header statuses: `complete` (every cell has its repeats), `incomplete` (the run cap ended the order; `shortCells` lists the cells short), and `voided` (the task set changed mid-order: every run is void with `task-set-changed`, nothing is rerun, and `shortCells` lists every planned cell with 0 valid runs).

Void reasons on a run: `harness-failed`, `sign-in-lost`, `machine-failed`, `task-set-changed`, `fixture-tag-changed`, `manifest-changed`, `harness-version-changed`, `model-changed`, `tool-pin-mismatch`, `check-script-failed` (the adapter's check threw), `transcript-missing` (a run that is valid so far left no readable transcript). All but `task-set-changed` void one run, which is rerun in place; `task-set-changed` voids the whole order.

Sign and verify (the company key is made and posted by the owner, not here; tests use a throwaway key):

```
npm run sign -w packages/fleet-runner -- <run book> <key path>
npm run verify-run-book -w packages/fleet-runner -- <run book> <allowed-signers file> [<identity>]
```

`sign` writes `<run book>.sig` beside the run book and refuses an `incomplete` or `voided` one. `verify` exits 1 when the run book or signature differs from what the allowed-signers line names. A cell row under 3 sessions is left out of a row file and counted in its header's `leftOut`; a server or skill row under 3 prints thin, with its count and no rates (that is the read's behavior).

What a real adapter must return for the store folders and the read: `RunResult.transcriptPath` is the Claude Code transcript JSONL of the run (a readable file (this adapter copies it to `transcriptOutDir`), with a `sessionId` on its lines; Claude Code names the file for it), written whenever the run exits `ok`. A clean run with no readable transcript, or one with no session id, is void (`transcript-missing`) and rerun.

## Claude Code on Bedrock adapter

Layout it reads: `taskSetDir` is the repository's `taskset/v1/` (`taskset/v1/README.md`). `manifest.json` carries `reset` (`node` is a `>=` floor such as `>=24.0.0`, and a lower Node is refused when the adapter is made; `install` and `buildDb` are the two reset command lines, run in order in the clone) and, per task, an optional `setup` path such as `setup/repo-workflow-commit.mjs` (run once after the reset with the run folder as its first argument; a non-zero exit is an error the runner records as `machine-failed`). The prompt is `prompts/<id>.md` (sent on stdin) and the check `checks/<id>.mjs` (a Node script, run folder as its first argument; exit 0 is a pass, any other exit a fail, a check that cannot start throws). A task id the manifest does not list is refused before anything is cloned. The task's `category` and `status` are not read here. The operator points the adapter at the fixture with the `ClaudeBedrockSettings.fixtureSource` setting (a local path or a git URL of the private fixture repository) and `fixtureTag` (`taskset-v1`); the manifest's `fixtureCommit` must be the commit that tag resolves to, or a 7 to 40 hex prefix of it, or the run is reported as `fixture-tag-changed`. `solutions/`, `prove.mjs`, and the fixture itself live outside this repository (the answers stay out of a public repo). `src/claude-bedrock-taskset.test.ts` runs the whole path over the real set against a stand-in fixture and the stub `claude`. A tool pin is `npm:<version>` for a server and `git:<commit prefix>` for a skill; the adapter installs the pin the order's request names, then reads the installed version again before the run.

Command: `claude -p --output-format stream-json --verbose --session-id <uuid> --model <id> --strict-mcp-config --mcp-config <config>/mcp.json --permission-mode acceptEdits --allowedTools <list>`, prompt on stdin, run folder as the working directory. Environment, names only: `PATH`, `PATHEXT`, `SystemRoot`, `windir`, `ComSpec`, `TEMP`, `TMP`, `TMPDIR` (copied), `HOME` and `USERPROFILE` (the run's own folder), `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`, `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` (the key does not reach Bash or the tool's MCP server). Nothing else is passed through.

## Codex CLI on Azure OpenAI adapter

`makeCodexAzure(settings, { env })` (`src/codex-azure.ts`; `src/stub-codex.mjs` stands in for `codex` in its tests) shares the reset, tool install, check, transcript copy, and cleanup with the Claude adapter (`src/harness-shared.ts`). It refuses to start without `AZURE_OPENAI_API_KEY`, an endpoint, and a deployment name, and a fresh `CODEX_HOME` holds only `config.toml`, plus the server under `tool/` for a server arm (no sign-in file). Command: `codex exec --json --sandbox workspace-write --model <deployment> --cd <run folder> --ignore-rules -`, prompt on stdin. Environment names: the copied start names, `HOME` and `USERPROFILE` (the run's folder), `CODEX_HOME`, `AZURE_OPENAI_API_KEY`. A skill goes to `<run home>/.agents/skills/<name>`. On Windows an npm-installed `codex` is a `.cmd`, which is refused; set `codexExecutable` to `node` and `codexArgs` to `[<npm root -g>/@openai/codex/bin/codex.js]`, or to the native executable. The rollout copied is `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`, the file the oars Codex reader (`packages/cli/src/sessions/codex.ts`) parses. The machine must have no `/etc/codex/skills` folder. Tokens of spawned agents' rollouts are counted even when the run's own rollout is missing.
