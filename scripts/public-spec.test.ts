import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../openapi/${name}`, import.meta.url)), 'utf8'));

const isRecord = (value: unknown): value is { [key: string]: unknown } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const walk = (value: unknown, visit: (key: string, child: unknown) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child);
      walk(child, visit);
    }
  }
};

// The committed spec is generated from an aor-platform checkout that CI does not have, so these check it against itself:
// a hand edit, or a list change without `just openapi-refresh`, shows here.
describe('openapi/public.json', () => {
  const spec = read('public.json');
  const listed = read('public-operations.json');

  it('holds exactly the operations public-operations.json lists', () => {
    const present: string[] = [];
    walk(spec, (key, child) => {
      if (key === 'operationId' && typeof child === 'string') present.push(child);
    });

    const ids = Array.isArray(listed) ? listed.filter((id): id is string => typeof id === 'string') : [];
    expect(ids.length).toBeGreaterThan(0);
    expect(present.sort()).toEqual(ids.sort());
  });

  it('resolves every $ref inside itself', () => {
    const dangling: string[] = [];
    walk(spec, (key, child) => {
      if (key !== '$ref' || typeof child !== 'string') return;
      const target = child
        .replace(/^#\//, '')
        .split('/')
        .reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), spec);
      if (target === undefined) dangling.push(child);
    });

    expect(dangling).toEqual([]);
  });
});
