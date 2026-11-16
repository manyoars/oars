# Changelog

`@manyoars/fleet-runner` is private (the operator's fleet runner); this file records what changes for its callers.

## Unreleased

- A new fleet runner core: an order file parser, a plan that alternates a retest's sides, a harness adapter interface with a scripted fake, void detection and in-place reruns under a run cap, and an unsigned JSON Lines run book, run end to end with `npm run run-fake -w packages/fleet-runner`.
