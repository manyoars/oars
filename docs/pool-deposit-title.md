# Pool deposits as pack supply: title from the covenant

Design page. It changes no code. Anchors are as of oars `a91fe1e2`.

Ruling (Matt, 2026-11-12): a covenant acceptance is title enough for a pack row. A depositor does not declare repositories.
Fact owed: counsel has not confirmed that the grant is title enough for sale. This page records that and does not reopen it.

Status: section 1 is written. Sections 2 to 6 (deposit input, the operator's own sessions, rights follow-through, build plan,
calls for Matt) are not written yet.

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
