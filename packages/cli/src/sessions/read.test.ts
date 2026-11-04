import { describe, expect, it } from 'vitest';
import { CALL_SHAPE_METHOD, contentHash, makeRead, METHODS, orderResolver, readIdOf, type ReadDraft } from './read.js';

const CELL_A = 'cell:aaaaaaaaaaaaaaaa';
const CELL_B = 'cell:bbbbbbbbbbbbbbbb';

const draft = (over: Partial<ReadDraft> = {}): ReadDraft => ({
  family: 'fit',
  method: 'failure-rate',
  methodVersion: '1',
  inputs: [CELL_A, CELL_B],
  slice: { action: 'shell.exec' },
  value: { failureRate: 0.25 },
  n: 4,
  clusters: 1,
  interval: null,
  asOf: { pool: 'pool-one', day: '2026-11-02' },
  basis: 'all',
  ...over,
});

describe('METHODS', () => {
  it('states a new version for every family whose rule or value fields moved with the cell grain, so an old read is told from a new one', () => {
    const moved: [string, string][] = [
      [METHODS.recovery.version, '2'],
      [METHODS.fit.version, '2'],
      [CALL_SHAPE_METHOD.version, '2'],
      [METHODS.change.version, '2'],
      [METHODS.adoption.version, '2'],
      [METHODS['version-boundary'].version, '2'],
      [METHODS.interaction.version, '3'],
    ];
    for (const [stated, wanted] of moved) expect(stated).toBe(wanted);
  });
});

describe('contentHash', () => {
  it('hashes content, not key order, to 16 hex characters', () => {
    expect(contentHash({ a: 1, b: [{ c: 2, d: 3 }] })).toBe(contentHash({ b: [{ d: 3, c: 2 }], a: 1 }));
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });
});

describe('makeRead', () => {
  it('computes order 1 over cells, and 1 + the highest input order over reads, with no ceiling', () => {
    const first = makeRead(draft(), orderResolver([]));
    expect(first.order).toBe(1);
    const second = makeRead(draft({ inputs: [first.readId, CELL_A] }), orderResolver([first]));
    expect(second.order).toBe(2);
    const third = makeRead(draft({ inputs: [second.readId, first.readId] }), orderResolver([first, second]));
    expect(third.order).toBe(3);
  });

  it('gives one content one ID, whatever order the inputs came in', () => {
    const one = makeRead(draft(), orderResolver([]));
    const two = makeRead(draft({ inputs: [CELL_B, CELL_A, CELL_A] }), orderResolver([]));
    expect(two.readId).toBe(one.readId);
    expect(two.inputs).toEqual([CELL_A, CELL_B]);
    expect(one.readId).toMatch(/^read:[0-9a-f]{16}$/);
    expect(readIdOf(one)).toBe(one.readId);
  });

  it('gives a later pool version a new read', () => {
    const one = makeRead(draft(), orderResolver([]));
    const two = makeRead(draft({ asOf: { pool: 'pool-two', day: '2026-11-02' } }), orderResolver([]));
    expect(two.readId).not.toBe(one.readId);
  });

  it('gives a new method version a new read', () => {
    expect(makeRead(draft({ methodVersion: '2' }), orderResolver([])).readId).not.toBe(makeRead(draft(), orderResolver([])).readId);
  });

  it('refuses a read that cites nothing', () => {
    expect(() => makeRead(draft({ inputs: [] }), orderResolver([]))).toThrow(/cites no input/);
  });

  it('refuses an input whose order is not known', () => {
    expect(() => makeRead(draft({ inputs: ['read:0000000000000000'] }), orderResolver([]))).toThrow(/read:0000000000000000/);
    expect(() => makeRead(draft({ inputs: ['motif:1'] }), orderResolver([]))).toThrow(/motif:1/);
  });

  it('freezes what it returns, so a read cannot change after its ID is taken', () => {
    const read = makeRead(draft(), orderResolver([]));
    expect(Object.isFrozen(read)).toBe(true);
    for (const part of [read.slice, read.value, read.inputs, read.asOf]) expect(Object.isFrozen(part)).toBe(true);
    const nested = makeRead(draft({ value: { following: { 'file.read': 1 } }, interval: { low: 0, high: 1, level: 0.95 } }), orderResolver([]));
    expect(Object.isFrozen(nested.value['following'])).toBe(true);
    expect(Object.isFrozen(nested.interval)).toBe(true);
    expect(() => {
      Reflect.set(read, 'n', 5);
      if (read.n !== 4) throw new Error('changed');
    }).not.toThrow();
    expect(read.n).toBe(4);
  });
});
