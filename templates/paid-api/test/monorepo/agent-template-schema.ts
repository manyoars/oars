// AgentTemplateResponse as spec 1's T87 (unit E37) defines it: {templateId, name, description, manifest, starterPrices[]},
// each starter price {priceRef, displayName, amountUsd, kind, credits?}. Hand-written because openapi/public.json does not
// carry the schema yet; catalog-entry.test.ts fails once it does, and this file is then deleted in favor of the generated one.
// `manifest` is RegisterWorkloadRequest and `kind` is PriceKind, both taken from openapi/public.json.
import type { SchemaObject } from 'ajv';

export const agentTemplateSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['templateId', 'name', 'description', 'manifest', 'starterPrices'],
  properties: {
    templateId: { type: 'string', pattern: '^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$' },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', minLength: 1, maxLength: 4000 },
    manifest: { $ref: '#/components/schemas/RegisterWorkloadRequest' },
    starterPrices: { type: 'array', maxItems: 10, items: { $ref: '#/definitions/TemplateStarterPrice' } },
  },
  definitions: {
    TemplateStarterPrice: {
      type: 'object',
      additionalProperties: false,
      required: ['priceRef', 'displayName', 'amountUsd', 'kind'],
      properties: {
        priceRef: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
        displayName: { type: 'string', minLength: 1, maxLength: 120 },
        amountUsd: { type: 'number', minimum: 0.5 },
        kind: { $ref: '#/components/schemas/PriceKind' },
        credits: { type: ['integer', 'null'], minimum: 1 },
      },
    },
  },
};
