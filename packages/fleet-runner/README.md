# @manyoars/fleet-runner

Private (not published). The runner core for a commissioned run: it takes an order file, runs every cell and repeat through a harness adapter, voids and reruns by the run-task-set spec (section 9), and writes the unsigned run book (section 7).

This package has no real harness. The only adapter is a scripted fake, so its tests need no key, no network, and no spend.

| File | What it does |
| --- | --- |
| `src/order.ts` | The order file: types and `parseOrder`, which rejects a mixed task-set version, a retest without two pinned sides, a harness the fleet manifest does not name, and repeats under 1. |
| `src/manifest.ts` | The fleet manifest (`fleet-1`) and the task-set manifest (`<folder>/manifest.json`). |
| `src/plan.ts` | `planOrder`: the ordered runs and the cells; a retest alternates sides. |
| `src/harness.ts` | The adapter interface: `prepare`, `run`, `check`. |
| `src/fake-harness.ts` | The scripted fake; each void cause can be injected per run. |
| `src/runner.ts` | `runOrder`: void detection, in-place reruns, the run cap. |
| `src/runbook.ts` | The run book as JSON Lines with a fixed key order, no transcript text, and no signature. |

Run an order through the fake:

```
npm run run-fake -w packages/fleet-runner -- [--order <file>] [--taskset <folder>] [--fleet <file>] [--out <folder>]
```

With no flags it runs a demo retest. Exit code 0 is a complete order, 1 an incomplete one (the run cap hit), 2 a bad input.
