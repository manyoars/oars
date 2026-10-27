# per-task-agent: instructions for coding agents

## What this is

A job (Hono, Node 24) that sells one task, `POST /v1/tasks {url}`: it fetches a landing page and returns an audit (title,
meta description, one `h1`, Open Graph tags, HTTPS, response time, page weight, and a pass/warn/fail list). It charges one
prepaid credit for each finished task. A credit is held when the task starts, spent when it returns 2xx, and returned on any
4xx, 5xx, timeout or crash. Buyers are stateless: a bearer token `oc_...` minted by `POST /v1/customers`; the server stores
nothing. With an `ANTHROPIC_API_KEY` secret a model adds a short `summary`; without one the audit is deterministic.

## What to change

- **The work to replace:** `src/audit.ts` (`auditPage` turns a fetched page into findings) and the `task` handler in
  `src/app.ts` that calls it (fetch, audit, optional summary). Swap them for what this agent does.
- **The line that charges:** the `withCredits(...)` call in the `/v1/tasks` route of `src/app.ts`. A new paid route goes
  through `withCredits` the same way.
- **The time it may take:** `TASK_BUDGET_MS` (45 s) and `HOLD_TTL_SECONDS` (60 s) in `src/app.ts`. The hold must outlast the
  budget, and the budget stays inside the edge proxy's idle limit because the request is synchronous. For work that takes longer,
  return a task id and let the buyer poll; do not raise the budget.

## Rules

- Charge only through `src/billing.ts`. Do not call billing from a route, and never add Stripe or any payment processor.
  `src/billing.ts` and `src/recovery.ts` (token recovery) are byte-for-byte copies of the files in `templates/paid-api/src/`;
  in the Many Oars monorepo `just check` fails when they differ, so change both or neither.
- Any fetch of an address the buyer chose goes through `src/fetch-page.ts`: it refuses private, loopback, link-local and
  `fdaa::/16` addresses after DNS resolution and again on every redirect hop (at most 5). Do not add a second way to fetch a
  buyer's URL, and do not weaken that file's tests.
- A task the buyer would not want to pay for fails with a non-2xx status: a page that errors, a page that is not HTML, a
  summary that could not be written. Never return a partial result as a 200.
- Keep `GET /healthz` free and unauthenticated, and keep listening on `PORT` (default 8080).
- Requests stay under the platform's 1 MB cap; for larger inputs take a presigned upload URL instead of a body.
- Secrets (`ANTHROPIC_API_KEY`, your own keys) go in only as agent secrets, never in the code or the image. Do not start your
  own secret names with `AOR_`.

## Run it locally

```sh
OARS_DEV_FAKE_BILLING=1 npm run dev      # in-memory fake billing, nothing is charged; never set it in production
npm test                                 # the unit tests
```

Without `AOR_SDK_KEY` the server refuses to start; the platform injects the key.

## Deploy

```sh
npx @manyoars/oars login
oars deploy --template per-task-agent    # first deploy
oars deploy --image <ref@sha256:...>     # after you rebuild and push your own image
oars test-charge                         # one test-mode purchase against your own price
oars status
```
