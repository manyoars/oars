# @manyoars/pack-seller

A small server that sells session packs the way any seller workload sells credits: it keeps a customer per buyer, asks the platform for an offer, and reads the buyer's credit balance (and, in the download route, reserves and commits credits) with the seller's own SDK key. It is not published to npm; it runs from a checkout (or the image built from the Dockerfile).

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

## Create the price

`npm start -w packages/pack-seller -- price` creates the `CREDIT_PACK` price (`pack-<packId>`, 3 credits, `OARS_SELLER_PRICE_USD`) of every pack in `OARS_SELLER_PACKS_DIR` and prints one line per pack: `Price pack-alpha created.`, or `already exists.` on a second run, which creates nothing. A price that exists with other terms is left unchanged and the command exits 1, because an amount is immutable once charged. Creating a price needs the operator's login, not the SDK key: run `oars login --api-url <url>` first, or set `OARS_API_KEY`. It needs the same variables as the server except `OARS_SELLER_SDK_KEY*` and `OARS_SELLER_PORT`, plus `OARS_SELLER_WORKLOAD_ID`. Every failure is one line with no token in it.

## Routes

| Method and path | What it does |
|---|---|
| `GET /health` | `{"status":"ok"}`. |
| `GET /packs`, `GET /packs/{packId}` | The packs the catalog lists. The page carries the manifest, census, card, and the terms fields. |
| `POST /packs/{packId}/offer` | Body `{recipientLegalName, licenseVersion}`, both required. Creates a customer under a fresh ref, records both against it, asks for an offer, and returns `{offerId, expiresAt, priceRef, customerRef}`. The `customerRef` is shown this once and never logged. Rate limited per caller. |
| `POST /packs/{packId}/download` | Header `X-Customer-Ref`, body `{buyerKey}`. Reads the balance (no credit refuses before anything is reserved), reserves one credit, rechecks the objections (a stale pack is rebuilt), builds the pack under the buyer's key, streams it as a tar archive with `manifest.jsonl` last, commits the credit before that last entry is sent, and appends the delivery record with the recipient and license from the offer. A failed build, a stream cut before the commit, a refused commit, or an objection recorded during the stream releases the reservation and writes no delivery; after a refused commit the archive lacks its manifest, so `validate-pack` rejects it. The key is held only for the build and is never logged or stored. |
| `GET /credits` | The balance for the customer in the `X-Customer-Ref` header. |

There are no public reservation routes. Reserve, commit, and release (`billing.reserve`, `billing.commit`, `billing.release` in `src/billing.ts`) run only inside the download route.

A refusal from the platform reaches the caller as one of 400, 402, 404, 409, 502, or 503 with a one-line body `{"error":"..."}`; the platform's own text never does.

## Develop

`npm test -w packages/pack-seller` runs the tests against msw; no test reaches the network.
