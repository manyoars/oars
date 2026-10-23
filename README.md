# oars

The Many Oars open-source monorepo. Apache-2.0.

Many Oars lets a developer put a paid agent on the AOR platform in minutes. This repository holds what a developer copies,
installs or imports to do that:

| Path | What it is | State |
|------|------------|-------|
| `packages/client` | `@manyoars/oars-client`: TypeScript types generated from `openapi/public.json` and a thin `openapi-fetch` wrapper that adds the bearer token, `Idempotency-Key` and `User-Agent` | published on npm as [`@manyoars/oars-client`](https://www.npmjs.com/package/@manyoars/oars-client) at 0.1.x |
| `openapi/public.json` | The slice of the platform API that the CLI and the templates call, generated from the platform's OpenAPI by `scripts/openapi-public.mjs` and the operation list in `openapi/public-operations.json` | here |
| `templates/paid-api` | Starter template: an HTTP API that charges per call | here |
| `templates/per-task-agent` | Starter template: a job that charges per finished task | here |
| `packages/cli` | `@manyoars/oars`, the `oars` command: `login`, `templates`, `deploy`, `status`, `test-charge` | to come |

## Develop

Node 24 (LTS) and [`just`](https://github.com/casey/just).

```sh
npm ci
just check     # billing sync, client build, lint, typecheck and unit tests; CI runs the same recipe
```

`just check` includes a staleness test: it regenerates the client's types from `openapi/public.json` and fails when
`packages/client/src/generated/schema.d.ts` differs.

It also runs `scripts/check-billing-sync.mjs`, which fails (naming both paths) when the two templates' `src/billing.ts`
differ. The file holds all the money handling and is one file in every template: change both copies or neither.

## The public API spec

`openapi/public.json` is a committed copy, never edited by hand. To add a call, list its `operationId` in
`openapi/public-operations.json` and run:

```sh
just openapi-refresh <path to aor-platform/api-specs/openapi.json>
```

That rewrites `openapi/public.json` (the listed operations and the components they reference, keys sorted, so a diff shows only
real changes) and the client's generated types. The script fails, naming the operation, when a listed `operationId` is not in
the source.

## License

[Apache-2.0](LICENSE).
