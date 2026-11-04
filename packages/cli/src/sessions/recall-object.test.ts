import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecall, armOf, evidencePredates, HOLDBACK_RATE, makeRecall, RECALL_CLASSES, readRecalls, recallsPath, type Recall } from './recall-object.js';

let storeDir: string;
beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'oars-recall-'));
});
afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

const AT = '2026-11-03T12:00:00.000Z';
const miss = (at = AT): Recall =>
  makeRecall({ sid: 'session-1', at, frame: null, mode: 'pull', query: { form: 'entity', entity: 'nothing-known' }, poolVersion: '2026-11-03T03:00:00.000Z', arm: 'shown', reads: [], rendered: '', names: [], evidence: [] });

describe('the recall object', () => {
  it('holds a miss as answer.kind miss, with no reads and nothing injected', () => {
    expect(miss().answer).toEqual({ kind: 'miss', reads: [], tokens: 0, rendered: '', names: [] });
  });

  it('holds a hit with its reads in order and the size of what it shows', () => {
    const hit = makeRecall({ sid: 's', at: AT, frame: null, mode: 'push', query: { form: 'pattern', prefix: ['abc'] }, poolVersion: 'p', arm: 'held', reads: ['r2', 'r1'], rendered: 'x'.repeat(41), names: ['file.read'], evidence: [] });
    expect(hit.answer).toEqual({ kind: 'hit', reads: ['r2', 'r1'], tokens: 11, rendered: 'x'.repeat(41), names: ['file.read'] });
    expect(hit.n).toBeNull();
  });

  it('gives the same id to the same event and another to a different one', () => {
    expect(miss().id).toMatch(/^[0-9a-f]{16}$/);
    expect(miss().id).toBe(miss().id);
    expect(miss('2026-11-03T12:00:01.000Z').id).not.toBe(miss().id);
  });

  it('states its classes as the spec does: sid, at, and query.text are A, everything else P', () => {
    expect(RECALL_CLASSES.A).toEqual(['sid', 'at', 'query.text']);
    expect(RECALL_CLASSES.P).toEqual(['id', 'n', 'frame', 'mode', 'query.form', 'query.prefix', 'query.entity', 'query.family', 'query.slice', 'poolVersion', 'arm', 'answer', 'evidence', 'consequence']);
  });
});

describe('recalls.jsonl', () => {
  it('reads as empty when there is no file', async () => {
    expect(await readRecalls(storeDir)).toEqual([]);
  });

  it('appends one line per recall and never rewrites an earlier one', async () => {
    const first = miss();
    await appendRecall(storeDir, first);
    const before = readFileSync(recallsPath(storeDir), 'utf8');
    const second = miss('2026-11-03T12:00:01.000Z');
    await appendRecall(storeDir, second);
    const after = readFileSync(recallsPath(storeDir), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    expect(after.split('\n').filter((line) => line !== '')).toHaveLength(2);
    expect(await readRecalls(storeDir)).toEqual([first, second]);
  });

  it('keeps a miss through the file', async () => {
    await appendRecall(storeDir, miss());
    expect((await readRecalls(storeDir))[0]?.answer.kind).toBe('miss');
  });

  it('skips a torn line and a line that is not a recall', async () => {
    const good = miss();
    await appendRecall(storeDir, good);
    writeFileSync(recallsPath(storeDir), `${readFileSync(recallsPath(storeDir), 'utf8')}{"id":"x"}\n[1]\n{"torn":`);
    expect(await readRecalls(storeDir)).toEqual([good]);
  });
});

describe('the holdback arm', () => {
  it('is stable for one sid, prefix, and pool version', () => {
    expect(armOf('s', ['a', 'b'], 'p')).toBe(armOf('s', ['a', 'b'], 'p'));
  });

  it('moves with any of the three inputs across many hashes', () => {
    const arms = (make: (index: number) => [string, string[], string]): number => Array.from({ length: 2000 }, (_, index) => armOf(...make(index))).filter((arm) => arm === 'held').length;
    for (const held of [arms((index) => [`s${String(index)}`, ['a'], 'p']), arms((index) => ['s', [`a${String(index)}`], 'p']), arms((index) => ['s', ['a'], `p${String(index)}`])]) {
      expect(held).toBeGreaterThan(0);
      expect(held).toBeLessThan(2000);
    }
  });

  it('holds back about the rate over many hashes', () => {
    const total = 20000;
    const held = Array.from({ length: total }, (_, index) => armOf(`session-${String(index)}`, ['prefix'], 'pool')).filter((arm) => arm === 'held').length;
    expect(HOLDBACK_RATE).toBe(0.1);
    expect(held / total).toBeGreaterThan(0.09);
    expect(held / total).toBeLessThan(0.11);
  });

  it('takes the rate as an open parameter', () => {
    expect(armOf('s', ['a'], 'p', 0)).toBe('shown');
    expect(armOf('s', ['a'], 'p', 1)).toBe('held');
  });
});

describe('evidence must predate the recall', () => {
  const evidence = (lastDay: string | null): Recall['evidence'][number] => ({
    ref: 'r',
    frameRange: { harnesses: [], harnessVersions: [], models: [] },
    firstDay: lastDay,
    lastDay,
    n: 1,
    clusters: 1,
    delta: { harness: 'unknown', harnessVersions: null, model: 'unknown', modelVersions: null, platform: 'unknown', shell: 'unknown', stack: 'unknown', toolVersion: null, ageDays: null },
  });
  const withEvidence = (poolVersion: string, lastDay: string | null): Recall => ({ ...miss(), poolVersion, evidence: [evidence(lastDay)] });

  it('accepts a pool and evidence older than the recall', () => {
    expect(evidencePredates(withEvidence('2026-11-03T03:00:00.000Z', '2026-11-03'))).toBe(true);
    expect(evidencePredates(withEvidence('2026-11-03T03:00:00.000Z', null))).toBe(true);
  });

  it('refuses a pool version newer than the recall', () => {
    expect(evidencePredates(withEvidence('2026-11-03T12:00:00.001Z', '2026-11-02'))).toBe(false);
  });

  it('refuses evidence from a later day', () => {
    expect(evidencePredates(withEvidence('2026-11-03T03:00:00.000Z', '2026-11-04'))).toBe(false);
  });
});
