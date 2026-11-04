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
- **Two planes.** A deposit writes its parsed skeleton and its deltas (none yet: the wire carries none, so `[]`) to the ledger (`deposits`), and, in the same transaction, its cell increments to the index: `cells`, `motifs`, and rule 3's `strata`, each cell's `clusters` a held count. A `contributors` record per (cell or stratum, account, UTC day) tells a returning cluster from a new one, so only a new one raises a count. The ledger is meant to expire (not built yet); the index does not, and a bundle is read from the index alone (`packages/pool/src/stored.ts`: three statements whose rows grow with the cells, not with deposits). Deleting a batch's ledger rows leaves every served cell, the bundle's bytes, and its ETag as they were. A session sent again adds only the difference to its earlier batch. A batch's cells run about four times its skeleton's size, and D1 takes 2 MB in one value, so ingest binds each payload in chunks of at most 1 MB, one statement per chunk, all in the one transaction under the one guard. A cluster that returns after its record expires would be counted again; expiring a record is a later change. Two limits of the stored form stand until a later change rebuilds what they need, and tests pin them: a session sent again over a held row that no longer parses adds its whole batch a second time, since the cells keep that row's increments and there is no parsed batch to take back; and a session sent again that leaves a cell lowers its `sessions` but not its `clusters` or the account's `contributors` record, so four accounts plus one that left still read as five (one record cannot show whether another of the account's batches still holds the cell).
- **Pseudonymous accounts.** The provider's user id is hashed under `PSEUDONYM_KEY`, which the database never holds. No email, login, or provider id is stored.
- **Five accounts to a read.** A read is served only at 5 or more clusters (`K_CELL` in `packages/pool/src/derive.ts`, the spec's proposal, which a later decision may move), and a cluster is an account, so one account's many sessions count once. A cell's `clusters` is its held count of accounts, and a read's is the largest held count among the cells it cites, with no union over accounts: the fetch path reads no per-account record, so five accounts on five different days serve no read, since each day's cell holds one (a later change brings held counts for a key's `n` and `c`). A cell served on its own needs 5 accounts in that cell, and a strata cell needs 5 accounts pool-wide. A `live` read cites only the sliced day's cells, so its floor counts the clusters held on that day and never those in its seven-day baseline; the baseline takes the same floor on its own, and under it `value.baseline` and `value.ratio` are `null`.
- **A fetch cap.** An account without access may fetch `FETCH_CAP` bundles (default 1) per ISO week, counted per account and not per harness version. Past it the pool answers 429 `fetch_cap` with `Retry-After` in seconds to the next Monday 00:00 UTC, before it reads the pool. The count is one atomic statement, and a count from an earlier week is dropped. A fetch that fails after it spent gives the spend back, since the account received no bundle. An account with access is not capped.
- **Access.** The `access` record is null, `pending`, or `standing`, and only a counting batch sets it: ingested at tier committed or higher, or at `skeleton` when every transcript's harness writes no raw file (Cursor), with one prompt and one tool step over the batch, subagents folded in, and at least one cell increment written over the row held now (a batch sent again unchanged writes none); an ingest that writes none leaves the flag and the batch's date alone. It is `pending` while it rests on batches inside `ledger_days` (90), clears when every one falls to `none`, and is `standing` once one has stood the 90 days. A resend that still counts keeps a batch's first `counted_at`; one that no longer counts clears it, and the flag falls if no counting batch is left. Until a wire carries a root, ingest writes tier `skeleton` only, so a claude-code batch cannot lift the cap yet.
- **A 304 spends nothing.** A 200 carries an `ETag` that names the code, the floor, the version asked for, and a generation of the stored cells (triggers on `cells` and `strata` move it in the same write as a change; expiry on `deposits` changes no served cell and moves nothing). An `If-None-Match` that holds it gets 304 with no body, before the spend and without reading the pool, so a conditional request can neither use up a fetch nor force a read. A weakened `W/` tag matches.
- **Two deposits of one session at once.** A deposit replaces the batch the account held under its id, and nets its cells against that earlier row, so two at once would each net against the same row and add the batch twice. The upsert therefore takes the row only if it is still the one that was read (its `ingest` mark), and the other gets 409 `deposit_conflict`: nothing of it is stored, and the client sends it again, which then nets against the winner.
- **A deposit holds something.** A skeleton with no prompt and no tool gets 422 `closed_vocabulary` naming `transcripts`, since only a counting batch lifts the fetch cap (see Access). A forged skeleton that holds invented prompts passes this check, and it lifts the cap only if it names a harness that writes no raw file.
- **Deposits per account.** Past `MAX_DEPOSITS_PER_ACCOUNT` rows (default 20,000) a new session gets 403 `deposit_limit`, and so does any deposit that would take the account past `MAX_DEPOSIT_BYTES_PER_ACCOUNT` stored bytes (default 64 MB). A redeposit of a held session replaces it if the account still fits. They bound one account's ledger, not a pull: a pull reads the stored cells, never the ledger. On the test fixture (one session, one prompt, two shell steps) a batch stores 1,196 bytes of skeleton plus 2 of deltas, so the 64 MB default admits about 56,000 such batches and the 20,000-row limit binds first, at about 24 MB; its five cells are shared index rows, and its six `contributors` rows per UTC day of ingest (five cells and one stratum) sit on the ledger outside this budget; an account's distinct days and motifs add `cells` rows that every fetch then reads.
- **A frame's day is real and not ahead of the server.** A day that is not a calendar date, or is later than tomorrow UTC, gets 422 `closed_vocabulary` naming the field, since the latest day sets a bundle's `asOf`.

## Routes

| Route | Answer |
|-------|--------|
| `POST /v1/login/start`, `POST /v1/login/poll` | The device flow. |
| `GET /v1/covenant` | `{version, accepted}`. `version` is null when deposits are closed. Sign-in is optional. |
| `POST /v1/covenant/accept` | Takes `{version}`. 409 `covenant_version` for any version but the one in force. |
| `POST /v1/deposits` | Takes one skeleton, 1 MB at most. A larger one gets 413 `too_large`, unread when it declares its length. |
| `GET /bundle/:harnessVersion/:vocabVersion` | A signed bundle for one harness version: `{payload, signature}`, Ed25519 over the payload's exact bytes. The request names no family. It holds the cells for that version's bucket and the reads the pool derives today (fit without call shape, cost, change, live, adoption, method, and next-step; recovery, tool-day, and reads above order 1 are not served), plus rule 3's strata cells (language, framework, and repo size) counted pool-wide. 401 with no valid credential, 400 `unknown_harness_version` or `unknown_vocab_version` by name, 404 for any other path. The old `/v1/slices/:stack` route is gone. |

## Bindings

All of these are set at the deploy, never in `wrangler.jsonc`, which holds no account id, resource id, secret, route, or domain. An unset one refuses the route that needs it.

| Binding | Holds |
|---------|-------|
| `DB` | The D1 database. |
| `PSEUDONYM_KEY` | The key accounts are hashed under. Changing it makes every account new. |
| `BUNDLE_SIGNING_KEY` | An Ed25519 private key as a JWK. Clients pin the public half, so changing it fails their next login. |
| `GITHUB_CLIENT_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The OAuth values. |
| `COVENANT_VERSION` | The covenant in force. Leave it unset until the covenant is published. |
| `FETCH_CAP` | Optional. Bundles one account may fetch per ISO week; a value that is not a positive whole number is 1. |
| `MAX_DEPOSITS_PER_ACCOUNT` | Optional. Rows one account may hold. |
| `MAX_DEPOSIT_BYTES_PER_ACCOUNT` | Optional. Stored bytes one account may hold. |

## Tests

`packages/pool` runs the bundled handler and its D1 store under the Workers runtime through Miniflare, in-process, with a stub sign-in provider, so it needs no Docker, account, or network. `full-run.test.ts` drives the real CLI commands against it over a local socket.

## Known gaps

A live read's baseline is not traceable through lineage: the floor counts only the sliced day's cells, so the read cites those and states `value.baseline` from cells it does not cite.

## Deploy steps

Nothing has been deployed or provisioned. Each step is owed once, by the account holder, in this order:

1. Create a GitHub OAuth app with device flow enabled, and note its client id.
2. Create a Google OAuth client of type "TVs and Limited Input devices", and note its id and secret.
3. Run `wrangler d1 create oars-pool` in `packages/pool`. The config binds it by name, so commit no `database_id`.
4. Run `wrangler d1 migrations apply oars-pool --remote` in `packages/pool`.
5. Run `wrangler secret put` for `PSEUDONYM_KEY` (32 random bytes), `BUNDLE_SIGNING_KEY`, `GITHUB_CLIENT_ID`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`, and leave `COVENANT_VERSION` unset.
6. Run `wrangler deploy` in `packages/pool`, confirm it bound the database from step 3 rather than creating another, and attach the custom domain in the dashboard or with `--domain`. Only `--dry-run` has been exercised.
7. Publish the covenant, and only then run `wrangler secret put COVENANT_VERSION`, which opens deposits.
