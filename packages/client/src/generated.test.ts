import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generate, schemaUrl } from '../scripts/generate.mjs';

describe('generated types', () => {
  it('are what openapi-typescript makes of openapi/public.json', async () => {
    const committed = readFileSync(schemaUrl, 'utf8');

    expect(committed, 'src/generated/schema.d.ts is stale: run `just openapi-refresh <spec>` or `npm run generate -w packages/client`').toBe(
      await generate(),
    );
  });
});
