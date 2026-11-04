# The pool

The pool is an optional server that accounts sign in to, deposit closed-vocabulary session skeletons to, and pull cells and reads from. Local capture, recall, and reads need none of it: nothing leaves your machine unless you run `oars pool deposit`. The code is in `packages/pool`, a Cloudflare Worker over one D1 database.

## Commands

Every command takes the server from `--server <url>` or `OARS_POOL_URL`. There is no default, and plain http goes only to localhost. The server is an origin with no credentials, path, or query, and a redirect is refused, so a token or a skeleton cannot be moved elsewhere.

| Command | What it does |
|---------|--------------|
| `oars pool login --provider github\|google` | Device flow through the pool. It saves the pool's own token at `<store>/pool-accounts.json` (mode 0600) and pins the pool's signing key on first login. No harness token is read. |
| `oars pool deposit [--accept-covenant <version>]` | Sends every session that passes the exclusion check as a skeleton, and prints counts only. A session that fails the check, or has no raw to scan, is never built or sent. |
| `oars pool pull --harness-version <version>` | Fetches that harness version's signed bundle, verifies it against the pinned key, and keeps it at `<store>/pool-replica/<hash of server>/<version>.json`, still signed. A bundle that fails verification, or is for another version, is refused and not written. The version must be a public one; nothing is keyed by stack. |

## What the server enforces

- **Deposits are closed by default.** With no `COVENANT_VERSION` binding, every deposit gets 403 `deposits_closed`. Once one is set, an account must have accepted exactly that version, or it gets 403 `covenant_not_accepted`, and a new version asks again. Reads and `pull` are not affected.
- **Closed vocabulary.** A skeleton holding an unknown field or a value outside the vocabulary gets 422 `closed_vocabulary` with the field named, and nothing is stored. What is stored is the parsed skeleton, not the text that came in.
- **Pseudonymous accounts.** The provider's user id is hashed under `PSEUDONYM_KEY`, which the database never holds. No email, login, or provider id is stored.
- **Three accounts to a read.** A read is served only at 3 or more clusters, and a cluster is an account, so one account's many sessions count once. The floor applies to the read's aggregate: its `clusters` is the distinct accounts across all the cells it cites, so three accounts on three different days serve a read even though each day's cell holds one. A cell served on its own needs 3 accounts in that cell.
- **A fetch cap.** Every account may fetch `FETCH_CAP` bundles (default 1) per ISO week, counted per account and not per harness version. Past it the pool answers 429 `fetch_cap` with `Retry-After` in seconds to the next Monday 00:00 UTC, before it reads the pool. The count is one atomic statement, and a count from an earlier week is dropped. Access that lifts the cap for an account that has deposited is the next change.
- **A 304 spends nothing.** A 200 carries an `ETag` that names the code, the floor, the version asked for, and a generation of the pool's rows (a trigger on `deposits` moves it in the same write as a change). An `If-None-Match` that holds it gets 304 with no body, before the spend and without reading the pool, so a conditional request can neither use up a fetch nor force a parse. A weakened `W/` tag matches.
- **A deposit holds something.** A skeleton with no prompt and no tool gets 422 `closed_vocabulary` naming `transcripts`, since a deposit is what lifts the fetch cap. A forged skeleton that holds invented prompts still counts.
- **Deposits per account.** Past `MAX_DEPOSITS_PER_ACCOUNT` rows (default 20,000) a new session gets 403 `deposit_limit`, and so does any deposit that would take the account past `MAX_DEPOSIT_BYTES_PER_ACCOUNT` stored bytes (default 64 MB). A redeposit of a held session replaces it if the account still fits. Every pull parses every row, so these bound one account's share of a pull's cost. They do not bound the pool: a pull still loads every matching row across all accounts at once.
- **A frame's day is real and not ahead of the server.** A day that is not a calendar date, or is later than tomorrow UTC, gets 422 `closed_vocabulary` naming the field, since the latest day sets a bundle's `asOf`.

## Routes

| Route | Answer |
|-------|--------|
| `POST /v1/login/start`, `POST /v1/login/poll` | The device flow. |
| `GET /v1/covenant` | `{version, accepted}`. `version` is null when deposits are closed. Sign-in is optional. |
| `POST /v1/covenant/accept` | Takes `{version}`. 409 `covenant_version` for any version but the one in force. |
| `POST /v1/deposits` | Takes one skeleton, 1 MB at most. A larger one gets 413 `too_large`, unread when it declares its length. |
| `GET /bundle/:harnessVersion/:vocabVersion` | A signed bundle for one harness version: `{payload, signature}`, Ed25519 over the payload's exact bytes. It holds every family's cells and reads for that version's bucket, plus rule 3's strata cells (language, framework, repo size) counted pool-wide. 401 with no valid credential, 400 `unknown_harness_version` or `unknown_vocab_version` by name, 404 for any other path. The old `/v1/slices/:stack` route is gone. |

## Bindings

All of these are set at the deploy, never in `wrangler.jsonc`, which holds no account id, resource id, secret, route, or domain. An unset one refuses the route that needs it.

| Binding | Holds |
|---------|-------|
| `DB` | The D1 database. |
| `PSEUDONYM_KEY` | The key accounts are hashed under. Changing it makes every account new. |
| `SLICE_SIGNING_KEY` | An Ed25519 private key as a JWK. Clients pin the public half, so changing it fails their next login. |
| `GITHUB_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The OAuth values. |
| `COVENANT_VERSION` | The covenant in force. Leave it unset until the covenant is published. |
| `FETCH_CAP` | Optional. Bundles one account may fetch per ISO week; a value that is not a positive whole number is 1. |
| `MAX_DEPOSITS_PER_ACCOUNT` | Optional. Rows one account may hold. |
| `MAX_DEPOSIT_BYTES_PER_ACCOUNT` | Optional. Stored bytes one account may hold. |

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
