// The same-target lookup a client serves from a bundle: one function over a bundle's reads, keyed by error code, failed action, and target class.
import { describe, expect, it } from 'vitest';
import { readOf } from './next-fixtures.js';
import { sameTargetOf } from './same-target-lookup.js';
import { renderSameTarget, sameTargetServed } from './recall-next.js';
import type { Read } from './read.js';

const same = (over: Partial<Read> = {}, step = 'file.read'): Read =>
  readOf({ readId: 'read:st1', family: 'recovery', slice: { failed: 'file.edit', errorCode: '1', target: 'source', step, week: '2026-11-02' }, value: { recovered: 6, followed: 8, of: 12, share: 0.5 }, n: 6, asOf: { pool: 'p1', day: '2026-11-02' }, ...over });

describe('sameTargetOf', () => {
  it('returns the read for its code, failed action, and target class', () => {
    expect(sameTargetOf([same()], '1', 'file.edit', 'source')).toEqual({ readId: 'read:st1', step: 'file.read', recovered: 6, followed: 8, of: 12, clusters: 1, day: '2026-11-02' });
  });

  it('misses on each of the three keys', () => {
    const reads = [same()];
    expect(sameTargetOf(reads, '2', 'file.edit', 'source')).toBeUndefined();
    expect(sameTargetOf(reads, '1', 'file.write', 'source')).toBeUndefined();
    expect(sameTargetOf(reads, '1', 'file.edit', 'test')).toBeUndefined();
  });

  it('misses on a bundle with no same-target reads: edge reads, other families, and a read with no target or step', () => {
    const edge = readOf({ family: 'recovery', slice: { action: 'file.edit', errorCode: '1', next: 'file.read', week: '2026-11-02' }, value: { followed: 4, of: 8, share: 0.5 } });
    const noTarget = same({ slice: { failed: 'file.edit', errorCode: '1', step: 'file.read' } });
    const noStep = same({ slice: { failed: 'file.edit', errorCode: '1', target: 'source' } });
    const other = same({ family: 'next-step' });
    expect(sameTargetOf([edge, noTarget, noStep, other], '1', 'file.edit', 'source')).toBeUndefined();
    expect(sameTargetOf([], '1', 'file.edit', 'source')).toBeUndefined();
  });

  it('skips a read whose counts are not numbers', () => {
    expect(sameTargetOf([same({ value: { recovered: 'x', followed: 8, of: 12 } })], '1', 'file.edit', 'source')).toBeUndefined();
  });

  it('takes the newest week, then the most recoveries, then the lower read ID', () => {
    const older = same({ readId: 'read:a', asOf: { pool: 'p1', day: '2026-10-26' } });
    const newer = same({ readId: 'read:b' });
    const heavier = same({ readId: 'read:c', value: { recovered: 7, followed: 8, of: 12 } });
    const nullDay = same({ readId: 'read:d', asOf: { pool: 'p1', day: null } });
    expect(sameTargetOf([older, newer], '1', 'file.edit', 'source')?.readId).toBe('read:b');
    expect(sameTargetOf([newer, heavier], '1', 'file.edit', 'source')?.readId).toBe('read:c');
    expect(sameTargetOf([heavier, same({ readId: 'read:b2', value: { recovered: 7, followed: 8, of: 12 } })], '1', 'file.edit', 'source')?.readId).toBe('read:b2');
    expect(sameTargetOf([nullDay, older], '1', 'file.edit', 'source')?.readId).toBe('read:a');
  });
});

describe('same-target wording', () => {
  it('names the step and its counts for a step other than the failed action', () => {
    const read = sameTargetOf([same()], '1', 'file.edit', 'source');
    expect(read && renderSameTarget('file.edit', '1', 'source', read).rendered).toBe(
      'oars recall, counts from earlier sessions: after a failed file.edit (1) on a source target, file.read came back ok 6 of 8 times it followed\n  read read:st1 (recovery)',
    );
  });

  it('words a step equal to the failed action as the same action on another kind of target, never a retry', () => {
    const read = sameTargetOf([same({}, 'file.edit')], '1', 'file.edit', 'source');
    const text = read === undefined ? '' : renderSameTarget('file.edit', '1', 'source', read).rendered;
    expect(text).toContain('the same action on another kind of target came back ok 6 of 8 times it followed');
    expect(text).not.toContain('retry');
  });

  it('says nothing for a step the vocabulary does not close, and serves nothing', () => {
    const reads = [same({}, 'some-private-tool')];
    expect(sameTargetServed(reads, '1', 'file.edit', 'source')).toBeUndefined();
    expect(sameTargetServed(undefined, '1', 'file.edit', 'source')).toBeUndefined();
    expect(sameTargetServed([same()], '1', 'file.edit', 'source')?.read.step).toBe('file.read');
  });
});
