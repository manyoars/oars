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

## Refreshing a fixture

The weekly workflow `harness-readers.yml` fails when a harness's latest npm release is past the allowance in `versions.json` (default: a different minor). The reader tests do not: they read these static files. To refresh one:

1. Find a newer session file of that harness on your machine (for example the newest under `~/.claude/projects` or `~/.codex/sessions`).
2. Run `node packages/cli/src/sessions/harness-fixtures/shape.mjs <claude-code|codex|copilot|gemini|grok|pi|vscode-copilot> <file>`. It reads only that file and prints field paths and value types the file has and the fixture lacks, and the reverse, never a value; a key that is not a plain identifier prints as `*`. Cursor and OpenCode keep rows in a database, so compare those by hand.
3. Add the fields the reader reads (or may soon read) to the fixture with invented values. Never paste a prompt, path, id, or any other content from the real file.
4. Set `modeledOn` in `versions.json` to the version the file records, and the same version in the table in `docs/harness-install.md` (a test fails when they differ).
5. Run the harness-fixtures tests; if the reader's summary changed, update the expectation and say why. Keep the old fixture beside the new one if the old shape is still readable.
