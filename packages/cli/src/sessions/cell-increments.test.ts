// One cell computation for a deposit and a local read (pool vocabulary spec Section 4, rules 1 to 6).
import { describe, expect, it } from 'vitest';
import { cellsOf, incrementsOf, projectedStore, storeOf, type Increments } from './cell-increments.js';
import { deriveCells, effortClass, ENVIRONMENT_BUCKET, isEnvironmentCell, NO_AXES } from './cells.js';
import { classMotif } from './motif.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { floorOf, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import { deriveConsequences, recallGraphOf } from './recall-consequence.js';
import { makeRecall } from './recall-object.js';
import type { Strata } from './schema.js';
import type { Store } from './store.js';

const framed = frame({ shell: 'bash', stack: { languages: ['rust'], frameworks: ['astro'], size: 'xl' } });
const ID = '0123456789abcdef';
// The local store's one prompt runs at high effort and spends 5,000 thinking tokens.
const effortPairId = classMotif(effortClass('high', 5000)).motifId;

const pushStep = (n: number, cost: { tokens: number | null; durationMs: number | null }) => step(n, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: ['--force'] }, cost });

// A local store holding exact values, the way capture writes them.
const localStore = (): Store =>
  store({
    sessions: [session('s1', { frame: framed })],
    prompts: [prompt('s1', 0, { frame: framed, errors: 4, wallSec: 37, usage: { input: 123456, cacheWrite: 1500, cacheRead: 987654, output: 4321, thinking: 5000 } })],
    tools: [tool('s1', 0, 'Bash', { steps: [pushStep(0, { tokens: 98765, durationMs: 4321 })] }), tool('s1', 1, 'Bash', { steps: [pushStep(1, { tokens: 5000, durationMs: 150 })] })],
  });

const skeletonOfLocal = (local: Store): SessionSkeleton => {
  const [only] = sessionsFrom(local);
  const skeleton = only === undefined ? null : skeletonOf(only, ID, storedNames, printOf);
  if (skeleton === null) throw new Error('the local store has no skeleton');
  return skeleton;
};

const keyed = (cells: readonly { motifId: string; frameBucket: string; grain: string; day: string; exposed: boolean | number; sessions: number; ok: number; failed: number; tokens: number; durationMs: number }[]) =>
  cells.map(({ motifId, frameBucket, grain, day, exposed, sessions, ok, failed, tokens, durationMs }) => `${motifId}/${frameBucket}/${grain}/${day}/${String(Number(exposed))} ${String(sessions)} ${String(ok)} ${String(failed)} ${String(tokens)} ${String(durationMs)}`).sort();

describe('storeOf', () => {
  it('numbers the calls and prompts of a transcript by position, and ties each subagent to the main run', () => {
    const skeleton = skeletonOfLocal(localStore());
    const [main] = skeleton.transcripts;
    if (main === undefined) throw new Error('the skeleton has no transcript');
    const rebuilt = storeOf([{ ...skeleton, transcripts: [main, main] }]);
    expect(rebuilt.tools.map((held) => [held.session, held.n])).toEqual([[`${ID}#0`, 0], [`${ID}#0`, 1], [`${ID}#1`, 0], [`${ID}#1`, 1]]);
    expect(rebuilt.prompts.map((held) => [held.session, held.index])).toEqual([[`${ID}#0`, 0], [`${ID}#1`, 0]]);
    expect(rebuilt.tools.flatMap((held) => (held.steps ?? []).map((held_) => held_.seg))).toEqual([0, 0, 0, 0]);
    expect(rebuilt.subagents.map((agent) => [agent.session, agent.parent])).toEqual([[`${ID}#1`, `${ID}#0`]]);
  });
});

describe('rule 5: a bucket and no exact number', () => {
  it('counts the explore steps of a prompt as the lowest value of their bucket, and none when the record held none', () => {
    const strata = { languages: [], repoFiles: null, frameworks: [], explore: 37 };
    const local = store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed, strata }), prompt('s1', 1, { frame: framed })] });
    // 37 steps is bucket 7, whose lowest value is 33.
    expect(storeOf([skeletonOfLocal(local)]).prompts.map(({ explore }) => explore)).toEqual([33, 0]);
  });

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

  it('reads a usage category the wire sent as null as a placeholder zero that is left out of usageObserved, with the coverage the prompt sent', () => {
    const skeleton = skeletonOfLocal(localStore());
    const [main] = skeleton.transcripts;
    const first = main?.prompts[0];
    if (main === undefined || first === undefined) throw new Error('the skeleton has no prompt');
    const sent = { ...first, usage: { ...first.usage, input: null }, usageResponses: 3 };
    const rebuilt = storeOf([{ ...skeleton, transcripts: [{ ...main, prompts: [sent] }] }]).prompts[0];
    expect(rebuilt?.usage.input).toBe(0);
    expect(rebuilt?.usageObserved).toEqual(['cacheWrite', 'cacheRead', 'output', 'thinking']);
    expect(rebuilt?.usage.output).toBe(floorOf('tokens', first.usage.output ?? 0));
    expect(rebuilt?.usageResponses).toBe(floorOf('count', 3));
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
    expect(unnamed.size).toBe(4);
    expect(keyed(flooredCells.filter(({ motifId }) => unnamed.has(motifId)))).toEqual(keyed(exactCells.filter(({ motifId }) => unnamed.has(motifId))));
    // And one more: a deposit holds the program and subcommand alone, so the flagged call is a plain call there and has its (name, platform, shell) cell, which the exact store's flagged call does not.
    expect(flooredCells).toHaveLength(exactCells.length + 2);
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

  // The one difference that stays: a deposit is derived from a skeleton, which has no recall graph, so a recall the local store shows is a step and an exposure only locally.
  it('derives a session with a shown recall differently from its deposit, which has no recall graph', () => {
    const base = localStore();
    const timed = store({ ...base, tools: base.tools.map((held, n) => ({ ...held, ts: `2026-11-01T10:00:0${String(n * 2)}.000Z`, prompt: 0 })) });
    const recall = makeRecall({ sid: 's1', at: '2026-11-01T10:00:01.000Z', frame: null, mode: 'push', query: { form: 'pattern', prefix: ['shape'] }, poolVersion: '2026-10-01T00:00:00.000Z', arm: 'shown', reads: ['r'], rendered: 'x'.repeat(40), names: ['shell.exec'], evidence: [] });
    const recallActions = (motifs: readonly { steps: readonly { action: string }[] }[]): number => motifs.filter(({ steps }) => steps.some(({ action }) => action === 'recall.push')).length;
    const projected = projectedStore(timed, storedNames);
    const withGraph = cellsOf(projected, recallGraphOf(timed, deriveConsequences(timed, [recall])));
    const deposit = incrementsOf(skeletonOfLocal(timed));
    expect(recallActions(withGraph.motifs)).toBeGreaterThan(0);
    expect(withGraph.cells.some(({ exposed }) => exposed)).toBe(true);
    expect(recallActions(deposit.motifs)).toBe(0);
    expect([...deposit.cells.values()].some(({ exposed }) => exposed)).toBe(false);
    expect(keyed([...deposit.cells.values()])).not.toEqual(keyed(withGraph.cells));
    // Without the graph the two are the same cells, so the graph is the whole difference.
    expect(keyed([...deposit.cells.values()])).toEqual(keyed(cellsOf(projected).cells));
  });

  it('reads a record with no steps as it is, and a shell step as a deposit would project it', () => {
    const bare = store({ sessions: [session('s1')], tools: [tool('s1', 0, 'Bash')] });
    expect(projectedStore(bare, storedNames)).toEqual(bare);
    const projected = projectedStore(localStore(), () => [{ program: 'ffmpeg', subcommand: null, flags: ['-i'] }]);
    expect(projected.tools[0]?.steps?.[0]?.identity).toEqual({ program: 'ffmpeg', sub: null, flags: [] });
  });
});

describe('rules 1 to 3 and 6: what a cell and a stratum hold', () => {
  const increments = (): Increments => incrementsOf(skeletonOfLocal(localStore()));

  it('keeps one element per cell: one motif, one frame bucket, one grain and period, and one exposure, with no row joining two cells', () => {
    const { cells, motifs } = increments();
    const known = new Set(motifs.map(({ motifId }) => motifId));
    expect(cells.size).toBeGreaterThan(1);
    for (const [key, cell] of cells) {
      expect(key).toBe(`${cell.motifId}/${cell.frameBucket}/${cell.grain}/${cell.day}/${String(cell.exposed)}`);
      expect(known.has(cell.motifId)).toBe(true);
      // The effort pair joins no axis (rule 3); every other cell holds a harness, a version bucket, and a model.
      // A (name, platform, shell) cell joins those two and neither a version nor a model.
      if (cell.frameBucket !== NO_AXES && !cell.frameBucket.startsWith(ENVIRONMENT_BUCKET)) expect(cell.frameBucket.split('/')).toHaveLength(3);
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
              steps: [step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: ['--force', '--tags'], pulls: [{ registry: 'npm', name: 'zod', version: null }, { registry: 'npm', name: 'react', version: '1.0.0' }] } })],
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
    expect(single(null, 'zod')).toBe(1);
    expect(single(null, 'react')).toBe(1);
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
    const keys = cells.map(({ motifId, frameBucket, grain, day, exposed }) => `${motifId}/${frameBucket}/${grain}/${day}/${String(exposed)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('pools a stack stratum alone, per value, and no other bound field', () => {
    const { strata } = increments();
    expect([...strata.keys()].sort()).toEqual(['framework/astro', 'language/rust', 'repoFiles/xl']);
    for (const stratum of strata.values()) expect(stratum.sessions).toBe(1);
  });

  it('pools the two pair strata per value, each beside the single ones, and no pair for a language without a share or a prompt without a count', () => {
    // A stored share is text on a record, so a test can hold one the list does not: Object.assign types the result as the record while the input stays loose.
    const strata: Strata = Object.assign({ languages: [], repoFiles: null, frameworks: [], explore: 37 }, { languages: [{ language: 'rust', share: 'over-50' }, { language: 'go', share: 'nonsense' }], repoFiles: 'over-100k' });
    const local = store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed, strata }), prompt('s1', 1, { frame: framed })] });
    const keys = [...incrementsOf(skeletonOfLocal(local)).strata.keys()];
    // 37 explore steps is bucket 7; the second prompt held no count, and a share outside its list is dropped with its pair.
    expect(keys.filter((key) => key.startsWith('languageShare/') || key.startsWith('repoFilesExplore/')).sort()).toEqual(['languageShare/rust/over-50', 'repoFilesExplore/xl/7']);
    expect(keys).toContain('repoFiles/xl');
    for (const stratum of incrementsOf(skeletonOfLocal(local)).strata.values()) expect(stratum.sessions).toBe(1);
  });

  it('pools a language outside the pinned list as other, beside its share', () => {
    const strata: Strata = { languages: [{ language: 'other', share: '10-50' }, { language: 'rust', share: 'over-50' }], repoFiles: null, frameworks: [], explore: 0 };
    const local = store({ sessions: [session('s1', { frame: framed, strata })], prompts: [prompt('s1', 0, { frame: framed, strata })] });
    const keys = [...incrementsOf(skeletonOfLocal(local)).strata.keys()].filter((key) => key.startsWith('languageShare/')).sort();
    expect(keys).toEqual(['languageShare/other/10-50', 'languageShare/rust/over-50']);
  });

  it('puts only the axes in a cell key, and never effort (rule 3)', () => {
    for (const cell of increments().cells.values()) expect(cell.frameBucket).toBe(cell.motifId === effortPairId ? NO_AXES : isEnvironmentCell({ frameBucket: cell.frameBucket }) ? 'env:linux:bash' : 'claude-code/2.1.31x/claude-opus-5-5');
  });

  // Rule 6: a cell is weekly except `live`. 2026-11-01 is a Sunday, so its UTC week starts on Monday 2026-10-26.
  it('keys every cell on its UTC week, and only a live shape cell on the UTC day', () => {
    const held = [...increments().cells.values()];
    for (const cell of held) expect(cell.day).toBe(cell.grain === 'week' ? '2026-10-26' : '2026-11-01');
    expect(held.filter(({ grain }) => grain === 'day').length).toBeGreaterThan(0);
    expect(held.filter(({ grain }) => grain === 'week').length).toBeGreaterThan(0);
  });
});
