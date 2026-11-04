import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRedactor } from '../sessions/redact.js';
import { checkCall, CROSSING_FORMS, type Crossing } from './checks.js';
import { withLocalBin } from './local-bin.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const root = (): string => {
  const one = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
  made.push(one);
  return one;
};

const bin = (project: string, name: string): void => {
  mkdirSync(join(project, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(project, 'node_modules', '.bin', name), '');
};

const only = (command: string): Crossing => {
  const [crossing, ...rest] = checkCall({ tool: 'Bash', input: { command } }, makeRedactor()).crossings;
  if (crossing === undefined || rest.length > 0) throw new Error(`not one crossing: ${command}`);
  return crossing;
};

describe('npx of a bin the folder already has', () => {
  it('keeps its own closed value', () => {
    expect(CROSSING_FORMS).toContain('local-bin-run');
  });

  it.each([
    ['present in the folder', 'npx tsc --noEmit', '.', 'tsc', 'local-bin-run'],
    ['absent', 'npx tsc --noEmit', '.', 'eslint', 'fetch-and-run'],
    ['in a parent folder', 'npx tsc', 'a/b/c', 'tsc', 'local-bin-run'],
    ['a scoped package by its last segment', 'npx @scope/tool run', '.', 'tool', 'local-bin-run'],
    ['a Windows shim', 'npx tsc', '.', 'tsc.cmd', 'local-bin-run'],
    ['a pinned version, which the bin cannot answer for', 'npx tsc@5.4.0', '.', 'tsc', 'fetch-and-run'],
    ['a latest tag', 'npx tsc@latest', '.', 'tsc', 'fetch-and-run'],
  ])('%s', async (_title, command, below, present, form) => {
    const project = root();
    bin(project, present);
    const cwd = join(project, below);
    mkdirSync(cwd, { recursive: true });
    expect((await withLocalBin(only(command), cwd, new Map())).form).toBe(form);
  });

  it('leaves everything but an unstated npx alone', async () => {
    const project = root();
    bin(project, 'tsc');
    bin(project, 'left-pad');
    for (const command of ['npm install left-pad', 'pnpm dlx left-pad', 'npm exec left-pad']) {
      const crossing = only(command);
      expect(await withLocalBin(crossing, project, new Map())).toBe(crossing);
    }
  });

  it('does not look when the call chose its folder or registry, or the folder is unknown', async () => {
    const project = root();
    bin(project, 'tsc');
    const crossing = only('npx tsc');
    const moved = { ...crossing, registryAsked: false };
    expect(await withLocalBin(moved, project, new Map())).toBe(moved);
    expect(await withLocalBin(crossing, null, new Map())).toBe(crossing);
  });

  it('does not throw for a folder that is gone', async () => {
    const crossing = only('npx tsc');
    expect(await withLocalBin(crossing, join(root(), 'missing', 'deeper'), new Map())).toBe(crossing);
  });

  it('answers one folder and bin once', async () => {
    const project = root();
    bin(project, 'tsc');
    const memo = new Map<string, Promise<boolean>>();
    await withLocalBin(only('npx tsc'), project, memo);
    await withLocalBin(only('npx tsc -p x'), project, memo);
    expect(memo.size).toBe(1);
  });
});
