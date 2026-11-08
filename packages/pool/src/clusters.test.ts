// The cluster rule: accounts that share a machine, a repo-key set, or a creation window and a deposit cadence are one cluster, and a cluster of only young accounts counts half.
import { describe, expect, it } from 'vitest';
import { CADENCE_MIN_DAYS, CADENCE_SHARE, CLUSTER_WINDOW_MS, clusterHolders as clusterRule, REPO_KEYS_JACCARD, REPO_KEYS_MIN, YOUNG_DAYS, YOUNG_WEIGHT, type Holder } from './clusters.js';

const DAY = 24 * 60 * 60 * 1000;
const FIRST = Date.UTC(2026, 10, 1);
const OLD = Date.UTC(2020, 0, 1);

/** An old, unrelated account: its own creation day (far apart, so no window joins it), its own repo keys, and its own deposit hour. */
const holder = (at: number, over: Partial<Holder> = {}): Holder => ({
  account: `acct_${String(at)}`,
  repoKeys: [`${String(at)}a`, `${String(at)}b`, `${String(at)}c`],
  createdAt: OLD + at * 10 * DAY,
  firstDeposit: FIRST,
  cadence: new Map([['2026-11-01', new Set([at])]]),
  ...over,
});
const many = (count: number, over: (at: number) => Partial<Holder> = () => ({})): Holder[] => Array.from({ length: count }, (_, at) => holder(at, over(at)));

describe('the thresholds', () => {
  it('are named constants', () => {
    expect([YOUNG_DAYS, YOUNG_WEIGHT, REPO_KEYS_MIN, REPO_KEYS_JACCARD, CADENCE_SHARE, CADENCE_MIN_DAYS, CLUSTER_WINDOW_MS]).toEqual([30, 0.5, 3, 0.8, 0.9, 3, DAY]);
  });
});

describe('clusterRule', () => {
  it('(a) counts five accounts on one machine as one cluster', () => {
    const found = clusterRule(many(5, () => ({ machine: 'm1' })));
    expect(found.groups).toHaveLength(1);
    expect(found.count).toBe(1);
  });

  it('(b) counts five accounts whose repo-key sets overlap at the threshold as one cluster', () => {
    const shared = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'];
    // Each holds the eight shared keys and one of its own: Jaccard 8/10 = 0.8, exactly the threshold.
    expect(clusterRule(many(5, (at) => ({ repoKeys: [...shared, `own${String(at)}`] }))).count).toBe(1);
  });

  it('(b) keeps accounts apart when the overlap is under the threshold or a set holds fewer than three keys', () => {
    expect(clusterRule(many(2, (at) => ({ repoKeys: ['k1', 'k2', 'k3', `own${String(at)}`, `own${String(at)}b`] }))).count).toBe(2);
    expect(clusterRule(many(2, () => ({ repoKeys: ['k1', 'k2'] }))).count).toBe(2);
  });

  it('(c) counts five accounts created in one window that deposit in lockstep as one cluster', () => {
    expect(clusterRule(many(5, (at) => ({ createdAt: OLD + at * 3_600_000, cadence: new Map([['2026-11-01', new Set([9])], ['2026-11-02', new Set([9])], ['2026-11-03', new Set([9])]]) }))).count).toBe(1);
  });

  it('(c) joins on cadence only after each account has deposited on 3 distinct days: a team installing together is not a sybil cluster (t958)', () => {
    const daysOf = (count: number): Map<string, Set<number>> => new Map(Array.from({ length: count }, (_, at) => [`2026-11-0${String(at + 1)}`, new Set([9])]));
    const join = (left: number, right: number): number => clusterRule([holder(0, { createdAt: OLD, cadence: daysOf(left) }), holder(1, { createdAt: OLD + 3_600_000, cadence: daysOf(right) })]).count;
    // Created the same day, one deposit each, the same hour: apart.
    expect(join(1, 1)).toBe(2);
    expect(join(2, 2)).toBe(2);
    // Both at 3 days: joined. One short of it on either side: apart.
    expect(join(3, 3)).toBe(1);
    expect(join(3, 2)).toBe(2);
    expect(join(2, 3)).toBe(2);
  });

  it('(c) keeps accounts apart when only one of the two holds', () => {
    const lockstep = new Map([['2026-11-01', new Set([9])]]);
    expect(clusterRule(many(2, (at) => ({ createdAt: OLD + at * 2 * DAY, cadence: lockstep }))).count).toBe(2);
    expect(clusterRule(many(2, (at) => ({ createdAt: OLD + at * 3_600_000, cadence: new Map([['2026-11-01', new Set([at])]]) }))).count).toBe(2);
    // 9 of 10 days in the same hour is the threshold; 8 of 10 is not.
    const days = (hours: number[]): Map<string, Set<number>> => new Map(hours.map((hour, at) => [`2026-11-${String(at + 1).padStart(2, '0')}`, new Set([hour])]));
    const base = Array.from({ length: 10 }, () => 9);
    const join = (other: number[]): number => clusterRule([holder(0, { createdAt: OLD, cadence: days(base) }), holder(1, { createdAt: OLD, cadence: days(other) })]).count;
    expect(join([9, 9, 9, 9, 9, 9, 9, 9, 9, 3])).toBe(1);
    expect(join([9, 9, 9, 9, 9, 9, 9, 9, 3, 3])).toBe(2);
  });

  it('(c) does not join an account with no deposit day or no known creation time', () => {
    expect(clusterRule(many(2, (at) => ({ createdAt: OLD + at, cadence: new Map() }))).count).toBe(2);
    expect(clusterRule(many(2, () => ({ createdAt: undefined, cadence: new Map([['2026-11-01', new Set([9])]]) }))).count).toBe(2);
  });

  it('(d) counts five accounts with nothing shared as five', () => {
    const found = clusterRule(many(5));
    expect(found.groups).toHaveLength(5);
    expect(found.count).toBe(5);
  });

  it('(e) counts a cluster of only young accounts as half, and one old account in a cluster as a whole', () => {
    const young = (at: number): Partial<Holder> => ({ machine: 'm1', createdAt: FIRST - (YOUNG_DAYS - 1) * DAY - at });
    expect(clusterRule(many(2, young)).count).toBe(0);
    // Two unrelated young accounts are two clusters at half each: one.
    expect(clusterRule(many(2, (at) => ({ createdAt: FIRST - DAY - at * 10 * DAY }))).count).toBe(1);
    // Thirty days old is not young.
    expect(clusterRule(many(1, () => ({ createdAt: FIRST - YOUNG_DAYS * DAY }))).count).toBe(1);
    // One old account makes its cluster whole.
    expect(clusterRule([holder(0, { machine: 'm1', createdAt: FIRST - DAY }), holder(1, { machine: 'm1' })]).count).toBe(1);
    // An account with no known creation time is not young.
    expect(clusterRule(many(1, () => ({ createdAt: undefined }))).count).toBe(1);
  });

  it('(f) closes the union transitively: a shared machine with B and shared repo keys between B and C is one cluster', () => {
    const keys = ['k1', 'k2', 'k3'];
    const found = clusterRule([holder(0, { machine: 'm1' }), holder(1, { machine: 'm1', repoKeys: keys }), holder(2, { repoKeys: keys }), holder(3)]);
    expect(found.groups.map((group) => group.length).sort()).toEqual([1, 3]);
    expect(found.count).toBe(2);
  });

  it('is the same whatever order the accounts arrive in, and names only account ids', () => {
    const accounts = [holder(0, { machine: 'm1' }), holder(1, { machine: 'm1' }), holder(2)];
    const forward = clusterRule(accounts);
    expect(clusterRule([...accounts].reverse()).count).toBe(forward.count);
    expect(forward.groups.flat().sort()).toEqual(accounts.map(({ account }) => account).sort());
  });

  it('counts nothing for no accounts', () => {
    expect(clusterRule([])).toEqual({ groups: [], count: 0 });
  });
});
