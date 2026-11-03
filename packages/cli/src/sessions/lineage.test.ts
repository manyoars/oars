import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { cellIdOf, type Cell } from './cells.js';
import { formatLineage, loadLineage, walkLineage, type LineageSources } from './lineage.js';
import { poolFiles } from './pool.js';
import { frame } from './pool-fixture.js';
import type { Read } from './read.js';
import { appendRecall, makeRecall, type Recall, type RecallEvidence } from './recall-object.js';
import { cleanup, stage } from './test-support.js';

afterEach(() => {
  cleanup();
  removeTestDirs();
});

const cell = (day: string, over: Partial<Cell> = {}): Cell => ({ motifId: 'm', frameBucket: 'claude-code/2.1.31x/claude-opus-5-5/high', day, sessions: 2, clusters: 1, ok: 1, failed: 1, tokens: 0, durationMs: 0, exposed: false, ...over });

const read = (readId: string, inputs: string[], day: string | null = '2026-11-01'): Read => ({ readId, family: 'fit', method: 'm', methodVersion: '1', inputs, order: 1, slice: {}, value: {}, n: 3, clusters: 1, interval: null, asOf: { pool: 'p', day }, basis: 'all' });

const delta: RecallEvidence['delta'] = { harness: 'same', harnessVersions: 0, model: 'same', modelVersions: 0, platform: 'unknown', shell: 'unknown', stack: 'unknown', toolVersion: null, ageDays: 1 };

const evidence = (ref: string, lastDay: string | null = '2026-11-01'): RecallEvidence => ({ ref, frameRange: { harnesses: ['claude-code'], harnessVersions: ['2.1.300'], models: ['claude-opus-5-5'] }, firstDay: '2026-10-01', lastDay, n: 4, clusters: 1, delta });

const recall = (items: RecallEvidence[], over: Partial<Recall> = {}): Recall => ({
  ...makeRecall({ sid: 's', at: '2026-11-02T10:00:00.000Z', frame: frame(), mode: 'push', query: { form: 'pattern', prefix: ['p'] }, poolVersion: '2026-11-01T00:00:00.000Z', arm: 'shown', reads: ['r'], rendered: 'x', names: [], evidence: items }),
  id: 'recall-one',
  ...over,
});

const sources = (over: Partial<LineageSources>): LineageSources => ({ recalls: [], reads: [], cells: [], ...over });

const refusal = (run_: () => unknown): CliError => {
  try {
    run_();
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('nothing was refused');
};

describe('walkLineage', () => {
  it('walks a recall to a read to its cells, one hop each with frame range and day', () => {
    const one = cell('2026-11-01');
    const hops = walkLineage(sources({ recalls: [recall([evidence('read:a')])], reads: [read('read:a', [cellIdOf(one), 'cell:gone'])], cells: [one] }), 'recall-one');
    expect(hops.map(({ depth, kind, ref, day }) => [depth, kind, ref, day])).toEqual([
      [0, 'recall', 'recall-one', '2026-11-02'],
      [1, 'read', 'read:a', '2026-11-01'],
      [2, 'cell', cellIdOf(one), '2026-11-01'],
      [2, 'missing', 'cell:gone', null],
    ]);
    expect(hops[0]?.frames).toEqual(['claude-code 2.1.314 claude-opus-5-5']);
    expect(hops[1]?.frames).toEqual([one.frameBucket]);
    expect(formatLineage(hops).split('\n')[2]).toBe(`    cell ${cellIdOf(one)} | ${one.frameBucket} | 2026-11-01 | 2 sessions, 1 ok, 1 failed`);
  });

  it('ends at the evidence a recall holds when the ref is a stand-in, once per ref', () => {
    const hops = walkLineage(sources({ recalls: [recall([evidence('abc123'), evidence('abc123')])] }), 'recall-one');
    expect(hops.map(({ kind, ref }) => [kind, ref])).toEqual([['recall', 'recall-one'], ['evidence', 'abc123']]);
    expect(formatLineage(hops)).toContain('claude-code, 2.1.300, claude-opus-5-5 | 2026-11-01 | 4 sessions, 1 cluster, from 2026-10-01');
  });

  it('starts from a read or a cell, and caps a read of many frames', () => {
    const cells = ['a', 'b', 'c', 'd'].map((name) => cell('2026-11-01', { frameBucket: name, exposed: name === 'a' }));
    const hops = walkLineage(sources({ reads: [read('read:a', cells.map(cellIdOf))], cells }), 'read:a');
    expect(hops[0]?.frames).toEqual(['a', 'b', 'c', '+1']);
    expect(formatLineage(hops)).toContain(', exposed');
    expect(walkLineage(sources({ cells }), cellIdOf(cells[1] ?? cell('x')))).toHaveLength(1);
  });

  it('walks a loop in a hand-edited file once and stops', () => {
    const hops = walkLineage(sources({ reads: [read('read:a', ['read:b', 'read:a']), read('read:b', ['read:a'])], recalls: [recall([evidence('read:a'), evidence('read:a')])] }), 'recall-one');
    expect(hops.map(({ ref }) => ref)).toEqual(['recall-one', 'read:a', 'read:b']);
  });

  it('prints a recall with no frame, and evidence with no day, as unknown', () => {
    const hops = walkLineage(sources({ recalls: [recall([evidence('abc', null)], { frame: null })] }), 'recall-one');
    expect(formatLineage(hops)).toContain('recall recall-one | frames unknown | 2026-11-02');
    expect(formatLineage(hops)).toContain('day unknown');
  });

  it('refuses evidence newer than the recall, on the recall, a read, a cell, and a recall it cites', () => {
    const newer = cell('2026-11-03');
    expect(refusal(() => walkLineage(sources({ recalls: [recall([evidence('abc', '2026-11-03')])] }), 'recall-one')).message).toContain('2026-11-03');
    expect(refusal(() => walkLineage(sources({ recalls: [recall([], { poolVersion: '2026-11-03T00:00:00.000Z' })] }), 'recall-one')).exitCode).toBe(ExitCode.INVALID);
    expect(refusal(() => walkLineage(sources({ recalls: [recall([evidence('read:a')])], reads: [read('read:a', [], '2026-11-03')] }), 'recall-one')).message).toContain('read:a');
    expect(refusal(() => walkLineage(sources({ recalls: [recall([evidence('read:a')])], reads: [read('read:a', [cellIdOf(newer)], null)], cells: [newer] }), 'recall-one')).message).toContain(cellIdOf(newer));
    const later = recall([], { id: 'later', at: '2026-11-03T00:00:00.000Z' });
    expect(refusal(() => walkLineage(sources({ recalls: [recall([evidence('later')]), later] }), 'recall-one')).message).toContain('later');
  });

  it('holds the tightest limit down a chain of recalls, and a cell of unknown day passes', () => {
    const unknownDay = cell('unknown');
    const earlier = recall([evidence('read:a')], { id: 'earlier', at: '2026-11-02T00:00:00.000Z' });
    const top = recall([evidence('earlier')], { at: '2026-11-04T00:00:00.000Z' });
    expect(walkLineage(sources({ recalls: [top, earlier], reads: [read('read:a', [cellIdOf(unknownDay)])], cells: [unknownDay] }), 'recall-one')).toHaveLength(4);
    const notTighter = recall([evidence('earlier')], { at: '2026-11-01T00:00:00.000Z' });
    expect(refusal(() => walkLineage(sources({ recalls: [notTighter, earlier] }), 'recall-one')).message).toContain('earlier');
  });

  it('says so for an ID nothing holds', () => {
    expect(refusal(() => walkLineage(sources({}), 'nope')).message).toContain('nope');
  });
});

describe('oars sessions lineage', () => {
  it('reads the files and prints the walk; a torn line and a foreign line are skipped', async () => {
    const staged = stage();
    const h = harness();
    h.deps.sessions = staged.runtime;
    expect(await loadLineage(staged.storeDir)).toEqual({ recalls: [], reads: [], cells: [] });
    const files = poolFiles(staged.storeDir);
    const one = cell('2026-11-01');
    mkdirSync(`${staged.storeDir}/reads`, { recursive: true });
    writeFileSync(files.cells, `${JSON.stringify(one)}\nnot json\n{"other":1}\n`);
    writeFileSync(files.reads('p'), `${JSON.stringify(read('read:a', [cellIdOf(one)]))}\n`);
    writeFileSync(`${staged.storeDir}/reads/notes.txt`, 'not a read file');
    await appendRecall(staged.storeDir, recall([evidence('read:a')]));
    expect(await run(['sessions', 'lineage', 'recall-one'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('').trim().split('\n')).toHaveLength(3);
    h.out.length = 0;
    expect(await run(['--json', 'sessions', 'lineage', 'read:a'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('"kind":"cell"');
    expect(await run(['sessions', 'lineage', 'no-such-id'], h.deps)).toBe(ExitCode.INVALID);
  });

  it('counts recalls from the command line, within a day', async () => {
    const staged = stage();
    const h = harness();
    h.deps.sessions = staged.runtime;
    await appendRecall(staged.storeDir, recall([]));
    expect(await run(['sessions', 'recall', '--counts', '--day', '2026-11-02'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('push shown hit | 1 recalls, 1 sessions');
    h.out.length = 0;
    expect(await run(['--json', 'sessions', 'recall', '--counts'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('"day":null');
  });
});
