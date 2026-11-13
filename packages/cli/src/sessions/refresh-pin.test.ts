import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyUsage } from './extract.js';
import { error as errorRow, frame as frameOf, prompt as promptRow, session as sessionRow, tool as toolRow } from './pool-fixture.js';
import { appendRecall, makeRecall, readRecalls, type Recall } from './recall-object.js';
import { deriveConsequences, recallGraphOf } from './recall-consequence.js';
import { shellReader } from './projection.js';
import { vocabulary } from './vocab-load.js';
import { CAPTURE_VERSION, type ToolObservation } from './schema.js';
import { poolFiles } from './pool.js';
import { cellsFold, cellsOf, projectedStore } from './cell-increments.js';
import { fitFold, fitReads } from './recall-reads.js';
import { finishReversions, foldReversions, newReversionIndex, reversionsOf } from './reversion.js';
import { derive, deriveFold, loadStore, paths, refresh, runOrder, scanLog } from './store.js';
import { cleanup, stage } from './test-support.js';

afterEach(cleanup);

/**
 * The oracle for the bounded refresh (t1239 spec 4, Build 1 Item 1): a store whose cross-session joins and visit order every derived file depends on, refreshed, then every
 * file `refresh` wrote hashed. A change to `refresh` that moves one byte fails here; the pin is never updated to match a change.
 */
const PIN_AT = '2026-11-02T00:00:00.000Z';
const stamp = (minute: number, second = 0, millis = 0): string => `2026-11-01T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${String(millis).padStart(3, '0')}Z`;

const userPrompt = (session: string, index: number, ts: string, wallSec: number | null, rev = 1, head = `prompt ${String(index)} of ${session}`) => ({
  kind: 'user-prompt', cv: CAPTURE_VERSION, sid: null, session, rev, index, ts, wallSec, head, thinking: 0, turns: 1, model: 'claude-opus-5-5', efforts: ['high'], skills: [], usage: emptyUsage(), promptFingerprint: null, frame: frameOf(),
});

const call = (session: string, n: number, name: string, minute: number, promptIndex: number, over: Partial<ToolObservation> = {}): ToolObservation =>
  toolRow(session, n, name, { cv: CAPTURE_VERSION, ts: stamp(minute, n), prompt: promptIndex, ...over });

const errorLine = (session: string, n: number, minute: number, promptIndex: number, line: string, after: number) => ({
  kind: 'error-line', cv: CAPTURE_VERSION, sid: null, session, rev: 1, toolUseId: `${session}-${String(n)}`, tool: 'Bash', line, ts: stamp(minute, n), harnessVersion: '2.1.314', side: false, prompt: promptIndex, after,
});

const recallAt = (sid: string, at: string): Recall =>
  makeRecall({ sid, at, frame: null, mode: 'push', query: { form: 'pattern', prefix: ['shape'] }, poolVersion: '2026-10-01T00:00:00.000Z', arm: 'shown', reads: ['r'], rendered: 'x'.repeat(40), names: ['file.edit'], evidence: [] });

const captured = (id: string, over: Partial<ReturnType<typeof sessionRow>> = {}): ReturnType<typeof sessionRow> => sessionRow(id, { cv: CAPTURE_VERSION, repo: 'r', tsFirst: stamp(0), tsLast: stamp(59), ...over });

/**
 * Every row of the log, in log order. `sa` holds the two recalled prompts: P1 (index 0) commits sha abc1234 and P2 (index 1) edits `src/y.ts`, uncommitted. `sc` later runs `git revert abc1234` and `sd`
 * `git restore src/y.ts`, all in one repository, each stamped later. Also: two subagents captured before their parents (one of `sa`, after it), errors with tied `next` tools, fractional `wallSec`, a version 2 session whose lines follow
 * the version 3 sessions', and a superseded copy of a session.
 */
const rows = (): unknown[] => [
  captured('old', { rev: 1, cv: '4' }), userPrompt('old', 0, stamp(2), 3.5),
  captured('sa'), userPrompt('sa', 0, stamp(1), 12.345), userPrompt('sa', 1, stamp(1, 2), 7.125),
  call('sa', 0, 'Read', 1, 0),
  call('sa', 1, 'Bash', 1, 0, { segments: [{ run: 'git commit', read: true }], commits: ['abc1234'] }),
  call('sa', 2, 'Read', 1, 1),
  call('sa', 3, 'Edit', 1, 1, { target: 'src/y.ts', digests: [{ old: 'aaaa', new: 'bbbb' }] }),
  call('sa', 4, 'Bash', 1, 1, { status: 'error', segments: [{ run: 'npm test', read: true }] }), errorLine('sa', 4, 1, 1, 'npm ERR! missing script: test', 4),
  call('sa', 5, 'Edit', 1, 1, { target: 'src/z.ts', digests: [{ old: 'cccc', new: 'dddd' }] }),
  call('sa', 6, 'Read', 1, 1),
  // The subagent of `sc` is captured before its parent, and before `sb`.
  captured('sc~ag', { parent: 'sc', spawnedBy: 'sc-1', agentType: 'general' }), userPrompt('sc~ag', 0, stamp(21), 1.5),
  call('sc~ag', 0, 'Bash', 21, 0, { status: 'error', side: true, parent: 'sc' }), errorLine('sc~ag', 0, 21, 0, 'npm ERR! missing script: test', 0),
  call('sc~ag', 1, 'Read', 21, 0, { side: true, parent: 'sc' }),
  // A second subagent, of the earlier session `sa`, whose lines follow the first subagent's: the errors of two subagents append after every main session's.
  captured('sa~ag', { parent: 'sa', spawnedBy: 'sa-1', agentType: 'general' }), userPrompt('sa~ag', 0, stamp(22), 0.75),
  call('sa~ag', 0, 'Bash', 22, 0, { status: 'error', side: true, parent: 'sa' }), errorLine('sa~ag', 0, 22, 0, 'npm ERR! missing script: test', 0),
  captured('sb'), userPrompt('sb', 0, stamp(10), 2.5),
  call('sb', 0, 'Bash', 10, 0, { status: 'error' }), errorLine('sb', 0, 10, 0, 'npm ERR! missing script: test', 0),
  call('sb', 1, 'Edit', 10, 0, { target: 'src/w.ts' }), call('sb', 2, 'Read', 10, 0),
  captured('sc'), userPrompt('sc', 0, stamp(20), 4.75),
  call('sc', 0, 'Bash', 20, 0, { segments: [{ run: 'git revert abc1234', read: true }] }), call('sc', 1, 'Task', 20, 0),
  captured('sd'), userPrompt('sd', 0, stamp(30), 5.5),
  call('sd', 0, 'Bash', 30, 0, { segments: [{ run: 'git restore src/y.ts', read: true }], restores: ['src/y.ts'] }),
  // A version 1 session between them: unreadable like version 2, so it too has its rows ahead of the readable sessions' and is placed by its first line.
  sessionRow('sx', { cv: '1', repo: 'r' }), promptRow('sx', 0, { wallSec: 0.5, ts: stamp(35) }), errorRow('sx', 'old sig', { next: ['Edit'] }),
  // A version 2 session after the version 3 sessions in the log: its prompts and errors come first in the store.
  sessionRow('v2', { cv: '2', repo: 'r' }), promptRow('v2', 0, { wallSec: 0.25, ts: stamp(40) }), errorRow('v2', 'old sig', { next: ['Read', 'Edit'] }),
  // The superseded copy's newer rev, last in the log.
  captured('old', { rev: 2 }), userPrompt('old', 0, stamp(2), 3.5, 2, 'recaptured'),
];

/** The sha256 of every file under the store but the log, the state, and the recall record, by path. */
const hashes = (storeDir: string): { [path: string]: string } => {
  const found: { [path: string]: string } = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!['observations.jsonl', 'state.json', 'recalls.jsonl'].includes(entry.name) && !entry.name.endsWith('.lock')) found[relative(storeDir, full).split('\\').join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(storeDir);
  return found;
};

/** The store refreshed once: the pool's consequence rows (P1 and P2 are rows 0 and 1) and every written file's hash. */
const stagedLog = (): ReturnType<typeof stage> => {
  const staged = stage();
  mkdirSync(staged.storeDir, { recursive: true });
  writeFileSync(paths(staged.storeDir).observations, `${rows().map((row) => JSON.stringify(row)).join('\n')}\n`);
  return staged;
};

const PINNED_FILES = {
  'cells.jsonl': '9d8d8d87aaacc972d60af23e977bbbc04a05832d42f47438b83e570c157a5be5',
  'consequences.jsonl': 'f8b3180c8e3f07550ef8208813a524e975f2adbb09ef11dc82fce35324fcfc29',
  'derived.json': 'b21355137904c00e61e6d841467c478733f45229f34c8710b618441a84c0cd46',
  'hook-index.json': 'f1786daa214f9e50550cee1a7f9956250c7d22508ac50cb9ddccfec3c6d70cff',
  'load-status.jsonl': '1943b26443d2b7cba53fe6c9b9dab2235da9701b2732c24ec364bc2378b7e374',
  'motifs.jsonl': 'c26e98dec42688c8d6af7cc2f07c0db6aee2262c8ceab3d14eaadf382e299fec',
  'reads/b49f5d5dea00b56c.jsonl': 'fbd7037c804e5c2b118c5bfae97b8ee39ddda7c5aefef1e147af3322b438f838',
};

/** What a run of `refresh` told its seam: how many runs it folded, and the size of the reversion index. Absent when the seam was never called. */
type Folded = { runs: number; reversions: number };

const refreshed = async (runSize?: number, replaceLog = false): Promise<{ reverted: Array<string | null>; ns: Array<number | null>; files: { [path: string]: string }; folded: Folded | undefined }> => {
  const staged = stagedLog();
  await appendRecall(staged.storeDir, recallAt('sa', stamp(1, 0, 500)));
  await appendRecall(staged.storeDir, recallAt('sa', stamp(1, 2, 500)));
  let folded: Folded | undefined;
  // A compaction renames a rewritten log into place between the scan and the runs. The rewrite keeps every live row behind a long line a reader skips, so each span the scan recorded points elsewhere.
  const afterScan = replaceLog
    ? (): Promise<void> => {
        const log = paths(staged.storeDir).observations;
        const swap = `${log}.swap`;
        writeFileSync(swap, `${['x'.repeat(200_000), ...readFileSync(log, 'utf8').split('\n').filter((line) => line !== '')].join('\n')}\n`);
        renameSync(swap, log);
        return Promise.resolve();
      }
    : undefined;
  await refresh({ ...staged.runtime, ...(runSize === undefined ? {} : { refreshRun: runSize }), ...(afterScan === undefined ? {} : { afterScan }), refreshed: (told) => { folded = told; } }, [], PIN_AT);
  const lines = readFileSync(poolFiles(staged.storeDir).consequences, 'utf8').split('\n').filter((line) => line !== '');
  const reverted = lines.map((line): string | null => {
    const parsed: unknown = JSON.parse(line);
    const reversion: unknown = Reflect.get(Reflect.get(Reflect.get(Object(parsed), 'consequence'), 'outcome'), 'reverted');
    return typeof reversion === 'string' ? reversion : null;
  });
  const ns = lines.map((line): number | null => {
    const n: unknown = Reflect.get(Object(JSON.parse(line)), 'n');
    return typeof n === 'number' ? n : null;
  });
  return { reverted, ns, files: hashes(staged.storeDir), folded };
};

describe('refresh writes the same bytes for a store with cross-session joins (refreshpin)', () => {
  it('pins every derived file, and reads each commit-then-revert and edit-then-restore across sessions as later-session', async () => {
    const { reverted, ns, files } = await refreshed();
    expect(reverted).toEqual(['later-session', 'later-session']);
    // P1 and P2 are rows 0 and 1 by position; each row's own `n` (the call its window opens at: after P1's two calls, after P2's four) says which is which, so a swap of the rows would show here.
    expect(ns).toEqual([1, 3]);
    expect(files).toEqual(PINNED_FILES);
  });
});

describe('refresh folds the store a run of sessions at a time and writes the pinned bytes at any run size (refreshruns)', () => {
  // The fixture holds nine sessions and subagents: sx and v2 (unreadable), then sa, sc~ag, sa~ag, sb, sc, sd, and old.
  it.each([
    [1, 9],
    [2, 5],
    [10_000, 1],
    [undefined, 1],
  ])('run size %s folds %s run(s) and matches the pin, cross-session reversions included', async (size, runs) => {
    const { reverted, ns, files, folded } = await refreshed(size);
    expect(folded?.runs).toBe(runs);
    // The index holds the fixture's main-line commits, revert words, restores, and edits, whatever the run size.
    expect(folded?.reversions).toBeGreaterThan(0);
    expect(reverted).toEqual(['later-session', 'later-session']);
    expect(ns).toEqual([1, 3]);
    expect(files).toEqual(PINNED_FILES);
  });

  it.each([1, 10_000])('keeps the pinned bytes when the log is replaced after the scan, at run size %i (refreshcompact)', async (size) => {
    const { reverted, ns, files } = await refreshed(size, true);
    expect(reverted).toEqual(['later-session', 'later-session']);
    expect(ns).toEqual([1, 3]);
    expect(files).toEqual(PINNED_FILES);
  });

  it('reports the same index size at every run size', async () => {
    const sizes = await Promise.all([1, 2, 10_000].map(async (size) => (await refreshed(size)).folded?.reversions));
    expect(new Set(sizes).size).toBe(1);
  });
});

describe('the scan keeps what the run order needs (scanorder)', () => {
  it('holds each subagent parent and each session cv at its highest rev, and orders unreadable sessions ahead of the rest by first line', async () => {
    const staged = stagedLog();
    const scan = await scanLog(paths(staged.storeDir).observations, undefined, true);
    expect(scan.parents).toEqual(new Map([['sc~ag', 'sc'], ['sa~ag', 'sa']]));
    // `old` was captured at cv 4 and again at cv 35 at a higher rev; `sx` is version 1 and `v2` version 2, both unreadable.
    expect(scan.cvs).toEqual(new Map([['old', CAPTURE_VERSION], ['sa', CAPTURE_VERSION], ['sc~ag', CAPTURE_VERSION], ['sa~ag', CAPTURE_VERSION], ['sb', CAPTURE_VERSION], ['sc', CAPTURE_VERSION], ['sd', CAPTURE_VERSION], ['sx', '1'], ['v2', '2']]));
    // `sx` and `v2` lines follow `sd` lines in the log (`sx` first) and `old` highest rev is the last line; the subagents `sc~ag` and `sa~ag` are ahead of `sb` and `sc`, in the order their lines start.
    expect(runOrder(scan)).toEqual(['sx', 'v2', 'sa', 'sc~ag', 'sa~ag', 'sb', 'sc', 'sd', 'old']);
  });

  it('keeps a session with an unreadable cv ahead of readable ones whose lines start earlier', async () => {
    const staged = stagedLog();
    const scan = await scanLog(paths(staged.storeDir).observations, undefined, true);
    expect(scan.cvs.get('sx')).toBe('1');
    expect(runOrder(scan).indexOf('sx')).toBeLessThan(runOrder(scan).indexOf('sa'));
  });

  it('orders nothing for a scan made without spans', async () => {
    const staged = stagedLog();
    expect(runOrder(await scanLog(paths(staged.storeDir).observations))).toEqual([]);
  });
});

describe('each fold over runs equals the whole-store call (foldsplit)', () => {
  it.each([1, 2])('at run size %i, with the commit and its revert, and the edit and its restore, in different runs', async (size) => {
    const staged = stagedLog();
    const file = paths(staged.storeDir).observations;
    const scan = await scanLog(file, undefined, true);
    const whole = await loadStore(staged.storeDir);
    const order = runOrder(scan);
    const cells = cellsFold();
    const fit = fitFold({ minFailedSessions: 1, minFailedShare: 0, minCalls: 1 });
    const prompts = deriveFold();
    const index = newReversionIndex();
    for (let at = 0; at < order.length; at += size) {
      const run = await loadStore(staged.storeDir, undefined, { latest: scan.latest, only: new Set(order.slice(at, at + size)), spans: scan.spans, identity: scan.identity });
      cells.add(run);
      fit.add(run);
      prompts.add(run.prompts);
      foldReversions(index, run);
    }
    expect(cells.finish()).toEqual(cellsOf(whole));
    expect(fit.finish()).toEqual(fitReads(whole, { minFailedSessions: 1, minFailedShare: 0, minCalls: 1 }));
    expect(prompts.finish(whole, PIN_AT)).toEqual(derive(whole, PIN_AT));
    const split = finishReversions(index);
    const together = reversionsOf(whole);
    for (const key of ['sa', 'sb', 'sc', 'sd', 'v2', 'sc~ag', 'sa~ag']) for (const prompt of [0, 1]) expect(split(key, prompt)).toEqual(together(key, prompt));
    // The pair on P1 and the pair on P2 are each found alone, across runs.
    expect([split('sa', 0), split('sa', 1)]).toEqual(['later-session', 'later-session']);
  });

  it.each([1, 2])('folds the projected runs under a recall graph, and hands deriveConsequences the split lookup, at run size %i', async (size) => {
    const staged = stagedLog();
    await appendRecall(staged.storeDir, recallAt('sa', stamp(1, 0, 500)));
    await appendRecall(staged.storeDir, recallAt('sa', stamp(1, 2, 500)));
    const scan = await scanLog(paths(staged.storeDir).observations, undefined, true);
    const whole = await loadStore(staged.storeDir);
    const recalls = await readRecalls(staged.storeDir);
    const read = shellReader(vocabulary());
    const consequences = deriveConsequences(whole, recalls);
    const graph = recallGraphOf(whole, consequences);
    const order = runOrder(scan);
    const cells = cellsFold(graph);
    const index = newReversionIndex();
    for (let at = 0; at < order.length; at += size) {
      const run = await loadStore(staged.storeDir, undefined, { latest: scan.latest, only: new Set(order.slice(at, at + size)), spans: scan.spans, identity: scan.identity });
      cells.add(projectedStore(run, read));
      foldReversions(index, run);
    }
    expect(cells.finish()).toEqual(cellsOf(projectedStore(whole, read), graph));
    expect(deriveConsequences(whole, recalls, finishReversions(index))).toEqual(consequences);
  });
});
