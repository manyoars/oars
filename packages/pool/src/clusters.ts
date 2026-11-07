// The cluster rule (t937). A cell's held count is the number of verified-distinct clusters of the accounts that hold it, not the number of accounts: one person with many pseudonymous
// sign-ins is one cluster, and a cluster that is all young counts less. It is a weighting, never a cap: no account or deposit is refused here, only the count a floor compares changes.
// This file reads no database and no clock; `cluster-store.ts` gathers the signals and calls it.

/** An account under this many days old, at its first deposit to the cell, is young. */
export const YOUNG_DAYS = 30;
/** What a cluster of only young accounts counts; every other cluster counts 1. */
export const YOUNG_WEIGHT = 0.5;
/** Two accounts created within this long of each other, and depositing in lockstep, are one cluster. */
export const CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A repo-key set joins accounts only at this many keys or more. */
export const REPO_KEYS_MIN = 3;
/** Two repo-key sets join accounts at this Jaccard overlap or more. */
export const REPO_KEYS_JACCARD = 0.8;
/** Two accounts deposit in lockstep when, on this share of the days either deposited, both deposited in the same hour. */
export const CADENCE_SHARE = 0.9;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One account that holds the cell, with the signals the pool kept for it. Account ids and signal values go no further than this file's output ids. */
export interface Holder {
  account: string;
  /** The per-machine id the deposit carries. The wire carries none today, so the pool stores none and this is absent for every account. */
  machine?: string | undefined;
  repoKeys: readonly string[];
  /** Epoch ms: the provider's account creation (GitHub), else the account's first-seen time at the pool. Absent for an account that predates the record. */
  createdAt?: number | undefined;
  /** Epoch ms of the account's first deposit to this cell. */
  firstDeposit: number;
  /** The UTC hours (0 to 23) in which the account deposited, by UTC day. */
  cadence: ReadonlyMap<string, ReadonlySet<number>>;
}

export interface Clusters {
  /** The account ids of each cluster. */
  groups: string[][];
  /** The weighted count, rounded down: the number a floor compares and a served read states. */
  count: number;
}

const jaccard = (a: readonly string[], b: readonly string[]): number => {
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const key of left) if (right.has(key)) shared += 1;
  return shared / (left.size + right.size - shared);
};

const sharesMachine = (a: Holder, b: Holder): boolean => a.machine !== undefined && a.machine === b.machine;

const sharesRepoKeys = (a: Holder, b: Holder): boolean => new Set(a.repoKeys).size >= REPO_KEYS_MIN && new Set(b.repoKeys).size >= REPO_KEYS_MIN && jaccard(a.repoKeys, b.repoKeys) >= REPO_KEYS_JACCARD;

const sameHour = (a: ReadonlySet<number> | undefined, b: ReadonlySet<number> | undefined): boolean => a !== undefined && b !== undefined && [...a].some((hour) => b.has(hour));

const inLockstep = (a: Holder, b: Holder): boolean => {
  if (a.createdAt === undefined || b.createdAt === undefined || Math.abs(a.createdAt - b.createdAt) > CLUSTER_WINDOW_MS) return false;
  const days = new Set([...a.cadence.keys(), ...b.cadence.keys()]);
  if (days.size === 0) return false;
  let together = 0;
  for (const day of days) if (sameHour(a.cadence.get(day), b.cadence.get(day))) together += 1;
  return together >= CADENCE_SHARE * days.size;
};

const young = (holder: Holder): boolean => holder.createdAt !== undefined && holder.firstDeposit - holder.createdAt < YOUNG_DAYS * DAY_MS;

/** The connected components of "shares a machine, a repo-key set, or a creation window and a deposit cadence", each counted 1, or half when every account in it is young. */
export const clustersOf = (holders: readonly Holder[]): Clusters => {
  const parent = holders.map((_, at) => at);
  const find = (at: number): number => {
    let root = at;
    while (parent[root] !== root) root = parent[root] ?? root;
    parent[at] = root;
    return root;
  };
  holders.forEach((one, at) => {
    for (let other = at + 1; other < holders.length; other += 1) {
      const next = holders[other];
      if (next !== undefined && (sharesMachine(one, next) || sharesRepoKeys(one, next) || inLockstep(one, next))) parent[find(other)] = find(at);
    }
  });
  const members = new Map<number, Holder[]>();
  holders.forEach((one, at) => members.set(find(at), [...(members.get(find(at)) ?? []), one]));
  const groups = [...members.values()];
  const weight = groups.reduce((sum, group) => sum + (group.every(young) ? YOUNG_WEIGHT : 1), 0);
  return { groups: groups.map((group) => group.map(({ account }) => account)), count: Math.floor(weight) };
};
