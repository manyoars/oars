// One cell computation for a deposit and a local read (pool vocabulary spec Section 4, rules 1 to 6).
import { describe, expect, it } from 'vitest';
import { cellsOf, incrementsOf, projectedStore, storeOf, type Increments } from './cell-increments.js';
import { deriveCells } from './cells.js';
import { classMotif } from './motif.js';
import { frame, prompt, session, step, storedNames, store, tool } from './pool-fixture.js';
import { floorOf, sessionsOf, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import { deriveConsequences, recallGraphOf } from './recall-consequence.js';
import { makeRecall } from './recall-object.js';
import type { Store } from './store.js';

const framed = frame({ shell: 'bash', stack: { languages: ['rust'], frameworks: ['astro'], size: 'xl' } });
const ID = '0123456789abcdef';

const pushStep = (n: number, cost: { tokens: number | null; durationMs: number | null }) => step(n, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: ['--force'] }, cost });

// A local store holding exact values, the way capture writes them.
const localStore = (): Store =>
  store({
    sessions: [session('s1', { frame: framed })],
    prompts: [prompt('s1', 0, { frame: framed, errors: 4, wallSec: 37, usage: { input: 123456, cacheWrite: 1500, cacheRead: 987654, output: 4321, thinking: 5000 } })],
    tools: [tool('s1', 0, 'Bash', { steps: [pushStep(0, { tokens: 98765, durationMs: 4321 })] }), tool('s1', 1, 'Bash', { steps: [pushStep(1, { tokens: 5000, durationMs: 150 })] })],
  });

const skeletonOfLocal = (local: Store): SessionSkeleton => {
  const [only] = sessionsOf(local);
  const skeleton = only === undefined ? null : skeletonOf(only, ID, storedNames);
  if (skeleton === null) throw new Error('the local store has no skeleton');
  return skeleton;
};

const keyed = (cells: readonly { motifId: string; frameBucket: string; day: string; exposed: boolean | number; sessions: number; ok: number; failed: number; tokens: number; durationMs: number }[]) =>
  cells.map(({ motifId, frameBucket, day, exposed, sessions, ok, failed, tokens, durationMs }) => `${motifId}/${frameBucket}/${day}/${String(Number(exposed))} ${String(sessions)} ${String(ok)} ${String(failed)} ${String(tokens)} ${String(durationMs)}`).sort();

describe('storeOf', () => {
  it('numbers the calls and prompts of a transcript by position, and ties each subagent to the main run', () => {
    const skeleton = skeletonOfLocal(localStore());
    const [main] = skeleton.transcripts;
    if (main === undefined) throw new Error('the skeleton has no transcript');
    const rebuilt = storeOf([{ ...skeleton, transcripts: [main, main] }]);
    expect(rebuilt.tools.map((held) => [held.session, held.n])).toEqual([[`${ID}#0`, 0], [`${ID}#0`, 1], [`${ID}#1`, 0], [`${ID}#1`, 1]]);
    expect(rebuilt.prompts.map((held) => [held.session, held.index])).toEqual([[`${ID}#0`, 0], [`${ID}#1`, 0]]);
    expect(rebuilt.subagents.map((agent) => [agent.session, agent.parent])).toEqual([[`${ID}#1`, `${ID}#0`]]);
  });
});

describe('rule 5: a bucket and no exact number', () => {
  it('counts a prompt as the lowest value of each bucket, never the exact tokens or seconds', () => {
    const { cells } = incrementsOf(skeletonOfLocal(localStore()));
    const asked = classMotif('edit-verify').motifId;
    const cell = [...cells.values()].find((held) => held.motifId === asked);
    // 123456, 1500, 987654, and 4321 tokens read as 64,000, 1,000, 512,000, and 4,000; 37 s reads as 32 s.
    expect(cell).toMatchObject({ tokens: floorOf('tokens', 7) + floorOf('tokens', 1) + floorOf('tokens', 10) + floorOf('tokens', 3), durationMs: floorOf('seconds', 6) * 1000 });
    expect(cell?.tokens).toBe(581_000);
    expect(cell?.durationMs).toBe(32_000);
    expect(cell?.failed).toBe(1);
  });

  it('reads a lower bound of what the local store derives exactly, and equal when every value sits on a floor', () => {
    const exact = deriveCells(localStore());
    const floored = incrementsOf(skeletonOfLocal(localStore()));
    const sum = (rows: readonly { tokens: number; durationMs: number }[], field: 'tokens' | 'durationMs'): number => rows.reduce((total, row) => total + row[field], 0);
    expect(sum([...floored.cells.values()], 'tokens')).toBeLessThan(sum(exact.cells, 'tokens'));
    expect(sum([...floored.cells.values()], 'durationMs')).toBeLessThan(sum(exact.cells, 'durationMs'));
    const onFloors = store({
      sessions: [session('s1', { frame: framed })],
      prompts: [prompt('s1', 0, { frame: framed, wallSec: 32, usage: { input: 64000, cacheWrite: 1000, cacheRead: 512000, output: 4000, thinking: 4000 } })],
      tools: [tool('s1', 0, 'Bash', { steps: [pushStep(0, { tokens: 64000, durationMs: 3200 })] })],
    });
    // The named cell keys on the program and subcommand alone now (rule 1), so a one-flag step's old named cell is now its flag cell (same id, same counts) and the program-and-subcommand cell is new.
    const exactCells = deriveCells(onFloors).cells;
    const flooredCells = [...incrementsOf(skeletonOfLocal(onFloors)).cells.values()];
    const unnamed = new Set(exactCells.filter(({ motifId }) => flooredCells.some((cell) => cell.motifId === motifId)).map(({ motifId }) => motifId));
    expect(unnamed.size).toBe(3);
    expect(keyed(flooredCells.filter(({ motifId }) => unnamed.has(motifId)))).toEqual(keyed(exactCells.filter(({ motifId }) => unnamed.has(motifId))));
    expect(flooredCells).toHaveLength(exactCells.length + 1);
  });
});

describe('the local read and the deposit share one computation', () => {
  it('gives a local store and the skeleton of that store the same cells', () => {
    const local = localStore();
    const viaLocalRead = cellsOf(projectedStore(local, storedNames)).cells;
    const viaDeposit = incrementsOf(skeletonOfLocal(local)).cells;
    expect(viaDeposit.size).toBeGreaterThan(1);
    expect(keyed([...viaDeposit.values()])).toEqual(keyed(viaLocalRead));
  });

  it('reads a record with no steps as it is, and a shell step as a deposit would project it', () => {
    const bare = store({ sessions: [session('s1')], tools: [tool('s1', 0, 'Bash')] });
    expect(projectedStore(bare, storedNames)).toEqual(bare);
    const projected = projectedStore(localStore(), () => [{ program: 'ffmpeg', subcommand: null, flags: ['-i'] }]);
    expect(projected.tools[0]?.steps?.[0]?.identity).toEqual({ program: 'private', sub: null, flags: [] });
  });
});

describe('rules 1 to 3 and 6: what a cell and a stratum hold', () => {
  const increments = (): Increments => incrementsOf(skeletonOfLocal(localStore()));

  it('keeps one element per cell: one motif, one frame bucket, one day, and one exposure, with no row joining two cells', () => {
    const { cells, motifs } = increments();
    const known = new Set(motifs.map(({ motifId }) => motifId));
    expect(cells.size).toBeGreaterThan(1);
    for (const [key, cell] of cells) {
      expect(key).toBe(`${cell.motifId}/${cell.frameBucket}/${cell.day}/${String(cell.exposed)}`);
      expect(known.has(cell.motifId)).toBe(true);
      expect(cell.frameBucket.split('/')).toHaveLength(4);
    }
  });

  // A step with two flags and a pull, and a stack with two languages: each must reach a cell one at a time.
  const manyFramed = frame({ shell: 'bash', stack: { languages: ['rust', 'go'], frameworks: ['astro', 'vite'], size: 'xl' } });
  const many = (): Increments =>
    incrementsOf(
      skeletonOfLocal(
        store({
          sessions: [session('s1', { frame: manyFramed })],
          prompts: [prompt('s1', 0, { frame: manyFramed })],
          tools: [
            tool('s1', 0, 'Bash', {
              steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: ['--force', '--tags'], pulls: [{ registry: 'npm', name: 'left-pad', version: null }, { registry: 'npm', name: 'is-odd', version: '1.0.0' }] } })],
            }),
          ],
        }),
      ),
    );

  it('puts no list longer than one in a cell or a motif: each flag and each pull is its own cell', () => {
    const { motifs, strata } = many();
    for (const { steps } of motifs) {
      for (const { identity } of steps) {
        if (identity === null || !('program' in identity)) continue;
        expect(identity.flags.length).toBeLessThanOrEqual(1);
        expect(identity.pulls?.length ?? 0).toBeLessThanOrEqual(1);
      }
    }
    const single = (flag: string | null, pull: string | null): number =>
      motifs.filter(({ level, steps }) => level === 'named' && steps.length === 1 && steps.some(({ identity }) => identity !== null && 'program' in identity && identity.flags.join() === (flag ?? '') && (identity.pulls ?? []).map(({ name }) => name).join() === (pull ?? ''))).length;
    expect(single('--force', null)).toBe(1);
    expect(single('--tags', null)).toBe(1);
    expect(single(null, 'left-pad')).toBe(1);
    expect(single(null, 'is-odd')).toBe(1);
    expect(single(null, null)).toBe(1);
    expect([...strata.keys()].sort()).toEqual(['framework/astro', 'framework/vite', 'language/go', 'language/rust', 'repoFiles/xl']);
  });

  it('keeps one row per cell key when a shown recall follows a call with two flags', () => {
    const flagged = store({
      sessions: [session('s1', { frame: manyFramed })],
      prompts: [prompt('s1', 0, { frame: manyFramed })],
      tools: [
        tool('s1', 0, 'Bash', { ts: '2026-11-01T10:00:00.000Z', prompt: 0, steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: ['--force', '--tags'] }, cost: { tokens: 1000, durationMs: 100 } })] }),
        tool('s1', 1, 'Read', { ts: '2026-11-01T10:00:02.000Z', prompt: 0 }),
      ],
    });
    const recall = makeRecall({ sid: 's1', at: '2026-11-01T10:00:01.000Z', frame: null, mode: 'push', query: { form: 'pattern', prefix: ['shape'] }, poolVersion: '2026-10-01T00:00:00.000Z', arm: 'shown', reads: ['r'], rendered: 'x'.repeat(40), names: ['file.edit'], evidence: [] });
    const { cells } = cellsOf(projectedStore(flagged, storedNames), recallGraphOf(flagged, deriveConsequences(flagged, [recall])));
    const keys = cells.map(({ motifId, frameBucket, day, exposed }) => `${motifId}/${frameBucket}/${day}/${String(exposed)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('pools a stack stratum alone, per value, and no other bound field', () => {
    const { strata } = increments();
    expect([...strata.keys()].sort()).toEqual(['framework/astro', 'language/rust', 'repoFiles/xl']);
    for (const stratum of strata.values()) expect(stratum.sessions).toBe(1);
  });

  it('puts only the axes and effort in a cell key', () => {
    const [cell] = increments().cells.values();
    expect(cell?.frameBucket).toBe('claude-code/2.1.31x/claude-opus-5-5/high');
  });

  // Stated limit (pool.md): the cell model is at UTC day, and its frame bucket still names `effort`. Rules 6 (week) and 3 (no `effort` in a cell key) need the cells rebuilt.
  it('keeps the cells at the frame\'s UTC day, the grain the cell model holds today', () => {
    for (const cell of increments().cells.values()) expect(cell.day).toBe('2026-11-01');
  });
});
