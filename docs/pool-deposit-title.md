# Pool deposits as pack supply: title from the covenant

Design page. It changes no code. Anchors are as of oars `a91fe1e2`.

Ruling (Matt, 2026-11-12): a covenant acceptance is title enough for a pack row. A depositor does not declare repositories.
Fact owed: counsel has not confirmed that the grant is title enough for sale. This page records that and does not reopen it.

## 1. The title rule

### What exists today

- A pack row takes `repoOwner` and `sourceLicense` from the owners file and from nothing else
  (`packages/pool/scripts/sample-pack.ts:1324-1325`). A session with no owners match is dropped (`sample-pack.ts:1196-1197`).
- The pool holds two covenant texts: `2.0-4c538c50d706` and `2.1-ec0ca3f6ff73` (`packages/pool/src/covenant-texts.ts:3-4`,
  `docs/covenant/`). No other text is held.
- An acceptance row holds the account, the version, and the time (`migrations/0020_covenant_record.sql:3`), plus the hash of
  the text shown, how the person answered, and the client (`migrations/0022_covenant_proof.sql:3-5`). The pool writes a row
  only when the hash the client names equals the hash of the screen it holds for that version (`src/covenant.ts:100`, `:113`).
- `text_sha256` is the hash of the acceptance screen (Part A and the acceptance block), not of the full text
  (`src/covenant.ts:39`). The version string itself proves the full text (`src/covenant-texts.ts:2`).
- A row from before migration `0022` has no hash. The migration says such an acceptance "proves nothing" (`0022:2`).
- No deposit is stored without an acceptance of the version in force: the gate runs before the body is read
  (`src/worker.ts:126-134`), and with no version set nothing can deposit (`src/covenant.ts:1`).
- A deposit row has no arrival time and no covenant column. Its columns come from `0001_init.sql:4`, `0004_access.sql:2-3`,
  `0018_erasure.sql:12`, `0025_deposit_provenance.sql:5-9`, and `0035_request_country.sql:5`. It joins to an acceptance by
  `account` only.

### Which versions grant sale

| Version | Grants sale | Proof |
|---|---|---|
| `2.0-4c538c50d706` | Yes | Part A (`docs/covenant/2.0-4c538c50d706.md:5`), the grant (`:82`), sale to anyone (`:96`) |
| `2.1-ec0ca3f6ff73` | Yes | Part A (`docs/covenant/2.1-ec0ca3f6ff73.md:5`), the grant (`:82-84`), sale to anyone (`:96-98`) |
| Any other version string on an account | Not shown | No text is held for it, so no grant can be cited |

The two texts differ only in the Version line and in the erasure clauses 6.4 and 6.6(d) (a `diff` of the two files: lines 46,
177 to 184, and 203 to 206). The grant, the sale clause, and the promises are word for word the same.

### The rule

A deposit row is packable on title when its account holds at least one **proved acceptance**: a `covenant_acceptances` row
whose `version` is a key of `COVENANT_FULL_TEXTS`, whose `text_sha256` is not null and equals the hash of the screen held for
that version, and whose `input` is not null. The row cites the account's newest proved acceptance at build time.

Why the newest, and not the one in force when the deposit arrived:

- The deposit row does not record when it arrived or under which version (above). So the builder cannot pick per deposit.
- The covenant covers the gap. Accepting a new version also grants its license for earlier Deposits, to the extent it gives
  more (Section 14.2, `2.1-ec0ca3f6ff73.md:327-329`; `2.0-4c538c50d706.md:325-327`). So the newest proved acceptance reaches
  every Deposit of the account that is stored today.
- The grant takes effect when each Deposit is sent and survives opting out and closing the account (Section 2.5, `2.1:109-113`).

### What the pack row carries

| Field | Value for a deposit-sourced row | Why |
|---|---|---|
| `repoOwner` | `depositor:<16 hex>`: the first 16 hex of the HMAC-SHA-256 of the account id under the buyer key | See below |
| `sourceLicense` | `manyoars-covenant <version> sha256:<text_sha256>` of the cited acceptance | The version proves the full text and the hash proves the screen shown |
| `acceptedAt` (new, optional) | The cited acceptance's `accepted_at` as an ISO time | The time is part of the proof of the grant (Section 7.2(c), `2.1:235-236`) |

Why `repoOwner` is a per-pack pseudonym:

- It is not the account id. The account id is a personal identifier the covenant lists (Part C.1, `2.1:360`). One value in
  every pack would let two buyers join a depositor across packs. Every other id in a pack is keyed per buyer for that reason
  (`docs/pool.md:428`, the `repoKey` sentence).
- It is not "Many Oars Co. by covenant". That would be false. The license is non-exclusive (Section 2.4, `2.1:106-107`) and
  title to the content of a Deposit stays with whoever holds it (Section 3.2, `2.1:127-129`). The field means the owner of the
  repositories (`docs/session-record.md:50`), and a buyer reads it that way.
- The word `depositor` is exact. The depositor promises they hold every right needed, or have the permission of the employer
  or client that does (Section 8(b), `2.1:249-251`). The pool does not know who owns the repository, only who made the promise.
  A buyer may enforce Sections 2, 3, 8, 9, and 11 directly (Section 16.3, `2.1:345`).
- One buyer still sees one depositor as one value across lots built under the same key, as with `repoKey`. That lets a buyer
  split or weight by contributor. An owners-file row keeps its plain owner name, so the two kinds of row stay distinct.

Why `sourceLicense` names the covenant: no column anywhere records the license of a depositor's repositories (t1171, gap 3).
The sale rests on the covenant grant, by the ruling above. For material someone else published, the depositor grants only to
the extent of their rights (Section 8(b), `2.1:251`); the value does not claim more.

`acceptedAt` is a new field, so it must be listed. A row may not hold a field the spec does not list
(`docs/session-record.md:34`). It is optional, like `reasoning` (`docs/session-record.md:61`), so every pack built before it
still conforms and lot 1 r6 is not rebuilt.

The operator's `index.jsonl` row (`sample-pack.ts:191`) gains three optional values for a deposit-sourced row: `account`,
`covenant`, and `acceptedAt` (the exact milliseconds). They never enter a pack. `license-status` then has a covenant to print
where it prints `unknown` today (`packages/pool/scripts/license-status.ts:239`, `docs/pool.md:458`).

### Deposits the rule leaves out

- **A deposit under a version that does not grant sale.** No such text is held, so this means an account whose only
  acceptances are unproved: an older version string, or a row with no `text_sha256` (`0022:2`), or only the old
  `accounts.covenant` value from before the history table (`0020:1-2`). Its deposits are left out and counted `noGrant`. If
  the account later accepts 2.0 or 2.1, Section 14.2 brings its earlier Deposits under that grant and they become packable.
  Whether production holds such accounts is not known here; the production database was not read.
- **A deposit made before the account's acceptance.** The gate makes this impossible for a stored row (`src/worker.ts:134`).
  The builder does not test for it, because the row holds no time to test (above). The 14.2 back-grant covers the case in law.
- **An erased account's deposits.** After `erase account` each kept deposit row sits under a random `erased:` account
  (`docs/pool.md:515`). It joins to no acceptance, so the rule itself leaves it out. No extra check is needed for title.

Title is one gate of several. A Raw Copy also needs the raw yes, and section 2 lists every other exclusion.

## 2. The deposit input

- The one operator read path is `erase export --account <id> --out <folder> --raw` (`packages/pool/scripts/erase-cli.ts:152`,
  `scripts/export-account.ts:32`) over `EraseStore` (`scripts/erase.ts:17`). It is the Art. 15 and 20 copy of one account. It
  lists no accounts, omits `restricted_at`, and a change to its shape moves its version (`docs/pool.md:528`). It is not reused.
- A Raw Copy has no stored link to its deposit row: `raw_objects` holds account, hash, size, two versions, and a time
  (`migrations/0011_raw_tier.sql:3`). The link can be recomputed. `deposits.id` is the skeleton `id`
  (`packages/cli/src/sessions/pool-wire.ts:853`), which the client sets to `contentHash([account, session])`
  (`pool-command.ts:754`, `:807`; `read.ts:20`), and a transcript line carries its `sessionId` (`sample-pack.ts:583`).
  A machine's session under a session salt cannot be recomputed (`pool-command.ts:688`).
- The builder reads one local store and one transcript folder, both named by the environment (`sample-pack.ts:1443-1445`).

**Design: pull once, then build offline.**

1. `pull-deposits` is a new script, `packages/pool/scripts/pull-deposits.ts`, run by the operator. It calls only `rows` and
   `readObject` of `EraseStore`, so it cannot write. It writes a lot-input folder outside every repository: `accounts.jsonl`
   (account, cited version, `text_sha256`, `accepted_at`), and per account `deposits.jsonl` (id, tier, `request_country`,
   skeleton) and `projects/deposit/<sha256>.jsonl` (each Raw Copy). This is the only production read. The build makes none.
2. `sample-pack --deposits <folder>` takes each account folder in turn. It captures the Raw Copies into a throwaway store with
   the CLI's own capture (`captureSession`, `packages/cli/src/sessions/extract.ts:1631`), pairs each session with its deposit
   row by the recomputed id, and then runs every existing rule. Title (section 1) stands where `ownerOf` stands (`:1196`). The
   repository test (`:1203`) reads the skeleton's `repoKey` (`pool-wire.ts:231`), because the build machine holds no clone.
3. A Raw Copy that pairs with no deposit row is left out and counted `unlinked`. Brief 5 stores the link, so the count ends.

Not verified here, so brief 2 proves both with its first tests: the capture reads a redacted transcript, and the redactor
leaves `sessionId` in place.

**What a deposit must pass.** The default is more data, kept longer. No rule below sets an age limit, and the grant does not
end with time (Section 2.5, `2.1:109-113`).

| Rule | What sets it | Where it is enforced today | In the deposit path |
|---|---|---|---|
| Proved acceptance | Section 1 | `covenant_acceptances` (`0020:3`, `0022:3-5`) | Pull, per account |
| Not erased | GDPR and UK GDPR Art. 17; covenant 6.4 (`2.1:177-184`) | `erased_on` on both tables (`0018_erasure.sql:12-13`); `erased:` accounts (`docs/pool.md:515`) | Pull, per row |
| Not restricted | Art. 18(2): restricted data is stored and not otherwise used | `accounts.restricted_at` (`0039_account_restricted.sql:2`) | Pull, whole account |
| Raw yes in force | Art. 7(3) and 9(2)(a) (`0026:1`) | `raw_consent_version` (`0026:4`); the nightly sweep erases held copies after a withdrawal (`src/nightly.ts:27`) | Pull: the column is not null |
| Tier is not `none` | No law. The batch failed its challenge or root check (`src/access.ts:5`) | `deposits.tier` (`0004_access.sql:2`) | Build, after pairing |
| Not from a protected region | Art. 44 to 46; the covenant's Transfers promise (`2.1:407-412`) | Acceptance is refused while `PROTECTED_REGIONS_OPEN` is not `1` (`src/covenant.ts:109`); `deposits.request_country` (`0035:5`) | Build: left out, counted `protectedRegion`; expected zero while the gate is closed |
| Exclusion terms | No law. The depositor's list and the operator's list | Depositor, before a copy is queued (`pool-command.ts:826-830`); operator, `checkSession` (`sample-pack.ts:1189`) | Unchanged, over the pulled transcripts |
| Harness terms | Each vendor's terms | `HARNESS_TERMS` (`sample-pack.ts:59`); a harness with no row is left out | Unchanged |
| Redaction and secret scan | The page promise (`docs/pool.md:416-422`) | Depositor (`pool-command.ts:829`), version on the ledger row (`src/raw.ts:199`); builder, again | Unchanged; see the gap below |
| Reasoning text | Vendor terms, per lot (`docs/pool.md:420`) | `--strip-thinking` (`sample-pack.ts:1212`, `:1268`) | Unchanged; kept by default |
| Must-not list | `docs/session-record.md:31-37` | `validate-pack.ts` | Unchanged; brief 3 lists `acceptedAt` first |
| No objection | Art. 21(1) | `objections.jsonl` (`sample-pack.ts:1136-1139`) | By session, name, or account (section 4) |

Gap: the builder's owner-handle rule reads `.git/config` on the build machine (`docs/pool.md:416-422`), and the depositor's
redaction passes no handles (`pool-command.ts:829`). A repository owner's handle can survive in a deposit-sourced transcript.
Call 1 decides. Opening protected regions needs a record of each buyer's transfer safeguard first; that is not in this plan.

## 3. The operator's own sessions

- **The path.** Matt's account deposits like any other: the same command, the same raw yes (`pool-command.ts:826`), under
  his own proved acceptance. `pull-deposits` returns his sessions with everyone's, and they are packed as `depositor:<hex>`
  rows under the covenant. Nothing in the deposit path knows which account is the operator's.
- **Match ids do not move.** A deposit-sourced session takes its match id as a store session does, from the buyer key, the
  index key, and the harness session id (`sample-pack.ts:1167`). So one session has one match id per buyer on either path.
- **`deliver` is untouched.** It resolves a match id through `index.jsonl` (`deliver.ts:118`) and reads each indexed pack
  folder (`:149`). A deposit-sourced build appends rows of the same shape with the optional values of section 1. No row is
  rewritten or removed, so the r2 to r6 folders and their `operator/index.jsonl` rows stay as they are.
- **Lot 1 r6 stays byte-identical.** `--deposits` is an added input. Without it the builder runs the code it runs today.
  Brief 2's first test builds the existing fixture pack without the flag and compares bytes.
- **What `owners.json` is still for.** It anchors the operator folder: `index.jsonl`, `deliveries.jsonl`, and
  `objections.jsonl` sit beside it (`deliver.ts:17`, `license-status.ts:176-190`). It names a real owner and a repository
  license where Matt wants the row to say so, with the pointer and outcome block only a local clone gives
  (`sample-pack.ts:128`, `:1153`). It is the only source for sessions never deposited. And it rebuilds lot 1.

## 4. Rights follow-through for a row already sold

The covenant sets the frame. A deletion "does not reach a copy already licensed or sold, except that Many Oars Co. will tell a
recipient where the law requires it to" (Section 6.4, `2.1:183`). So each right becomes: stop further sale, and tell each
recipient. GDPR and UK GDPR both apply, and the article numbers are the same in each.

| Right | Article | Pool side today | What reaches the sold row |
|---|---|---|---|
| Erasure, or the unlink that stands in for it (`docs/pool-rights.md:144`) | Art. 17(1); recipients told under Art. 19 | `erase account` (`erase-cli.ts:176`): rows are erased or kept under an `erased:` account (`docs/pool.md:515`) | Register line, then `notices` per recipient. The pack row needs no relink: `depositor:` never named the account |
| Restriction | Art. 18(1) and (2); recipients told under Art. 19 | `erase restrict` sets `restricted_at` (`erase-cli.ts:146`, `0039:2`) | Register line; no new pack holds the account until it is lifted |
| Objection | Art. 21(1) | Recorded only: "the first sale path loads those records" (`docs/pool-rights.md:152`) | Register line with its scope |
| Access to recipients | Art. 15(1)(c) | `deliver recipients <session or name>` (`deliver.ts:137`); a pool account finds nothing (`docs/pool-rights.md:70`) | `deliver recipients --account <id>` |

The carrier is one line keyed by account in the register that exists, `objections.jsonl`:
`{"account": "<id>", "right": "erasure" | "restriction" | "objection", "received": "<time>", "scope": "sale" | "training" | "all"}`.
Existing code then does the work. `sample-pack` leaves the account out of every later build (`sample-pack.ts:1136-1139`).
`deliver` refuses every pack built before the line, because the hash of the file changed (`deliver.ts:115-117`). `license-status`
answers a buyer per match id (`license-status.ts:187-189`), and `notices` records that each recipient was told (`notices.ts:98`).
The index and the register keep the account id after an erasure, as the pool keeps the acceptance record (6.4, `2.1:181`;
6.6(d), `2.1:203-204`). Art. 17(3)(e) allows what the defence of legal claims needs.

Missing in code:

1. No operator file is keyed by account: an index row holds `pack`, `session`, `project`, and `matchId` (`sample-pack.ts:191`).
2. `Objection` holds `session` and `name`, with no `account` and no `right` (`sample-pack.ts:204-207`).
3. `deliver recipients` and `license-status` have no account lookup (`deliver.ts:11`, `license-status.ts:187-189`).
4. `erase account` and `erase restrict` do not print the register line, so the step rests on the runbook alone.
5. The Art. 15 export has no recipients section and omits `restricted_at` (`src/export.ts:59-60`); both are answered by hand.
