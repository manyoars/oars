import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// These cases spawn a node process; under load that takes 8 s or more, past vitest's 5 s default.
vi.setConfig({ testTimeout: 30_000 });

const script = fileURLToPath(new URL('./openapi-public.mjs', import.meta.url));

const ok = (description: string, ref: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: ref } } },
});

// A small stand-in for the platform's combined spec: three paths, one of them with an unlisted method, a
// schema chain (Order -> Line -> Quantity), a shared response component and schemas nothing listed uses.
const source = {
  openapi: '3.1.0',
  info: { title: 'Combined', description: 'Internal title for every microservice', version: '1.0.0' },
  tags: [
    { name: 'Orders', description: 'Order lifecycle' },
    { name: 'Internal', description: 'Not for the public' },
    { name: 'Unused', description: 'Nothing listed carries this tag' },
  ],
  paths: {
    '/orders': {
      post: {
        tags: ['Orders'],
        operationId: 'createOrder',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateOrder' } } } },
        responses: { '201': ok('Created', '#/components/schemas/Order'), '400': { $ref: '#/components/responses/Problem' } },
      },
      get: {
        tags: ['Internal'],
        operationId: 'listAllOrders',
        responses: { '200': ok('All', '#/components/schemas/AuditEntry') },
      },
    },
    '/orders/{orderId}': {
      parameters: [{ $ref: '#/components/parameters/OrderId' }],
      get: {
        tags: ['Orders'],
        operationId: 'getOrder',
        responses: { '200': ok('One', '#/components/schemas/Order') },
      },
      delete: {
        tags: ['Internal'],
        operationId: 'purgeOrder',
        responses: { '204': { description: 'Gone' } },
      },
    },
    '/audit': {
      get: {
        tags: ['Internal'],
        operationId: 'audit',
        responses: { '200': ok('Audit', '#/components/schemas/AuditEntry') },
      },
    },
  },
  components: {
    schemas: {
      CreateOrder: { type: 'object', properties: { lines: { type: 'array', items: { $ref: '#/components/schemas/Line' } } } },
      Order: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'array', items: { $ref: '#/components/schemas/Line' } } } },
      Line: { type: 'object', properties: { size: { $ref: '#/components/schemas/Quantity' } } },
      Quantity: { type: 'object', properties: { amount: { type: 'string' } } },
      Problem: { type: 'object', properties: { code: { type: 'string' } } },
      AuditEntry: { type: 'object', properties: { who: { type: 'string' } } },
      Orphan: { type: 'object' },
    },
    responses: { Problem: ok('Problem', '#/components/schemas/Problem') },
    parameters: { OrderId: { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } } },
    securitySchemes: { 'bearer-jwt': { type: 'http', scheme: 'bearer' } },
  },
};

let dir: string;
let sourcePath: string;
let operationsPath: string;
let outPath: string;

const writeJson = (path: string, value: unknown) => {
  writeFileSync(path, JSON.stringify(value));
};

const run = (operations: string[], spec: unknown = source) => {
  writeJson(sourcePath, spec);
  writeJson(operationsPath, operations);
  return spawnSync(process.execPath, [script, sourcePath, '--operations', operationsPath, '--out', outPath], {
    encoding: 'utf8',
  });
};

const isRecord = (value: unknown): value is { [key: string]: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), value);

const keysAt = (value: unknown, ...path: string[]): string[] => {
  const node = at(value, ...path);
  return isRecord(node) ? Object.keys(node) : [];
};

const readOut = (): unknown => JSON.parse(readFileSync(outPath, 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oars-openapi-public-'));
  sourcePath = join(dir, 'source.json');
  operationsPath = join(dir, 'operations.json');
  outPath = join(dir, 'public.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('openapi-public.mjs', () => {
  it('exits non-zero naming each listed operation the source does not have', () => {
    const result = run(['createOrder', 'noSuchOperation', 'alsoMissing']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('noSuchOperation');
    expect(result.stderr).toContain('alsoMissing');
    expect(result.stderr).not.toContain('createOrder,');
    expect(existsSync(outPath)).toBe(false);
  });

  it('keeps only the listed operations and the components they reference', () => {
    const result = run(['createOrder', 'getOrder']);

    expect(result.status).toBe(0);
    const out = readOut();
    expect(keysAt(out, 'paths')).toEqual(['/orders', '/orders/{orderId}']);
    expect(keysAt(out, 'paths', '/orders')).toEqual(['post']);
    expect(keysAt(out, 'paths', '/orders/{orderId}')).toEqual(['get', 'parameters']);
    expect(keysAt(out, 'components', 'schemas')).toEqual(['CreateOrder', 'Line', 'Order', 'Problem', 'Quantity']);
    expect(keysAt(out, 'components', 'responses')).toEqual(['Problem']);
    expect(keysAt(out, 'components', 'parameters')).toEqual(['OrderId']);
    expect(keysAt(out, 'components')).not.toContain('securitySchemes');
    expect(at(out, 'tags')).toEqual([{ name: 'Orders', description: 'Order lifecycle' }]);
  });

  it('replaces the source title and description with the public ones and keeps its version', () => {
    const result = run(['getOrder'], { ...source, info: { ...source.info, version: '7.8.9' } });

    expect(result.status).toBe(0);
    const out = readOut();
    expect(at(out, 'info', 'title')).toBe('Many Oars API');
    expect(at(out, 'info', 'version')).toBe('7.8.9');
    const description = at(out, 'info', 'description');
    expect(description).toBe(
      'The Many Oars calls the CLI, starter templates, and coding agents use: register, read, configure, and deploy a workload; exchange an OIDC token; and create, list, rotate, and revoke API keys.',
    );
    expect(description).not.toContain('Internal');
    expect(JSON.stringify(at(out, 'info'))).not.toContain('Combined');
  });

  it('drops a path whose only operations are not listed', () => {
    const result = run(['getOrder']);

    expect(result.status).toBe(0);
    expect(keysAt(readOut(), 'paths')).toEqual(['/orders/{orderId}']);
  });

  it('exits non-zero naming a $ref that points at a component the source lacks', () => {
    const broken = structuredClone(source);
    broken.components.schemas.Line = { type: 'object', properties: { size: { $ref: '#/components/schemas/Gone' } } };

    const result = run(['createOrder'], broken);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('#/components/schemas/Gone');
  });

  it('writes the same bytes whatever order the source lists its keys in', () => {
    run(['getOrder', 'createOrder']);
    const first = readFileSync(outPath, 'utf8');

    const reversed = {
      ...source,
      paths: Object.fromEntries(Object.entries(source.paths).reverse()),
      components: {
        ...source.components,
        schemas: Object.fromEntries(Object.entries(source.components.schemas).reverse()),
      },
    };
    run(['createOrder', 'getOrder'], reversed);
    const second = readFileSync(outPath, 'utf8');

    expect(second).toBe(first);
    expect(first.endsWith('}\n')).toBe(true);
    expect(keysAt(readOut())).toEqual(['components', 'info', 'openapi', 'paths', 'tags']);
  });

  // The platform's spec also carries a money side. The list file selects operations, but the generator is the backstop: a
  // listed operation on a money path, tag, or schema is dropped, so a regeneration cannot bring it back.
  describe('the money side', () => {
    const moneySource = structuredClone(source) as typeof source & {
      paths: { [path: string]: unknown };
      components: { schemas: { [name: string]: unknown } };
    };
    moneySource.paths['/billing/charges'] = {
      post: {
        tags: ['Billing charges'],
        operationId: 'createCharge',
        responses: { '200': ok('Charged', '#/components/schemas/ChargeView') },
      },
    };
    moneySource.paths['/agents/templates'] = {
      get: {
        tags: ['Agent Templates'],
        operationId: 'listTemplates',
        responses: { '200': ok('Templates', '#/components/schemas/TemplateStarterPrice') },
      },
    };
    moneySource.paths['/orders/{orderId}/tagged'] = {
      get: {
        tags: ['Billing mode'],
        operationId: 'taggedOnly',
        responses: { '200': { description: 'Tagged' } },
      },
    };
    moneySource.components.schemas['ChargeView'] = { type: 'object', properties: { id: { type: 'string' } } };
    moneySource.components.schemas['TemplateStarterPrice'] = { type: 'object', properties: { id: { type: 'string' } } };

    it('drops a listed operation on a billing path, with a billing tag, or reaching a money-named schema', () => {
      const result = run(['getOrder', 'createCharge', 'listTemplates', 'taggedOnly'], moneySource);

      expect(result.status).toBe(0);
      const out = readOut();
      expect(keysAt(out, 'paths')).toEqual(['/orders/{orderId}']);
      expect(keysAt(out, 'components', 'schemas')).toEqual(['Order', 'Line', 'Quantity'].sort());
      expect(at(out, 'tags')).toEqual([{ name: 'Orders', description: 'Order lifecycle' }]);
      expect(JSON.stringify(out)).not.toMatch(/charge|billing|price/i);
    });

    it('still names a listed operation the source lacks when the others are money operations', () => {
      const result = run(['createCharge', 'noSuchOperation'], moneySource);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('noSuchOperation');
      expect(result.stderr).not.toContain('createCharge');
    });

    it('drops the 402 response and rewrites the platform texts that name money', () => {
      const withTexts = structuredClone(source) as typeof source & {
        paths: { '/orders/{orderId}': { get: { responses: { [code: string]: unknown } } } };
        components: { schemas: { [name: string]: unknown } };
      };
      withTexts.paths['/orders/{orderId}'].get.responses['402'] = { description: 'Payment Required' };
      withTexts.paths['/orders/{orderId}'].get.responses['409'] = {
        description:
          'PLATFORM_STEWARDED, WORKLOAD_SUSPENDED, COMPUTE_CREDIT_EXHAUSTED (actionUrl: add compute credit)',
      };
      withTexts.components.schemas['Order'] = {
        type: 'object',
        properties: {
          actionUrl: {
            type: 'string',
            description:
              'A URL where a human completes the step that clears this rejection (Stripe onboarding, a credit-pack checkout). Present only when such a step exists.',
          },
        },
      };

      const result = run(['getOrder'], withTexts);

      expect(result.status).toBe(0);
      const out = readOut();
      expect(keysAt(out, 'paths', '/orders/{orderId}', 'get', 'responses')).toEqual(['200', '409']);
      expect(at(out, 'paths', '/orders/{orderId}', 'get', 'responses', '409', 'description')).toBe(
        'PLATFORM_STEWARDED, WORKLOAD_SUSPENDED, COMPUTE_CREDIT_EXHAUSTED',
      );
      expect(at(out, 'components', 'schemas', 'Order', 'properties', 'actionUrl', 'description')).toBe(
        'A URL where a human completes the step that clears this rejection. Present only when such a step exists.',
      );
      expect(JSON.stringify(out)).not.toMatch(/payment|stripe|add compute credit|credit-pack/i);
    });
  });
});
