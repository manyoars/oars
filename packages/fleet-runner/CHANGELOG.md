# Changelog

`@manyoars/fleet-runner` is private (the operator's fleet runner); this file records what changes for its callers.

## Unreleased

- A new fleet runner core: an order file parser, a plan that alternates a retest's sides, a harness adapter interface with a scripted fake, void detection and in-place reruns under a run cap, and an unsigned JSON Lines run book, run end to end with `npm run run-fake -w packages/fleet-runner`.
- The real harness adapter for Claude Code on Amazon Bedrock (`src/claude-bedrock.ts`): the spec section 3 reset in a temp folder, a headless `claude -p` run on a Bedrock API key with one tool or none in a fresh config folder, the check script, the transcript copy, and cleanup; proved against a stub `claude`, with no real run.
- The runner signs a complete run book with one command (`npm run sign`, `ssh-keygen -Y sign -n manyoars-runbook`) and verifies it (`npm run verify-run-book`), files each side and arm's valid sessions in its own store folder, fills the run book's pool session id, runs the `real-work-table` read over each folder at 3 sessions, and saves one row file per side and arm; a throwing check or a missing transcript is a named void run instead of a lost run book.
- The task set v1 is committed at `taskset/v1/` (26 prompts, 26 check scripts with their helpers, two setup scripts, and the manifest naming the fixture tag), and the Bedrock adapter reads that layout and the manifest's `reset`, `setup`, and Node floor; a test runs its reset, setup, run, and check path over the real set with a stand-in fixture.
- The second real harness adapter, Codex CLI on Azure OpenAI (`src/codex-azure.ts`): a fresh `CODEX_HOME` with only the Azure provider and the tool under test, a headless `codex exec --json` run on an Azure API key, the rollout copied out as the transcript, and the shell environment policy that keeps the key from the agent's commands; the code both adapters need moved to `src/harness-shared.ts`, which also fixes three Lows (a fixture commit prefix, the Node floor compared as major.minor.patch, and a tag setting that differs from the manifest refused at construction); proved against a stub `codex`, with no real run.
