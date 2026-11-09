import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cellKey, firstRunMeasures, measuresOf } from './measures.js';

const hook = (data: object): unknown => ({ type: 'hook', data: { name: 'pre-tool', latencyMs: 10, outcome: 'hit', ...data } });

describe('hook cells', () => {
  it('keys a hook cell by harness and harness version: one version under two harnesses is two cells', () => {
    const claude = measuresOf(hook({ harness: 'claude-code', harnessVersion: '2.1.5' }));
    const codex = measuresOf(hook({ harness: 'codex', harnessVersion: '2.1.5' }));
    expect(claude.map(cellKey)).not.toEqual(codex.map(cellKey));
    expect(claude[0]).toMatchObject({ metric: 'hook.pre-tool.latency', dimension: 'harnessVersion', value: 'claude-code/2.1.5' });
    expect(codex[0]).toMatchObject({ value: 'codex/2.1.5' });
  });

  it('reads an event written before the field as an unrecorded harness, and an unknown name as other', () => {
    expect(measuresOf(hook({ harnessVersion: '2.1.5' }))[0]).toMatchObject({ value: 'unrecorded/2.1.5' });
    expect(measuresOf(hook({ harness: 'acme private', harnessVersion: '2.1.5' }))[0]).toMatchObject({ value: 'other/2.1.5' });
    expect(measuresOf(hook({ harness: 'codex' }))[0]).toMatchObject({ value: 'codex/unrecorded' });
  });
});

describe('the first-run cell', () => {
  const firstRun = (data: object, cli = '0.4.0'): unknown => ({ type: 'first-run', cli, data });

  it('is one yes-or-no under the oars version, named for the listing surface, and a yes only for a run in CI', () => {
    expect(firstRunMeasures(firstRun({ ci: 'none', surface: 'npx' }))).toEqual([{ metric: 'first-run.npx', dimension: 'cli', value: '0.4.0', kind: 'rate', x: 0 }]);
    expect(firstRunMeasures(firstRun({ ci: 'github-actions', surface: 'npm-global' }))).toEqual([{ metric: 'first-run.npm-global', dimension: 'cli', value: '0.4.0', kind: 'rate', x: 1 }]);
  });

  it('reads a word off the closed lists as unknown or not-CI, and still counts the install', () => {
    expect(firstRunMeasures(firstRun({ ci: 'someone/private', surface: '/home/someone/.npm' }))).toEqual([{ metric: 'first-run.unknown', dimension: 'cli', value: '0.4.0', kind: 'rate', x: 0 }]);
    expect(firstRunMeasures(firstRun({}, 'acme private'))).toEqual([{ metric: 'first-run.unknown', dimension: 'cli', value: 'other', kind: 'rate', x: 0 }]);
  });

  it('is measured by nothing else: other events give none, and measuresOf leaves it out of the own report and the fleet read', () => {
    expect(firstRunMeasures(hook({}))).toEqual([]);
    expect(firstRunMeasures('first-run')).toEqual([]);
    expect(measuresOf(firstRun({ ci: 'none', surface: 'npx' }))).toEqual([]);
  });
});

describe('what the pool Worker imports', () => {
  // The pool's rollup imports this module, and the Worker has no file system: no file it reaches by a value import (a type import is erased) may import a `node:` module. A word list the rollup needs sits in a leaf module for this.
  it('reaches no `node:` module from measures.ts', () => {
    const reached = new Map<string, string[]>();
    const walk = (file: string): void => {
      if (reached.has(file)) return;
      const specifiers = [...readFileSync(file, 'utf8').matchAll(/^(?:import|export)(?!\s+type\b)\s[^;]*?from\s+'([^']+)'/gm)].map((match) => match[1] ?? '');
      reached.set(file, specifiers);
      for (const specifier of specifiers) if (specifier.startsWith('.')) walk(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')));
    };
    walk(fileURLToPath(new URL('./measures.ts', import.meta.url)));
    const nodeImports = [...reached].flatMap(([file, specifiers]) => specifiers.filter((specifier) => specifier.startsWith('node:')).map((specifier) => `${file.replaceAll('\\', '/').split('/src/')[1] ?? file} imports ${specifier}`));
    expect(reached.size).toBeGreaterThan(1);
    expect(nodeImports).toEqual([]);
  });
});
