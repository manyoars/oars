import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./check-billing-sync.mjs', import.meta.url));

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'billing-sync-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const place = (template: string, file: string, content: string): string => {
  const path = join(root, 'templates', template, file);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  return path;
};

const run = () => {
  const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
  return { status: result.status, out: result.stdout, err: result.stderr };
};

describe('scripts/check-billing-sync.mjs', () => {
  it('passes when the two templates carry the same src/billing.ts', () => {
    place('paid-api', 'src/billing.ts', 'export const x = 1;\n');
    place('per-task-agent', 'src/billing.ts', 'export const x = 1;\n');

    expect(run()).toMatchObject({ status: 0, err: '' });
  });

  it('fails on a one-byte difference and names both paths', () => {
    const first = place('paid-api', 'src/billing.ts', 'export const x = 1;\n');
    const second = place('per-task-agent', 'src/billing.ts', 'export const x = 2;\n');

    const { status, err } = run();

    expect(status).toBe(1);
    expect(err).toContain(first);
    expect(err).toContain(second);
  });

  it('fails on a trailing-newline difference, since the copies must be byte for byte', () => {
    place('paid-api', 'src/billing.ts', 'export const x = 1;\n');
    place('per-task-agent', 'src/billing.ts', 'export const x = 1;');

    expect(run().status).toBe(1);
  });

  it('fails and names the path when one copy is missing', () => {
    place('paid-api', 'src/billing.ts', 'export const x = 1;\n');
    const missing = join(root, 'templates', 'per-task-agent', 'src', 'billing.ts');

    const { status, err } = run();

    expect(status).toBe(1);
    expect(err).toContain(missing);
  });

  it('says how to repair it', () => {
    place('paid-api', 'src/billing.ts', 'a');
    place('per-task-agent', 'src/billing.ts', 'b');

    expect(run().err).toMatch(/same change in both|identical|byte for byte/i);
  });
});
