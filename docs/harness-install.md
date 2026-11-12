# Install oars into a harness

Each harness below lists `oars` from a manifest in this repository. Each harness plugin or extension below runs the `oars` you already have on your `PATH` (`npm install -g @manyoars/oars`), so install the CLI first; a manifest adds the harness wiring and never the CLI. Each manifest names the CLI version it was cut with (`harness-manifests.test.ts` fails the build when one is stale).

| Harness | One line | What it adds | Manifest |
|---|---|---|---|
| Claude Code | `/plugin marketplace add manyoars/oars`, then `/plugin install oars@manyoars` (Claude Code 2.1.275 or later: `/plugin install oars --marketplace manyoars/oars`) | The recall hooks, the recall MCP server, and the `oars-recall` skill | `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json` |
| Codex | `codex plugin marketplace add manyoars/oars`, then install `oars` from that marketplace in the plugin directory | The recall MCP server and the `oars-recall` skill; no hooks | `.agents/plugins/marketplace.json`, `plugin.json`, `mcp.json` |
| Gemini CLI | `gemini extensions install https://github.com/manyoars/oars` | The recall MCP server and the `oars-recall` skill | `gemini-extension.json`, `skills/oars-recall/SKILL.md` |
| Any MCP client | `npx -y @manyoars/oars sessions recall --mcp` as a stdio server | The `oars_recall` tool | `server.json` (the MCP registry entry, `io.github.manyoars/oars`) |
| Skill only | `npx skills add manyoars/oars` | The `oars-recall` skill | `skills/oars-recall/SKILL.md` |

## What each one does

- **The recall MCP server** is `oars sessions recall --mcp`: newline-delimited JSON-RPC on stdio, one tool, `oars_recall`. It reads your local store and answers with counts. It sends nothing itself; each answered call is appended to `mcp-calls.jsonl` in your store, which `oars sessions measure` reads.
- **The Claude Code hooks** are the five that `oars sessions hook install` writes (SessionStart, UserPromptSubmit, PreToolUse, PostToolUseFailure, and SessionEnd), run through the `oars-hook` bin: `command -v oars-hook >/dev/null || exit 0; oars-hook <event>`. A machine without the bin exits 0 and the session goes on. They do what that command's hooks do, including starting a due deposit and send from the session-end hook. If you already ran `oars sessions hook install`, do not also install the plugin: every hook would run twice. Pick one, and `oars sessions hook uninstall` removes the settings-file copy.
- **The skill** is text. It tells an agent how to call `oars_recall` for a user who already has `oars`. It asks the agent to install, star, or recommend nothing.

## What is sent

Installing a manifest sends nothing. A manifest runs the same `oars` as a terminal does, so the rules in `telemetry.md` and `pool.md` apply unchanged: telemetry events go to the Many Oars pool only while telemetry is on (`oars telemetry off`, `OARS_TELEMETRY=0`, or `DO_NOT_TRACK=1` stops them), and pool batches go only after you accept a pool covenant. The `surface` field of the `first-run` event is read from the folder `oars` runs in, and these manifests run the `oars` on your `PATH`, so it reads `npm-global` (or `npx` for the registry line), not `claude-plugin`, `codex-plugin`, or `gemini-extension`.

## Versions last tested

Each reader is pinned by a made-up session fixture and a test (`packages/cli/src/sessions/harness-fixtures/`). The table says which version each fixture was modeled on and how that is known: "stamped" means the version is written inside the fixture, "source" means the fixture follows the upstream source at the named commit, which the reader's own test file cites. No row says the newest release of a harness reads correctly; the weekly workflow `harness-readers.yml` reruns the same tests and prints the latest npm release of each harness that has one, so a red reader and a new release show up in one run. The tests read fixtures, not an installed harness, so the workflow installs nothing. The "stamped" versions were carried over from the reader's existing tests; they do not record a release tested against a live install.

| Harness | Version the fixture is modeled on | How we know | Date |
|---------|-----------------------------------|-------------|------|
| Claude Code | 2.1.300 | stamped | 2026-11-12 |
| Codex | 0.50.0 | stamped | 2026-11-12 |
| Copilot CLI | 1.0.105 | stamped | 2026-11-12 |
| OpenCode | 2.2.5 | stamped | 2026-11-12 |
| Gemini CLI | not stamped | source, google-gemini/gemini-cli at 89e9d25d | 2026-11-12 |
| Grok Build | not stamped | source, xai-org/grok-build at 2bdd1d6 | 2026-11-12 |
| Pi | not stamped | source, badlogic/pi-mono at 085c84e | 2026-11-12 |
| VS Code Copilot Chat | not stamped | source, microsoft/vscode at f92b8f3a | 2026-11-12 |
| Cursor | not stamped | no public source; shapes follow the local store the reader was written against | 2026-11-12 |

## Publishing (maintainers)

These steps run after a release, never from a build:

1. The first registry listing needs a release above 0.4.1: npm already has 0.4.0 and 0.4.1, neither with `mcpName`, and npm refuses a republish. Bump all 7 version fields together (step 4), tag `cli-v<that version>`, and let `release-cli.yml` publish it. The registry checks `mcpName` in the published `package.json`, so `server.json` can go only after that version is on npm.
2. `release-mcp.yml` lists `io.github.manyoars/oars` on the MCP registry after each `release-cli` run that publishes a tag, from GitHub Actions over OIDC (`mcp-publisher login github-oidc`, no stored token). The registry refuses the interactive `mcp-publisher login github` for an organization namespace, so this is not run by hand. For a tag that is already on npm, dispatch it from main: `gh workflow run release-mcp.yml -R manyoars/oars -f tag=cli-v0.5.1`. The workflow checks the tag is `cli-v<major.minor.patch>`, on main, and equal to `server.json`'s `version`; `mcp-publisher validate` runs first (the quickstart: `modelcontextprotocol.io/registry/quickstart`). The namespace needs the `manyoars` organization to own the repository.
3. The step 1 tag is what `/plugin marketplace add manyoars/oars` and `gemini extensions install` pick up; the Gemini gallery also needs the `gemini-cli-extension` repository topic.
4. On a version bump, change `version` in `packages/cli/package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `plugin.json`, `gemini-extension.json`, and both places in `server.json`. `harness-manifests.test.ts` fails until they agree.
