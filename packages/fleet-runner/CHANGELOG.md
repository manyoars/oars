# Changelog

`@manyoars/fleet-runner` is private (the operator's fleet runner); this file records what changes for its callers.

## Unreleased

- A new fleet runner core: an order file parser, a plan that alternates a retest's sides, a harness adapter interface with a scripted fake, void detection and in-place reruns under a run cap, and an unsigned JSON Lines run book, run end to end with `npm run run-fake -w packages/fleet-runner`.
- The real harness adapter for Claude Code on Amazon Bedrock (`src/claude-bedrock.ts`): the spec section 3 reset in a temp folder, a headless `claude -p` run on a Bedrock API key with one tool or none in a fresh config folder, the check script, the transcript copy, and cleanup; proved against a stub `claude`, with no real run.
