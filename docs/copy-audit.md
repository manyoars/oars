# Copy audit (t897)

Every sentence in the public text of this repository that states a fact about behavior, data, privacy, security, cost,
compatibility, or numbers, checked against the code on `main` at `e4d13bf`. Scope: `README.md`, `packages/*/README.md`,
`docs/**`, `packages/*/package.json` (description), the CLI's help text (`packages/cli/src/cli.ts`) and printed messages, the
telemetry notice (`packages/cli/src/telemetry/consent.ts`), the raw prompt (`packages/cli/src/sessions/pool-command.ts`), and
`packages/cli/CHANGELOG.md` `## Unreleased`. The repository has no NOTICE file. The field-by-field references (`docs/pool.md`
"Wire field register" and `docs/sessions-store.md` field tables) were searched for send, leave, store, and upload claims
rather than read row by row.

## Claims

| # | Location | Claim | Evidence | Verdict |
|---|----------|-------|----------|---------|
| C1 | `README.md:11` | `pool` holds commands for the Many Oars pool, `pool.manyoars.com` | `docs/flags.md:12`: the default server; the pool is not deployed (`docs/pool.md:7`, lead 208) | false (implies a live service) |
| C2 | `README.md:13`, `packages/cli/README.md:5` | `oars login` uses the built-in issuer and, until it is deployed, exits 2 naming `login.manyoars.com` | `packages/cli/src/issuer.ts:11` (the message), `issuer.test.ts` | true |
| C3 | `README.md:17`, `packages/cli/README.md:72` | session commands make no model or network call except `gold arms` | the session commands call no model or network (`cli.ts:180` group); any interactive command can start the once-a-day detached telemetry send (`telemetry/send.ts:166`) | true as worded (telemetry is named in the same sentence) |
| C4 | `README.md:17`, `packages/cli/README.md:72` | telemetry sends to the Many Oars pool or `OARS_POOL_URL` | `telemetry/send.ts` posts to `OARS_POOL_URL`, else `https://pool.manyoars.com`; the pool is not deployed, so a send fails and the spool is kept (`docs/flags.md:18`) | false (no word that the pool is not deployed) |
| C5 | `README.md:17`, `packages/cli/README.md:72` | after covenant acceptance the nightly task sends skeletons, and raw copies only after a yes to the raw prompt | `sessions/pool-nightly.ts:46-77`: covenant read, then batches, raw only when `rawConsent === granted`; the task exists on Windows only (`install.ts:16`) | true, missing "Windows only" |
| C6 | `README.md:17`, `packages/cli/README.md:72` | `oars pool outbox` prints all of it whenever you run it, before the next nightly send | `pool-nightly.ts:55`: the nightly builds the outbox and sends it in the same run with `requireShown: false` (`:61`), so a batch built that night is never printed first | false |
| C7 | `README.md:20` | `raw/` holds unredacted transcripts that stay on your machine | `pool-raw.ts:1`, `pool-nightly.ts:68-75`: with a yes to the raw prompt, a redacted copy of each transcript is uploaded; the unredacted `raw/` file itself is not | false (a redacted copy can leave) |
| C8 | `README.md:22`, `packages/cli/README.md:162` | the uninstall steps remove everything; "Nothing else is created" | `credentials.ts:56` writes `<config>/oars/credentials.json`; telemetry writes `<config>/oars/telemetry/` (`docs/telemetry.md:9`); neither is in the steps | false |
| C9 | `packages/cli/package.json:4` | `oars sessions` uploads nothing except what `gold arms` sends | `oars sessions hook install` registers the nightly task, which sends after acceptance (`pool-nightly.ts`); telemetry sends from any command | false |
| C10 | `packages/cli/README.md:37` | login prints "Cannot reach Many Oars sign-in at login.manyoars.com ..." and exits 2 | `packages/cli/src/issuer.ts:11` | true |
| C11 | `packages/cli/README.md:47` | the platform keeps no copy of a key secret | `openapi/public.json` `IssuedDeveloperApiKeyResponse.secret`: "the platform never stores it" | true per the API contract (platform code is not in this repository) |
| C12 | `packages/cli/README.md:47` | a key expires after 90 days unless `--expires-in-days` (at most 365) | `openapi/public.json` `expiresInDays`: 1 to 365, no default stated; `commands/keys.ts:68` sends none when the flag is absent | cannot back (90 days is a platform default this repository does not hold) |
| C13 | `packages/cli/README.md:51`, `cli.ts:165` | `keys list` never returns a secret | `DeveloperApiKeyResponse` has no `secret` field (`openapi/public.json`) | true |
| C14 | `packages/cli/README.md:56`, `docs/telemetry.md:177` | telemetry never records session content, prompt text, paths, URLs, or argument values | closed schema `telemetry/schema.ts`; `schema.test.ts` feeds a home path, command text, a prompt, and a URL to every field | true |
| C15 | `packages/cli/README.md:56`, `docs/telemetry.md:15`, `consent.ts:9` | events are sent in batches to the Many Oars pool, `https://pool.manyoars.com` | as C4; `consent.ts:9` also says "and only there" | false (pool not deployed) |
| C16 | `packages/cli/README.md:56`, `docs/telemetry.md:11` | the install id is random, not derived from the machine or account | `telemetry/spool.ts:38` `randomUUID()` | true |
| C17 | `packages/cli/README.md:70` | `raw/` files stay on your machine; apart from `gold arms` no session command uploads them | as C7: the nightly task (`hook-bin.ts:31`) uploads redacted copies after a yes | false |
| C18 | `packages/cli/README.md:115` | apart from `gold arms` no session command uploads anything | true of `oars sessions` commands, but the names it lists (skills, models, tools, MCP servers) do leave in pool skeletons (`docs/pool.md` "Wire field register") | misleading as worded |
| C19 | `packages/cli/README.md:129` | the session hooks are local calls with no model and no network | `sessions/hooks.ts`, `hook-bin.ts`, `recall-push.ts`, `hook-index.ts`: no `fetch(` (grep); only the `nightly` event sends; telemetry never sends from a hook (`send.ts:1`) | true |
| C20 | `packages/cli/README.md:133-136` | hook budgets: under 500 ms, under 1 s, under 5 s | `install.ts:40-46` writes harness timeouts of 5 s, 5 s, 5 s, and 30 s; nothing in oars enforces 500 ms or 1 s | cannot back (targets, not measured or enforced) |
| C21 | `packages/cli/README.md:138` | on Windows a fresh `node` costs 250 ms or more | a timing on one machine; no test or benchmark in the repository | cannot back |
| C22 | `packages/cli/README.md:138` | a store lock older than ten minutes is broken | `sessions/store.ts:762`, `:1173`: `staleMs: 600_000` | true |
| C23 | `packages/cli/README.md:154` | the nightly task is registered on Windows only, daily at 03:00 | `install.ts:16`, `:229-231`, `SCHEDULE_HOUR = 3` (`:235`) | true |
| C24 | `packages/cli/README.md:175` | a crossing goes nowhere; no opt-in to send one exists | no `crossing` in `sessions/pool-*.ts`; `gate/` makes no request but the registry ask | true |
| C25 | `packages/cli/README.md:179` | `oars pool` talks to `https://pool.manyoars.com` | as C1 | false (implies a live service) |
| C26 | `packages/cli/README.md:182` | `oars pool deposit` sends nothing itself; with no sign-in, no acceptance, or an unreachable server the nightly sends nothing | `pool-command.ts:469` (deposit makes no request without `--send`), `pool-nightly.ts:38-50` | true |
| C27 | `packages/cli/README.md:186` | a floor change is a pool deploy, never a new oars release | `pool/src/floors.ts` reads `PUBLIC_FLOOR` and `DISCLOSURE_FLOOR` bindings; `pool fetch` prints the bundle's floors | true |
| C28 | `packages/client/README.md:4-5` | the client adds Authorization, User-Agent, and a fresh Idempotency-Key on a mutation | `packages/client/src/client.ts:12`: no Authorization header when no token is given | false ("every call") |
| C29 | `docs/flags.md:3`, `:5` | "Since 0.4.0" / "as of 0.4.0" nothing waits behind a flag except the consent prompts | `packages/cli/package.json` version 0.3.0; 0.4.0 is not released | false (names an unreleased version as current) |
| C30 | `docs/flags.md:12` | the pool commands reach `https://pool.manyoars.com` | as C1 | false (implies a live service) |
| C31 | `docs/flags.md:28` | outbox before send, no automatic send: a batch is sent only by the hash `outbox` printed | `pool-nightly.ts:61` sends with `requireShown: false`: the nightly sends without a print | false |
| C32 | `docs/flags.md:30` | the fetch cap is how a deposit buys access | `pool/src/bundle.ts:77-79`: an account with access has no cap; "A deposit that counts lifts the cap"; no money changes hands | false wording (no buying exists) |
| C33 | `docs/flags.md:32` | nothing in this repository charges, buys, or sells | no payment, price, or checkout code in `packages/` (grep: none) | true |
| C34 | `docs/telemetry.md:9` | the spool folder never holds more than 2 MiB | `spool.ts:9`, `:62`: each spool file stays under 1 MiB, but the folder also holds `install-id`, `settings.json`, and `last-send` | false (the cap is on the two spool files) |
| C35 | `docs/telemetry.md:15` | with none set, the events go to the Many Oars pool | as C4 | false (pool not deployed) |
| C36 | `docs/telemetry.md:18` | batches of at most 250, a 10 second timeout, no redirects followed; the server stores no IP address or user agent | `send.ts:18`, `:21`, `:73`; `pool/src/telemetry.ts:118` keeps `{received, account?, batch}` only | true |
| C37 | `docs/telemetry.md:16` | a command sends at most once a day from a detached process; a session hook never sends | `send.ts:1`, `:122`, `:166` | true |
| C38 | `docs/pool.md:3` | no session data leaves until sign-in, covenant acceptance, and a send by you or by the nightly task | `pool-nightly.ts`, `pool-command.ts:435-446` | true |
| C39 | `docs/pool.md:7` | the default pool is not deployed yet; a command that reaches it exits 8; a redirect is refused | `errors.ts:91` (unreachable is exit 8), `pool-command.ts:188` `redirect: 'error'` | true |
| C40 | `docs/sessions-store.md:186` | the store uploads nothing, and telemetry carries nothing from the store | `store-health` carries counts and sizes of the store (`docs/telemetry.md` "store-health"); the pool commands and the nightly send skeletons built from it | false |
| C41 | `docs/gate.md:134-144` | "Measured": figures from one run over one Windows machine's harness folder | figures from one person's machine; not reproducible from the repository | cannot back |
| C42 | `docs/gate.md:148` | not in this release: pool reads, sign-in, deposit prompts, any opt-in to send a crossing | `oars pool login` and the pool reads exist (`cli.ts:488`); what the section means is that the gate has none | false as worded |
| C43 | `cli.ts:180` | `oars sessions`: no model calls, no network, except `gold arms` | as C3; the help line does not name telemetry | misleading (no word of telemetry) |
| C44 | `cli.ts:504` | `oars pool deposit`: nothing is sent without `--send` | `pool-command.ts:469` | true |
| C45 | `cli.ts:574` | `oars telemetry off`: nothing more is recorded or sent | `consent.ts:77-79` `telemetrySendAllowed` requires enabled | true |
| C46 | `pool-command.ts:762` (raw prompt) | a yes uploads a redacted copy of each full transcript of every folder you allowed | `pool-choices.ts:15`: a folder at `skeleton` or `off` sends no raw copy; the upload is the nightly task's, after covenant acceptance | false (omits the folder switch and when it happens) |
| C47 | `pool-command.ts:763-764` (raw prompt) | redaction is local, best effort, and names what it cannot catch | `sessions/redact.ts`, `sessions/injected.ts`, `redact-raw.test.ts`, `injected.test.ts` | false: the prompt does not name the injected-block limit |
| C48 | `CHANGELOG.md:12` | `oars pool outbox` prints everything queued, before the next nightly send | as C6 | false |
| C49 | `CHANGELOG.md:13` | one send lock per outbox, so two runs never post one batch twice | t884 report residual: two waiters that clear a dead guard at once can both take over | cannot back ("never") |
| C50 | `CHANGELOG.md:51` | telemetry is sent now, to the Many Oars pool | as C4 | false (pool not deployed) |
| C51 | `CHANGELOG.md:26-28` | the t902 `usageObserved` bullet appears three times | `CHANGELOG.md:26-28`: each line is a prefix of the next (a union-merge leftover) | false (duplicate entry) |
| C52 | `pool-command.ts:783` (`oars pool raw`) | a folder switched off: "nothing leaves" | `pool-choices.ts`: the switch stops pool sends from that folder; telemetry is not per folder | false as worded |
| C53 | `docs/pool.md:3` | `oars pool outbox` prints everything queued whenever you run it, before the next nightly send | as C6: the nightly run builds and sends in one pass with `requireShown: false` (`pool-nightly.ts:56-61`) | false (fixed) |
| C54 | `docs/pool.md:3` | telemetry events are sent to the Many Oars pool, or `OARS_POOL_URL` | as C4: the default pool is not deployed | false (fixed) |
| C55 | `telemetry/command.ts:43` (`oars telemetry status`) | events are sent to the Many Oars pool or `OARS_POOL_URL` | as C4/C15: the default pool is not deployed | false (fixed; pinned at `telemetry/run.test.ts:167`) |
| C56 | `cli.ts:393` (`sessions hook install`) | install merges the SessionStart, PostToolUseFailure, and SessionEnd hooks | `sessions/install.ts:40-46` writes five hooks as of the merge with main (PreToolUse and UserPromptSubmit too) and, on Windows, registers the nightly task, which sends | false (fixed; pinned in `help.test.ts`) |
| C57 | `cli.ts:488` (`oars pool`) | the group deposits session skeletons only | after a yes to the raw prompt, `deposit` also queues redacted raw copies | misleading (fixed; pinned) |
| C58 | `cli.ts:184` (`sessions deposit`) | each raw transcript is hard-linked | the store keeps a hard link or a copy (`README.md:20`, `:70`) | false as worded (fixed; pinned) |
| C59 | `packages/cli/README.md:115` | the names that leave in pool skeletons are skill, model, harness version, tool, and MCP server names | the wire also carries effort, a shell call's program, subcommand, and flag names, tool-input key names, a pulled package's name (its version only when `PUBLIC_PACKAGES` holds the name), and a web host sent after redaction (`sessions/pool-wire.ts:378-380` `wirePull`, `:396` host, `:746`, `:753`, `:928`; `CHANGELOG.md:16`, `:21`, `:24`; the pool hashes a host on arrival, `docs/pool.md` Wire field register) | misleading (understates; fixed) |
| C60 | `CHANGELOG.md:16` (t903 bullet) | the names leave only through `pool deposit`'s gate, and `pool outbox` prints every byte | the nightly task sends batches it built in the same run without printing them (as C6) | false (fixed) |
| C61 | `CHANGELOG.md:52` (format 3 bullet) | "Nothing is sent" | the same release ships the nightly send | false (cut) |
| C62 | `docs/gate.md:134` | the `## Measured` heading and its note about removed figures | the section holds no measurement; the note describes text that is gone | misleading (heading renamed, note cut) |
| C63 | `packages/pool/package.json:5` | the pool takes session skeletons only | it also takes raw copies (`/v1/raw`) and telemetry (`/v1/telemetry`) | false as worded (fixed) |
| C64 | `README.md:11`, `:17`, `packages/cli/README.md:3`, `:68`, `:70`, `cli.ts:106` | `oars sessions` keeps a record of your own Claude Code sessions | it reads Claude Code, Cursor, Codex, Copilot CLI, Gemini CLI, Grok Build, OpenCode, Pi, VS Code Copilot Chat, and OpenTelemetry GenAI traces (`cli.ts:184`) | misleading (understates; fixed) |
| C65 | `packages/cli/CHANGELOG.md:25` | `outbox` still prints every byte that would leave, hosts included | as C53: the nightly task sends batches it built that run without printing them (`pool-nightly.ts:61` `requireShown: false`) | false (fixed) |
| C66 | `cli.ts:393` (`sessions hook install`) | the nightly task "sends to the pool after you accept its covenant" | the nightly run also sends telemetry with no covenant (`hook-bin.ts:49-51`, `hooks.ts` `nightlyTelemetry`) | misleading (leaves out telemetry; fixed; pinned at `help.test.ts`) |
| C67 | `cli.ts:518` (`pool raw --mode`) | off "sends nothing from now on" | telemetry keeps sending from a folder set to off; the mode governs what goes to the pool (as C52) | misleading (fixed; pinned at `help.test.ts`) |
| C68 | `pool-command.ts:765`, `:782` (raw prompt and `pool raw` output) | "only skeletons leave" | telemetry keeps sending beside skeletons | misleading (fixed to "only skeletons go to the pool"; pinned at `pool-command.test.ts`) |
| C69 | `README.md:20`, `packages/cli/README.md:70` | after a yes to the raw prompt, the nightly task uploads a redacted copy of each | needs covenant acceptance (`pool-nightly.ts`) and skips a folder set to skeleton only or off (C52) | misleading (omits two conditions; fixed) |

## Changes

Every claim marked false, misleading, or cannot back above was rewritten to what the code does, or cut. "Not deployed yet" is
stated wherever the default pool or `login.manyoars.com` is named as a destination (lead 208).

| Claims | Change |
|--------|--------|
| C1, C25, C30 | the pool is named as the default destination, "which is not deployed yet", with the exit code a request gets |
| C4, C15, C35, C50 | telemetry "sends to the pool server in `OARS_POOL_URL`, else to the Many Oars pool ... not deployed yet, so a send fails and the events stay in the spool" |
| C5 | "the nightly task (registered on Windows only)" |
| C6, C31, C48 | the outbox prints what is queued; the nightly task builds and sends new batches in the same run without printing them first |
| C7, C17 | the unredacted `raw/` files stay; after a yes to the raw prompt the nightly task uploads a redacted copy of each |
| C8 | the uninstall steps add `<config>/oars/telemetry/` and `<config>/oars/credentials.json`; "Nothing else is created" is cut |
| C12 | the 90-day default is cut: `--expires-in-days` takes 1 to 365, else the platform sets the expiry, shown by `keys list` |
| C18 | scoped to `oars sessions` commands, and names the fields that leave in pool skeletons |
| C20 | the "Budget" column is now the timeout install writes (5 s, 5 s, 5 s, 30 s) |
| C21 | the 250 ms figure is cut |
| C28 | "up to three headers": Authorization only when a token is given |
| C29 | "on `main` after 0.3.0 (not yet in a release)" |
| C32 | "a deposit that counts gives the account access, and an account with access has no fetch cap" |
| C34 | "the two spool files together hold at most 2 MiB" |
| C40 | the store makes no network call; `oars pool` and the nightly task send what is built from it; telemetry carries counts and sizes |
| C41 | the one-machine figures are cut; the three code behaviors the reading led to stay |
| C42 | the section is "What the gate does not do": no pool read, no sign-in, no way to send a crossing |
| C49 | "wait for each other instead of posting one batch twice", with the one case t884 left open |
| C51 | the two shorter copies of the t902 bullet are removed |
| C9 | package description: the session commands upload nothing but `gold arms`; telemetry and the nightly pool send are named |
| C15 (notice) | `consent.ts:9`: "oars sends the events ... else to the Many Oars pool (pool.manyoars.com, not deployed yet ...)" |
| C43 | `cli.ts:180`: "these commands make no model call and no network call, except `gold arms` ...; telemetry is separate" |
| C46 | raw prompt: the nightly task uploads, after covenant acceptance, except a folder at skeleton only or off |
| C52 | "nothing sent to the pool"; `pool-command.test.ts` updated |
| C53 | `docs/pool.md:3`: "`oars pool outbox` prints what is queued when you run it, but the nightly task builds new batches and sends them in the same run without printing them first" |
| C54 | `docs/pool.md:3`: telemetry "sends those events to the pool server in `OARS_POOL_URL`, else to the Many Oars pool, which is not deployed yet ..." |
| C55 | `oars telemetry status` prints the C15 wording: "pool server in OARS_POOL_URL, else to the Many Oars pool (pool.manyoars.com, not deployed yet ...)"; pin updated |
| C56 | `cli.ts:393`: "merge the SessionStart, UserPromptSubmit, PreToolUse, PostToolUseFailure, and SessionEnd hooks ..., and on Windows register the nightly task (which sends to the pool after you accept its covenant)", reworded in C66 |
| C57 | `cli.ts:488`: "... and, after a yes to the raw prompt, redacted raw copies" |
| C58 | `cli.ts:184`: "hard-linked or copied" |
| C59 | `packages/cli/README.md:115` lists every name class the wire carries, including a pulled package's name and a web host (fix round 2) |
| C60 | `CHANGELOG.md:16`: "... only in pool batches built through `pool deposit`'s one gate ..., sent by `deposit --send` or the nightly task, and `pool outbox` prints what is queued when you run it" |
| C61 | `CHANGELOG.md:52`: "Nothing is sent: " cut |
| C62 | `docs/gate.md`: heading "What a reading of real transcripts changed", the removed-figures sentence cut |
| C63 | `packages/pool/package.json`: "takes closed-vocabulary session skeletons, redacted raw copies, and CLI telemetry, and serves signed reads" |
| C64 | the sentences say "coding-agent sessions", with the harness names where one lists them |
| C65 | `packages/cli/CHANGELOG.md:25`: "`oars pool outbox` prints what is queued when you run it, hosts included; the nightly task sends the batches it builds that run without printing them first" |
| C66 | `cli.ts:393`: "which sends telemetry while telemetry is on, and pool batches only after you accept a pool covenant"; `help.test.ts` pins it (red first: 3 failed, 179 passed across `help.test.ts` and `pool-command.test.ts` against the old text) |
| C67 | `cli.ts:518`: "off sends nothing from that folder to the pool from now on"; pinned in `help.test.ts` |
| C68 | "only skeletons go to the pool" in the raw prompt and the `pool raw` output; pinned in `pool-command.test.ts`; the module comment at `pool-command.ts:1` also names the nightly send (a comment, no row) |
| C69 | the raw-upload sentence carries the raw yes, covenant acceptance, and the skeleton-only/off exception |
