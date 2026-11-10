# Pool rights: the operator's runbooks

This file tells the operator how a written request about the pool becomes commands, and what to send back. It uses only commands that exist. Where a right has no command, the section says so on a line that starts "Gap".

What each right reaches, and the reasons, are in [`pool.md`](pool.md) ("Rights and what answers them", "Erasure"). The rules are the covenant's Sections 6.1 to 6.6 and Articles 12 and 15 to 21 of the GDPR and the UK GDPR, read as written.

## Before any request

- **Run the migrations first.** The erase and close commands need every migration through the newest one applied on the live pool. Check before the first request, not during one.
- **Where requests arrive.** `privacy@manyoars.com` only (covenant 6.1, 6.3, 6.6). A request anywhere else is forwarded there and answered from there.
- **Run the erase commands from the repository root** with your own `wrangler` login: `npm run erase -w packages/pool -- <what> ...`. Every erase command is a dry run until you add `--confirm`, and says what it would do. `--local` points it at local state, for rehearsal. Never rehearse against the remote pool.
- **Erase needs R2 keys.** `erase ... account` lists the telemetry bucket, so export `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` first.

## The clock (Article 12(3)), for every right

- The month starts the day the email arrives. Write the date in your record that day.
- Send an acknowledgement at once (good practice; the covenant sets 30 days only for a complaint, 6.6(h)).
- Answer within one month. For a complex request you may extend by two more months, but you must tell the requester inside the first month, with the reason.
- If you will not act, tell the requester within the month why, and that they may complain to a supervisory authority or go to court (covenant 6.6(f)).
- Charge nothing unless the request is manifestly unfounded or excessive.

## Who is asking: confirming the account

The pool holds no email address and no name. An account id is a hash of the sign-in provider's subject (`docs/pool.md`, "Pseudonymous accounts"). So the email's sender proves nothing about the account.

What the pool does have: the account id, the machines enrolled under it (label and id), and the provider sign-in. Use them together:

1. Ask the requester to run `oars pool login --provider github` (or `google`) on their machine. It prints `Signed in to <server> as <account id>`. Ask them to rerun it with `--json` and send you the account id and the `expiresAt` it prints.
2. Ask them to run `oars pool machines` and send one machine's label and id, or the last deposit day it shows. Only someone signed in to the account sees these.
3. Check both against the pool, read-only, from `packages/pool` (this reads production, so only for a live request):
   `npx wrangler d1 execute oars-pool --remote --command "SELECT id, closed_at, raw_consent_withdrawn_at FROM accounts WHERE id = '<account id>'"`
   and the same against `machines` (`id`, `label`, `account`, `last_deposit_day`). Then check the sign-in is fresh:
   `npx wrangler d1 execute oars-pool --remote --command "SELECT expires_at FROM tokens WHERE account = '<account id>'"`
   One row must hold exactly the `expiresAt` the requester sent, issued after the date of the email.
4. If both match, go on. If not, write back, say what could not be matched, and do not act. The month keeps running.

Rules for how hard to ask:

- For **erasure and closing**, do steps 1 to 3 whenever the requester asks the operator to act. They cannot be undone. The export (access and portability) runs only on the account's own sign-in, so it needs no check.
- For a **protected person** (the GDPR or UK GDPR protects them), covenant 6.6(f) says to ask for proof of identity only when you have reasonable doubts. The pool holds no name or email, so an email alone always leaves reasonable doubt (Art. 12(6)), and covenant 6.3 allows requiring a fresh sign-in. A matching `expiresAt` from one is that proof.
- If the requester says they cannot sign in (they lost the provider account), you cannot confirm them. Say so in writing. Do not erase, close, or send data on an email alone.
- A request from someone other than the account holder (a third party named in a deposit) is a different case. See "A third party named in a deposit" at the end.

Gap: no command issues a challenge or checks an id. The check above is by hand.

## Art. 15, access, and Art. 20, portability

**Arrives:** an email asking for a copy of their data, or for it in a machine-readable form.

**Command (the requester runs it):** `oars pool export --out <folder>`, and `--raw` to include their raw copies. It signs in with their own credential (`GET /v1/account/export`), writes JSON one file a page, and writes nothing to the pool. Tell them the folder holds the account row, token expiry times, covenant acceptances, machines, repository keys, deposit hours, telemetry day counts, the raw ledger, staged deposit parts, erasure audit rows, and deposit rows as they now read.

**Steps:**
1. Confirm the account (above).
2. Reply with the one command, and the folder it will fill. Tell them an erased raw object is not in the copy.
3. Tell them what is not in it, and why: `contributors`, pooled cells, strata, and bundle reads tie the account to totals over other people (Art. 15(4)), and credential hashes are withheld (Art. 32).
4. When they report the files are saved, the answer is complete. If the command fails, send the error line back and retry once the cause is fixed.

**Answer to send:** the one command, the list of what the copy holds and leaves out, and the date.

**Record kept:** the dates, which right, how the account was confirmed, and the date answered. The export itself is not kept by the operator: it never passes through you.

Gap: **the operator cannot produce the copy.** The export runs only on the account's own sign-in. A requester who cannot sign in cannot be served; say so. Not yet possible.

Gap: **recipients.** Covenant 6.6(e) promises to name recipients on request (Art. 15(1)(c)). The pool keeps no register of who fetched which bundle, so you cannot name them. Not yet possible. Say that nothing is sold today ([`flags.md`](flags.md)) and that a bundle holds no account.

## Art. 16, rectification

**Arrives:** an email saying a record about them is wrong.

Gap: **no command.** A deposit is a derived skeleton and the ledger never changes its content. Not yet possible.

What you can do by hand, and only if the requester asks for it:
- A wrong machine label: they revoke the machine and enroll it again with the right label (`oars pool machines revoke <id>`, then `oars pool enroll ...`).
- A deposit they do not want kept: erase it. That is the Art. 17 request below.

**Answer to send:** say the pool cannot correct a deposit in place, name the two options above, and say what each does. If you decline, say why, within the month.

**Record kept:** dates, the request, and the answer.

## Art. 17, erasure

**Arrives:** an email asking for their data to be deleted. A protected person need not name a law (covenant 6.3, 6.6(c)).

**Steps:**
1. Confirm the account (above).
2. Tell the requester what an erasure leaves, from covenant 6.4 and 6.6(d), before you run it: the shared totals already built, the sign-in and acceptance records, the tombstone, and the hash, size, and date of what was erased. Tell them it does not stop new deposits, and that they should run `oars pool logout` on every machine and close the account if they want no more (see "Closing an account").
3. Dry run:
   `npm run erase -w packages/pool -- account --account <id>`
4. Read the line it prints. If it names the right account, run it:
   `npm run erase -w packages/pool -- account --account <id> --confirm`
   It prints `{"rowsErased":n,"objectsErased":n}`.
5. The same run rewrites the telemetry batches kept within the 90-day retention that name the account. If the run stops partway, run step 4 again: it is safe to repeat and finishes the rest.
6. One deposit only, or one raw object only, if that is all they asked for:
   `npm run erase -w packages/pool -- row --account <id> --id <session>`, and `npm run erase -w packages/pool -- raw <r2-key>`. Each is a dry run until `--confirm`. Both are for narrower cases; the usual answer is `account`.

**Answer to send:** the counts it printed, the date, the list of what stays (covenant 6.4, 6.6(d)), and that a copy already sold or served cannot be recalled (covenant 6.6(e)).

**Record kept:** the pool keeps the tombstone and one audit row (`erasure_audit`, kind and reason, the date, the counts). You keep the request dates, the proof used, and the printed counts.

Gap: **backups.** Whether D1 Time Travel or any R2 replication holds the erased data is not stated anywhere in the repository. Tell the requester it is not stated, until someone checks.

Gap: **bundles and client copies.** A bundle already served and a client's `<store>/pool-replica` copy are not recalled. The generation moves, so clients fetch a new bundle.

Gap: **the person's own machine.** No command deletes the local store (`raw/`, `state.json`, the outbox). It is theirs; tell them to delete it.

Gap: **Art. 19, telling recipients.** Covenant 6.6(e) promises to tell each recipient. The pool has no register of recipients. Not yet possible.

## Art. 18, restriction

**Arrives:** an email asking you to stop using their data while a dispute about it is settled.

Gap: **no per-account freeze on the pool.** Nothing marks an account's held data as restricted. Not yet possible.

The nearest steps, with their agreement:
- Stop later deposits: close the account (below). This ends all credentials. The held data stays and is still processed.
- On their machine: `oars pool raw --folder <entry> --mode off`, or `oars sessions deposit --deny <folder>`, or `oars sessions hook install --schedule off`. These stop later sends only.

**Answer to send:** say what stops and what does not, in those words. Do not say the data is restricted.

**Record kept:** dates, the request, and the steps taken.

## Art. 21, objection

**Arrives:** an email objecting to the pool processing their data, or its use for training or sale.

Covenant 6.6(a): you must stop the processing unless you show compelling grounds, or need it for a legal claim. The decision is yours; write it down.

**Steps:**
1. Confirm the account.
2. If you accept: close the account so no more arrives (below), and erase if they ask for it (Art. 17 above). Closing deletes their credentials; erasing removes their contributor records.
3. For telemetry only: they run `oars telemetry off`, or set `OARS_TELEMETRY=0`.
4. If you do not accept, tell them the grounds within the month, with the complaint right.

**Answer to send:** what you did, and what still stands.

**Record kept:** the decision and the grounds, with dates.

Gap: **no exclusion marker for a sale or a manual export.** Nothing is sold today. When a sale path exists, nothing excludes an objecting account from it, because no field records the objection. Not yet possible. Keep your record of the objection; it is the only trace.

## Art. 7(3), withdrawing raw consent

**Arrives:** an email saying they withdraw their yes to raw copies.

**Command (the requester runs it):** `oars pool raw --consent no`. It stops later raw copies on their machine and tells the pool (`DELETE /v1/consent/raw`), which drops their staged raw parts at once. The pool erases the raw objects it already holds, whole, on its nightly run; a large account can take more than one night. Each erased object keeps a tombstone, and the hash, size, and date stay.

**Steps:**
1. Confirm the account.
2. Reply with the one command. If it prints that the pool was not told, they sign in again with `oars pool login` and rerun it.
3. Check the withdrawal landed, read-only, from `packages/pool`:
   `npx wrangler d1 execute oars-pool --remote --command "SELECT raw_consent_withdrawn_at FROM accounts WHERE id = '<account id>'"`
   A number means the pool has it.
4. A few days later, check the raw objects are gone the same way (`raw_objects` rows with `erased_on` set). If objects remain after several nights, erase them by key. Dry run: `npm run erase -w packages/pool -- raw <r2-key>`. Read the line it prints, then add `--confirm`.

**Answer to send:** the date the withdrawal landed, that earlier processing is not affected (Art. 7(3)), and that a copy already sold or served is not recalled.

**Record kept:** the pool keeps `raw_consent_withdrawn_at` and the covenant version it answered. You keep the dates.

Gap: **the operator cannot withdraw for them.** Only the account's own credential sends the withdrawal. If the requester cannot sign in, erase the raw objects by key with the command in step 4, after listing them from `raw_objects`. That by-hand erasure does not set the withdrawal.

Gap: **withdrawing the covenant.** Acceptance rows are append-only. Declining a later version stops later deposits. Not yet possible beyond that.

## Closing an account (covenant 6.1)

**Arrives:** an email asking to close the account. This is open to anyone, not only protected persons.

**Steps:**
1. Confirm the account.
2. Dry run:
   `npm run erase -w packages/pool -- close --account <id>`
3. Run it:
   `npm run erase -w packages/pool -- close --account <id> --confirm`
   It prints `{"rowsChanged":n}`.
4. It revokes every token and every machine key, and from then on sign-in, machine enrollment, and activation answer 403 `account_closed`. A rerun changes nothing.

A close erases nothing. If they also want their data deleted, that is a separate Art. 17 request.

**Answer to send:** the date it closed, that no machine of theirs can deposit now, that their data stays unless they ask for erasure, and that reopening is a written request handled by hand.

**Record kept:** the pool sets `accounts.closed_at`, which starts the retention clock in covenant 7.2(a), and writes one audit row. You keep the dates.

Gap: **reopening.** No command reopens an account. Not yet possible.

## A third party named in a deposit

**Arrives:** an email from someone who is not an account holder, saying a deposit names them.

You cannot confirm them against an account, so confirm the claim instead: find the text.

1. Put the text on stdin, never as an argument, so it stays out of the process list and shell history:
   `npm run erase -w packages/pool -- raw --contains --value-stdin --all-accounts` (eight characters at least)
2. It prints each matching key, account, and size, and changes nothing.
3. Erase each key you accept. Dry run: `npm run erase -w packages/pool -- raw <r2-key>`. Read the line it prints, then add `--confirm`.
4. Deposit skeletons, motifs, cells, and contributors that hold the text. Dry run, text on stdin: `npm run erase -w packages/pool -- row --account <id> --id <session> --value-stdin`. Read the line it prints, then add `--confirm`. That scrubs the text from every place it appears, for every account, and cannot be undone.
   The account is the one in the raw key. With no known session, the dry run shows "no such row: only the value would be erased".

Gap: **parts of a raw object still uploading are not searched**, and redaction can miss a name written in prose.

**Answer to send:** what you found and erased, or that you found nothing, within the month.

**Record kept:** dates, and the keys erased. Do not keep the text you searched for.
