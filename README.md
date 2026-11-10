# oars

oars keeps a local, searchable record of your coding agent sessions, across Claude Code, Cursor, Codex, and other harnesses. Ask it about an error and it shows how many past sessions hit it, when, and which tools came next. More at [manyoars.com](https://manyoars.com/).

## Install

```sh
npm install --global @manyoars/oars
```

Node 22.23.4 or later. Local recall needs no account.

Sample output (made-up sessions, from `oars sessions try`):

```
$ oars sessions recall --error "unexpected EOF while looking for matching quote"
Bash | bash: -c: line <n>: unexpected EOF while looking for matching quote
  3 sessions, 3 errors, first 2026-10-06T10:00:15.000Z, last 2026-10-20T10:00:27.000Z
  harness 2.1.300; followed by Bash x2, Read x1, Write x1; an edit followed 1 times

$ oars sessions recall --context --cwd C:\work\demo
oars recall: errors that recur in this repository's earlier sessions. Check these before retrying:
- Bash | bash: -c: line <n>: unexpected EOF while looking for matching quote (3 sessions in the last 300; next: Bash, Read, Write)
- Write | File has not been read yet. Read it first before writing to it. (2 sessions in the last 300; next: Read, Bash, Write)
```

No history yet? `oars sessions try` runs recall, books, and the hook line over made-up sessions in a throwaway store, labeled synthetic and deleted on exit. It never touches your own store.

To use it on your own sessions, run `oars sessions deposit`, then `oars sessions hook install --scope user` to add recall to Claude Code. `oars sessions hook uninstall --scope user` removes only the entries install wrote. Install raises `cleanupPeriodDays` in your settings to at least 365, and uninstall leaves it raised.

## What leaves your machine

- The record stays on your machine, under `<config>/oars/sessions/` (`<config>` is `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere). `raw/` there holds raw transcripts, unredacted. Session commands make no model call and no network call, except `gold arms`, which sends redacted text through your own Claude subscription. The hooks and the MCP tool add recall text to the running session, and your harness sends that to its model.
- Telemetry is on by default: counts, sizes, and closed words, never session content. Turn it off with `oars telemetry off`, `OARS_TELEMETRY=0`, or `DO_NOT_TRACK=1`. It sends to the Many Oars pool at `pool.manyoars.com`, or to `OARS_POOL_URL`.
- Deposits to the Many Oars pool are closed until its covenant opens them. After you accept the covenant, a deposit may be licensed under it. Nothing is sent before you accept, and raw copies need a separate yes.
- The pool is not offered in the EU, the EEA, or the UK.
- Every field and every switch is in [docs/telemetry.md](docs/telemetry.md) and [docs/pool.md](docs/pool.md). The full reference is in [`packages/cli/README.md`](packages/cli/README.md).

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

## Repository layout

This is the Many Oars open-source monorepo (Apache-2.0): the `oars` command line and its generated client. It holds what a developer installs or imports:

| Path | What it is | State |
|------|------------|-------|
| `packages/client` | `@manyoars/oars-client`: TypeScript types generated from `openapi/public.json` and a thin `openapi-fetch` wrapper that adds the bearer token, `Idempotency-Key`, and `User-Agent` | published on npm as [`@manyoars/oars-client`](https://www.npmjs.com/package/@manyoars/oars-client) at 0.1.x |
| `openapi/public.json` | The slice of the platform API that Many Oars exposes to the CLI and coding agents (including the API key operations), generated from the platform's OpenAPI by `scripts/openapi-public.mjs` and the operation list in `openapi/public-operations.json` | here |
| `packages/cli` | `@manyoars/oars`, the `oars` command: `login`, `keys` (`create`, `list`, `revoke`), `sessions` (a local memory of your own coding-agent sessions: Claude Code, Cursor, Codex, Copilot CLI, Gemini CLI, Grok Build, OpenCode, Pi, and VS Code Copilot Chat), `gate` (a record of the install, MCP, and skill picks your agents make), and `pool` (deposit, outbox, and fetch commands for a pool server: the Many Oars pool, `pool.manyoars.com`, which is live, or one you name) | published on npm as [`@manyoars/oars`](https://www.npmjs.com/package/@manyoars/oars) |

Accounts are not open yet: `oars login` uses the Many Oars issuer by default, and until Many Oars sign-in at `login.manyoars.com` is deployed it exits 2 with an error that names `login.manyoars.com`.

## License

[Apache-2.0](LICENSE).
