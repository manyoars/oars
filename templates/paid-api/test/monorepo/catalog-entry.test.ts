// Manifest: the catalog entry the platform's template catalog takes (kebab-case keys, bound by Spring) validates against
// AgentTemplateResponse. The wire form is what the API serves, so the keys are converted to camelCase first.
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../../src/config.js';
import { agentTemplateSchema } from './agent-template-schema.js';

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
      return [WIRE_NAMES.get(camel) ?? camel, toWire(inner)];
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
const validate = ajv.compile({ ...agentTemplateSchema, components: { schemas: strict(schemas) } });

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
    const prices = wrong['starterPrices'].map((price: unknown) => (isRecord(price) ? { ...price, amountUsd: 0.1, surprise: true } : price));

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
      { priceRef: 'calls-100', amountUsd: 5, kind: 'CREDIT_PACK', credits: 100 },
      { priceRef: 'calls-1000', amountUsd: 40, kind: 'CREDIT_PACK', credits: 1000 },
    ]);
    expect(prices.map((price: unknown) => (isRecord(price) ? price['priceRef'] : undefined))).toEqual(loadConfig({ OARS_DEV_FAKE_BILLING: '1' }).priceRefs);
  });
});

describe('the AgentTemplateResponse schema', () => {
  // Tripwire: the hand-written copy exists only because openapi/public.json lacks the real one (spec 1's T87).
  it('is swapped for the generated one as soon as openapi/public.json carries it', () => {
    expect(
      Object.keys(schemas),
      'openapi/public.json now has AgentTemplateResponse: validate the catalog entry against it and delete test/agent-template-schema.ts',
    ).not.toContain('AgentTemplateResponse');
  });
});
