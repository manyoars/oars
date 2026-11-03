import { describe, expect, it } from 'vitest';
import { clearsZero, differenceOf, estimateOf, MIN_MOVE, moved, relate, TRIALS_FLOOR, trialsOf, type Estimate } from './read-order.js';
import { makeRead, orderResolver, type Read, type ReadDraft, type ReadInterval } from './read.js';

const ASOF = { pool: 'pool-one', day: '2026-11-02' };
const span = (low: number, high: number): ReadInterval => ({ low, high, level: 0.95 });

const firstOrder = (id: string, over: Partial<ReadDraft> = {}): Read =>
  makeRead(
    { family: 'change', method: 'share', methodVersion: '1', inputs: [`cell:${id}`], slice: { motif: id }, value: { share: 0.5, of: 100 }, n: 50, clusters: 1, interval: span(0.4, 0.6), asOf: ASOF, basis: 'all', ...over },
    orderResolver([]),
  );

const width = (interval: ReadInterval | null): number => (interval === null ? 0 : interval.high - interval.low);

describe('differenceOf', () => {
  it('propagates each side of the interval from the inputs (the worked MOVER case)', () => {
    const move = differenceOf({ value: 0.5, interval: span(0.4, 0.6) }, { value: 0.3, interval: span(0.2, 0.4) });
    expect(move).toEqual({ value: 0.2, interval: span(0.0586, 0.3414) });
  });

  it('keeps the two sides apart when an input is skewed', () => {
    const move = differenceOf({ value: 0.1, interval: span(0.08, 0.2) }, { value: 0.5, interval: span(0.45, 0.52) });
    expect(move.value).toBe(-0.4);
    // Low: the later side's 0.02 below and the earlier side's 0.02 above. High: the later side's 0.1 above and the earlier side's 0.05 below.
    expect(move.interval).toEqual(span(-0.4283, -0.2882));
  });

  it('widens when an input is less certain, with the same point estimates', () => {
    const narrow = differenceOf({ value: 0.5, interval: span(0.49, 0.51) }, { value: 0.3, interval: span(0.29, 0.31) });
    const wide = differenceOf({ value: 0.5, interval: span(0.3, 0.7) }, { value: 0.3, interval: span(0.29, 0.31) });
    expect(wide.value).toBe(narrow.value);
    expect(width(wide.interval)).toBeGreaterThan(width(narrow.interval));
  });
});

describe('estimateOf', () => {
  it('pairs a named number in the value with the interval of the read', () => {
    expect(estimateOf(firstOrder('a'), 'share')).toEqual({ value: 0.5, interval: span(0.4, 0.6) });
  });

  it('has none for a read with no interval, or a metric that is not a number', () => {
    expect(estimateOf(firstOrder('a', { interval: null }), 'share')).toBeUndefined();
    expect(estimateOf(firstOrder('a', { value: { share: null } }), 'share')).toBeUndefined();
    expect(estimateOf(firstOrder('a'), 'absent')).toBeUndefined();
  });
});

describe('trialsOf', () => {
  it('counts a share by its denominator, because that is what its interval rests on', () => {
    expect(trialsOf(firstOrder('a', { n: 2, value: { share: 0.02, of: 100 } }))).toBe(100);
  });

  it('counts anything else by its own n', () => {
    expect(trialsOf(firstOrder('a', { n: 40, value: { failureRate: 0.1 } }))).toBe(40);
  });
});

describe('moved', () => {
  const at = (value: number, low: number, high: number): Estimate => ({ value, interval: span(low, high) });

  it('needs the interval to clear zero with room for every comparison made', () => {
    expect(clearsZero(at(0.2, 0.1, 0.3), 1)).toBe(true);
    expect(clearsZero(at(-0.2, -0.3, -0.1), 1)).toBe(true);
    expect(clearsZero(at(0.2, 0.1, 0.3), 1_000_000_000)).toBe(false);
    expect(clearsZero(at(0, -0.1, 0.1), 1)).toBe(false);
    expect(clearsZero(at(0.05, -0.01, 0.11), 1)).toBe(false);
  });

  it('needs the move to be large enough to matter, however large the sample', () => {
    expect(moved(at(MIN_MOVE / 2, MIN_MOVE / 2 - 0.0001, MIN_MOVE / 2 + 0.0001), 1)).toBe(false);
    expect(moved(at(-MIN_MOVE * 2, -MIN_MOVE * 2 - 0.0001, -MIN_MOVE * 2 + 0.0001), 1)).toBe(true);
  });
});

describe('relate', () => {
  const fields = { slice: { motif: 'a' }, value: { move: 0.1 }, interval: span(0.05, 0.15) };

  it('states the weakest side: the fewest trials and the fewest clusters', () => {
    const body = relate('version-boundary', 'share-move', '1', [firstOrder('a', { value: { share: 0.5, of: 200 } }), firstOrder('b', { clusters: 3, value: { share: 0.5, of: 90 } })], fields);
    expect(body?.n).toBe(90);
    expect(body?.clusters).toBe(1);
    expect(body?.basis).toBe('all');
    expect(body?.inputs).toHaveLength(2);
  });

  it('takes n from the caller when its observations are not its inputs, as a slope over pairs is', () => {
    expect(relate('lead-lag', 'slope', '1', [firstOrder('a')], { ...fields, n: 44 })?.n).toBe(44);
  });

  it('does not exist below the floor', () => {
    const under = firstOrder('b', { value: { share: 0.5, of: TRIALS_FLOOR - 1 } });
    expect(relate('version-boundary', 'share-move', '1', [firstOrder('a'), under], fields)).toBeUndefined();
    const at = firstOrder('b', { value: { share: 0.5, of: TRIALS_FLOOR } });
    expect(relate('version-boundary', 'share-move', '1', [firstOrder('a'), at], fields)).toBeDefined();
  });

  it('does not exist when an input has no interval to propagate', () => {
    expect(relate('version-boundary', 'share-move', '1', [firstOrder('a'), firstOrder('b', { interval: null })], fields)).toBeUndefined();
  });

  it('cites what it reads besides its measured inputs without holding those to the floor', () => {
    const cited = firstOrder('b', { interval: null, value: { failureRate: 0 }, n: 1 });
    const body = relate('interaction', 'gap', '1', [firstOrder('a')], { ...fields, cites: [cited] });
    expect(body?.inputs).toContain(cited.readId);
    expect(body?.n).toBe(100);
  });
});

describe('a chain of orders 1 to 3', () => {
  const shares = (of: number): Read[] => [
    firstOrder('a1', { value: { share: 0.5, of }, interval: span(0.4, 0.6) }),
    firstOrder('a2', { value: { share: 0.3, of }, interval: span(0.2, 0.4) }),
    firstOrder('b1', { value: { share: 0.4, of }, interval: span(0.3, 0.5) }),
    firstOrder('b2', { value: { share: 0.35, of }, interval: span(0.25, 0.45) }),
  ];

  const move = (later: Read | undefined, earlier: Read | undefined, known: readonly Read[]): Read | undefined => {
    if (later === undefined || earlier === undefined) return undefined;
    const a = estimateOf(later, 'share') ?? estimateOf(later, 'move');
    const b = estimateOf(earlier, 'share') ?? estimateOf(earlier, 'move');
    if (a === undefined || b === undefined) return undefined;
    const { value, interval } = differenceOf(a, b);
    const body = relate('version-boundary', 'move', '1', [later, earlier], { slice: {}, value: { move: value }, interval });
    return body === undefined ? undefined : makeRead({ ...body, asOf: ASOF }, orderResolver(known));
  };

  const chain = (of: number): { first: Read[]; second: (Read | undefined)[]; third: Read | undefined } => {
    const first = shares(of);
    const second = [move(first[0], first[1], first), move(first[2], first[3], first)];
    const known = [...first, ...second.filter((read) => read !== undefined)];
    return { first, second, third: move(second[0], second[1], known) };
  };

  it('computes each order from its inputs, and each interval is wider than the last', () => {
    const { first, second, third } = chain(100);
    expect(first.map((read) => read.order)).toEqual([1, 1, 1, 1]);
    expect(second.map((read) => read?.order)).toEqual([2, 2]);
    expect(third?.order).toBe(3);
    expect(third?.value).toEqual({ move: 0.15 });
    expect(width(second[0]?.interval ?? null)).toBeGreaterThan(width(first[0]?.interval ?? null));
    expect(width(third?.interval ?? null)).toBeGreaterThan(width(second[0]?.interval ?? null));
    // By hand: order 2 is 0.2 (0.0586, 0.3414) and 0.05 (-0.0914, 0.1914), so order 3 is 0.15 with half-widths of hypot(0.1414, 0.1414) = 0.2.
    expect(third?.interval).toEqual(span(-0.05, 0.35));
  });

  it('breaks at the floor: below it no order 2 read exists, so neither does the order 3 read', () => {
    const { second, third } = chain(TRIALS_FLOOR - 1);
    expect(second).toEqual([undefined, undefined]);
    expect(third).toBeUndefined();
  });

  it('holds an order 3 read to the floor through what its order 2 inputs state', () => {
    const { second } = chain(TRIALS_FLOOR);
    expect(second[0]?.n).toBe(TRIALS_FLOOR);
    expect(second[0] === undefined ? 0 : trialsOf(second[0])).toBe(TRIALS_FLOOR);
  });
});
