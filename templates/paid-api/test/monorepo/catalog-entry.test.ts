// Manifest: the catalog entry the platform's template catalog takes (kebab-case keys, bound by Spring) validates against
// AgentTemplateResponse, the schema `GET /agents/templates` serves (openapi/public.json). The wire form is what the API serves,
// so the keys are converted to camelCase first and the amounts become decimal strings.
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../../src/config.js';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const publicSpec: unknown = JSON.parse(read('../../../../openapi/public.json'));
const components = isRecord(publicSpec) && isRecord(publicSpec['components']) ? publicSpec['components'] : {};
const schemas = isRecord(components['schemas']) ? components['schemas'] : {};

// The catalog's Java component is `publicIngress`; on the wire it is `public` (@JsonProperty).
const WIRE_NAMES = new Map([['publicIngress', 'public']]);

const toWire = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(toWire);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      const camel = key.replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
      // The YAML amount is a number (5.00 parses as 5); the wire carries a decimal string with two places.
      const wire = camel === 'amountUsd' && typeof inner === 'number' ? inner.toFixed(2) : toWire(inner);
      return [WIRE_NAMES.get(camel) ?? camel, wire];
    }),
  );
};

// The spec's objects name every property they accept, so one that is misspelled (a wrong kebab key) must fail, not pass as extra.
const strict = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(strict);
  if (!isRecord(node)) return node;
  const copy = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, strict(value)]));
  return 'properties' in node ? { ...copy, additionalProperties: false } : copy;
};

const entries: unknown = parse(read('../../catalog-entry.yaml'));
const entry: unknown = Array.isArray(entries) ? entries[0] : undefined;

// OpenAPI's int32/int64/decimal formats are not JSON Schema formats, and the spec carries `example`; neither is under test.
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validate = ajv.compile({ $ref: '#/components/schemas/AgentTemplateResponse', components: { schemas: strict(schemas) } });

describe('catalog-entry.yaml', () => {
  it('holds exactly one template, the one the catalog calls paid-api', () => {
    expect(entries).toHaveLength(1);
    expect(toWire(entry)).toMatchObject({ templateId: 'paid-api', name: 'Paid API' });
  });

  it('validates against AgentTemplateResponse once its keys are camelCase', () => {
    const valid = validate(toWire(entry));

    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  });

  it('is rejected when a field is wrong, so the check above can fail', () => {
    const wrong = toWire(entry);
    if (!isRecord(wrong) || !Array.isArray(wrong['starterPrices'])) throw new Error('the entry has no starter prices');
    const prices = wrong['starterPrices'].map((price: unknown) => (isRecord(price) ? { ...price, credits: 0, surprise: true } : price));

    expect(validate({ ...wrong, starterPrices: prices })).toBe(false);
    expect(validate.errors?.map((error) => error.keyword).sort()).toEqual(['additionalProperties', 'additionalProperties', 'minimum', 'minimum']);
  });

  it('names the image by digest, never a tag', () => {
    const wire = toWire(entry);
    const image = JSON.stringify(wire).match(/"image":"([^"]+)"/)?.[1];

    expect(image).toMatch(/^ghcr\.io\/manyoars\/paid-api@sha256:[0-9a-f]{64}$/);
  });

  it('serves one public service on port 8080, with the size the design fixes', () => {
    expect(toWire(entry)).toMatchObject({ manifest: { name: 'Paid API', services: [{ name: 'api', port: 8080, public: true, cpuMillicores: 250, memoryMib: 256 }] } });
  });

  it('prices credit packs only, under the refs the server advertises by default', () => {
    const wire = toWire(entry);
    const prices = isRecord(wire) && Array.isArray(wire['starterPrices']) ? wire['starterPrices'] : [];

    expect(prices).toMatchObject([
      { priceRef: 'calls-100', amountUsd: '5.00', kind: 'CREDIT_PACK', credits: 100 },
      { priceRef: 'calls-1000', amountUsd: '40.00', kind: 'CREDIT_PACK', credits: 1000 },
    ]);
    expect(prices.map((price: unknown) => (isRecord(price) ? price['priceRef'] : undefined))).toEqual(loadConfig({ OARS_DEV_FAKE_BILLING: '1' }).priceRefs);
  });
});

describe('the AgentTemplateResponse schema', () => {
  it('is the one openapi/public.json generates from the platform, not a hand-written copy', () => {
    expect(Object.keys(schemas)).toContain('AgentTemplateResponse');
  });
});
