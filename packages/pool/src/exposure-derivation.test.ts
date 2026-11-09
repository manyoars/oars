// The pool derives a session's cells from its skeleton alone, and the skeleton carries each recommendation's arm and window. A call inside a shown window counts as shown, inside a held window as held, and a call with no evidence counts as unknown:
// a session with no row (an older client, or one that never recommended) is never read as unexposed, because the pool cannot tell that from a client that did not look. Every id and version here is invented.
import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from '../../cli/src/sessions/pool-fixture.js';
import { NO_COVERAGE, OPEN_GATE, parseSkeleton, recommendationsOf, skeletonOf, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { makeRecall, type Recall } from '../../cli/src/sessions/recall-object.js';
import { incrementsOf, type CellRow } from './ingest.js';

const framed = frame({ shell: 'bash' });
const VERSION = '2026-11-03T03:00:00.000Z';

/** A row as `deriveConsequences` leaves it: the window is the calls of the asker's prompt after the recommendation. */
const row = (arm: Recall['arm'], at: string, from: number, to: number): Recall => ({
  ...makeRecall({ sid: 's1', at, frame: null, mode: 'push', query: { form: 'pattern', prefix: [`shape-${at}`] }, poolVersion: VERSION, arm, reads: ['r1'], rendered: 'advice', names: ['file.read'], evidence: [] }),
  consequence: {
    window: { from, to, calls: to - from, end: 'prompt' },
    motifs: [],
    nameMatched: false,
    cost: { tokens: null, durationMs: 0 },
    outcome: { errors: null, verify: null, stopped: null, commits: null, redo: null, reverted: null },
  },
});

const SHOWN = row('shown', '2026-11-04T10:00:00.000Z', 1, 3);
const HELD = row('held', '2026-11-04T10:05:00.000Z', 3, 4);

/** Four reads of one prompt, so the windows above cover calls 1 and 2 (shown) and 3 (held), and call 0 sits outside both. */
const calls = (): ReturnType<typeof tool>[] => [0, 1, 2, 3].map((n) => tool('s1', n, 'Read', { prompt: 0, steps: [step(n, 0, 'file.read', { native: 'Read' })] }));

/** What the client sends and the Worker reads: the skeleton through JSON and the parse, never the in-memory object. */
const deposited = (recalls: readonly Recall[]): SessionSkeleton => {
  const [only] = sessionsFrom(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: calls() }));
  const built = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf, [], OPEN_GATE, NO_COVERAGE, recommendationsOf(recalls, 's1'));
  if (built === null) throw new Error('no skeleton');
  const parsed = parseSkeleton(JSON.parse(JSON.stringify(built)));
  if (!parsed.ok) throw new Error(`${parsed.field}: ${parsed.reason}`);
  return parsed.skeleton;
};

/** The session's live cells (a day cell is the one-step shape of its one action, here the read), by how they were exposed: the number of calls each state holds. */
const readsBy = (skeleton: SessionSkeleton): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const cell of incrementsOf(skeleton).cells.values()) {
    if (cell.grain !== 'day') continue;
    counts.set(cell.exposure, (counts.get(cell.exposure) ?? 0) + cell.ok);
  }
  return counts;
};

const keysOf = (skeleton: SessionSkeleton): string[] => [...incrementsOf(skeleton).cells.values()].map(({ key }) => key);
const lastField = (key: string): string => key.slice(key.lastIndexOf('/') + 1);

describe('the exposure the worker derives from a deposit', () => {
  it('counts a call inside a shown window as shown, and the calls outside it as unknown', () => {
    expect(readsBy(deposited([SHOWN]))).toEqual(new Map([['unknown', 2], ['shown', 2]]));
  });

  it('counts a call inside a held window as held, and does not call it shown', () => {
    const counts = readsBy(deposited([HELD]));
    expect(counts.get('held')).toBe(1);
    expect(counts.has('shown')).toBe(false);
    expect(counts.get('unknown')).toBe(3);
  });

  it('reads a session with no row as unknown throughout, never as unexposed', () => {
    const skeleton = deposited([]);
    expect(readsBy(skeleton)).toEqual(new Map([['unknown', 4]]));
    for (const cell of incrementsOf(skeleton).cells.values()) {
      expect(cell.exposure).toBe('unknown');
      expect(cell.exposed).toBe(0);
    }
  });

  it('keeps the three states apart in the key, and a cell with no evidence keeps the key it always had', () => {
    expect([...new Set(keysOf(deposited([SHOWN, HELD])).map(lastField))].sort()).toEqual(['0', '1', '2']);
    expect([...new Set(keysOf(deposited([])).map(lastField))]).toEqual(['0']);
  });

  it('puts a call in both a shown and a held window on the shown side', () => {
    const both = row('held', '2026-11-04T10:01:00.000Z', 1, 4);
    const counts = readsBy(deposited([SHOWN, both]));
    expect(counts.get('shown')).toBe(2);
    expect(counts.get('held')).toBe(1);
  });

  it('writes the row of a shown cell as exposed and a held cell as not', () => {
    const rows: CellRow[] = [...incrementsOf(deposited([SHOWN, HELD])).cells.values()];
    expect(new Set(rows.filter(({ exposure }) => exposure === 'shown').map(({ exposed }) => exposed))).toEqual(new Set([1]));
    expect(new Set(rows.filter(({ exposure }) => exposure !== 'shown').map(({ exposed }) => exposed))).toEqual(new Set([0]));
  });
});
