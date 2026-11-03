import { describe, expect, it } from 'vitest';
import { makeRead, orderResolver, type Family, type Read } from './read.js';
import { formatReads, isFamily, parseSlice, selectReads } from './read-rows.js';

const read = (family: Family, n: number, slice: Read['slice'], over: Partial<Read> = {}): Read =>
  makeRead({ family, method: 'm', methodVersion: '1', inputs: ['cell:a'], slice, value: { share: 0.5 }, n, clusters: 1, interval: null, asOf: { pool: 'p', day: null }, basis: 'all', ...over }, orderResolver([]));

describe('isFamily', () => {
  it('knows the families and nothing else', () => {
    expect(isFamily('next-step')).toBe(true);
    expect(isFamily('lead-lag')).toBe(true);
    expect(isFamily('nextstep')).toBe(false);
  });
});

describe('parseSlice', () => {
  it('reads repeated pairs, keeping an equals sign inside a value', () => {
    expect(parseSlice(['model=opus', 'motif=shell.exec[program=git]'])).toEqual({ model: 'opus', motif: 'shell.exec[program=git]' });
    expect(parseSlice([])).toEqual({});
  });

  it.each(['model', '=opus', 'model='])('refuses %s', (pair) => {
    expect(parseSlice([pair])).toBeUndefined();
  });
});

describe('selectReads', () => {
  const reads = [read('fit', 5, { model: 'opus', motif: 'a' }), read('recovery', 2, { motif: 'a' }), read('fit', 9, { model: 'sonnet', motif: 'a' }), read('fit', 5, { model: 'opus', motif: 'b' })];

  it('lists in family order, then largest sample first, then by ID', () => {
    const selected = selectReads(reads, { family: undefined, slice: {} });
    expect(selected.map((one) => [one.family, one.n])).toEqual([['recovery', 2], ['fit', 9], ['fit', 5], ['fit', 5]]);
    expect(selectReads([...reads].reverse(), { family: undefined, slice: {} })).toEqual(selected);
  });

  it('filters by family and by every slice axis named', () => {
    expect(selectReads(reads, { family: 'recovery', slice: {} })).toHaveLength(1);
    expect(selectReads(reads, { family: undefined, slice: { motif: 'a' } })).toHaveLength(3);
    expect(selectReads(reads, { family: 'fit', slice: { motif: 'a', model: 'opus' } })).toHaveLength(1);
    expect(selectReads(reads, { family: undefined, slice: { week: '2026-W44' } })).toEqual([]);
  });

  it('leaves the list it was given as it was', () => {
    const order = reads.map((one) => one.readId);
    selectReads(reads, { family: undefined, slice: {} });
    expect(reads.map((one) => one.readId)).toEqual(order);
  });
});

describe('formatReads', () => {
  it('states clusters on every row, under a heading per family', () => {
    const text = formatReads([
      read('recovery', 3, { action: 'file.read' }, { value: { errors: 3, following: { 'file.edit': 2, 'file.read': 1 }, lastSeen: null } }),
      read('fit', 4, { motif: 'file.read' }, { interval: { low: 0.1, high: 0.9, level: 0.95 } }),
      read('fit', 2, { motif: 'file.edit' }),
    ]);
    expect(text.split('\n')).toEqual([
      'recovery (1 reads)',
      '  n=3 clusters: 1 order=1 action=file.read | errors=3 following=file.edit:2,file.read:1 lastSeen=null',
      'fit (2 reads)',
      '  n=4 clusters: 1 order=1 motif=file.read | share=0.5 ci=0.1-0.9',
      '  n=2 clusters: 1 order=1 motif=file.edit | share=0.5',
    ]);
  });

  it('marks a labeled experiment in its heading, so a reader meets the label before the row', () => {
    const text = formatReads([read('lead-lag', 60, { lead: 'failureRate' }, { value: { label: 'experimental', check: 'failed' } })]);
    expect(text.split('\n')).toEqual([
      'lead-lag (1 reads, experimental: fit on earlier days and scored on later ones; not served to an agent)',
      '  n=60 clusters: 1 order=1 lead=failureRate | label=experimental check=failed',
    ]);
  });

  it('says so when nothing matches', () => {
    expect(formatReads([])).toBe('No reads match.');
  });
});
