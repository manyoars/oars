// Parity: `parity/deploy-plans/<templateId>.json` is the golden plan of each catalog template with its defaults (every starter
// price chosen, start on): the calls the web deploy page makes, in order. The CLI deploys each catalog entry against the fake
// platform, which lists the entry in its catalog (`--template <id>`), and its recorded calls must equal the golden plan. aor-web syncs the same files (design §6, Parity).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { run } from './cli.js';
import type { AgentTemplate } from './commands/templates.js';
import { ExitCode } from './errors.js';
import { fakePlatform } from './fake-platform.js';
import { harness, useServer } from './test-support.js';

useServer();

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TEMPLATES = join(REPO, 'templates');
const PLANS = join(REPO, 'parity', 'deploy-plans');

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

// The catalog's Java component is `publicIngress`; on the wire it is `public` (@JsonProperty).
const WIRE_NAMES = new Map([['publicIngress', 'public']]);

/** The catalog entry's kebab-case keys as the API serves them (camelCase, `public-ingress` as `public`). */
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

const isAgentTemplate = (value: unknown): value is AgentTemplate =>
  isRecord(value) && typeof value['templateId'] === 'string' && typeof value['name'] === 'string' && isRecord(value['manifest']) && Array.isArray(value['starterPrices']);

const readTemplate = (directory: string): AgentTemplate | undefined => {
  const file = join(TEMPLATES, directory, 'catalog-entry.yaml');
  if (!existsSync(file)) return undefined;
  const entries: unknown = parse(readFileSync(file, 'utf8'));
  const entry = toWire(Array.isArray(entries) ? entries[0] : undefined);
  if (!isAgentTemplate(entry)) throw new Error(`${file} is not a catalog entry with a templateId, name, manifest, and starterPrices`);
  return entry;
};

const templates = readdirSync(TEMPLATES).flatMap((directory) => readTemplate(directory) ?? []);
const goldenFiles = readdirSync(PLANS).filter((name) => name.endsWith('.json')).sort();

describe('parity/deploy-plans', () => {
  it('holds one golden plan for each catalog template and no other', () => {
    expect(templates.length).toBeGreaterThan(0);
    expect(goldenFiles).toEqual(templates.map((template) => `${template.templateId}.json`).sort());
  });

  it.each(templates)('the CLI deploys $templateId in the golden plan order: register, each starter price, deploy', async (template) => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    const platform = fakePlatform({ templates });

    const code = await run(['deploy', '--template', template.templateId, '--idempotency-key', 'parity'], h.deps);

    expect(code).toBe(ExitCode.OK);
    const golden: unknown = JSON.parse(readFileSync(join(PLANS, `${template.templateId}.json`), 'utf8'));
    expect(platform.plan()).toEqual(golden);
  });
});
