# Task set v1

The commissioned run's task set: 26 tasks, four categories of six (`browser`, `database`, `docs-fetch`, `repo-workflow`) and two `control` tasks. Each task is one prompt and one check script.

- `manifest.json`: the version, the fixture tag and commit, the reset commands, and the task list (`id`, `category`, `status`, and `setup` when the task has one).
- `prompts/<id>.md`: the prompt, fixed word for word. No prompt names a tool.
- `checks/<id>.mjs`: the check. `checks/_shared.mjs` and `checks/_page.mjs` are helpers; `checks/_original/` holds the starting files two checks compare against.
- `setup/<id>.mjs`: for the two tasks whose starting state a tag cannot hold (a staged change, a working-tree diff).

## Version rule

A version fixes the categories, the task text, each task's check, the fixture tag, and the controls. An order names one version and every run in it uses that version. A version never changes once an order names it; a fix makes a new version (`v2`).

## Calling a check

`node taskset/v1/checks/<id>.mjs <run folder>` exits 0 for pass and 1 for fail, and prints one last line saying why. A setup runs after the reset and before the agent: `node taskset/v1/<setup> <run folder>`. Checks need no network, browser, or model.

## The fixture

The fixture is a private repository (a small TypeScript app) at the tag `taskset-v1`; `manifest.json` names the tag and its commit. Each run starts from a fresh clone at that tag.

## Node floor

Node 24 or later (`reset.node` in the manifest).
