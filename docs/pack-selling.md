# Selling packs: the operator runbook

The pack seller (`packages/pack-seller`) sells session packs over the platform's billing. It runs on the operator's machine, because the term list, owners file, index key, session store copy, and transcripts a pack is built from live there. Steps only the account owner can do are marked **Account owner**.

## The variables

| Variable | Kind | Meaning |
|---|---|---|
| `OARS_SELLER_API_URL` | value | The platform's base URL. Required. |
| `OARS_SELLER_SDK_KEY_FILE` | secret, path | A file holding the seller's SDK key. Wins over `OARS_SELLER_SDK_KEY`. |
| `OARS_SELLER_SDK_KEY` | secret | The key itself. Use the file form in the image. |
| `OARS_SELLER_PORT` | value | The port to listen on. Required. |
| `OARS_SELLER_HOST` | value | The IP to listen on. Default `127.0.0.1`; the image sets `0.0.0.0`. |
| `OARS_SELLER_PACKS_DIR` | path | One subfolder per pack (`listing.json`, `preview/`); per-buyer builds go under `builds/`. |
| `OARS_SELLER_TERMS_FILE` | path, sensitive | The term list the build reads. |
| `OARS_SELLER_OWNERS_FILE` | path, sensitive | The owners file; the offer and delivery records are kept beside it. |
| `OARS_SELLER_INDEX_KEY_FILE` | path, secret | The index key. |
| `OARS_SELLER_STORE_DIR` | path, sensitive | The copy of the session store. |
| `OARS_SELLER_PROJECTS_DIR` | path, sensitive | The transcripts the build reads. |
| `OARS_SELLER_PRICE_USD` | value | The amount of each pack's price. Read by `price` only. |
| `OARS_SELLER_WORKLOAD_ID` | value | The seller's workload id (a UUID). Read by `price` only. |

Every path must point outside a git repository. The server refuses to start otherwise, with one line naming the variable. A missing or malformed value prints one line naming the variable and never its value.

## Build and run the image

Build from the repository root:

```sh
docker build -f packages/pack-seller/Dockerfile -t oars-pack-seller .
```

The image runs as the non-root `node` user and holds no secret, no operator login, and no `OARS_API_KEY`. Mount the key file and a folder for each path. The files must be readable by uid 1000 (`node`), and the folders writable by it, because the seller writes builds and records:

```sh
docker run --rm -p 8790:8790 -v /srv/seller:/data \
  -e OARS_SELLER_API_URL=<platform url> -e OARS_SELLER_PORT=8790 \
  -e OARS_SELLER_SDK_KEY_FILE=/data/seller.key \
  -e OARS_SELLER_PACKS_DIR=/data/packs -e OARS_SELLER_TERMS_FILE=/data/terms.json \
  -e OARS_SELLER_OWNERS_FILE=/data/owners.jsonl -e OARS_SELLER_INDEX_KEY_FILE=/data/index.key \
  -e OARS_SELLER_STORE_DIR=/data/store -e OARS_SELLER_PROJECTS_DIR=/data/projects \
  oars-pack-seller
```

`GET /health` answers `{"status":"ok"}`. The image holds no `git` binary. A download for an owner that is not opted in to outcome pointers builds without it; outcome pointers need git in the image. Without Docker, run `npm run build` and `npm start -w packages/pack-seller` with the same variables.

## 1. Create the price

On the operator machine, not in the image. **Account owner:** it needs the operator login (`oars login --api-url <url>`) or `OARS_API_KEY`.

```sh
npm start -w packages/pack-seller -- price
```

It needs every variable above except `OARS_SELLER_SDK_KEY*` and `OARS_SELLER_PORT`, and it prints one line per pack: `Price pack-<packId> created.`, or `already exists.` on a second run. A pack's price is 3 credits at `OARS_SELLER_PRICE_USD`. If a price exists with other terms, the command leaves it unchanged and exits 1, because an amount is immutable once charged. A new edition is a new pack id and so a new price.

## 2. Set the fee policy

**Account owner.** The seller's fee is an admin write on the platform side, not a setting in this code. The value for pack sales is 0 basis points. The admin route is not in the public client, so this runbook does not name it.

## 3. Check a sale end to end in test mode

The tests run the whole loop against a fake platform: price, offer, buy, settle, three downloads, and `validate-pack` on each archive.

```sh
npm test -w packages/pack-seller
```

`src/money-loop.test.ts` is the loop. It uses no network, no real account, and no money. For a real test-mode run on the platform, **Account owner** supplies the test-mode keys and the workload id, then:

1. Start the seller (above) with the test-mode key file.
2. Create the price (step 1) and set the fee policy (step 2).
3. As a buyer, follow "Buy a pack" in `packages/pack-seller/README.md`: ask for an offer, buy, poll the purchase until it leaves `PENDING`, download, and run `validate-pack` on the result.
4. A fourth download answers 402 `No credits are available.`, and `GET /credits` shows 0.

## Not stated here

How a buying agent is registered, and the fee-policy route, are not in this repository, so this runbook does not describe them.
