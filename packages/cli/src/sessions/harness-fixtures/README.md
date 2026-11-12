# Harness reader fixtures

One made-up session per reader, each with a test beside it (`<reader>.test.ts`). Nothing here was copied from a real store: the prompts, paths, and ids are invented. Every fixture uses the project path `/work/app` except `cursor.json` and `opencode.json`, whose readers resolve a real folder, so their tests replace the `FOLDER` placeholder with a temp folder at test time. Each session has one prompt, a shell call that exits 2, and an edit (Cursor's also reads `src/a.ts` first), so a reader that loses an outcome, a tool, a model, or a version turns exactly its own test red.

| Reader | Fixture | Staged by the test as |
|--------|---------|-----------------------|
| Claude Code | `claude-code.jsonl` | the transcript text itself |
| Codex | `codex.jsonl` | `sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Copilot CLI | `copilot.jsonl` | `session-state/<id>/events.jsonl` |
| Gemini CLI | `gemini.jsonl` | `.gemini/tmp/<slug>/chats/session-*.jsonl` |
| Grok Build | `grok.updates.jsonl`, `grok.summary.json`, `grok.usage.json` | one session folder |
| Pi | `pi.jsonl` | `sessions/--<cwd>--/<time>_<id>.jsonl` |
| VS Code Copilot Chat | `vscode-copilot.json` | `workspaceStorage/<hash>/chatSessions/<id>.json` |
| Cursor | `cursor.json` | rows written into a `state.vscdb` |
| OpenCode | `opencode.json` | rows written into an `opencode.db` |

When a harness release changes its format, update the fixture to the new shape, keep the old one beside it if the old shape is still readable, and record the version in `docs/harness-install.md`.
