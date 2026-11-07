// Item 3 of t926: the split-positions table at SessionStart and UserPromptSubmit. The 13 qualifying cells of t782 are the fixture (shares from its section 4), not shipped data.
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { slugOf } from './allow.js';
import { indexPath, readIndex } from './hook-index.js';
import { runHook } from './hooks.js';
import { armOf, readRecalls } from './recall-object.js';
import { lastTable, mergePositions, positionsOf, positionsRecall, renderPositions, POSITION_MIN_N, TABLE_CAP_BYTES, type Position } from './recall-next.js';
import type { Read } from './read.js';
import { deposit } from './store.js';
import { cleanup, NOW, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const REPO = 'work/app';
const SHARES = [0.6, 0.8, 0.8, 0.75, 0.55, 0.65, 0.65, 0.55, 0.75, 0.7, 0.65, 0.7, 0.6];
const FIRST = 'shell.exec';
const SECOND = 'file.read';

const cell = (prefix: string, n: number, share: number): Read => {
  const top = Math.round(n * share);
  return { readId: `read:${prefix}`, family: 'next-step', slice: { prefix, length: '1' }, value: { next: { [FIRST]: top, [SECOND]: n - top }, top: FIRST, topShare: share }, n, clusters: 1, asOf: { pool: 'p', day: '2026-11-01' } } as unknown as Read;
};

/** Thirteen distinct closed prefixes of one to three canonical actions. */
const PREFIXES = [
  'file.edit',
  'file.read',
  'shell.exec',
  'file.edit>file.read',
  'file.edit>shell.exec',
  'file.read>file.edit',
  'file.read>shell.exec',
  'shell.exec>file.edit',
  'shell.exec>file.read',
  'file.edit>file.edit',
  'file.read>file.read',
  'shell.exec>shell.exec',
  'file.edit>file.read>shell.exec',
];
const fixture = (): Read[] => SHARES.map((share, i) => cell(PREFIXES[i] ?? '', POSITION_MIN_N, share));

const position = (prefix: string, n: number): Position => ({ prefix, n, next: [[FIRST, Math.round(n * 0.6)], [SECOND, n - Math.round(n * 0.6)]], clusters: 1, readId: `read:${prefix}`, day: '2026-11-01' });

describe('positionsOf', () => {
  it("lists every one of t782's 13 qualifying cells", () => {
    const positions = positionsOf(fixture());
    expect(positions).toHaveLength(13);
    expect(positions[0]).toMatchObject({ n: POSITION_MIN_N });
  });

  it('leaves a settled cell off (0.9), and a diffuse one (0.1)', () => {
    expect(positionsOf([cell('file.edit', 20, 0.9), cell('file.read', 20, 0.1)])).toEqual([]);
  });

  it('keeps both ends of the band and drops a cell under 20 observations', () => {
    expect(positionsOf([cell('file.edit', 20, 0.2), cell('file.read', 20, 0.8)])).toHaveLength(2);
    expect(positionsOf([cell('file.edit', POSITION_MIN_N - 1, 0.6)])).toEqual([]);
  });

  it('ignores other families, a prefix that is not a closed action chain, a missing slice, and a next map that is not usable', () => {
    const other = { ...cell('file.edit', 20, 0.6), family: 'recovery' } as Read;
    const literal = cell('file.edit>some private name', 20, 0.6);
    const noPrefix = { ...cell('file.edit', 20, 0.6), slice: {} } as unknown as Read;
    const noNext = { ...cell('file.read', 20, 0.6), value: { topShare: 0.6, next: null } } as unknown as Read;
    const badShare = { ...cell('file.read', 20, 0.6), value: { topShare: 'x', next: {} } } as unknown as Read;
    const oneOption = { ...cell('file.read', 20, 0.6), value: { topShare: 0.6, next: { [FIRST]: 20, 'not an action': 5 } } } as unknown as Read;
    expect(positionsOf([other, literal, noPrefix, noNext, badShare, oneOption])).toEqual([]);
  });

  it('keeps the three most common next steps, and orders positions by observations then prefix', () => {
    const wide = { ...cell('file.edit', 30, 0.5), value: { topShare: 0.5, next: { 'file.read': 15, 'shell.exec': 9, 'file.edit': 5, 'file.write': 1 } } } as unknown as Read;
    const [only] = positionsOf([wide]);
    expect(only?.next).toEqual([
      ['file.read', 15],
      ['shell.exec', 9],
      ['file.edit', 5],
    ]);
    expect(positionsOf([cell('shell.exec', 20, 0.6), cell('file.read', 25, 0.6), cell('file.edit', 20, 0.6)]).map((p) => p.prefix)).toEqual(['file.read', 'file.edit', 'shell.exec']);
  });
});

describe('renderPositions', () => {
  it('prints names, percentages and counts, one line per position', () => {
    const { rendered, listed, names } = renderPositions([position('file.edit', 20)]);
    expect(listed).toHaveLength(1);
    expect(rendered).toBe('oars recall, next steps that earlier sessions split on (counts, not advice):\n- after file.edit: shell.exec 60%, file.read 40% (n 20)');
    expect(names).toEqual([FIRST, SECOND]);
  });

  it('prints nothing when no position is given', () => {
    expect(renderPositions([])).toEqual({ rendered: '', listed: [], names: [] });
  });

  it(`stays under ${String(TABLE_CAP_BYTES)} bytes by dropping the positions that do not fit, last first`, () => {
    const many = positionsOf(fixture());
    const { rendered, listed } = renderPositions(many);
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(TABLE_CAP_BYTES);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.length).toBeLessThan(many.length);
    expect(listed).toEqual(many.slice(0, listed.length));
  });
});

describe('mergePositions', () => {
  it("lists a prefix once, the bundle's first, ordered by observations", () => {
    const merged = mergePositions([position('file.edit', 30)], [position('file.edit', 99), position('file.read', 40)]);
    expect(merged.map((p) => [p.prefix, p.n])).toEqual([
      ['file.read', 40],
      ['file.edit', 30],
    ]);
  });
});

describe('positionsRecall and lastTable', () => {
  const asker = { harness: 'claude-code', harnessVersion: null };

  it('is undefined with nothing to list, and when the table is the one already sent', async () => {
    const made = stage();
    const input = { storeDir: made.storeDir, sid: 's1', tail: '', platform: 'win32', at: new Date(NOW).toISOString() };
    expect(await positionsRecall(input, asker, [], 'p')).toBeUndefined();
    const sent = renderPositions([position('file.edit', 20)]).rendered;
    expect(await positionsRecall(input, asker, [position('file.edit', 20)], 'p', sent)).toBeUndefined();
    expect(await readRecalls(made.storeDir)).toEqual([]);
  });

  it('writes one row with the read ids, and lastTable returns the text last sent to that session only', async () => {
    const made = stage();
    const input = { storeDir: made.storeDir, sid: 's1', tail: '', platform: 'win32', at: new Date(NOW).toISOString() };
    expect(await lastTable(made.storeDir, 's1')).toBeUndefined();
    const recall = await positionsRecall(input, asker, [position('file.edit', 20), position('file.read', 22)], 'p');
    expect(recall?.query).toMatchObject({ family: 'next-step', prefix: ['positions'] });
    expect(await readRecalls(made.storeDir)).toHaveLength(1);
    expect(await lastTable(made.storeDir, 's1')).toBe(recall?.answer.rendered);
    expect(await lastTable(made.storeDir, 's2')).toBeUndefined();
  });
});

/** A deposited store whose index carries the given positions. */
const staged = async (positions: Position[]): Promise<Staged> => {
  const made = stage(slugOf(REPO));
  await deposit(made.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
  const index = await readIndex(made.storeDir);
  writeFileSync(indexPath(made.storeDir), JSON.stringify({ ...index, positions }));
  return made;
};

const sessionOn = (made: Staged, arm: 'shown' | 'held'): string => {
  const at = JSON.parse(readFileSync(indexPath(made.storeDir), 'utf8')).at as string;
  for (let i = 0; i < 1000; i++) if (armOf(`s${String(i)}`, ['positions'], at) === arm) return `s${String(i)}`;
  throw new Error('no session found');
};

const start = (session: string): string => JSON.stringify({ hook_event_name: 'SessionStart', session_id: session, cwd: REPO });
const submit = (session: string): string => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: REPO, prompt: 'go' });
const text = (output: string | undefined): string => String(JSON.parse(output ?? '{}')?.hookSpecificOutput?.additionalContext ?? '');

describe('the table at SessionStart and UserPromptSubmit', () => {
  it('lists a split position at session start, with one row', async () => {
    const made = await staged([position('file.edit', 20)]);
    const session = sessionOn(made, 'shown');
    const output = await runHook('session-start', start(session), made.runtime, () => NOW);
    expect(text(output)).toContain('- after file.edit: shell.exec 60%, file.read 40% (n 20)');
    const rows = await readRecalls(made.storeDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sid: session, arm: 'shown', mode: 'push', query: { family: 'next-step', prefix: ['positions'] } });
  });

  it('prints no table, and writes no row, when no position qualifies', async () => {
    const made = await staged([]);
    expect(text(await runHook('session-start', start(sessionOn(made, 'shown')), made.runtime, () => NOW))).not.toContain('oars recall, next steps');
    expect(await readRecalls(made.storeDir)).toEqual([]);
  });

  it('sends the prompt hook nothing for a table the session already has, and the new table when it changed', async () => {
    const made = await staged([position('file.edit', 20)]);
    const session = sessionOn(made, 'shown');
    await runHook('session-start', start(session), made.runtime, () => NOW);
    expect(await runHook('prompt', submit(session), made.runtime, () => NOW)).toBeUndefined();
    expect(await readRecalls(made.storeDir)).toHaveLength(1);
    const index = await readIndex(made.storeDir);
    writeFileSync(indexPath(made.storeDir), JSON.stringify({ ...index, positions: [position('file.edit', 20), position('file.read', 30)] }));
    expect(text(await runHook('prompt', submit(session), made.runtime, () => NOW))).toContain('- after file.read');
    expect(await readRecalls(made.storeDir)).toHaveLength(2);
  });

  it('holds the table back for the held arm: nothing printed, one row, and the prompt hook does not repeat it', async () => {
    const made = await staged([position('file.edit', 20)]);
    const session = sessionOn(made, 'held');
    expect(text(await runHook('session-start', start(session), made.runtime, () => NOW))).not.toContain('oars recall, next steps');
    expect(await runHook('prompt', submit(session), made.runtime, () => NOW)).toBeUndefined();
    const rows = await readRecalls(made.storeDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ arm: 'held' });
    expect(rows[0]?.answer.rendered).toContain('after file.edit');
  });

  it('says nothing from the prompt hook for a session with no id', async () => {
    const made = await staged([position('file.edit', 20)]);
    expect(await runHook('prompt', JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'go' }), made.runtime, () => NOW)).toBeUndefined();
    expect(await readRecalls(made.storeDir)).toEqual([]);
  });
});
