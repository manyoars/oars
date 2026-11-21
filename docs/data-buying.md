# Finding and fetching a dataset pack: `oars data`

`oars data search` reads the public catalog. `oars data fetch` starts a fetch of one listing's pack, buys the credit first when the pool asks for one, waits for the pack, unpacks it into a fresh folder, and checks it. A buy is never automatic: it takes `--yes` or a typed `yes` at a terminal, and it never goes over the cap.

## Search

```
oars data search [query] [--harness <name>] [--permitted-use <use>] [--training <terms>] [--max-price-per-fetch <usd>] [--json]
```

Needs no sign-in and no key. Each line is the listing id, the seller, the pack's name, the price, the fetches it grants, the price per fetch, the sessions in it, and its redaction version. An empty page prints `No datasets match.`

## Fetch

```
oars data fetch <listingId> --state <XX> [--out <dir>] [--yes] [--max-usd <usd>] [--sdk-key-file <path>] [--server <url>] [--json]
```

What you need first:

- A pool sign-in: `oars pool login`. The pool credential is the one `oars pool` commands use.
- `--state`, your two-letter US state. The pool sells to buyers in the United States only, and refuses another region with `region_not_supported`.
- To buy, the buying agent's SDK key (`OARS_SDK_KEY`, or `--sdk-key-file`), with an approved purchasing cap and a saved card on the platform. A fetch that needs no buy never reads the key.

What it does:

1. Reads the listing from the catalog and starts the fetch at the pool with your buyer key and state.
2. On `402 payment_required`, prints the pack, its price, its fetches, and what you hold. It buys only after `--yes` or a typed `yes`, and not at all when the price is over `--max-usd` (default: `OARS_BUY_CAP_USD`). The platform also enforces the agent's own monthly cap and answers `PURCHASE_CAP_REACHED` with what is left.
3. Polls the purchase until it settles, then starts the fetch again.
4. Polls the fetch with a wait that grows from one second to fifteen, for up to fifteen minutes. If the pack is not ready it stops with exit 8; run the command again later, since the pool keeps a pack for seven days.
5. Downloads the archive, checks every entry before writing anything, and unpacks it into `<out>/pack-<fetchId>` (a fresh temporary folder when `--out` is not given). An existing folder is never reused.
6. Checks the pack and prints the folder.

The buyer key is made once and kept in the sessions store next to the pool sign-in (`buyer-key`, owner-only). The pack's session ids are masked under it, so keep it: a pack fetched under another key does not line up with your earlier ones.

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | The pack is unpacked and checked. |
| 2 | A usage problem: no `--state`, no `--yes` and no terminal, no SDK key, a folder that exists. |
| 3 | Not signed in to the pool, or the pool refused the buyer (`buyer_refused`, `account_restricted`). |
| 4 | `region_not_supported`, `state_invalid`, an unsafe archive, or a pack that failed the check (its folder is kept). |
| 5 | The price is over the cap, the purchase failed, or the pool still asked for payment after a purchase. |
| 8 | The pool or platform could not be reached, a purchase stayed pending, or the pack was not ready in time. |

A fetch that failed at the pool (`409 fetch_failed`) or expired (`410 gone`) exits 1 with the pool's message and writes nothing.

### What the download will not do

It writes only under the folder it makes. An archive with an entry that has `..`, an absolute or drive path, a backslash, or any link, device, or extended header is refused whole before a byte is written. So is an archive cut short, and one whose last file is not `manifest.jsonl` (the pool sends the manifest last, so an archive without it is incomplete).

### The check

The check run after unpacking confirms that `manifest.jsonl` has rows, each row is JSON with a `matchId`, each `matchId` has its folder under `sessions/`, and no session folder is left unnamed. It is a structural check. The full session-record check is `validate-pack` (`packages/pool/scripts/validate-pack.ts`, `docs/session-record.md`), which you can run on the printed folder from a checkout: `npm run validate-pack -w packages/pool -- <folder>`.
