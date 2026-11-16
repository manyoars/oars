# @manyoars/pack-seller

A small server that sells session packs the way any seller workload sells credits: it keeps a customer per buyer, asks the platform for an offer, and reads the buyer's credit balance (and, in the download route, reserves and commits credits) with the seller's own SDK key. It is not published to npm; it runs from a checkout or from the image built from the Dockerfile. The operator's steps are in [`docs/pack-selling.md`](../../docs/pack-selling.md).

The server holds no price. The platform's credit pack carries it, and the offer response repeats the `priceRef` so the buyer pays for what it read. It learns that a purchase went through only by reading the customer's balance: nothing is pushed to it.

## Run it locally

```sh
npm ci
npm run build
OARS_SELLER_API_URL=https://api.manyoars.com \
OARS_SELLER_SDK_KEY_FILE=./seller.key \
OARS_SELLER_PORT=8790 \
npm start -w packages/pack-seller
```

| Variable | Meaning |
|---|---|
| `OARS_SELLER_API_URL` | The platform's base URL. Required. |
| `OARS_SELLER_SDK_KEY_FILE` | Path to a file holding the seller's SDK key (`aorsk_...`). Wins over `OARS_SELLER_SDK_KEY`. |
| `OARS_SELLER_SDK_KEY` | The key itself, when no file is given. One of the two is required. |
| `OARS_SELLER_PORT` | The port to listen on. Required. |
| `OARS_SELLER_HOST` | The IP address to listen on. Default `127.0.0.1`; the image sets `0.0.0.0`. |
| `OARS_SELLER_PACKS_DIR` | The folder holding one subfolder per pack (`listing.json` and the built `preview/`); per-buyer builds go under `builds/`. Required. |
| `OARS_SELLER_TERMS_FILE`, `OARS_SELLER_OWNERS_FILE`, `OARS_SELLER_INDEX_KEY_FILE` | The term list, owners file, and index key the per-buyer build reads. Required. |
| `OARS_SELLER_STORE_DIR`, `OARS_SELLER_PROJECTS_DIR` | The copy of the session store and the transcripts the build reads. Required. |
| `OARS_SELLER_PRICE_USD` | The amount of a pack's `CREDIT_PACK` price, read by the price command (`src/pricing.ts`). It is never a default in code. |
| `OARS_SELLER_WORKLOAD_ID` | The seller's workload id (a UUID), read by the price command only. |

Every path above is local to the operator's machine, and a path inside a git repository is refused at start with a line naming the variable. The offer record (`offers.jsonl`) is kept beside `deliveries.jsonl`, next to the owners file.

A missing or malformed value prints one line naming the variable and exits 1. The line never holds a value.

## The image

Build it from the repository root, then run it with every path folder mounted and the key file mounted:

```sh
docker build -f packages/pack-seller/Dockerfile -t oars-pack-seller .
```

The image runs as the non-root `node` user, listens on `0.0.0.0`, and holds no key and no operator login. The `price` command does not run in it. The full run command, the mounts, and the steps around it are in [`docs/pack-selling.md`](../../docs/pack-selling.md).

## Create the price

`npm start -w packages/pack-seller -- price` creates the `CREDIT_PACK` price (`pack-<packId>`, 3 credits, `OARS_SELLER_PRICE_USD`) of every pack in `OARS_SELLER_PACKS_DIR` and prints one line per pack: `Price pack-alpha created.`, or `already exists.` on a second run, which creates nothing. A price that exists with other terms is left unchanged and the command exits 1, because an amount is immutable once charged. Creating a price needs the operator's login, not the SDK key: run `oars login --api-url <url>` first, or set `OARS_API_KEY`. It needs the same variables as the server except `OARS_SELLER_SDK_KEY*` and `OARS_SELLER_PORT`, plus `OARS_SELLER_WORKLOAD_ID`. Every failure is one line with no token in it.

## Buy a pack

Each step below is one the tests run (`src/money-loop.test.ts`).

1. Have a buying agent and its SDK key. The buying calls below send that key, not a seller key.
2. See the offer: `GET /packs` lists the packs and `GET /packs/{packId}` shows one pack's page with its manifest, census, card, and terms. Read it before you buy.
3. Ask for an offer: `POST /packs/{packId}/offer` with `{recipientLegalName, licenseVersion}`. The answer holds `offerId`, `priceRef`, and `customerRef`. Keep the `customerRef`: it is shown this once.
4. Buy: `oars purchasing buy <offerId> --pack <priceRef>` (set `OARS_SDK_KEY` or pass `--sdk-key-file`). Then run `oars purchasing get <purchaseId>` until the purchase leaves `PENDING`.
5. Download: `POST /packs/{packId}/download` with the header `X-Customer-Ref: <customerRef>` and the body `{"buyerKey": "<your buyer key>"}`. The answer is a tar archive. `GET /credits` with the same header shows what is left.
6. Check it: `npm run validate-pack -w packages/pool -- <the unpacked folder>`. It checks the pack against `docs/session-record.md`: the manifest, each session record, and the field rules. It reads files only. A pack whose commit was refused arrives without its manifest, and `validate-pack` rejects it.

A pack carries 3 credits, and each download spends one. Download a fourth time and the seller answers 402.

### The 402 on download

`POST /packs/{packId}/download` answers `402` with `{"error":"No credits are available."}` when the customer has no credit left. That means the purchase has not settled yet, nothing was bought, or the three credits are spent. Nothing is reserved or built on a 402. To get more downloads, buy another pack.

## Routes

| Method and path | What it does |
|---|---|
| `GET /health` | `{"status":"ok"}`. |
| `GET /packs`, `GET /packs/{packId}` | The packs the catalog lists. The page carries the manifest, census, card, and the terms fields. |
| `POST /packs/{packId}/offer` | Body `{recipientLegalName, licenseVersion}`, both required. Creates a customer under a fresh ref, records both against it, asks for an offer, and returns `{offerId, expiresAt, priceRef, customerRef}`. The `customerRef` is shown this once and never logged. Rate limited per caller. |
| `POST /packs/{packId}/download` | Header `X-Customer-Ref`, body `{buyerKey}`. Reads the balance (no credit answers 402 `No credits are available.` before anything is reserved), reserves one credit, rechecks the objections (a stale pack is rebuilt), builds the pack under the buyer's key, streams it as a tar archive with `manifest.jsonl` last, commits the credit before that last entry is sent, and appends the delivery record with the recipient and license from the offer. A failed build, a stream cut before the commit, a refused commit, or an objection recorded during the stream releases the reservation and writes no delivery; after a refused commit the archive lacks its manifest, so `validate-pack` rejects it. The key is held only for the build and is never logged or stored. |
| `GET /credits` | The balance for the customer in the `X-Customer-Ref` header. |

There are no public reservation routes. Reserve, commit, and release (`billing.reserve`, `billing.commit`, `billing.release` in `src/billing.ts`) run only inside the download route.

A refusal from the platform reaches the caller as one of 400, 402, 404, 409, 502, or 503 with a one-line body `{"error":"..."}`; the platform's own text never does.

## Develop

`npm test -w packages/pack-seller` runs the tests against msw; no test reaches the network.
