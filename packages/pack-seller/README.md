# @manyoars/pack-seller

A small server that sells session packs the way any seller workload sells credits: it keeps a customer per buyer, asks the platform for an offer, and reads the buyer's credits and reservations with the seller's own SDK key. It is not published to npm; it runs from a checkout (or the image built from the Dockerfile).

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

A missing or malformed value prints one line naming the variable and exits 1. The line never holds a value.

## Routes

| Method and path | What it does |
|---|---|
| `GET /health` | `{"status":"ok"}`. |
| `GET /packs`, `GET /packs/{packId}` | The packs the catalog lists. Until the pack store lands the catalog is empty, so these answer an empty list and 404. |
| `POST /packs/{packId}/offer` | Body `{recipientLegalName, licenseVersion}`, both required. Creates a customer under a fresh ref, records both against it, asks for an offer, and returns `{offerId, expiresAt, priceRef, customerRef}`. The `customerRef` is shown this once and never logged. Rate limited per caller. |
| `GET /credits` | The balance for the customer in the `X-Customer-Ref` header. |

There are no public reservation routes. Reserve, commit, and release (`billing.reserve`, `billing.commit`, `billing.release` in `src/billing.ts`) are the seam for brief 3's download route, which runs them for the buyer; those paths answer 404.

A refusal from the platform reaches the caller as one of 400, 402, 404, 409, 502, or 503 with a one-line body `{"error":"..."}`; the platform's own text never does.

## Develop

`npm test -w packages/pack-seller` runs the tests against msw; no test reaches the network.
