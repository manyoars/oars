import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveCells } from './cells.js';
import { shapeId } from './motif.js';
import { poolFiles, refreshPool } from './pool.js';
import { prompt, session, store, tool } from './pool-fixture.js';
import { deriveConsequences, formatRecallCounts, recallCounts, recallGraphOf, WINDOW_CALLS } from './recall-consequence.js';
import { appendRecall, makeRecall, type Recall, type RecallArm } from './recall-object.js';
import type { StepObservation, ToolObservation } from './schema.js';
import { cleanup, stage } from './test-support.js';

afterEach(cleanup);

const stamp = (n: number): string => `2026-11-01T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`;
const call = (n: number, name: string, promptIndex: number, over: Partial<ToolObservation> = {}): ToolObservation => tool('s', n, name, { ts: stamp(n), prompt: promptIndex, ...over });

const recallAt = (n: number, arm: RecallArm = 'shown', sid: string | null = 's'): Recall =>
  makeRecall({ sid, at: stamp(n), frame: null, mode: 'push', query: { form: 'pattern', prefix: ['shape'] }, poolVersion: '2026-10-01T00:00:00.000Z', arm, reads: ['r'], rendered: 'x'.repeat(40), names: ['file.edit'], evidence: [] });

const line = (tools: ToolObservation[]) => store({ sessions: [session('s')], prompts: [prompt('s', 0, { errors: 2, verify: 'passed', commits: 1 }), prompt('s', 1)], tools });

const consequence = (tools: ToolObservation[], recall: Recall) => deriveConsequences(line(tools), [recall])[0]?.consequence;

describe('the consequence window', () => {
  it('opens on the next decision and ends with the prompt', () => {
    const found = consequence([call(0, 'Read', 0), call(2, 'Edit', 0), call(3, 'Read', 0), call(4, 'Bash', 1)], recallAt(1));
    expect(found?.window).toEqual({ from: 1, to: 3, calls: 2, end: 'prompt' });
  });

  it('leaves the call a push fired on behind it, because that call was already decided', () => {
    expect(consequence([call(1, 'Edit', 0), call(2, 'Read', 0)], recallAt(1))?.window).toEqual({ from: 1, to: 2, calls: 1, end: 'session' });
  });

  it('ends after the call limit while the prompt runs on', () => {
    const tools = Array.from({ length: WINDOW_CALLS + 5 }, (_, n) => call(n + 1, 'Read', 0));
    expect(consequence(tools, recallAt(0))?.window).toEqual({ from: 0, to: WINDOW_CALLS, calls: WINDOW_CALLS, end: 'calls' });
  });

  it('holds nothing when the next call is under a later prompt', () => {
    expect(consequence([call(0, 'Read', 0), call(5, 'Edit', 1)], recallAt(1))?.window).toEqual({ from: 1, to: 1, calls: 0, end: 'prompt' });
  });

  it('skips a sidechain call and reads a call with no time as behind the recall', () => {
    const tools = [call(0, 'Read', 0, { ts: null }), call(2, 'Read', 0, { side: true }), call(3, 'Edit', 0)];
    expect(consequence(tools, recallAt(1))?.window).toMatchObject({ from: 1, calls: 1 });
  });

  it('sums the tokens the window measured and states none when it measured none, since an older capture holds no step costs and zero would read as free', () => {
    const step = (tokens: number | null): StepObservation => ({ n: 0, seg: 0, action: 'file.read', native: 'Read', identity: null, status: 'ok', cost: { tokens, durationMs: 1 }, parent: null, edges: [], frameId: 'f' });
    const measured = consequence([call(0, 'Read', 0), call(2, 'Read', 0, { steps: [step(30), step(null)] }), call(3, 'Read', 0, { steps: [step(12)] })], recallAt(1));
    expect(measured?.cost.tokens).toBe(42);
    expect(consequence([call(0, 'Read', 0), call(2, 'Read', 0, { steps: [step(null)] })], recallAt(1))?.cost.tokens).toBeNull();
  });

  it('holds motifs, the name match, cost, and outcome apart, with no composite', () => {
    const found = consequence([call(0, 'Read', 0), call(2, 'Edit', 0, { durationMs: 40 }), call(3, 'Read', 0, { durationMs: 2 })], recallAt(1));
    expect(found?.motifs).toContain(shapeId([{ action: 'file.edit', identity: null }]));
    expect(found?.nameMatched).toBe(true);
    expect(found?.cost).toEqual({ tokens: null, durationMs: 42 });
    expect(found?.outcome).toEqual({ errors: 2, verify: 'passed', stopped: null, commits: 1, redo: null, reverted: null });
    expect(Object.keys(found ?? {}).sort()).toEqual(['cost', 'motifs', 'nameMatched', 'outcome', 'window']);
  });

  it('keeps the outcome the prompt first showed and sets a later reversion beside it, read from the calls: a clean `git revert` of the commit, in a later prompt or in a later session', () => {
    const committed = [call(0, 'Read', 0), call(2, 'Bash', 0, { segments: [{ run: 'git commit', read: true }], commits: ['abc1234'] })];
    const revert = (session: string, n: number, promptIndex: number): ToolObservation => tool(session, n, 'Bash', { ts: stamp(n), prompt: promptIndex, segments: [{ run: 'git revert abc1234', read: true }] });
    const outcome = (sessions: ReturnType<typeof session>[], tools: ToolObservation[]) =>
      deriveConsequences(store({ sessions, prompts: [prompt('s', 0, { errors: 2, verify: 'passed', commits: 1 }), prompt('s', 1), prompt('t', 0)], tools }), [recallAt(1)])[0]?.consequence?.outcome;
    const original = { errors: 2, verify: 'passed', stopped: null, commits: 1, redo: null };
    expect(outcome([session('s')], committed)).toEqual({ ...original, reverted: null });
    expect(outcome([session('s')], [...committed, revert('s', 5, 1)])).toEqual({ ...original, reverted: 'later-prompt' });
    expect(outcome([session('s', { repo: 'r' }), session('t', { repo: 'r' })], [...committed, revert('t', 100, 0)])).toEqual({ ...original, reverted: 'later-session' });
    expect(outcome([session('s')], committed)).not.toHaveProperty('intervention');
  });

  it('records a match on the action name and nothing stronger: a call of that name that failed still matches, and no field calls it followed', () => {
    const found = consequence([call(0, 'Read', 0), call(2, 'Edit', 0, { status: 'error' })], recallAt(1));
    expect(found?.nameMatched).toBe(true);
    expect(found).not.toHaveProperty('followed');
    expect(JSON.stringify(found)).not.toContain('followed');
  });

  it('says no name matched when no shown name appears, and states no outcome for a prompt it cannot find', () => {
    const found = consequence([call(2, 'Read', 7)], recallAt(1));
    expect(found?.nameMatched).toBe(false);
    expect(found?.outcome).toEqual({ errors: null, verify: null, stopped: null, commits: null, redo: null, reverted: null });
  });

  it('reads a held recall the same way, and leaves a recall with no session or an unknown one as it was', () => {
    const tools = [call(2, 'Edit', 0)];
    expect(consequence(tools, recallAt(1, 'held'))?.nameMatched).toBe(true);
    const [noSession] = deriveConsequences(line(tools), [recallAt(1, 'shown', null)]);
    expect(noSession).toMatchObject({ n: null });
    expect(noSession?.consequence).toBeUndefined();
    expect(deriveConsequences(line(tools), [recallAt(1, 'shown', 'other')])[0]?.consequence).toBeUndefined();
  });

  it('gives a session that made no call an empty window', () => {
    expect(consequence([], recallAt(1))?.window).toEqual({ from: 0, to: 0, calls: 0, end: 'session' });
  });
});

describe('recalls in the graph', () => {
  const tools = [call(0, 'Read', 0), call(2, 'Edit', 0), call(3, 'Read', 1)];
  const cellsWith = (recalls: Recall[]) => {
    const base = line(tools);
    return deriveCells(base, recallGraphOf(base, deriveConsequences(base, recalls))).cells;
  };
  const push = { action: 'recall.push', identity: null } as const;
  const edit = { action: 'file.edit', identity: null } as const;

  it('enters a shown push as a recall.push step and marks only its window exposed', () => {
    const cells = cellsWith([recallAt(1)]);
    expect(cells.find((cell) => cell.motifId === shapeId([push]))).toMatchObject({ exposed: true, sessions: 1 });
    expect(cells.find((cell) => cell.motifId === shapeId([push, edit]))?.exposed).toBe(true);
    expect(cells.find((cell) => cell.motifId === shapeId([edit]))?.exposed).toBe(true);
    expect(cells.find((cell) => cell.motifId === shapeId([{ action: 'file.read', identity: null }]))?.exposed).toBe(false);
  });

  // Rule 5: no cell holds a number finer than its bucket's floor. A recall step is placed after the store is floored, so its own count is floored where it enters.
  it('floors the tokens of a recall step to its bucket where the step enters a cell', () => {
    const sized = (tokens: number): Recall => ({ ...recallAt(1), answer: { ...recallAt(1).answer, tokens } });
    const tokensOf = (tokens: number): number | null | undefined => cellsWith([sized(tokens)]).find((cell) => cell.motifId === shapeId([push]))?.tokens;
    expect(tokensOf(1500)).toBe(1000);
    expect(tokensOf(2999)).toBe(2000);
    expect(tokensOf(999)).toBe(0);
  });

  it('keeps a held recall out of the steps and out of exposure, so the cells are those of no recall', () => {
    expect(cellsWith([recallAt(1, 'held')])).toEqual(deriveCells(line(tools)).cells);
  });

  it('keeps the step of a shown miss and marks only the motifs holding its own step exposed, since it showed no evidence', () => {
    const miss: Recall = { ...recallAt(0), at: '2026-11-01T09:00:00.000Z', mode: 'pull', answer: { ...recallAt(0).answer, kind: 'miss' } };
    const base = line(tools);
    const graph = recallGraphOf(base, deriveConsequences(base, [miss]));
    const { cells, motifs } = deriveCells(base, graph);
    const pullRead = cells.find((cell) => cell.motifId === shapeId([{ action: 'recall.pull', identity: null }, { action: 'file.read', identity: null }]));
    expect(pullRead).toMatchObject({ sessions: 1 });
    // The pull's own step stays, and only the motifs that hold it are exposed; the calls its window covers are not.
    const exposed = cells.filter((cell) => cell.exposed);
    expect(exposed.length).toBeGreaterThan(0);
    expect(exposed.every((cell) => motifs.find((motif) => motif.motifId === cell.motifId)?.steps.some((step) => step.action === 'recall.pull'))).toBe(true);
    expect(cells.find((cell) => cell.motifId === shapeId([{ action: 'file.read', identity: null }]))?.exposed).toBe(false);
    expect(cells.find((cell) => cell.motifId === shapeId([{ action: 'file.edit', identity: null }]))?.exposed).toBe(false);
    expect(graph.exposedPrompt('s', 0)).toBe(false);
  });

  it('places a recall before a line with no earlier call, and enters a pull as recall.pull', () => {
    const pull: Recall = { ...recallAt(0), at: '2026-11-01T09:00:00.000Z', mode: 'pull' };
    expect(cellsWith([pull]).find((cell) => cell.motifId === shapeId([{ action: 'recall.pull', identity: null }, { action: 'file.read', identity: null }]))?.exposed).toBe(true);
  });

  it('adds nothing for a recall with no consequence, and marks the prompt the window ran under', () => {
    expect(cellsWith([recallAt(1, 'shown', null)])).toEqual(deriveCells(line(tools)).cells);
    const base = line(tools);
    const graph = recallGraphOf(base, deriveConsequences(base, [recallAt(1)]));
    expect(graph.exposedPrompt('s', 0)).toBe(true);
    expect(graph.exposedPrompt('s', 1)).toBe(false);
  });

  it('stacks two recalls on one call and places nothing for a session with no calls', () => {
    const two = cellsWith([recallAt(1), { ...recallAt(1), id: 'second' }]);
    expect(two.some((cell) => cell.motifId === shapeId([push, push]))).toBe(true);
    const empty = line([]);
    expect(deriveCells(empty, recallGraphOf(empty, deriveConsequences(empty, [recallAt(1)]))).cells.every((cell) => cell.motifId !== shapeId([push]))).toBe(true);
  });

  it('writes consequences at derive, one row per recall that has one, and a recall moves the pool', async () => {
    const staged = stage();
    const before = await refreshPool(staged.storeDir, line(tools));
    await appendRecall(staged.storeDir, recallAt(1));
    await appendRecall(staged.storeDir, recallAt(1, 'shown', null));
    const after = await refreshPool(staged.storeDir, line(tools));
    expect(after.pool.version).not.toBe(before.pool.version);
    const rows = readFileSync(poolFiles(staged.storeDir).consequences, 'utf8').trim().split('\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('"nameMatched":true');
  });
});

describe('recall counts', () => {
  it('counts per mode, arm, and answer, as counts only, within a day', () => {
    const base = line([call(2, 'Edit', 0)]);
    const later: Recall = { ...recallAt(1), at: '2026-11-02T00:00:00.000Z', id: 'later' };
    const noSession = recallAt(1, 'shown', null);
    const rows = recallCounts(deriveConsequences(base, [recallAt(1), recallAt(1, 'held'), noSession, later]), '2026-11-01');
    expect(rows.map(({ arm, recalls, sessions, windows, nameMatched, windowCalls }) => ({ arm, recalls, sessions, windows, nameMatched, windowCalls }))).toEqual([
      { arm: 'held', recalls: 1, sessions: 1, windows: 1, nameMatched: 1, windowCalls: 1 },
      { arm: 'shown', recalls: 2, sessions: 1, windows: 1, nameMatched: 1, windowCalls: 1 },
    ]);
    expect(formatRecallCounts(rows)).toContain('push held hit | 1 recalls, 1 sessions, 10 tokens | 1 windows, 1 name-matched, 1 calls, window tokens unmeasured');
    expect(formatRecallCounts(rows.map((row) => ({ ...row, windowTokens: 7 })))).toContain('1 calls, 7 window tokens');
    expect(recallCounts(deriveConsequences(base, [later]))).toHaveLength(1);
    expect(recallCounts(deriveConsequences(line([call(2, 'Read', 0)]), [recallAt(1)]))[0]?.nameMatched).toBe(0);
    expect(formatRecallCounts([])).toBe('No recalls in that span.');
  });

  it('counts a held window that shares a call with a shown one, so the baseline states its contamination', () => {
    const base = line([call(2, 'Edit', 0), call(3, 'Read', 0), call(10, 'Read', 1)]);
    const recalls = [recallAt(1, 'held'), recallAt(2), recallAt(5, 'held'), recallAt(100, 'held'), recallAt(100)];
    const rows = recallCounts(deriveConsequences(base, recalls));
    expect(rows.map(({ arm, windows, overlapped }) => ({ arm, windows, overlapped }))).toEqual([
      { arm: 'held', windows: 3, overlapped: 1 },
      { arm: 'shown', windows: 2, overlapped: 0 },
    ]);
    expect(formatRecallCounts(rows)).toContain('window tokens unmeasured, 1 overlapped');
  });

  it('reads the overlap against every shown window, so one day of held recalls still sees a shown one from before it', () => {
    const base = line([call(2, 'Edit', 0), call(3, 'Read', 0)]);
    const yesterday = { ...recallAt(1), at: '2026-10-31T23:59:59.000Z' };
    const rows = recallCounts(deriveConsequences(base, [yesterday, recallAt(1, 'held')]), '2026-11-01');
    expect(rows.map(({ arm, overlapped }) => ({ arm, overlapped }))).toEqual([{ arm: 'held', overlapped: 1 }]);
  });
});
