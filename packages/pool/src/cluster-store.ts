// The cluster signals the pool keeps and the count it writes from them (t937). A deposit records the repo keys it carried and the UTC hour it arrived (both from data the pool already receives);
// a login records the account's age (`identity.ts`). After a deposit lands, `recount` takes the touched cells' and strata's accounts through the rule in `clusters.ts` and writes the weighted
// count to their `clusters` column, the one number a floor compares in SQL (`stored.ts`) and in code (`floors.ts`). Nothing here refuses, drops, or hides an account or a deposit.
import type { SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { clustersOf, type Holder } from './clusters.js';
import { fieldOf, type Bound, type Env } from './http.js';
import { chunksOf } from './ingest.js';

/** The distinct repo keys a batch's frames carry. A frame with none (its repository is unknown) adds nothing. */
export const repoKeysOf = (skeleton: SessionSkeleton): string[] => {
  const keys = new Set<string>();
  for (const transcript of skeleton.transcripts) for (const frame of [transcript.frame, ...transcript.frames]) if (frame.repoKey !== undefined) keys.add(frame.repoKey);
  return [...keys];
};

/**
 * The statements that record a deposit's cluster signals, to run in the deposit's own batch under its guard, so a refused deposit records none. The hour is the pool's own clock at receipt:
 * the client states no deposit time, and what it states about hours is the session's, not the deposit's.
 */
export const signalStatements = (env: Env, account: string, guard: readonly [string, string, string], at: Date, repoKeys: readonly string[]): Bound[] => {
  const exists = 'EXISTS (SELECT 1 FROM deposits WHERE account = ? AND id = ? AND ingest = ?)';
  const statements = [env.DB.prepare(`INSERT OR IGNORE INTO deposit_hours (account, day, hour) SELECT ?, ?, ? WHERE ${exists}`).bind(account, at.toISOString().slice(0, 10), at.getUTCHours(), ...guard)];
  for (const keys of chunksOf(repoKeys)) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO account_repo_keys (account, repo_key) SELECT ?, value FROM json_each(?) WHERE ${exists}`).bind(account, keys, ...guard));
  }
  return statements;
};

type Kind = 'cell' | 'stratum';
const TABLE: { [kind in Kind]: string } = { cell: 'cells', stratum: 'strata' };

const rows = async (env: Env, sql: string, ...values: (string | number | null)[]): Promise<readonly unknown[]> => (await env.DB.prepare(sql).bind(...values).all()).results;

const text = (row: unknown, key: string): string => {
  const found = fieldOf(row, key);
  return typeof found === 'string' ? found : '';
};

const whole = (row: unknown, key: string): number | undefined => {
  const found = fieldOf(row, key);
  return typeof found === 'number' ? found : undefined;
};

const into = <Value>(map: Map<string, Value[]>, key: string, value: Value): void => {
  map.set(key, [...(map.get(key) ?? []), value]);
};

/** The accounts that hold any of `keys`, as the subquery every signal read starts from. */
const HOLDING = (kind: Kind): string => `SELECT account FROM contributors WHERE kind = '${kind}' AND key IN (SELECT value FROM json_each(?))`;

/** The weighted count of each of `keys` (cell keys, or stratum keys), from every account that holds it. */
const countsOf = async (env: Env, kind: Kind, keys: string): Promise<{ key: string; count: number }[]> => {
  const [held, accounts, repoKeys, hours] = await Promise.all([
    rows(env, `SELECT key, account, MIN(day) AS first_day FROM contributors WHERE kind = ? AND key IN (SELECT value FROM json_each(?)) GROUP BY key, account`, kind, keys),
    rows(env, `SELECT id, first_seen, provider_created FROM accounts WHERE id IN (${HOLDING(kind)})`, keys),
    rows(env, `SELECT account, repo_key FROM account_repo_keys WHERE account IN (${HOLDING(kind)})`, keys),
    rows(env, `SELECT account, day, hour FROM deposit_hours WHERE account IN (${HOLDING(kind)})`, keys),
  ]);
  const created = new Map<string, number | undefined>(accounts.map((row) => [text(row, 'id'), whole(row, 'provider_created') ?? whole(row, 'first_seen')]));
  const keysOf = new Map<string, string[]>();
  for (const row of repoKeys) into(keysOf, text(row, 'account'), text(row, 'repo_key'));
  const cadence = new Map<string, Map<string, Set<number>>>();
  for (const row of hours) {
    const days = cadence.get(text(row, 'account')) ?? new Map<string, Set<number>>();
    days.set(text(row, 'day'), (days.get(text(row, 'day')) ?? new Set<number>()).add(whole(row, 'hour') ?? 0));
    cadence.set(text(row, 'account'), days);
  }
  const holders = new Map<string, Holder[]>();
  for (const row of held) {
    const account = text(row, 'account');
    into(holders, text(row, 'key'), {
      account,
      repoKeys: keysOf.get(account) ?? [],
      createdAt: created.get(account),
      firstDeposit: Date.parse(text(row, 'first_day')),
      cadence: cadence.get(account) ?? new Map<string, Set<number>>(),
    });
  }
  return [...holders].map(([key, found]) => ({ key, count: clustersOf(found).count }));
};

/**
 * Writes the weighted count of each key in `keys` to its row's `clusters`. It reads what is committed, so two deposits racing converge on the later recount, and a key with no row
 * (a stratum a batch did not write) is left alone. A key none hold stays at the 0 it began with.
 */
export const recount = async (env: Env, kind: Kind, keys: readonly string[]): Promise<void> => {
  for (const chunk of chunksOf(keys)) {
    const counts = await countsOf(env, kind, chunk);
    for (const part of chunksOf(counts)) {
      await env.DB.prepare(
        `UPDATE ${TABLE[kind]} SET clusters = (SELECT json_extract(value, '$.count') FROM json_each(?) WHERE json_extract(value, '$.key') = ${TABLE[kind]}.key) WHERE key IN (SELECT json_extract(value, '$.key') FROM json_each(?))`,
      )
        .bind(part, part)
        .run();
    }
  }
};
