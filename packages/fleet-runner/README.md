# @manyoars/fleet-runner

Private (not published). The runner core for a commissioned run: it takes an order file, runs every cell and repeat through a harness adapter, voids and reruns by the run-task-set spec (section 9), writes the run book (section 7), signs a complete one, files each side and arm's valid sessions in its own store folder, and runs the `real-work-table` read over each.

This package has no real harness. The only adapter is a scripted fake, so its tests need no key, no network, and no spend.

| File | What it does |
| --- | --- |
| `src/order.ts` | The order file: types and `parseOrder`, which rejects a mixed task-set version, a retest without two pinned sides, a harness the fleet manifest does not name, and repeats under 1. |
| `src/manifest.ts` | The fleet manifest (`fleet-1`) and the task-set manifest (`<folder>/manifest.json`). |
| `src/plan.ts` | `planOrder`: the ordered runs and the cells; a retest alternates sides. |
| `src/harness.ts` | The adapter interface: `prepare`, `run`, `check`. |
| `src/fake-harness.ts` | The scripted fake; each void cause can be injected per run. |
| `src/runner.ts` | `runOrder`: void detection, in-place reruns, the run cap. |
| `src/sign.ts` | The sign step and the verify command: `ssh-keygen -Y sign -n manyoars-runbook` and `-Y verify`, refusing a run book whose header status is not `complete`. |
| `src/stores.ts` | `makeStager` (copies a valid run's transcript out of its temp folder), `buildStores` (one store folder per side and arm through the CLI's `deposit`), `readStores` (`tableOf` over each with `--min-sessions 3`). |
| `src/runbook.ts` | The run book as JSON Lines with a fixed key order, no transcript text, and no signature. |

Run an order through the fake:

```
npm run run-fake -w packages/fleet-runner -- [--order <file>] [--taskset <folder>] [--fleet <file>] [--out <folder>] [--terms <file>] [--change-task-set-at <run number>]
```

With no flags it runs a demo retest, then writes beside the run book: `<order>.stores/<side>-<arm>/` (a sessions store and its projects folder per side and arm, valid runs only) and `<order>.<side>-<arm>.rows.json` (the read, one file per side and arm), `<order>.stores/owners.json` (the owner list the read takes), and, without `--terms`, `<order>.demo-terms.txt` (the invented exclusion list). It prints one line per output file. `--terms` names the exclusion term list the read applies (the demo writes an invented one). Every path is explicit; no code here reads `APPDATA`. Exit code 0 is a complete order, 1 an incomplete or voided one, 2 a bad input. `--change-task-set-at 3` makes run 3 report another task-set version.

Header statuses: `complete` (every cell has its repeats), `incomplete` (the run cap ended the order; `shortCells` lists the cells short), and `voided` (the task set changed mid-order: every run is void with `task-set-changed`, nothing is rerun, and `shortCells` lists every planned cell with 0 valid runs).

Void reasons on a run: `harness-failed`, `sign-in-lost`, `machine-failed`, `task-set-changed`, `fixture-tag-changed`, `manifest-changed`, `harness-version-changed`, `model-changed`, `tool-pin-mismatch`, `check-script-failed` (the adapter's check threw), `transcript-missing` (a run that is valid so far left no readable transcript). All but `task-set-changed` void one run, which is rerun in place; `task-set-changed` voids the whole order.

Sign and verify (the company key is made and posted by the owner, not here; tests use a throwaway key):

```
npm run sign -w packages/fleet-runner -- <run book> <key path>
npm run verify-run-book -w packages/fleet-runner -- <run book> <allowed-signers file> [<identity>]
```

`sign` writes `<run book>.sig` beside the run book and refuses an `incomplete` or `voided` one. `verify` exits 1 when the run book or signature differs from what the allowed-signers line names. A cell row under 3 sessions is left out of a row file and counted in its header's `leftOut`; a server or skill row under 3 prints thin, with its count and no rates (that is the read's behavior).

What a real adapter must return for the store folders and the read: `RunResult.transcriptPath` is the Claude Code transcript JSONL of the run (a file in the run's temp folder, with a `sessionId` on its lines; Claude Code names the file for it), written whenever the run exits `ok`. A clean run with no readable transcript, or one with no session id, is void (`transcript-missing`) and rerun.
