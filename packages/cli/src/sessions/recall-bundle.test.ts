import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Cell } from './cells.js';
import { classMotif } from './motif.js';
import { bundleOf, keep, pair } from './pool-books-fixture.js';
import { session, store, tool } from './pool-fixture.js';
import type { Read } from './read.js';
import { bundlePool, recallPool, storeSetup, withBundle } from './recall-bundle.js';
import type { CurrentPool } from './recall-pool.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const cell = (motifId: string): Cell => ({ motifId, frameBucket: 'claude-code/2.1.x/none', grain: 'week', day: '2026-11-02', sessions: 5, clusters: 5, ok: 0, failed: 5, tokens: null, durationMs: 0, exposed: false });
const read = (readId: string): Read => ({ readId, family: 'next-step', method: 'm', methodVersion: '1', inputs: ['cell:x'], order: 1, slice: {}, value: {}, n: 5, clusters: 5, interval: null, asOf: { pool: 'p', day: null }, basis: 'all' });
const local: CurrentPool = { pool: { cells: [cell('local')], motifs: new Map([[classMotif('local').motifId, classMotif('local')]]), version: 'v-local', lastDay: '2026-11-01' }, reads: [read('read:local')] };
const kept = { ...bundleOf(undefined), cells: [cell('kept')], motifs: [classMotif('kept')], reads: [read('read:kept')] };

describe('storeSetup', () => {
  it('names the harness and version of the newest call that states one', () => {
    const found = storeSetup(
      store({
        sessions: [session('a', { harness: 'codex' }), session('b')],
        tools: [tool('a', 0, 'Bash', { ts: '2026-11-03T00:00:00Z', harnessVersion: '0.9.0' }), tool('b', 0, 'Bash', { ts: '2026-11-02T00:00:00Z', harnessVersion: '2.1.314' }), tool('b', 1, 'Bash', { ts: '2026-11-04T00:00:00Z', harnessVersion: null }), tool('c', 0, 'Bash', { ts: null, harnessVersion: '2.1.1' })],
      }),
    );
    expect(found).toEqual({ harness: 'codex', harnessVersion: '0.9.0' });
  });

  it('defaults a call with no session to Claude Code, and a store with no versions to none', () => {
    expect(storeSetup(store({ tools: [tool('x', 0, 'Bash', { ts: '2026-11-03T00:00:00Z', harnessVersion: '2.1.314' })] }))).toEqual({ harness: 'claude-code', harnessVersion: '2.1.314' });
    expect(storeSetup(store({}))).toBeUndefined();
  });
});

describe('withBundle', () => {
  it('puts the bundle ahead of the local pool and keeps the local version', () => {
    const merged = withBundle(local, kept);
    expect(merged?.reads.map((row) => row.readId)).toEqual(['read:kept', 'read:local']);
    expect(merged?.pool.cells.map((row) => row.motifId)).toEqual(['kept', 'local']);
    expect([...(merged?.pool.motifs.keys() ?? [])].sort()).toEqual([classMotif('kept').motifId, classMotif('local').motifId].sort());
    expect(merged?.pool.version).toBe('v-local');
  });

  it('answers from either alone', () => {
    expect(withBundle(local, undefined)).toBe(local);
    expect(withBundle(undefined, kept)).toEqual(bundlePool(kept));
    expect(bundlePool(kept).pool.version).toBe('p1');
    expect(withBundle(undefined, undefined)).toBeUndefined();
  });
});

describe('recallPool', () => {
  it('reads the bundle for the store setup beside the served local pool', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oars-recall-bundle-'));
    dirs.push(dir);
    await keep(dir, kept, await pair());
    const from = store({ tools: [tool('x', 0, 'Bash', { ts: '2026-11-03T00:00:00Z', harnessVersion: '2.1.314' })] });
    const merged = await recallPool(dir, from, () => Promise.resolve(local));
    expect(merged?.reads.map((row) => row.readId)).toEqual(['read:kept', 'read:local']);
    expect(await recallPool(dir, store({}), () => Promise.resolve(undefined))).toBeUndefined();
  });
});
