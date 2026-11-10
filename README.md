# oars

oars keeps a local, searchable record of your coding agent sessions, across Claude Code, Cursor, Codex, and other harnesses. Ask it about an error and it shows how many past sessions hit it, when, and which tools came next. More at [manyoars.com](https://manyoars.com/).

This is the Many Oars open-source monorepo (Apache-2.0): the `oars` command line and its generated client. It holds what a developer installs or imports:

| Path | What it is | State |
|------|------------|-------|
| `packages/client` | `@manyoars/oars-client`: TypeScript types generated from `openapi/public.json` and a thin `openapi-fetch` wrapper that adds the bearer token, `Idempotency-Key`, and `User-Agent` | published on npm as [`@manyoars/oars-client`](https://www.npmjs.com/package/@manyoars/oars-client) at 0.1.x |
| `openapi/public.json` | The slice of the platform API that Many Oars exposes to the CLI and coding agents (including the API key operations), generated from the platform's OpenAPI by `scripts/openapi-public.mjs` and the operation list in `openapi/public-operations.json` | here |
| `packages/cli` | `@manyoars/oars`, the `oars` command: `login`, `keys` (`create`, `list`, `revoke`), `sessions` (a local memory of your own coding-agent sessions: Claude Code, Cursor, Codex, Copilot CLI, Gemini CLI, Grok Build, OpenCode, Pi, and VS Code Copilot Chat), `gate` (a record of the install, MCP, and skill picks your agents make), and `pool` (deposit, outbox, and fetch commands for a pool server: the Many Oars pool, `pool.manyoars.com`, which is live, or one you name) | published on npm as [`@manyoars/oars`](https://www.npmjs.com/package/@manyoars/oars) |

Accounts are not open yet: `oars login` uses the Many Oars issuer by default, and until Many Oars sign-in at `login.manyoars.com` is deployed it exits 2 with an error that names `login.manyoars.com`.

## Session memory

`oars sessions` keeps a local record of your own coding-agent sessions so a repeated error can be looked up. It makes no model call and no network call, except `gold arms`, which sends redacted text through your own Claude subscription. Apart from that and telemetry (on by default, off with `oars telemetry off`, `OARS_TELEMETRY=0`, or `DO_NOT_TRACK=1`; it sends to the pool server in `OARS_POOL_URL`, else to the Many Oars pool at `pool.manyoars.com`, which is live), oars itself sends nothing, except what you opted into with a pool server: after you accept its covenant, the detached sender that a session-end hook or any `oars` command starts, at most about once an hour, sends closed-vocabulary session skeletons, and, only after a separate yes to the raw prompt, a locally redacted (best-effort) copy of each full transcript; `oars pool outbox` prints what is queued when you run it, but the sender builds new batches and sends them in the same run without printing them first, and a session leaves your machine no sooner than an hour after it ends, and a folder can be switched to skeleton only or off; the hooks and the MCP tool add recall text to the running session, and your harness sends that to its model like any other context.

- **Captured:** the sessions of every project folder and harness store by default; `--allow` narrows it to the folders you name and `--deny` keeps a folder out (a denial wins). Secrets, emails, and the domains you name are masked in the log.
- **Stored:** under `<config>/oars/sessions/` on your machine (`<config>` is `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere), including `raw/`, a hard link or copy of each deposited transcript. `raw/` is on by default and holds raw transcripts, unredacted: they keep whatever the transcript held, secrets included. The files in `raw/` stay on your machine; after a yes to the raw prompt (`oars pool raw`) and covenant acceptance, the sender uploads a redacted copy of each (never the file itself), except from a folder set to skeleton only or off.
- **Commands:** `oars sessions deposit` (or `--allow <folder>`, `--deny <folder>`), `oars sessions recall --error "<text>"`, `oars sessions hook install --scope user`.
- **Uninstall:** `oars sessions hook uninstall --scope user`, then delete the `<config>/oars/sessions/` and `<config>/oars/telemetry/` folders, and `<config>/oars/credentials.json` if you ran `oars login`. If you ran `gold sample`, also delete `~/.claude/session-commons/review/` (or `$CLAUDE_CONFIG_DIR/session-commons/review/`, or your `--out-dir`). Install raises `cleanupPeriodDays` in your settings to at least 365, and uninstall leaves it raised.

The full reference is in [`packages/cli/README.md`](packages/cli/README.md).

## Develop

Node 24 (LTS) and [`just`](https://github.com/casey/just).

```sh
npm ci
just check     # dependency licenses, client build, lint, typecheck, and unit tests; CI runs the same recipe on Linux and Windows
just audit     # npm audit for high or critical advisories in what ships; needs the network, so CI runs it as its own job
```

`just check` includes a staleness test: it regenerates the client's types from `openapi/public.json` and fails when
`packages/client/src/generated/schema.d.ts` differs.

**Testing and sockets.** A test reaches a handler in process (call it with a `Request`, or build the store and call the
function) rather than over a socket. Every loopback connection a test opens and closes stays in the operating system's
TIME_WAIT table for a minute (about two on Windows), and concurrent runs share that table's dynamic port range (16,384
ports on Windows), so a test that opens a socket says why in a one-line comment: the transport, a port, or a timeout is
what it tests. The pool tests go through `startPool` in `packages/pool/src/test-pool.ts`, which keeps their requests to
the Worker on Node's keep-alive connection pool; a full `vitest run` leaves a few hundred such sockets, and a change that
adds thousands is a regression (`test-pool.test.ts` fails when the connections stop being reused).

## The public API spec

`openapi/public.json` is a committed copy, never edited by hand. To add a call, list its `operationId` in
`openapi/public-operations.json` and run:

```sh
just openapi-refresh <path to the platform checkout's api-specs/openapi.json>
```

That rewrites `openapi/public.json` (the listed operations and the components they reference, keys sorted, so a diff shows only
real changes) and the client's generated types. The script fails, naming the operation, when a listed `operationId` is not in
the source.

## License

[Apache-2.0](LICENSE).
