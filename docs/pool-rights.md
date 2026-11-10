# Pool rights: the operator's runbooks

This file tells the operator how a written request about the pool becomes commands, and what to send back. It uses only commands that exist. Where a right has no command, the section says so on a line that starts "Gap".

What each right reaches, and the reasons, are in [`pool.md`](pool.md) ("Rights and what answers them", "Erasure"). The rules are the covenant's Sections 6.1 to 6.6 and Articles 12 and 15 to 21 of the GDPR and the UK GDPR, read as written.

## Before any request

- **Run the migrations first.** The erase and close commands need every migration through the newest one applied on the live pool. Check before the first request, not during one.
- **Where requests arrive.** `privacy@manyoars.com` only (covenant 6.1, 6.3, 6.6). A request anywhere else is forwarded there and answered from there.
- **Run the erase commands from the repository root** with your own `wrangler` login: `npm run erase -w packages/pool -- <what> ...`. Every erase command is a dry run until you add `--confirm`, and says what it would do. `--local` points it at local state, for rehearsal. Never rehearse against the remote pool.
- **Keep a request register,** outside the repository, because it holds personal data. One entry per request: the date received, the right, the account, the proof used, any extension and its reason with the date you told them, the answer and its date, and for an Art. 16 request any supplementary statement. Art. 5(2) needs you able to show you met each clock, and the pool keeps no request log.
- **Erase needs R2 keys.** `erase ... account` lists the telemetry bucket, so export `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` first.

## The clock (Article 12(3)), for every right

- The month starts the day the email arrives. Write the date in your record that day.
- Send an acknowledgement at once (good practice; the covenant sets 30 days only for a complaint, 6.6(h)).
- Answer within one month. For a complex request you may extend by two more months, but you must tell the requester inside the first month, with the reason.
- If you will not act, tell the requester within the month why, and that they may complain to a supervisory authority or go to court (covenant 6.6(f)).
- Charge nothing unless the request is manifestly unfounded or excessive.

## Who is asking: confirming the account

The pool holds no email address and no name. An account id is a hash of the sign-in provider's subject (`docs/pool.md`, "Pseudonymous accounts"). So the email's sender proves nothing about the account.

What the pool does have is a proof of control: a sign-in the requester makes with their provider, which the pool stores as a time on the account (`accounts.proved_at`). The account id is derived from the provider's account, so only the person who can sign in to it can make that proof. Use it:

1. Reply to the request asking them to run `oars pool prove --json` and to send back the `account` and `provedAt` it prints. If the account is closed, they run `oars pool login --provider github --json` (or `google`) instead: the sign-in is refused with 403 `account_closed`, and the refusal prints the same two values. Note the date you asked.
2. Read the stored time, read-only, from `packages/pool` (this reads production, so only for a live request):
   `npx wrangler d1 execute oars-pool --remote --command "SELECT id, closed_at, proved_at FROM accounts WHERE id = '<account id>'"`
3. `proved_at` must equal the `provedAt` they sent, and fall after your request for proof. If it is older, or no longer equals the row, ask them to run it again.
4. If it matches, go on. If not, write back, say what could not be matched, and do not act. The month keeps running.

A machine key is no proof: `oars pool prove` uses the sign-in only, and the pool refuses a key on the route (403 `deposit_only`), because a key may sit on a host and not with the person (Art. 32).

Rules for how hard to ask:

- For **erasure and closing**, do steps 1 to 3 whenever the requester asks the operator to act. They cannot be undone. The export (access and portability) runs only on the account's own sign-in, so it needs no check.
- For a **protected person** (the GDPR or UK GDPR protects them), covenant 6.6(f) says to ask for proof of identity only when you have reasonable doubts. The pool holds no name or email, so an email alone always leaves reasonable doubt (Art. 12(6)), and covenant 6.3 allows requiring a fresh sign-in. A matching `provedAt` from one is that proof.
- If the requester says they cannot sign in, ask them to run `oars pool login --provider github` (or `google`) and then `oars pool prove --json` first: it needs only their provider sign-in, not the account's machines. If they have no provider sign-in at all, you cannot confirm them. A machine key is no proof: it may sit on a host, not with the person. The pool holds no name or email, and the account id is derived from the sign-in provider's account, so nothing else proves the account is theirs (Art. 11(2) and 12(2)). Tell them so, in writing, within the month. Do not erase, close, or send data on an email alone.
- A request from someone other than the account holder (a third party named in a deposit) is a different case. See "A third party named in a deposit" at the end.

## Art. 15, access, and Art. 20, portability

**Arrives:** an email asking for a copy of their data, or for it in a machine-readable form.

**Command (the requester runs it):** `oars pool export --out <folder>`, and `--raw` to include their raw copies. It signs in with their own credential (`GET /v1/account/export`), writes JSON one file a page, and writes nothing to the pool. Tell them the folder holds the account row, token expiry times, covenant acceptances, machines, repository keys, deposit hours, telemetry day counts, the raw ledger, staged deposit parts, erasure audit rows, and deposit rows as they now read.

**Steps:**
1. Nothing to confirm: the export runs only on their own sign-in.
2. Reply with the one command, and the folder it will fill. Tell them an erased raw object is not in the copy.
3. Tell them what is not in it, and why: `contributors`, pooled cells, strata, and bundle reads tie the account to totals over other people (Art. 15(4)), and credential hashes are withheld (Art. 32).
4. When they report the files are saved, the answer is complete. If the command fails, send the error line back and retry once the cause is fixed.

**Answer to send:** the one command, the list of what the copy holds and leaves out, and the date.

**Record kept:** the dates, which right, how the account was confirmed, and the date answered. The export itself is not kept by the operator: it never passes through you.

Gap: **the operator cannot produce the copy.** The export runs only on the account's own sign-in. A requester who cannot sign in cannot be served; say so. Not yet possible.

Gap: **recipients.** Covenant 6.6(e) promises to name recipients on request (Art. 15(1)(c)). The pool keeps no register of who fetched which bundle, so you cannot name them. Not yet possible. Say that nothing is sold today ([`flags.md`](flags.md)) and that a bundle holds no account.

## Art. 16, rectification

**Arrives:** an email saying a record about them is wrong.

A deposit row is the record of what the client sent, so it is accurate as that record; the ledger never changes content, and there is no edit command. Art. 16 corrects data that are inaccurate for their purpose, so you answer it in one of these ways, and only if the requester asks:
- They show a row is not theirs or not what was sent: restrict the account while you check (`erase restrict`, Art. 18(1)(a); see "Art. 18, restriction" below), then erase the row (`erase row`, Art. 17 below).
- A wrong machine label: they revoke the machine and enroll it again with the right label (`oars pool machines revoke <id>`, then `oars pool enroll ...`).
- A statement they want kept beside a record (Art. 16, second sentence): keep it in the request register, with the date.

**Answer to send:** say a deposit records what the client sent and so is not changed in place, name the options above that apply, and say what each does. If you decline, say why within the month (Art. 12(4)).

**Record kept:** dates, the request, and the answer.

## Art. 17, erasure

**Arrives:** an email asking for their data to be deleted. A protected person need not name a law (covenant 6.3, 6.6(c)).

**Steps:**
1. Confirm the account (above).
2. Tell the requester what an erasure leaves, from covenant 6.4 and 6.6(d), before you run it: the shared totals already built, the sign-in and acceptance records, each Deposit's anonymous shape (closed lists, buckets, listed names, step order, days cut to the week's Monday), the tombstone, and the hash, size, and date of what was erased. Tell them it does not stop new deposits, and that they should run `oars pool logout` on every machine and close the account if they want no more (see "Closing an account").
3. Dry run:
   `npm run erase -w packages/pool -- account --account <id>`
4. Read the line it prints. If it names the right account, run it:
   `npm run erase -w packages/pool -- account --account <id> --confirm`
   It prints `{"rowsErased":n,"objectsErased":n}`.
5. The same run rewrites the telemetry batches kept within the 90-day retention that name the account. If the run stops partway, run step 4 again: it is safe to repeat and finishes the rest.
6. One deposit only, or one raw object only, if that is all they asked for:
   `npm run erase -w packages/pool -- row --account <id> --id <session>`, and `npm run erase -w packages/pool -- raw <r2-key>`. Each is a dry run until `--confirm`. Both are for narrower cases; the usual answer is `account`.

**Answer to send:** the counts it printed, the date, the list of what stays (covenant 6.4, 6.6(d)), that a copy already sold or served cannot be recalled (covenant 6.6(e)), the copies below, and the completion date: three months after the run.

**Record kept:** the pool keeps the tombstone and one audit row (`erasure_audit`, kind and reason, the date, the counts). You keep the request dates, the proof used, and the printed counts.

**Copies.** The erasure is complete at the latest copy, three months after the run (the Analytics Engine retention). D1 Time Travel keeps point-in-time copies for 30 days at most (7 days on Workers Free), and a restore inside that window brings the erased rows back, so rerun step 4 after any restore. R2 objects are single copies: no versioning or replication is set.

Gap: **unconfirmed copies.** Whether the account's dashboard holds any R2 setting beyond those in the repository, and Cloudflare's own backups of R2 or D1 beyond Time Travel, are not confirmed. Say so to the requester until someone checks.

Gap: **bundles and client copies.** A bundle already served and a client's `<store>/pool-replica` copy are not recalled. The generation moves, so clients fetch a new bundle.

Gap: **the person's own machine.** No command deletes the local store (`raw/`, `state.json`, the outbox). It is theirs; tell them to delete it.

Gap: **Art. 19, telling recipients.** Covenant 6.6(e) promises to tell each recipient. The pool has no register of recipients. Not yet possible.

## Art. 18, restriction

**Arrives:** an email asking you to stop using their data while a dispute about it is settled.

**Steps:**
1. Confirm the account (see "Who is asking").
2. Dry run: `npm run erase -w packages/pool -- restrict --account <id>`. Read the line it prints, then add `--confirm`. The command sets `accounts.restricted_at`, writes one `erasure_audit` row (kind `restrict`), and revokes and deletes nothing. A rerun changes nothing. Restrict on request on any Art. 18(1) ground, and while you weigh an objection (18(1)(d)).
3. Tell them what stops and what stays (below).
4. Before you lift it (`restrict --account <id> --lift --confirm`), tell the requester (Art. 18(3)). Lifting restores the account whole: no credential was revoked.

What stops while it is set: later deposits and raw parts are refused (403 `account_restricted`, a machine key's too), and its records no longer count toward shared cells or the telemetry rollup (a cell's count catches up at the next deposit that touches it). Telemetry batches carry no account, so the telemetry route cannot refuse them. What stays: the data stored, the account's own export (Art. 15), an erasure if they ask (Art. 17), the withdrawal sweep, and the retention sweeps, because each is the person's own request or a deletion, which Art. 18(2) does not stop.

The nearest steps, for a person who wants only to stop sending, with their agreement:
- On their machine: `oars pool raw --folder <entry> --mode off`, or `oars sessions deposit --deny <folder>`, or `oars sessions hook install --schedule off`. These stop later sends only.

**Answer to send:** what stops and what stays, in those words, and that you will tell them before you lift it.

**Record kept:** dates, the request and its ground, the steps taken, and the date you lifted it.

## Art. 21, objection

**Arrives:** an email objecting to the pool processing their data, or its use for training or sale.

Covenant 6.6(a): you must stop the processing unless you show compelling grounds, or need it for a legal claim. The decision is yours; write it down.

**Steps:**
1. Confirm the account.
2. While you weigh the grounds, restrict the account (`erase restrict`, Art. 18(1)(d); see above). If you accept: erase the account (`erase account`, Art. 17 above), whose unlink of the kept rows covenant 6.6(c) allows in place of deletion; close the account too if they want no more arriving (below). Closing deletes their credentials; erasing removes their contributor records.
3. For telemetry only: they run `oars telemetry off`, or set `OARS_TELEMETRY=0`.
4. If you do not accept, tell them the grounds within the month, with the complaint right.

**Answer to send:** what you did, and what still stands.

**Record kept:** the decision and the grounds, with dates.

Nothing is sold and no path hands deposits to anyone, so an objection to sale or training has nothing to exclude from yet. Record it in the register, scope included; the first sale path loads those records.

## Art. 7(3), withdrawing raw consent

**Arrives:** an email saying they withdraw their yes to raw copies.

**Command (the requester runs it):** `oars pool raw --consent no`. It stops later raw copies on their machine and tells the pool (`DELETE /v1/consent/raw`), which drops their staged raw parts at once. The pool erases the raw objects it already holds, whole, on its nightly run; a large account can take more than one night. Each erased object keeps a tombstone, and the hash, size, and date stay.

**Steps:**
1. Confirm the account.
2. Reply with the one command. If it prints that the pool was not told, they sign in again with `oars pool login` and rerun it.
3. Check the withdrawal landed, read-only, from `packages/pool`:
   `npx wrangler d1 execute oars-pool --remote --command "SELECT raw_consent_withdrawn_at FROM accounts WHERE id = '<account id>'"`
   A number means the pool has it.
4. A few days later, check the raw objects are gone the same way (`raw_objects` rows with `erased_on` set). If objects remain after several nights, erase them by key (`raw/<account>/<sha256>`, from the row's `account` and `sha256`; `packages/pool/scripts/erase-cli.ts:10`). Dry run: `npm run erase -w packages/pool -- raw <r2-key>`. Read the line it prints, then add `--confirm`.

**Answer to send:** the date the withdrawal landed, that earlier processing is not affected (Art. 7(3)), and that a copy already sold or served is not recalled.

**Record kept:** the pool keeps `raw_consent_withdrawn_at` and the covenant version it answered. You keep the dates.

Gap: **the operator cannot withdraw for them.** Only the account's own credential sends the withdrawal. A requester who cannot sign in cannot be confirmed (see "Who is asking"), so do not erase for them. Not yet possible. For a confirmed requester whose objects remain, step 4 erases them by key; that does not set the withdrawal.

Gap: **withdrawing the covenant.** Acceptance rows are append-only. Declining a later version stops later deposits. Not yet possible beyond that.

## Closing an account (covenant 6.1)

**Arrives:** an email asking to close the account. This is open to anyone, not only protected persons.

**Steps:**
1. Confirm the account.
2. Before you close, ask whether they also want an export or an erasure: once closed, the account cannot sign in, so `oars pool export` cannot run for them. Do those first. A later request about a closed account can still be confirmed (see the answer below).
3. Dry run:
   `npm run erase -w packages/pool -- close --account <id>`
4. Read the line it prints. If it names the right account, run it:
   `npm run erase -w packages/pool -- close --account <id> --confirm`
   It prints `{"rowsChanged":n}`.
5. It revokes every token and every machine key, and from then on sign-in, machine enrollment, and activation answer 403 `account_closed`. A rerun changes nothing.

A close erases nothing. If they also want their data deleted, that is a separate Art. 17 request.

**Answer to send:** the date it closed, that no machine of theirs can deposit now, that their data stays, that a later request about it can still be confirmed: they sign in once with `oars pool login --provider github --json` (or `google`), which the pool refuses and records as proof of control (see "Who is asking"), and that reopening is done by hand on a written request.

**Record kept:** the pool sets `accounts.closed_at`, which starts the retention clock in covenant 7.2(a), and writes one audit row. You keep the dates.

**Reopening** (no article requires it; covenant 6.1 is contract). Confirm the requester as in "Who is asking", then, from `packages/pool`:
`npx wrangler d1 execute oars-pool --remote --command "UPDATE accounts SET closed_at = NULL WHERE id = '<account id>' AND closed_at IS NOT NULL"`
Tokens and machine keys stay revoked, so the person signs in and enrolls their machines again. Note it in the request register.

**Requests after closing.** The proof from `oars pool login --provider github --json` (or `google`) confirms the requester. Then run `erase account` (Art. 17). The operator cannot yet export a closed account's data or record its raw withdrawal; those commands are not written.

## A third party named in a deposit

**Arrives:** an email from someone who is not an account holder, saying a deposit names them.

You cannot confirm them against an account, so confirm the claim instead: find the text.

1. Put the text on stdin, never as an argument, so it stays out of the process list and shell history:
   `npm run erase -w packages/pool -- raw --contains --value-stdin --all-accounts` (eight characters at least)
2. It prints each matching key, account, and size, and changes nothing.
3. Erase each key you accept. Dry run: `npm run erase -w packages/pool -- raw <r2-key>`. Read the line it prints, then add `--confirm`.
4. Deposit rows (until the deposit find ships): put the text, and its JSON-escaped form, in a temporary SQL file of `SELECT account, id FROM deposits WHERE instr(skeleton, '<text>') > 0 OR instr(extensions, '<text>') > 0`-style reads over `deposits`, `motifs`, `cells`, and `contributors`. Run it with `npx wrangler d1 execute oars-pool --remote --file <file>` from `packages/pool` (this reads production, so only for a live request), then delete the file. `eraseLeakedSecret`'s search in `scripts/erase.ts` has the exact statements.
5. Deposit skeletons, motifs, cells, and contributors that hold the text. Dry run, text on stdin: `npm run erase -w packages/pool -- row --account <id> --id <session> --value-stdin`. Read the line it prints, then add `--confirm`. That scrubs the text from every place it appears, for every account, and cannot be undone. Later deposits holding the exact text are refused.
   The account is the one in the raw key or the deposit read. With no known session, the dry run shows "no such row: only the value would be erased".

Gap: **parts of a raw object still uploading are not searched**, and redaction can miss a name written in prose.

**Answer to send:** what you found and erased, or that you found nothing, within the month.

**Record kept:** dates, and the keys erased. Do not keep the text you searched for.
