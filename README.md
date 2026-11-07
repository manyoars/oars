# oars

The Many Oars open-source monorepo. Apache-2.0.

Many Oars is the open-source `oars` command line and its generated client. This repository holds what a developer installs or imports:

| Path | What it is | State |
|------|------------|-------|
| `packages/client` | `@manyoars/oars-client`: TypeScript types generated from `openapi/public.json` and a thin `openapi-fetch` wrapper that adds the bearer token, `Idempotency-Key`, and `User-Agent` | published on npm as [`@manyoars/oars-client`](https://www.npmjs.com/package/@manyoars/oars-client) at 0.1.x |
| `openapi/public.json` | The slice of the platform API that Many Oars exposes to the CLI and coding agents (including the API key operations), generated from the platform's OpenAPI by `scripts/openapi-public.mjs` and the operation list in `openapi/public-operations.json` | here |
| `packages/cli` | `@manyoars/oars`, the `oars` command: `login`, `keys` (`create`, `list`, `revoke`), `sessions` (a local memory of your own Claude Code sessions), `gate` (a record of the install, MCP, and skill picks your agents make), and `pool` (deposit, outbox, and fetch commands for the Many Oars pool, `pool.manyoars.com`, or a pool server you name) | published on npm as [`@manyoars/oars`](https://www.npmjs.com/package/@manyoars/oars) |

Accounts are not open yet: `oars login` uses the Many Oars issuer by default, and until Many Oars sign-in at `login.manyoars.com` (and its pool at `pool.manyoars.com`) is deployed it exits 2 with an error that names `login.manyoars.com`.

## Session memory

`oars sessions` keeps a local record of your own Claude Code sessions so a repeated error can be looked up. It makes no model call and no network call, except `gold arms`, which sends redacted text through your own Claude subscription. Apart from that and telemetry (on by default, off with `oars telemetry off`, `OARS_TELEMETRY=0`, or `DO_NOT_TRACK=1`; it sends to the Many Oars pool, or the pool server in `OARS_POOL_URL`), oars itself sends nothing; the hooks and the MCP tool add recall text to the running session, and your harness sends that to its model like any other context.

- **Captured:** the sessions of every project folder and harness store by default; `--allow` narrows it to the folders you name and `--deny` keeps a folder out (a denial wins). Secrets, emails, and the domains you name are masked in the log.
- **Stored:** under `<config>/oars/sessions/` on your machine (`<config>` is `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere), including `raw/`, a hard link or copy of each deposited transcript. `raw/` is on by default and holds raw transcripts, unredacted: they keep whatever the transcript held, secrets included, and stay on your machine.
- **Commands:** `oars sessions deposit` (or `--allow <folder>`, `--deny <folder>`), `oars sessions recall --error "<text>"`, `oars sessions hook install --scope user`.
- **Uninstall:** `oars sessions hook uninstall --scope user`, `oars sessions hook install --schedule off` on Windows, where install registers the nightly task, then delete the `<config>/oars/sessions/` folder. If you ran `gold sample`, also delete `~/.claude/session-commons/review/` (or `$CLAUDE_CONFIG_DIR/session-commons/review/`, or your `--out-dir`). Install raises `cleanupPeriodDays` in your settings to at least 365, and uninstall leaves it raised.

The full reference is in [`packages/cli/README.md`](packages/cli/README.md).

## Develop

Node 24 (LTS) and [`just`](https://github.com/casey/just).

```sh
npm ci
just check     # dependency licenses, client build, lint, typecheck, and unit tests; CI runs the same recipe
just audit     # npm audit for high or critical advisories in what ships; needs the network, so CI runs it as its own job
```

`just check` includes a staleness test: it regenerates the client's types from `openapi/public.json` and fails when
`packages/client/src/generated/schema.d.ts` differs.

**Testing and sockets.** A test reaches a handler in process (call it with a `Request`, or build the store and call the function) rather than over a socket. Every loopback connection a test opens and closes stays in the operating system's TIME_WAIT table for a minute (about two on Windows), and concurrent runs share that table's 16,384 dynamic ports, so a test that opens a socket says why in a one-line comment: the transport, a port, or a timeout is what it tests. The pool tests go through `startPool` in `packages/pool/src/test-pool.ts`, which keeps their requests to the Worker on one keep-alive connection; a full `vitest run` leaves a few hundred such sockets, and a change that adds thousands is a regression.

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
