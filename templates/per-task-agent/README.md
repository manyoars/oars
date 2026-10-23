# per-task-agent

A Many Oars starter template: a job your customers pay for per finished task, through prepaid credits. The sample task,
`POST /v1/tasks {url}`, audits a landing page and returns what it found. It is deterministic by default, so the whole loop
runs in test mode with no third-party key; set an `ANTHROPIC_API_KEY` secret and a model writes a short summary on top.
Replace that one task with what you sell.

You pay only for successful calls: a credit is held when your call starts, spent when it succeeds, and returned when it fails or times out.

## Run it locally

```sh
OARS_DEV_FAKE_BILLING=1 npm run dev        # http://localhost:8080, in-memory billing, nothing is charged
curl localhost:8080/                       # the endpoints and price refs, free
curl -X POST localhost:8080/v1/customers -d '{"countryCode":"US","regionCode":"NY"}'   # a bearer token, shown once
```

Without `AOR_SDK_KEY` the server refuses to start; `OARS_DEV_FAKE_BILLING=1` is the only way around that, and the image's
default command never sets it. On the platform, `AOR_SDK_KEY` is injected.

| Variable | Default | Meaning |
|----------|---------|---------|
| `AOR_SDK_KEY` | none, required | The agent's SDK key; the platform injects it |
| `OARS_API_URL` | `https://api.manyoars.com` | Where billing lives |
| `OARS_PRICE_REFS` | `task-1,tasks-5` | The price refs `GET /` advertises, comma separated |
| `OARS_DEV_FAKE_BILLING` | unset | `1` selects the in-memory fake, for local development only |
| `ANTHROPIC_API_KEY` | unset | An agent secret you add; with it each audit carries a model-written `summary` |
| `PORT` | `8080` | Listen port |

## Endpoints

| Call | Auth | What it does |
|------|------|--------------|
| `GET /healthz` | none | Liveness |
| `GET /` | none | The endpoints, the price refs and the charging sentence, as JSON |
| `POST /v1/customers` | none | Mints a bearer token `oc_...` (shown once) for `{countryCode, regionCode?}` |
| `POST /v1/credits/checkout` | bearer | `{priceRef}` returns `{checkoutUrl}` to buy a pack |
| `GET /v1/credits` | bearer | The buyer's balance |
| `POST /v1/tasks` | bearer | `{url}`: costs one credit when the audit is returned; send an `Idempotency-Key` to retry safely |

The token is the buyer's only secret: the server stores nothing and bills under `cus_` plus the SHA-256 of the token, so a
leaked `customerRef` cannot spend credits. Keep the token secret; losing it loses the credits until token recovery ships.

## The task

`POST /v1/tasks {"url": "https://example.com/"}` fetches the page and answers 200 with the audit: `title`,
`metaDescription`, `h1` (every one), `openGraph`, `https`, `responseTimeMs`, `pageWeightBytes`, the `finalUrl` after
redirects, and `checks`, a pass/warn/fail list with a message for each. With `ANTHROPIC_API_KEY` set it also has a
`summary`.

| Status | Code | Why | Charged |
|--------|------|-----|---------|
| 200 | none | The audit | 1 credit |
| 400 | `INVALID_REQUEST` | `url` is missing or not http or https | no |
| 402 | `INSUFFICIENT_CREDITS` | No credit; the body carries `checkoutUrl` and the task never runs | no |
| 422 | `URL_NOT_ALLOWED` | The address, or a redirect hop, is private, loopback, link-local or `fdaa::/16` | no |
| 422 | `TOO_MANY_REDIRECTS`, `PAGE_TOO_LARGE`, `PAGE_NOT_AUDITABLE`, `NOT_HTML` | More than 5 hops, over 5 MiB, a final non-2xx page, or a non-HTML page | no |
| 502 | `PAGE_UNREACHABLE`, `SUMMARY_FAILED` | The page could not be reached, or the model summary failed | no |
| 504 | `HANDLER_TIMEOUT` | The task ran past its 45 seconds | no |

A buyer is charged only for a complete result: a page that errors, a non-HTML page and a failed model summary each fail the
task, and a failed task costs nothing. The reason goes to the agent's log (a JSON line on stderr), never to the buyer.

The fetch is guarded against server-side request forgery (SSRF): it resolves the name, refuses private, loopback,
link-local and `fdaa::/16` addresses, connects to the address it checked, and re-checks every redirect hop the same way
(at most 5; a sixth is refused). `src/fetch-page.ts` is the only code that fetches a buyer's address.

## How a call is charged

`src/billing.ts` (`withCredits`) reserves one credit, runs the task, commits on a 2xx and releases on anything else. The
response leaves only after the commit succeeds. The task has a 45-second budget, so the synchronous request stays inside the
edge proxy's idle limit, and the hold is a 60-second hold (`HOLD_TTL_SECONDS`), so a task that runs to its
limit is still settled before the hold lapses. Both numbers come from the Many Oars 1T minimum design, section 2.3
(`docs/superpowers/specs/2026-10-21-many-oars-1t-minimum-design.md` in the platform repository).

- A 4xx, a 5xx, a timeout or a thrown error releases the credit and the buyer pays nothing.
- No credit gives 402 with a `checkoutUrl` and the task never runs. Two tasks racing for the last credit get one hold and
  one immediate 402.
- The reservation's key is the SHA-256 of the buyer, their `Idempotency-Key` and the body, so a retry of the same request
  is the same call, and a reused key with a new body is a new one.
- The same call arriving while it runs gets 409 `REQUEST_IN_PROGRESS` with `Retry-After`.
- After a paid call whose answer was lost, a retry runs the task again and charges nothing, at most twice and within 10
  minutes of the commit; after that, 409 `IDEMPOTENCY_KEY_SPENT`.
- Replays: a replay re-runs the call free; a failed replay does not refund the original charge. The template keeps no state, so it cannot return the stored result.

## Make it yours

Edit `src/audit.ts` and the `task` handler in `src/app.ts` that calls it: they are the work to replace. Charge only through
`withCredits` in `src/billing.ts`; the line that does is the `withCredits` call in the `/v1/tasks` route of `src/app.ts`.
Change the prices in the Billing tab and the refs in `OARS_PRICE_REFS`. If your task takes longer than 45 seconds, return
a task id for the buyer to poll rather than raising `TASK_BUDGET_MS`.

## Test

```sh
npm test                  # the unit tests
npm run test:monorepo    # monorepo only: the contract test against Prism, the catalog entry and README checks
docker build -f templates/per-task-agent/Dockerfile -t per-task-agent .   # monorepo only: from the repository root
OARS_SMOKE_IMAGE=per-task-agent npm run test:smoke                        # monorepo only: the image against Prism (needs Docker)
```

`catalog-entry.yaml` is the platform's catalog entry for this template; its image digest is filled in by the release.
`test/monorepo/` holds the tests that need the Many Oars monorepo around the template (they read its `openapi/public.json` or its
workflow, or build its image). Delete that folder in your copy; `npm test` skips it anyway.
