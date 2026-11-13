import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyUsage } from './extract.js';
import { error as errorRow, frame as frameOf, prompt as promptRow, session as sessionRow, tool as toolRow } from './pool-fixture.js';
import { appendRecall, makeRecall, type Recall } from './recall-object.js';
import { CAPTURE_VERSION, type ToolObservation } from './schema.js';
import { poolFiles } from './pool.js';
import { paths, refresh, runOrder, scanLog } from './store.js';
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
 * `git restore src/y.ts`, all in one repository, each stamped later. Also: a subagent captured before its parent, errors with tied `next` tools, fractional `wallSec`, a version 2 session whose lines follow
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
  captured('sb'), userPrompt('sb', 0, stamp(10), 2.5),
  call('sb', 0, 'Bash', 10, 0, { status: 'error' }), errorLine('sb', 0, 10, 0, 'npm ERR! missing script: test', 0),
  call('sb', 1, 'Edit', 10, 0, { target: 'src/w.ts' }), call('sb', 2, 'Read', 10, 0),
  captured('sc'), userPrompt('sc', 0, stamp(20), 4.75),
  call('sc', 0, 'Bash', 20, 0, { segments: [{ run: 'git revert abc1234', read: true }] }), call('sc', 1, 'Task', 20, 0),
  captured('sd'), userPrompt('sd', 0, stamp(30), 5.5),
  call('sd', 0, 'Bash', 30, 0, { segments: [{ run: 'git restore src/y.ts', read: true }], restores: ['src/y.ts'] }),
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

const refreshed = async (): Promise<{ reverted: Array<string | null>; files: { [path: string]: string } }> => {
  const staged = stagedLog();
  await appendRecall(staged.storeDir, recallAt('sa', stamp(1, 0, 500)));
  await appendRecall(staged.storeDir, recallAt('sa', stamp(1, 2, 500)));
  await refresh(staged.runtime, [], PIN_AT);
  const lines = readFileSync(poolFiles(staged.storeDir).consequences, 'utf8').split('\n').filter((line) => line !== '');
  const reverted = lines.map((line): string | null => {
    const parsed: unknown = JSON.parse(line);
    const reversion: unknown = Reflect.get(Reflect.get(Reflect.get(Object(parsed), 'consequence'), 'outcome'), 'reverted');
    return typeof reversion === 'string' ? reversion : null;
  });
  return { reverted, files: hashes(staged.storeDir) };
};

describe('refresh writes the same bytes for a store with cross-session joins (refreshpin)', () => {
  it('pins every derived file, and reads each commit-then-revert and edit-then-restore across sessions as later-session', async () => {
    const { reverted, files } = await refreshed();
    expect(reverted).toEqual(['later-session', 'later-session']);
    expect(files).toEqual({
      'cells.jsonl': '4c0b771f366bd80264ea02b2508030e6c53853cda4814e65a228a95e845c7428',
      'consequences.jsonl': 'f8b3180c8e3f07550ef8208813a524e975f2adbb09ef11dc82fce35324fcfc29',
      'derived.json': '7ff2fff40d988705f9a3249920176ba805d78a3896654dca4c4cfa51d86f730a',
      'hook-index.json': 'c12481574eeb02213d818fdec4d72a778fdc5059c047a2b88482ee745f7b0cd0',
      'load-status.jsonl': 'c99c8cf3f7fe884931b49275b8788cc953385334cf7d2f939b173a843a72f122',
      'motifs.jsonl': 'c26e98dec42688c8d6af7cc2f07c0db6aee2262c8ceab3d14eaadf382e299fec',
      'reads/99960caed91573ea.jsonl': '6b97d91c45c5b29e07fba98d703caaae425938a752af6be63b363d6ebaae1ac2',
    });
  });
});

describe('the scan keeps what the run order needs (scanorder)', () => {
  it('holds each subagent parent and each session cv at its highest rev, and orders version 2 sessions ahead of the rest by first line', async () => {
    const staged = stagedLog();
    const scan = await scanLog(paths(staged.storeDir).observations, undefined, true);
    expect(scan.parents).toEqual(new Map([['sc~ag', 'sc']]));
    // `old` was captured at cv 4 and again at cv 35 at a higher rev; `v2` is version 2.
    expect(scan.cvs).toEqual(new Map([['old', CAPTURE_VERSION], ['sa', CAPTURE_VERSION], ['sc~ag', CAPTURE_VERSION], ['sb', CAPTURE_VERSION], ['sc', CAPTURE_VERSION], ['sd', CAPTURE_VERSION], ['v2', '2']]));
    // `v2` lines follow `sd` lines in the log, and `old` highest rev is the last line; the subagent `sc~ag` is ahead of `sb` and `sc`.
    expect(runOrder(scan)).toEqual(['v2', 'sa', 'sc~ag', 'sb', 'sc', 'sd', 'old']);
  });

  it('keeps a session with an unreadable cv ahead of readable ones, whatever its place in the log', async () => {
    const staged = stagedLog();
    const scan = await scanLog(paths(staged.storeDir).observations, undefined, true);
    scan.cvs.set('sd', '1');
    expect(runOrder(scan).slice(0, 2)).toEqual(['sd', 'v2']);
  });

  it('orders nothing for a scan made without spans', async () => {
    const staged = stagedLog();
    expect(runOrder(await scanLog(paths(staged.storeDir).observations))).toEqual([]);
  });
});
