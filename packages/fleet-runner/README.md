# @manyoars/fleet-runner

Private (not published). The runner core for a commissioned run: it takes an order file, runs every cell and repeat through a harness adapter, voids and reruns by the run-task-set spec (section 9), and writes the unsigned run book (section 7).

The runner is proved with a scripted fake, and the Claude Code on Bedrock adapter with a stub `claude`, so no test needs a key, a network, or spend. No real run has been made.

| File | What it does |
| --- | --- |
| `src/order.ts` | The order file: types and `parseOrder`, which rejects a mixed task-set version, a retest without two pinned sides, a harness the fleet manifest does not name, and repeats under 1. |
| `src/manifest.ts` | The fleet manifest (`fleet-1`) and the task-set manifest (`<folder>/manifest.json`). |
| `src/plan.ts` | `planOrder`: the ordered runs and the cells; a retest alternates sides. |
| `src/harness.ts` | The adapter interface: `prepare`, `run`, `check`. |
| `src/fake-harness.ts` | The scripted fake; each void cause can be injected per run. |
| `src/claude-bedrock.ts` | The real adapter, Claude Code on Bedrock: `makeClaudeBedrock(settings, { env })` with typed `ClaudeBedrockSettings`; refuses to start without `AWS_BEARER_TOKEN_BEDROCK` and a region. `scripts/stub-claude.mjs` stands in for `claude` in its tests. |
| `src/runner.ts` | `runOrder`: void detection, in-place reruns, the run cap. |
| `src/runbook.ts` | The run book as JSON Lines with a fixed key order, no transcript text, and no signature. |

Run an order through the fake:

```
npm run run-fake -w packages/fleet-runner -- [--order <file>] [--taskset <folder>] [--fleet <file>] [--out <folder>] [--change-task-set-at <run number>]
```

With no flags it runs a demo retest. Exit code 0 is a complete order, 1 an incomplete or voided one, 2 a bad input. `--change-task-set-at 3` makes run 3 report another task-set version.

Header statuses: `complete` (every cell has its repeats), `incomplete` (the run cap ended the order; `shortCells` lists the cells short), and `voided` (the task set changed mid-order: every run is void with `task-set-changed`, nothing is rerun, and `shortCells` lists every planned cell with 0 valid runs).

Void reasons on a run: `harness-failed`, `sign-in-lost`, `machine-failed`, `task-set-changed`, `fixture-tag-changed`, `manifest-changed`, `harness-version-changed`, `model-changed`, `tool-pin-mismatch`. All but `task-set-changed` void one run, which is rerun in place; `task-set-changed` voids the whole order.

## Claude Code on Bedrock adapter

Layout it expects: `<taskSetDir>/manifest.json` (with a `reset` object: `node` is the Node major the fixture needs, `commands` the ordered reset command lines, run in the clone; a lower Node is refused when the adapter is made), per task an optional `setup/<id>.mjs` (run once after the reset, run folder as its first argument; a non-zero exit is an error the runner records as `machine-failed`), and per task `tasks/<id>/prompt.md` (sent on stdin) and `tasks/<id>/check.mjs` (a Node script, run folder as its first argument, exit 0 is a pass; any other exit is a fail; a check that cannot start throws). A tool pin is `npm:<version>` for a server and `git:<commit prefix>` for a skill; the adapter installs the pin the order's request names, then reads the installed version again before the run.

Command: `claude -p --output-format stream-json --verbose --session-id <uuid> --model <id> --strict-mcp-config --mcp-config <config>/mcp.json --permission-mode acceptEdits --allowedTools <list>`, prompt on stdin, run folder as the working directory. Environment, names only: `PATH`, `PATHEXT`, `SystemRoot`, `windir`, `ComSpec`, `TEMP`, `TMP`, `TMPDIR` (copied), `HOME` and `USERPROFILE` (the run's own folder), `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`, `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` (the key does not reach Bash or the tool's MCP server). Nothing else is passed through.
