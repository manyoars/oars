# paid-api

A Many Oars starter template: an HTTP API that charges per call through prepaid credits. The sample endpoint,
`POST /v1/transform {text}`, returns word, sentence and reading-time counts and a slug. It is deterministic, so the whole
loop runs in test mode with no third-party key. Replace that one handler with what you sell.

You pay only for successful calls: a credit is held when your call starts, spent when it succeeds, and returned when it fails or times out.

## Run it locally

```sh
OARS_DEV_FAKE_BILLING=1 npm run dev        # http://localhost:8080, in-memory billing, nothing is charged
curl localhost:8080/                       # the endpoints and price refs, free
curl -X POST localhost:8080/v1/customers -d '{"countryCode":"US","regionCode":"NY"}'   # a bearer token, shown once
```

Without `AOR_SDK_KEY` the server refuses to start; `OARS_DEV_FAKE_BILLING=1` is the only way around that, and the image's
default command never sets it. On the platform, `AOR_SDK_KEY` and `OARS_PUBLIC_URL` are injected; do not declare either in
the manifest. Outside the platform, set `OARS_PUBLIC_URL` to an http(s) URL with no query or fragment (`loadConfig` in
`src/config.ts`); trailing slashes are stripped.

| Variable | Default | Meaning |
|----------|---------|---------|
| `AOR_SDK_KEY` | none, required | The agent's SDK key; the platform injects it |
| `OARS_PUBLIC_URL` | none, required unless `OARS_DEV_FAKE_BILLING=1`, which defaults it to `http://localhost:<PORT>` | This agent's public URL; the platform injects it, so set it only outside the platform. Checkout returns the buyer to `<it>/?checkout=success` or `<it>/?checkout=cancel`. The server refuses to start without it |
| `OARS_API_URL` | `https://api.manyoars.com` | Where billing lives |
| `OARS_PRICE_REFS` | `calls-100,calls-1000` | The price refs `GET /` advertises, comma separated |
| `OARS_DEV_FAKE_BILLING` | unset | `1` selects the in-memory fake, for local development only |
| `OARS_CUSTOMERS_PER_MINUTE` | `5` | Anonymous `POST /v1/customers` requests one client address may make in a minute; the next gets `429` with `Retry-After`. A whole number of 1 or more |
| `OARS_TRUST_PROXY` | unset | `1` counts a request against the address in `CF-Connecting-IP` instead of the socket's; set it behind the oars router only (see "Minting is rate limited") |
| `PORT` | `8080` | Listen port |

## Endpoints

| Call | Auth | What it does |
|------|------|--------------|
| `GET /healthz` | none | Liveness |
| `GET /` | none | The endpoints, the price refs and the charging sentence, as JSON |
| `POST /v1/customers` | none | Mints a bearer token `oc_...` (shown once) for `{countryCode, regionCode}`; `regionCode`, the two-letter state, is required for `US`. 5 requests a minute per client address (`OARS_CUSTOMERS_PER_MINUTE`), then `429` |
| `POST /v1/credits/checkout` | bearer | `{priceRef}` returns `{checkoutUrl}` to buy a pack |
| `GET /v1/credits` | bearer | The buyer's balance |
| `POST /v1/transform` | bearer | Costs one credit on a 2xx; send an `Idempotency-Key` to retry safely |
| `POST /v1/recover` | none | `{email}`, the one used at checkout: always 202, whether or not it holds credits; if it does, a link that works once for 15 minutes is emailed. 5 requests a minute per client address |
| `GET /recover` | none | The page the link opens: one click trades the link for a new token with the same credits and stops the old one |
| `POST /v1/recover/redeem` | none | What that page calls: `{recoveryToken}` returns the new token once |

The token is the buyer's only secret: the server stores nothing and bills under `cus_` plus the SHA-256 of the token, so a
leaked `customerRef` cannot spend credits. Keep the token secret. A lost token keeps its credits; recover it at `/recover`:
`POST /v1/recover` with the email you used at checkout (or open `/recover`), and the emailed link gives you a new token with
the same credits and stops the old one. A buyer who never bought holds no credits and just mints a new token.

## Minting is rate limited

`POST /v1/customers` takes no token, and each customer it mints can lead to a Checkout session, so left open it is where card
testing starts. It is limited per client address: a sliding window in this process's memory, 5 requests a minute unless
`OARS_CUSTOMERS_PER_MINUTE` says otherwise. Over the limit the answer is `429` with the code `RATE_LIMITED` and a
`Retry-After` in seconds, and billing is not called. A request that fails validation counts too. `POST /v1/recover` keeps its
own count.

Which address counts is the one setting to get right. By default it is the socket's, because a header is only what the client
says it is: a caller who sends a new `CF-Connecting-IP` with every request gets a new allowance if the server believes it.
Behind a proxy every socket is the proxy's, so all your buyers would share one allowance. Behind the oars router, the edge in
front of every `<slug>.oars.run` agent, set `OARS_TRUST_PROXY=1`: Cloudflare sets `CF-Connecting-IP` and overwrites any value
a client sent, the router passes it on (the router sets no client-address header of its own), and the limit counts that
address. A request without the header still counts against its socket. Do not set it where clients can reach the server
directly, since they could then name any address they like.

## How a call is charged

`src/billing.ts` (`withCredits`) reserves one credit, runs the handler (aborted at 30 seconds, inside the 45-second hold),
commits on a 2xx and releases on anything else. The response leaves only after the commit succeeds.

- A 4xx, a 5xx, a timeout or a thrown error releases the credit and the buyer pays nothing.
- No credit gives 402 with a `checkoutUrl` and the handler never runs.
- The reservation's key is the SHA-256 of the buyer, their `Idempotency-Key` and the body, so a retry of the same request
  is the same call, and a reused key with a new body is a new one.
- The same call arriving while it runs gets 409 `REQUEST_IN_PROGRESS` with `Retry-After`.
- After a paid call whose answer was lost, a retry runs the handler again and charges nothing, at most twice and within 10
  minutes of the commit; after that, 409 `IDEMPOTENCY_KEY_SPENT`.
- Replays: a replay re-runs the call free; a failed replay does not refund the original charge. The template keeps no state, so it cannot return the stored result.

## Make it yours

Edit `src/transform.ts`, the one handler to replace, and keep the signature. Charge only through `withCredits` in
`src/billing.ts`; the line that does is the `withCredits` call in the `/v1/transform` route of `src/app.ts`. Change the
prices in the Billing tab and the refs in `OARS_PRICE_REFS`.

## Test

```sh
npm test                  # the unit tests
npm run test:monorepo    # monorepo only: the contract test against Prism, the catalog entry and README checks
docker build -f templates/paid-api/Dockerfile -t paid-api .   # monorepo only: from the repository root
OARS_SMOKE_IMAGE=paid-api npm run test:smoke                  # monorepo only: the image against Prism (needs Docker)
```

`catalog-entry.yaml` is the platform's catalog entry for this template; its image digest is filled in by the release.
`test/monorepo/` holds the tests that need the Many Oars monorepo around the template (they read its `openapi/public.json` or its
workflow, or build its image). Delete that folder in your copy; `npm test` skips it anyway.
