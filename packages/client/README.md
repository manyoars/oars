# @manyoars/oars-client

A typed client for the Many Oars public API. The types are generated from the API's OpenAPI document, and the client is a thin
[openapi-fetch](https://openapi-ts.dev/openapi-fetch/) wrapper that adds up to three headers to a call: `Authorization: Bearer
<token>` when you give a token, `User-Agent: oars/<version>`, and a fresh `Idempotency-Key` on a mutation that does not bring its own.

Node 22.23.4 or later. ESM only.

## Install

```sh
npm install @manyoars/oars-client
```

## Use

```ts
import { createOarsClient } from '@manyoars/oars-client';

const client = createOarsClient({ version: 'my-agent', token: process.env.OARS_TOKEN });

const { data, error } = await client.GET('/me/api-keys', { params: { query: { page: 0, size: 20 } } });
if (error) throw new Error('listing the keys failed');
console.log(data.content?.length);
```

`baseUrl` defaults to `https://api.manyoars.com` (exported as `DEFAULT_API_URL`). A caller that retries a mutation passes its own
`Idempotency-Key` header so the platform can replay the first answer instead of running the call twice. The generated `paths`,
`operations` and `components` types are exported for code that needs a request or response type by name.

## Source

[github.com/manyoars/oars](https://github.com/manyoars/oars/tree/main/packages/client), Apache-2.0.
