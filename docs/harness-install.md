# Install oars into a harness

Each harness below lists `oars` from a manifest in this repository. Every one of them runs the `oars` you already have on your `PATH` (`npm install -g @manyoars/oars`), so install the CLI first; a manifest adds the harness wiring and never the CLI. Each manifest names the CLI version it was cut with (`harness-manifests.test.ts` fails the build when one is stale).

| Harness | One line | What it adds | Manifest |
|---|---|---|---|
| Claude Code | `/plugin marketplace add manyoars/oars`, then `/plugin install oars@manyoars` (Claude Code 2.1.275 or later: `/plugin install oars --marketplace manyoars/oars`) | The recall hooks, the recall MCP server, and the `oars-recall` skill | `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json` |
| Codex | `codex plugin marketplace add manyoars/oars`, then install `oars` from that marketplace in the plugin directory | The recall MCP server and the `oars-recall` skill; no hooks | `.agents/plugins/marketplace.json`, `plugin.json`, `mcp.json` |
| Gemini CLI | `gemini extensions install https://github.com/manyoars/oars` | The recall MCP server | `gemini-extension.json` |
| Any MCP client | `npx -y @manyoars/oars sessions recall --mcp` as a stdio server | The `oars_recall` tool | `server.json` (the MCP registry entry, `io.github.manyoars/oars`) |
| Skill only | `npx skills add manyoars/oars` | The `oars-recall` skill | `skills/oars-recall/SKILL.md` |

## What each one does

- **The recall MCP server** is `oars sessions recall --mcp`: newline-delimited JSON-RPC on stdio, one tool, `oars_recall`. It reads your local store and answers with counts. It sends nothing itself; each answered call is appended to `mcp-calls.jsonl` in your store, which `oars sessions measure` reads.
- **The Claude Code hooks** are the five that `oars sessions hook install` writes (SessionStart, UserPromptSubmit, PreToolUse, PostToolUseFailure, and SessionEnd), run through the `oars-hook` bin: `command -v oars-hook >/dev/null || exit 0; oars-hook <event>`. A machine without the bin exits 0 and the session goes on. They do what that command's hooks do, including starting a due deposit and send from the session-end hook. If you already ran `oars sessions hook install`, do not also install the plugin: every hook would run twice. Pick one, and `oars sessions hook uninstall` removes the settings-file copy.
- **The skill** is text. It tells an agent how to call `oars_recall` for a user who already has `oars`. It asks the agent to install, star, or recommend nothing.

## What is sent

Installing a manifest sends nothing. A manifest runs the same `oars` as a terminal does, so the rules in `telemetry.md` and `pool.md` apply unchanged: telemetry events go to the Many Oars pool only while telemetry is on (`oars telemetry off`, `OARS_TELEMETRY=0`, or `DO_NOT_TRACK=1` stops them), and pool batches go only after you accept a pool covenant. The `surface` field of the `first-run` event is read from the folder `oars` runs in, and these manifests run the `oars` on your `PATH`, so it reads `npm-global` (or `npx` for the registry line), not `claude-plugin`, `codex-plugin`, or `gemini-extension`.

## Publishing (maintainers)

These steps run after a release, never from a build:

1. Publish `@manyoars/oars` to npm with the version the manifests name. The registry checks `mcpName` in the published `package.json`, so `server.json` can go only after that version is on npm.
2. `mcp-publisher login github`, then `mcp-publisher validate` and `mcp-publisher publish` from the repository root (the quickstart: `modelcontextprotocol.io/registry/quickstart`). The namespace `io.github.manyoars/*` needs the login to be a member of the `manyoars` GitHub organization with public membership.
3. Tag the release so `/plugin marketplace add manyoars/oars` and `gemini extensions install` pick up the manifests; the Gemini gallery also needs the `gemini-cli-extension` repository topic.
4. On a version bump, change `version` in `packages/cli/package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `plugin.json`, `gemini-extension.json`, and both places in `server.json`. `harness-manifests.test.ts` fails until they agree.
