# Changelog

`@manyoars/fleet-runner` is private (the operator's fleet runner); this file records what changes for its callers.

## Unreleased

- A new fleet runner core: an order file parser, a plan that alternates a retest's sides, a harness adapter interface with a scripted fake, void detection and in-place reruns under a run cap, and an unsigned JSON Lines run book, run end to end with `npm run run-fake -w packages/fleet-runner`.
- The runner signs a complete run book with one command (`npm run sign`, `ssh-keygen -Y sign -n manyoars-runbook`) and verifies it (`npm run verify-run-book`), files each side and arm's valid sessions in its own store folder, fills the run book's pool session id, runs the `real-work-table` read over each folder at 3 sessions, and saves one row file per side and arm; a throwing check or a missing transcript is a named void run instead of a lost run book.
