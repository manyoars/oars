# paid-api: instructions for coding agents

## What this is

An HTTP API (Hono, Node 24) that sells one call, `POST /v1/transform {text}`, and charges one prepaid credit for each
successful call. A credit is held when the call starts, spent when it returns 2xx, and returned on any 4xx, 5xx, timeout or
crash. Buyers are stateless: a bearer token `oc_...` minted by `POST /v1/customers`; the server stores nothing.

## What to change

- **The handler to replace:** `src/transform.ts`. Keep its signature; swap the body for what this API sells (an LLM call, a PDF
  summarizer).
- **The line that charges:** the `withCredits(...)` call in the `/v1/transform` route of `src/app.ts`. A new paid route
  goes through `withCredits` the same way.

## Rules

- Charge only through `src/billing.ts`. Do not call billing from a route, and never add Stripe or any payment processor.
- Keep `GET /healthz` free and unauthenticated, and keep listening on `PORT` (default 8080).
- Requests stay under the platform's 1 MB cap; for larger inputs take a presigned upload URL instead of a body.
- Secrets go in only as agent secrets, never in the code or the image. Do not start your own secret names with `AOR_`.

## Run it locally

```sh
OARS_DEV_FAKE_BILLING=1 npm run dev      # in-memory fake billing, nothing is charged; never set it in production
npm test                                 # the unit tests
```

Without `AOR_SDK_KEY` the server refuses to start; the platform injects the key.

## Deploy

```sh
npx @manyoars/oars login
oars deploy --template paid-api          # first deploy
oars deploy --image <ref@sha256:...>     # after you rebuild and push your own image
oars test-charge                         # one test-mode purchase against your own price
oars status
```
