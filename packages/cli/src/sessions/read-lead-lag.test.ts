import { describe, expect, it } from 'vitest';
import { tools } from './order-fixture.js';
import { deriveReads } from './pool.js';
import { frame, poolFrom, prompt, session, store } from './pool-fixture.js';
import { nextDay } from './read-day-move.js';
import { deriveLeadLag, leadLagPairs, PAIRS_FLOOR } from './read-lead-lag.js';
import { makeRead, type Read } from './read.js';
import type { Store } from './store.js';

/** A small fixed sequence, so a null fixture reads the same on every run. */
const noise = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
};

const dayAt = (index: number): string => {
  let day = '2026-09-01';
  for (let at = 0; at < index; at += 1) day = nextDay(day);
  return day;
};

const move = (motif: string, metric: string, from: string, value: number, sigma = 0.01): Read =>
  makeRead(
    {
      family: 'day-move',
      method: 'm',
      methodVersion: '1',
      inputs: [`read:${motif}${metric}${from}`],
      slice: { motif, level: 'shape', metric, from, to: nextDay(from) },
      value: { before: 0, after: value, move: value },
      n: 100,
      clusters: 1,
      interval: { low: value - 1.96 * sigma, high: value + 1.96 * sigma, level: 0.95 },
      asOf: { pool: 'p', day: null },
      basis: 'all',
    },
    () => 1,
  );

/** Hand-planted moves: each failure move runs from `index`, and the share move that shares no day with it, which `lagged` sets, runs from `index + 2`. */
const planted = (days: number, motifs: readonly string[], lagged: (failure: number, index: number) => number): Read[] => {
  const draw = noise(7);
  return motifs.flatMap((motif) =>
    Array.from({ length: days }, (_, index) => {
      const failure = draw() - 0.5;
      return [move(motif, 'failureRate', dayAt(index), failure), move(motif, 'share', dayAt(index + 2), lagged(failure, index))];
    }).flat(),
  );
};

const MOTIFS = ['file.read', 'file.edit', 'shell.exec'];

const only = (reads: readonly Read[]) => {
  const bodies = deriveLeadLag(reads);
  expect(bodies).toHaveLength(1);
  const [body] = bodies;
  if (body === undefined) throw new Error('no read');
  return body;
};

describe('lead-lag pairs', () => {
  it('pairs a failure move with the next share move that shares no day with it, because a day on both sides would correlate the two by itself', () => {
    const reads = [move('file.read', 'failureRate', '2026-10-01', 0.2), move('file.read', 'share', '2026-10-02', 0.9), move('file.read', 'share', '2026-10-03', -0.1), move('file.edit', 'share', '2026-10-03', 0.5)];
    const pairs = leadLagPairs(reads);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.x.value).toBe(0.2);
    expect(pairs[0]?.y.value).toBe(-0.1);
    expect(pairs[0]?.day).toBe('2026-10-04');
  });
});

describe('lead-lag out-of-time check', () => {
  it('passes a relation that holds on later days, states the score, and labels itself', () => {
    const body = only(planted(60, MOTIFS, (failure) => -0.1 * failure));
    expect(body.value.label).toBe('experimental');
    expect(body.value.check).toBe('passed');
    expect(body.value.slope).toBeCloseTo(-0.1, 2);
    expect(body.value.skill).toBeGreaterThan(0.9);
    expect(body.value.signAgreement).toBe(1);
    expect(body.interval?.high).toBeLessThan(0);
    expect(body.clusters).toBe(1);
    expect(body.slice).toEqual({ lead: 'failureRate', lag: 'share', level: 'shape' });
  });

  it('fits on earlier days only and scores on later ones, each stated', () => {
    const body = only(planted(60, MOTIFS, (failure) => -0.1 * failure));
    const { fitThrough, scoredFrom, fitPairs, scorePairs } = body.value;
    expect(typeof fitThrough === 'string' && typeof scoredFrom === 'string' && fitThrough < scoredFrom).toBe(true);
    expect(fitPairs).toBe(42 * 3);
    expect(scorePairs).toBe(18 * 3);
    expect(body.n).toBe(60 * 3);
  });

  it('fails a pattern that holds on the days it was fit on and reverses on the later ones, however tight the fit', () => {
    const body = only(planted(60, MOTIFS, (failure, index) => (index < 42 ? -0.1 : 0.1) * failure));
    expect(body.value.label).toBe('experimental');
    expect(body.value.check).toBe('failed');
    expect(body.value.slope).toBeCloseTo(-0.1, 2);
    expect(body.value.skill).toBeLessThan(0);
    expect(body.interval?.high).toBeLessThan(0);
  });

  it('fails when the share moves are unrelated to the failure moves', () => {
    const draw = noise(99);
    const body = only(planted(60, MOTIFS, () => (draw() - 0.5) * 0.1));
    expect(body.value.check).toBe('failed');
  });

  it('fails a slope that scores but agrees on sign no better than chance', () => {
    // On later days the large moves agree and carry the score, and the many small ones do not agree.
    const body = only(planted(60, MOTIFS, (failure, index) => (index < 42 || Math.abs(failure) > 0.25 ? -0.1 * failure : 0.1 * failure)));
    expect(body.value.skill).toBeGreaterThan(0);
    expect(body.value.check).toBe('failed');
  });

  it('does not exist below the floor of pairs on either side of the cut', () => {
    expect(PAIRS_FLOOR).toBe(30);
    expect(deriveLeadLag(planted(30, MOTIFS, (failure) => -0.1 * failure))).toEqual([]);
    expect(deriveLeadLag([])).toEqual([]);
  });

  it('does not exist when no failure moved on the days it would fit on', () => {
    const flat = planted(60, MOTIFS, () => 0.1).map((read) => (read.slice.metric === 'failureRate' ? move(read.slice.motif ?? '', 'failureRate', read.slice.from ?? '', 0) : read));
    expect(deriveLeadLag(flat)).toEqual([]);
  });

  it('scores nothing to explain as no skill, and a pass needs some', () => {
    expect(only(planted(60, MOTIFS, () => 0)).value).toMatchObject({ skill: 0, signAgreement: null, check: 'failed' });
  });
});

/** A store of `days` days and four tools: `countOf` and `failedOf` set each tool's calls and failures per day. */
const daily = (days: number, countOf: (tool: number, day: number) => number, failedOf: (tool: number, day: number) => number): Store => {
  const names = ['Read', 'Edit', 'Bash', 'Write'];
  return store({
    sessions: [session('s1')],
    prompts: Array.from({ length: days }, (_, day) => prompt('s1', day, { frame: frame({ day: dayAt(day) }) })),
    tools: Array.from({ length: days }, (_, day) => names.flatMap((name, index) => tools('s1', day, [{ name, count: countOf(index, day) }], failedOf(index, day)))).flat(),
  });
};

const DAYS = 45;

/** The check as the pool states it: the real families all the way up, so a store with no read has no check to pass. */
const checkOf = (from: Store): unknown => deriveReads(poolFrom(from), from).find((read) => read.family === 'lead-lag')?.value.check;

const drawn = (seed: number): number[][] => {
  const draw = noise(seed);
  return [0, 1, 2, 3].map(() => Array.from({ length: DAYS }, () => draw()));
};

const at = (table: readonly (readonly number[])[], tool: number, day: number): number => table[tool]?.[day] ?? 0;

describe('lead-lag over the real families', () => {
  it('keeps a pair whose tool then fell away, because a lag selected on the tool still being called would hide the drop it asks about', () => {
    const counts = [[100, 100, 100, 5], [100, 100, 100, 100], [0, 0, 0, 0], [0, 0, 0, 0]];
    const from = daily(4, (tool, day) => counts[tool]?.[day] ?? 0, () => 0);
    const reads = deriveReads(poolFrom(from), from);
    const pairs = leadLagPairs(reads).filter(({ reads: [lead] }) => lead.slice.motif === 'file.read');
    expect(pairs.map(({ y, day }) => [y.value, day])).toEqual([[-0.4524, dayAt(3)]]);
    const gone = daily(4, (tool, day) => (tool === 0 && day === 3 ? 0 : counts[tool]?.[day] ?? 0), () => 0);
    const after = leadLagPairs(deriveReads(poolFrom(gone), gone)).filter(({ reads: [lead] }) => lead.slice.motif === 'file.read');
    expect(after.map(({ y }) => y.value)).toEqual([-0.5]);
  });

  it('runs the chain from cells to order 3 and finds a planted lead: a tool that failed two days ago is called less', () => {
    const rolls = drawn(3);
    const failed = (tool: number, day: number) => Math.floor(at(rolls, tool, day) * 90);
    const from = daily(DAYS, (tool, day) => 400 - 3 * failed(tool, Math.max(day - 2, 0)), failed);
    const reads = deriveReads(poolFrom(from), from);
    const [read] = reads.filter((one) => one.family === 'lead-lag');
    expect(read?.order).toBe(3);
    expect(read?.value.check).toBe('passed');
    expect(read?.value.slope).toBeLessThan(0);
    const cited = new Set(read?.inputs);
    const inputs = reads.filter((one) => cited.has(one.readId));
    expect(inputs.length).toBe(cited.size);
    expect(inputs.every((one) => one.family === 'day-move' && one.order === 2)).toBe(true);
    const below = new Set(inputs.flatMap((one) => one.inputs));
    expect(reads.filter((one) => below.has(one.readId)).every((one) => one.family === 'tool-day' && one.order === 1)).toBe(true);
    expect(read?.interval?.level).toBe(0.95);
  });

  it('fails a null store, with counts and failures drawn apart', () => {
    const counts = drawn(11);
    const failures = drawn(23);
    const from = daily(DAYS, (tool, day) => 150 + Math.floor(at(counts, tool, day) * 250), (tool, day) => Math.floor(at(failures, tool, day) * 90));
    expect(checkOf(from)).toBe('failed');
  });

  it('fails a store where a burst day raises a tool share and failures together: one shared day must not read as a lead', () => {
    // A seed where reading the day twice passes the check: pairing adjacent moves passes 4 of 6 such stores, and this pairing none.
    const bursts = drawn(6);
    const from = daily(DAYS, (tool, day) => 150 + Math.floor(at(bursts, tool, day) * 250), (tool, day) => Math.floor(at(bursts, tool, day) * 90));
    expect(checkOf(from)).toBe('failed');
  });
});
