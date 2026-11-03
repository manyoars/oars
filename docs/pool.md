# The pool

The pool is an optional server that accounts sign in to, deposit closed-vocabulary session skeletons to, and pull cells and reads from. Local capture, recall, and reads need none of it: nothing leaves your machine unless you run `oars pool deposit`. The code is in `packages/pool`, a Cloudflare Worker over one D1 database.

## Commands

Every command takes the server from `--server <url>` or `OARS_POOL_URL`. There is no default, and plain http goes only to localhost. The server is an origin with no credentials, path, or query, and a redirect is refused, so a token or a skeleton cannot be moved elsewhere.

| Command | What it does |
|---------|--------------|
| `oars pool login --provider github\|google` | Device flow through the pool. It saves the pool's own token at `<store>/pool-accounts.json` (mode 0600) and pins the pool's signing key on first login. No harness token is read. |
| `oars pool deposit [--accept-covenant <version>]` | Sends every session that passes the exclusion check as a skeleton, and prints counts only. A session that fails the check, or has no raw to scan, is never built or sent. |
| `oars pool pull [--stack <name>]` | Fetches one stack's signed slice, verifies it against the pinned key, and keeps it at `<store>/pool-replica/<hash of server>/<stack>.json`, still signed. A slice that fails verification is refused and not written. |

## What the server enforces

- **Deposits are closed by default.** With no `COVENANT_VERSION` binding, every deposit gets 403 `deposits_closed`. Once one is set, an account must have accepted exactly that version, or it gets 403 `covenant_not_accepted`, and a new version asks again. Reads and `pull` are not affected.
- **Closed vocabulary.** A skeleton holding an unknown field or a value outside the vocabulary gets 422 `closed_vocabulary` with the field named, and nothing is stored. What is stored is the parsed skeleton, not the text that came in.
- **Pseudonymous accounts.** The provider's user id is hashed under `PSEUDONYM_KEY`, which the database never holds. No email, login, or provider id is stored.
- **Three accounts to a read.** A read is served only at 3 or more clusters, and a cluster is an account, so one account's many sessions count once.
- **Deposit or capped access.** An account with a deposit pulls on an ongoing basis. One without is served up to `READ_CAP` reads (default 50).

## Routes

| Route | Answer |
|-------|--------|
| `POST /v1/login/start`, `POST /v1/login/poll` | The device flow. |
| `GET /v1/covenant` | `{version, accepted}`. `version` is null when deposits are closed. Sign-in is optional. |
| `POST /v1/covenant/accept` | Takes `{version}`. 409 `covenant_version` for any version but the one in force. |
| `POST /v1/deposits` | Takes one skeleton, 1 MB at most. |
| `GET /v1/slices/:stack` | A signed slice: `{payload, signature}`, Ed25519 over the payload's exact bytes. |

## Bindings

All of these are set at the deploy, never in `wrangler.jsonc`, which holds no account id, resource id, secret, route, or domain. An unset one refuses the route that needs it.

| Binding | Holds |
|---------|-------|
| `DB` | The D1 database. |
| `PSEUDONYM_KEY` | The key accounts are hashed under. Changing it makes every account new. |
| `SLICE_SIGNING_KEY` | An Ed25519 private key as a JWK. Clients pin the public half, so changing it fails their next login. |
| `GITHUB_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The OAuth values. |
| `COVENANT_VERSION` | The covenant in force. Leave it unset until the covenant is published. |
| `READ_CAP` | Optional. Reads served to an account with no deposit. |

## Tests

`packages/pool` runs the bundled handler and its D1 store under the Workers runtime through Miniflare, in-process, with a stub sign-in provider, so it needs no Docker, account, or network. `full-run.test.ts` drives the real CLI commands against it over a local socket.

## Deploy steps

Nothing has been deployed or provisioned. Each step is owed once, by the account holder, in this order:

1. Create a GitHub OAuth app with device flow enabled, and note its client id.
2. Create a Google OAuth client of type "TVs and Limited Input devices", and note its id and secret.
3. Run `wrangler d1 create oars-pool` in `packages/pool`. The config binds it by name, so commit no `database_id`.
4. Run `wrangler d1 migrations apply oars-pool --remote` in `packages/pool`.
5. Run `wrangler secret put` for `PSEUDONYM_KEY` (32 random bytes), `SLICE_SIGNING_KEY`, `GITHUB_CLIENT_ID`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`, and leave `COVENANT_VERSION` unset.
6. Run `wrangler deploy` in `packages/pool`, confirm it bound the database from step 3 rather than creating another, and attach the custom domain in the dashboard or with `--domain`. Only `--dry-run` has been exercised.
7. Publish the covenant, and only then run `wrangler secret put COVENANT_VERSION`, which opens deposits.
