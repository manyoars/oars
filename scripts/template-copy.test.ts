// The copy rule a developer's copied template follows (lead 30/31): the monorepo-only tests, their configs and the dev
// dependencies only they use are gone; everything else is the template as shipped. scripts/check-template-copy.mjs installs
// and tests such a copy outside the monorepo; this file pins what the copy contains, without an install.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyTemplate } from './template-copy.mjs';

const templates = fileURLToPath(new URL('../templates/', import.meta.url));
const CLIENT = 'file:./oars-client.tgz';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

describe.each(['paid-api', 'per-task-agent'])('a copy of %s', (template) => {
  let copy = '';
  beforeEach(() => {
    copy = mkdtempSync(join(tmpdir(), 'template-copy-test-'));
    copyTemplate(join(templates, template), copy, CLIENT);
  });
  afterEach(() => {
    rmSync(copy, { recursive: true, force: true });
  });

  // One section of the copy's package.json: dependencies, devDependencies or scripts.
  const section = (key: string): Record<string, unknown> => {
    const manifest: unknown = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8'));
    const found = isRecord(manifest) ? manifest[key] : undefined;
    return isRecord(found) ? found : {};
  };

  it('drops test/monorepo, Dockerfile.dockerignore and the monorepo and smoke vitest configs', () => {
    for (const dropped of ['test/monorepo', 'Dockerfile.dockerignore', 'vitest.monorepo.config.ts', 'vitest.smoke.config.ts']) {
      expect(existsSync(join(copy, dropped)), dropped).toBe(false);
    }
  });

  it('keeps the source, the unit tests, the vitest config, the Dockerfile and the docs', () => {
    for (const kept of ['src/billing.ts', 'test/billing.test.ts', 'vitest.config.ts', 'Dockerfile', 'README.md', 'AGENTS.md', 'catalog-entry.yaml']) {
      expect(existsSync(join(copy, kept)), kept).toBe(true);
    }
  });

  it('never carries installed or built output over from the monorepo', () => {
    expect(existsSync(join(copy, 'node_modules'))).toBe(false);
    expect(existsSync(join(copy, 'dist'))).toBe(false);
  });

  it('drops the dev dependencies and scripts only the monorepo tests use and keeps the rest', () => {
    for (const dev of ['@stoplight/prism-cli', 'ajv', 'yaml']) expect(section('devDependencies'), dev).not.toHaveProperty(dev);
    for (const script of ['test:monorepo', 'test:smoke']) expect(section('scripts'), script).not.toHaveProperty(script);

    expect(Object.keys(section('devDependencies'))).toEqual(expect.arrayContaining(['esbuild', 'tsx']));
    expect(Object.keys(section('dependencies'))).toEqual(expect.arrayContaining(['hono']));
    expect(section('scripts').test).toBe('vitest run');
    expect(section('scripts')).toHaveProperty('build');
  });

  it('installs the client from the given spec in place of its version range', () => {
    expect(section('dependencies')['@manyoars/oars-client']).toBe(CLIENT);
  });
});
