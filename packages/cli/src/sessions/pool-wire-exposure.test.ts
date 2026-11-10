// Format 6: a deposit carries each recommendation the session was given or held back from, so shown stays shown and held stays held at the pool, and a session that carries none says nothing (the pool reads that as unknown, never as unexposed).
// Format 6 added exposure and the client now builds format 7; the pool still reads formats 3, 4, and 5, and a recommendations list in an older batch is a field its format does not define, so it goes to the bag. Every id and version here is invented.
import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { NO_COVERAGE, OPEN_GATE, parseSkeleton, recommendationsOf, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import { makeRecall, type Recall } from './recall-object.js';

const framed = frame({ shell: 'bash' });
const VERSION = '2026-11-03T03:00:00.000Z';

/** A row as `deriveConsequences` leaves it: the window is the calls of the asker's prompt after the recommendation. */
const row = (over: { sid?: string | null; arm: Recall['arm']; reads?: string[]; at: string; from: number; to: number }): Recall => ({
  ...makeRecall({ sid: over.sid === undefined ? 's1' : over.sid, at: over.at, frame: null, mode: 'push', query: { form: 'pattern', prefix: [`shape-${over.at}`] }, poolVersion: VERSION, arm: over.arm, reads: over.reads ?? ['r1'], rendered: 'advice', names: ['file.read'], evidence: [] }),
  consequence: {
    window: { from: over.from, to: over.to, calls: over.to - over.from, end: 'prompt' },
    motifs: [],
    nameMatched: false,
    cost: { tokens: null, durationMs: 0 },
    outcome: { errors: null, verify: null, stopped: null, commits: null, redo: null, reverted: null },
  },
});

const SHOWN = row({ arm: 'shown', at: '2026-11-04T10:00:00.000Z', from: 1, to: 3 });
const HELD = row({ arm: 'held', at: '2026-11-04T10:05:00.000Z', from: 3, to: 4 });

const calls = (): ReturnType<typeof tool>[] => [0, 1, 2, 3].map((n) => tool('s1', n, 'Read', { prompt: 0, steps: [step(n, 0, 'file.read', { native: 'Read' })] }));

const built = (recalls: readonly Recall[], tools: ReturnType<typeof tool>[] = calls()): SessionSkeleton => {
  const [only] = sessionsFrom(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools }));
  const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf, [], OPEN_GATE, NO_COVERAGE, recommendationsOf(recalls, 's1'));
  if (skeleton === null) throw new Error('no skeleton');
  return structuredClone(skeleton);
};

const sent = (skeleton: SessionSkeleton): SessionSkeleton => {
  const parsed = parseSkeleton(JSON.parse(JSON.stringify(skeleton)));
  if (!parsed.ok) throw new Error(`${parsed.field}: ${parsed.reason}`);
  expect(parsed).toMatchObject({ others: 0, extensions: [] });
  return parsed.skeleton;
};

describe('the recommendations a deposit carries', () => {
  it('keeps a shown row shown, with its id, pool version, and window', () => {
    expect(sent(built([SHOWN])).recommendations).toEqual([{ id: SHOWN.id, arm: 'shown', poolVersion: VERSION, from: 1, to: 3 }]);
  });

  it('keeps a held row held', () => {
    expect(sent(built([HELD])).recommendations).toEqual([{ id: HELD.id, arm: 'held', poolVersion: VERSION, from: 3, to: 4 }]);
  });

  it('carries both rows of one session in window order', () => {
    expect(sent(built([HELD, SHOWN])).recommendations?.map(({ arm }) => arm)).toEqual(['shown', 'held']);
  });

  it('sends nothing for a session with no row, and the parse holds nothing either: absent is the one way to say none', () => {
    const skeleton = built([]);
    expect('recommendations' in skeleton).toBe(false);
    expect('recommendations' in sent(skeleton)).toBe(false);
  });

  it('does not carry a miss, which recommended nothing, or another session\'s row', () => {
    const miss = row({ arm: 'shown', reads: [], at: '2026-11-04T10:09:00.000Z', from: 0, to: 1 });
    const other = row({ sid: 's2', arm: 'shown', at: '2026-11-04T10:10:00.000Z', from: 0, to: 2 });
    const unread = { ...row({ arm: 'shown', at: '2026-11-04T10:11:00.000Z', from: 0, to: 2 }), consequence: undefined };
    expect(built([miss, other, unread]).recommendations).toBeUndefined();
  });

  it('puts a recommendations list in a batch of format 5 into the bag, as a field that format does not define', () => {
    const parsed = parseSkeleton({ ...JSON.parse(JSON.stringify(built([SHOWN]))), format: 5, fieldsVersion: 10 });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect('recommendations' in parsed.skeleton).toBe(false);
    expect(parsed.extensions.map(({ at }) => at)).toEqual(['recommendations']);
  });

  it.each([
    ['an id that is no hash', { id: 'nope' }, 'recommendations[0].id'],
    ['a window that ends before it starts', { from: 3, to: 1 }, 'recommendations[0].to'],
    ['a window that is no count', { from: -1 }, 'recommendations[0].from'],
    ['a pool version that is no version', { poolVersion: 'a b' }, 'recommendations[0].poolVersion'],
    ['a window past every call the main run holds', { from: 5, to: 9 }, 'recommendations[0].to'],
  ])('refuses %s', (_name, change, field) => {
    const skeleton = built([SHOWN]);
    expect(parseSkeleton({ ...skeleton, recommendations: (skeleton.recommendations ?? []).map((entry) => ({ ...entry, ...change })) })).toMatchObject({ ok: false, field });
  });

  it('counts a window among the main run\'s calls that are not sidechain, so one that reaches only into the sidechain calls is refused', () => {
    // Four calls, the last one sidechain: the held row's window ends at 4, which the four calls would allow, but the line the windows are counted on holds three.
    const sidechained = [...calls().slice(0, 3), tool('s1', 3, 'Read', { prompt: 0, side: true, steps: [step(3, 0, 'file.read', { native: 'Read' })] })];
    const skeleton = built([HELD], sidechained);
    expect(skeleton.transcripts[0]?.tools).toHaveLength(4);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toMatchObject({ ok: false, field: 'recommendations[0].to' });
    // The same window over four calls that are all on the line is carried.
    expect(sent(built([HELD])).recommendations).toEqual([{ id: HELD.id, arm: 'held', poolVersion: VERSION, from: 3, to: 4 }]);
  });

  it('reads an arm off its list as other and bags it', () => {
    const skeleton = built([SHOWN]);
    const parsed = parseSkeleton({ ...skeleton, recommendations: (skeleton.recommendations ?? []).map((entry) => ({ ...entry, arm: 'sampled' })) });
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.skeleton.recommendations?.[0]?.arm).toBe('other');
    expect(parsed.extensions.map(({ at }) => at)).toEqual(['recommendations[0].arm']);
  });
});
