// t900 (conclusion section 17 rule 7): old and new clients both deposit. `pool-wire-old-client.json` holds the skeletons the client at oars main c87f3da (t881) built from two staged stores (not kept here): an off-list program went with
// `sub: null` and no flags, and a model or version the client's capture had closed read `<literal>` (the second test sets that form by hand). The parser at this branch reads each, refuses none, and sets nothing aside.
import { describe, expect, it } from 'vitest';
import { parseSkeleton } from './pool-wire.js';
import old from './pool-wire-old-client.json' with { type: 'json' };
import { LITERAL } from './public-vocabulary.js';

const skeletons: readonly unknown[] = old;

describe('a skeleton the client before t900 built', () => {
  it('has the shape this change moved: an off-list program with no subcommand or flag', () => {
    expect(skeletons).toHaveLength(2);
    expect(JSON.stringify(skeletons[0])).toContain('"program":"acme-deploy","sub":null,"flags":[]');
  });

  it('reads the literal an older capture left in a model and a version', () => {
    const wire: unknown = JSON.parse(JSON.stringify(skeletons[0]).replaceAll('"model":"claude-opus-5-5"', `"model":"${LITERAL}"`).replaceAll('"harnessVersion":"2.1.314"', `"harnessVersion":"${LITERAL}"`));
    const parsed = parseSkeleton(wire);
    expect(parsed.ok && parsed.extensions).toEqual([]);
    expect(JSON.stringify(wire)).toContain(`"model":"${LITERAL}"`);
  });

  it.each(skeletons.map((skeleton, at) => [at, skeleton]))('parses skeleton %i: none refused, nothing set aside', (_at, skeleton) => {
    const parsed = parseSkeleton(JSON.parse(JSON.stringify(skeleton)));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.extensions).toEqual([]);
  });

  it('parses a main-era step that holds a public multi-letter single-dash flag, with nothing set aside', () => {
    const wire: unknown = JSON.parse(JSON.stringify(skeletons[0]).replace('"program":"acme-deploy","sub":null,"flags":[]', '"program":"pwsh","sub":null,"flags":["-NoProfile"]'));
    expect(JSON.stringify(wire)).toContain('"program":"pwsh","sub":null,"flags":["-NoProfile"]');
    const parsed = parseSkeleton(wire);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.extensions).toEqual([]);
  });
});
