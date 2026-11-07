# Copy audit (t897)

Every sentence in the public text of this repository that states a fact about behavior, data, privacy, security, cost,
compatibility, or numbers, checked against the code on `main` at `e4d13bf`. Scope: `README.md`, `packages/*/README.md`,
`docs/**`, `packages/*/package.json` (description), the CLI's help text (`packages/cli/src/cli.ts`) and printed messages, the
telemetry notice (`packages/cli/src/telemetry/consent.ts`), the raw prompt (`packages/cli/src/sessions/pool-command.ts`), and
`packages/cli/CHANGELOG.md` `## Unreleased`. The repository has no NOTICE file. The field-by-field references (`docs/pool.md`
"Wire field register" and `docs/sessions-store.md` field tables) were searched for send, leave, store, and upload claims
rather than read row by row.

## Claims

| # | Location | Claim |
|---|----------|-------|
| C1 | `README.md:11` | `pool` holds commands for the Many Oars pool, `pool.manyoars.com` |
| C2 | `README.md:13`, `packages/cli/README.md:5` | `oars login` uses the built-in issuer and, until it is deployed, exits 2 naming `login.manyoars.com` |
| C3 | `README.md:17`, `packages/cli/README.md:72` | session commands make no model or network call except `gold arms` |
| C4 | `README.md:17`, `packages/cli/README.md:72` | telemetry sends to the Many Oars pool or `OARS_POOL_URL` |
| C5 | `README.md:17`, `packages/cli/README.md:72` | after covenant acceptance the nightly task sends skeletons, and raw copies only after a yes to the raw prompt |
| C6 | `README.md:17`, `packages/cli/README.md:72` | `oars pool outbox` prints all of it whenever you run it, before the next nightly send |
| C7 | `README.md:20` | `raw/` holds unredacted transcripts that stay on your machine |
| C8 | `README.md:22`, `packages/cli/README.md:162` | the uninstall steps remove everything; "Nothing else is created" |
| C9 | `packages/cli/package.json:4` | `oars sessions` uploads nothing except what `gold arms` sends |
| C10 | `packages/cli/README.md:37` | login prints "Cannot reach Many Oars sign-in at login.manyoars.com ..." and exits 2 |
| C11 | `packages/cli/README.md:47` | the platform keeps no copy of a key secret |
| C12 | `packages/cli/README.md:47` | a key expires after 90 days unless `--expires-in-days` (at most 365) |
| C13 | `packages/cli/README.md:51`, `cli.ts:165` | `keys list` never returns a secret |
| C14 | `packages/cli/README.md:56`, `docs/telemetry.md:177` | telemetry never records session content, prompt text, paths, URLs, or argument values |
| C15 | `packages/cli/README.md:56`, `docs/telemetry.md:15`, `consent.ts:9` | events are sent in batches to the Many Oars pool, `https://pool.manyoars.com` |
| C16 | `packages/cli/README.md:56`, `docs/telemetry.md:11` | the install id is random, not derived from the machine or account |
| C17 | `packages/cli/README.md:70` | `raw/` files stay on your machine; apart from `gold arms` no session command uploads them |
| C18 | `packages/cli/README.md:115` | apart from `gold arms` no session command uploads anything |
| C19 | `packages/cli/README.md:129` | the session hooks are local calls with no model and no network |
| C20 | `packages/cli/README.md:133-136` | hook budgets: under 500 ms, under 1 s, under 5 s |
| C21 | `packages/cli/README.md:138` | on Windows a fresh `node` costs 250 ms or more |
| C22 | `packages/cli/README.md:138` | a store lock older than ten minutes is broken |
| C23 | `packages/cli/README.md:154` | the nightly task is registered on Windows only, daily at 03:00 |
| C24 | `packages/cli/README.md:175` | a crossing goes nowhere; no opt-in to send one exists |
| C25 | `packages/cli/README.md:179` | `oars pool` talks to `https://pool.manyoars.com` |
| C26 | `packages/cli/README.md:182` | `oars pool deposit` sends nothing itself; with no sign-in, no acceptance, or an unreachable server the nightly sends nothing |
| C27 | `packages/cli/README.md:186` | a floor change is a pool deploy, never a new oars release |
| C28 | `packages/client/README.md:4-5` | the client adds Authorization, User-Agent, and a fresh Idempotency-Key on a mutation |
| C29 | `docs/flags.md:3`, `:7` | "Since 0.4.0" / "as of 0.4.0" nothing waits behind a flag except the consent prompts |
| C30 | `docs/flags.md:12` | the pool commands reach `https://pool.manyoars.com` |
| C31 | `docs/flags.md:27` | outbox before send, no automatic send: a batch is sent only by the hash `outbox` printed |
| C32 | `docs/flags.md:30` | the fetch cap is how a deposit buys access |
| C33 | `docs/flags.md:32` | nothing in this repository charges, buys, or sells |
| C34 | `docs/telemetry.md:9` | the spool folder never holds more than 2 MiB |
| C35 | `docs/telemetry.md:15` | with none set, the events go to the Many Oars pool |
| C36 | `docs/telemetry.md:18` | batches of at most 250, a 10 second timeout, no redirects followed; the server stores no IP address or user agent |
| C37 | `docs/telemetry.md:16` | a command sends at most once a day from a detached process; a session hook never sends |
| C38 | `docs/pool.md:3` | no session data leaves until sign-in, covenant acceptance, and a send by you or by the nightly task |
| C39 | `docs/pool.md:7` | the default pool is not deployed yet; a command that reaches it exits 8; a redirect is refused |
| C40 | `docs/sessions-store.md:186` | the store uploads nothing, and telemetry carries nothing from the store |
| C41 | `docs/gate.md:134-144` | "Measured": figures from one run over one Windows machine's harness folder |
| C42 | `docs/gate.md:148` | not in this release: pool reads, sign-in, deposit prompts, any opt-in to send a crossing |
| C43 | `cli.ts:180` | `oars sessions`: no model calls, no network, except `gold arms` |
| C44 | `cli.ts:504` | `oars pool deposit`: nothing is sent without `--send` |
| C45 | `cli.ts:574` | `oars telemetry off`: nothing more is recorded or sent |
| C46 | `pool-command.ts:762` (raw prompt) | a yes uploads a redacted copy of each full transcript of every folder you allowed |
| C47 | `pool-command.ts:763-764` (raw prompt) | redaction is local, best effort, and names what it cannot catch |
| C48 | `CHANGELOG.md:12` | `oars pool outbox` prints everything queued, before the next nightly send |
| C49 | `CHANGELOG.md:13` | one send lock per outbox, so two runs never post one batch twice |
| C50 | `CHANGELOG.md:51` | telemetry is sent now, to the Many Oars pool |
| C51 | `CHANGELOG.md:26-28` | the t902 `usageObserved` bullet appears three times |
