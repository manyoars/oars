// What a refresh lets go of before the pool derives its reads (t1619): the motif memo, which grows with every distinct window of the store and which nothing pruned.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { heldMotifs, namedId } from './motif.js';
import { deposit, newTrace, refresh } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

describe('refresh lets go of the folds it no longer needs', () => {
  it('lets go of the motif memo after its folds, and writes the same pool files as before', async () => {
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const cells = readFileSync(join(staged.storeDir, 'cells.jsonl'), 'utf8');
    const motifs = readFileSync(join(staged.storeDir, 'motifs.jsonl'), 'utf8');
    // A long tail of windows the store does not hold, as an earlier fold of other sessions would leave in the memo.
    for (let at = 0; at < 1000; at += 1) namedId([{ action: 'skill.run', identity: { skill: `tail-${String(at)}` } }]);
    expect(heldMotifs()).toBeGreaterThanOrEqual(1000);
    const trace = newTrace();
    await refresh(staged.runtime, [], '2026-06-10T00:00:00.000Z', trace);
    expect(trace.pool?.out.read).toBeGreaterThan(0);
    // The pool step and the index make the few motifs they read again (16 on this store); the tail is gone.
    expect(heldMotifs()).toBeLessThan(100);
    expect(readFileSync(join(staged.storeDir, 'cells.jsonl'), 'utf8')).toBe(cells);
    expect(readFileSync(join(staged.storeDir, 'motifs.jsonl'), 'utf8')).toBe(motifs);
  });
});
