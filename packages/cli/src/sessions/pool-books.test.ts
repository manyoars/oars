// `oars sessions books` prints the set of four from the last fetched bundle: the pool's totals, read from the replica a fetch kept and checked again against the pinned key.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { booksLines, booksTotals, lastFetchedBundle } from './pool-books.js';
import { booksOf, bundleOf, keep, NONE, pair } from './pool-books-fixture.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oars-pool-books-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('lastFetchedBundle', () => {
  it('reads the newest replica whose signature holds against the pinned key', async () => {
    const signer = await pair();
    await keep(dir, bundleOf(booksOf({ backlog: 1 }), '2.1.300'), signer, 100);
    await keep(dir, bundleOf(booksOf({ backlog: 2 })), signer);
    expect((await lastFetchedBundle(dir))?.books?.backlog).toBe(2);
  });

  it('is nothing when no fetch kept a bundle, or when the kept one no longer verifies', async () => {
    expect(await lastFetchedBundle(dir)).toBeUndefined();
    const signer = await pair();
    const file = await keep(dir, bundleOf(booksOf()), signer);
    writeFileSync(file, JSON.stringify({ payload: JSON.stringify(bundleOf(booksOf({ backlog: 99 }))), signature: 'bad' }));
    expect(await lastFetchedBundle(dir)).toBeUndefined();
  });
});

describe('booksLines', () => {
  it('prints served cells, below floor, and as-of, then one line each for panel, demand, and goal metric', () => {
    expect(booksLines(bundleOf(booksOf()))).toEqual([
      'served cells 12, below floor 7, as of 2026-11-02',
      'panel: 4 accounts deposited in the last four weeks, as of 2026-11-07',
      'demand: comparison-read owners no source yet (no comparison read exists to fetch yet), follow-on reads no source yet (no source feeds this yet)',
      'goal metric: read yield no source yet (no source feeds this yet), cost per served cell no source yet (no cost feed exists yet), yield per served cell no source yet (no source feeds this yet)',
    ]);
  });

  it('says there is no pool bundle yet, and nothing else, when no bundle was fetched', () => {
    expect(booksLines(undefined)).toEqual(['no pool bundle yet']);
  });

  it('says so when the bundle predates the set of four', () => {
    expect(booksLines(bundleOf(undefined))).toEqual(['the last fetched bundle carries no pool books; run oars pool fetch again']);
  });

  it('never renders no source yet as 0, and keeps a measured zero as 0', () => {
    const lines = booksLines(bundleOf(booksOf({ panel: { state: 'value', value: 0 }, served: { total: 0, byWeek: [], byTuple: [] }, backlog: 0 }))).join('\n');
    expect(lines).toContain('served cells 0, below floor 0');
    expect(lines).toContain('panel: 0 accounts');
    expect(lines.replaceAll(/no source yet \([^)]*\)/g, '')).not.toMatch(/(?:owners|reads|yield|cell) 0/);
    expect(booksLines(bundleOf(booksOf({ panel: NONE }))).join('\n')).toContain('panel: no source yet (no source feeds this yet)');
  });

  it('says there is no known day for a pool with none', () => {
    expect(booksLines(bundleOf(booksOf({ asOf: { pool: 'p', day: null } })))[0]).toBe('served cells 12, below floor 7, as of no known day');
  });
});

describe('booksTotals', () => {
  it('is flat numbers with null for every field that has no source, and null when there are no books', () => {
    expect(booksTotals(bundleOf(booksOf()))).toEqual({ floor: 5, asOfDay: '2026-11-02', panelDay: '2026-11-07', servedCells: 12, belowFloor: 7, panel: 4, comparisonReadOwners: null, followOnReads: null, readYield: null, costPerServedCell: null, yieldPerServedCell: null });
    expect(booksTotals(bundleOf(undefined))).toBeNull();
    expect(booksTotals(undefined)).toBeNull();
  });

  it('carries its lineage, and null for a day the bundle does not know, so an old panel is not read as current', () => {
    expect(booksTotals(bundleOf(booksOf({ floor: 8, asOf: { pool: 'p1', day: null }, panelDay: null })))).toMatchObject({ floor: 8, asOfDay: null, panelDay: null });
  });

  it('keeps a measured zero as 0', () => {
    expect(booksTotals(bundleOf(booksOf({ panel: { state: 'value', value: 0 } })))?.panel).toBe(0);
  });
});
