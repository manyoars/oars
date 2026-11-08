// The cluster signals the pool keeps and the count it writes from them (t937). A deposit records the repo keys it carried and the UTC hour it arrived (both from data the pool already receives);
// a login records the account's age (`identity.ts`). After a deposit lands, `recount` takes the touched cells' and strata's accounts through the rule in `clusters.ts` and writes the weighted
// count to their `clusters` column, the one number a floor compares in SQL (`stored.ts`) and in code (`floors.ts`). Nothing here refuses, drops, or hides an account or a deposit.
import type { SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { clusterHolders, type Holder } from './clusters.js';
import { STANDING_AFTER_DAYS } from './access.js';
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
/** The columns a recount writes: a cell keeps the count of every holder beside the standing one, a stratum only the standing one. */
const COLUMNS: { [kind in Kind]: string } = { cell: 'clusters = counts.count, clusters_any = counts.any', stratum: 'clusters = counts.count' };

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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The weighted count of each of `keys` (cell keys, or stratum keys), from the accounts that hold it and have stood. An account has stood when its `access` is `standing`, or when its first counting batch is
 * `STANDING_AFTER_DAYS` old (`accessOf` latches the flag the first time it is read after that, and a recount can come first). A free account counts toward no floor until then, so k-1 of them
 * cannot test whether a real account holds a name (S13); their holdings are kept and count once they have stood. `now` is the pool's clock.
 */
const countsOf = async (env: Env, kind: Kind, keys: string, now: number): Promise<{ key: string; count: number; any: number }[]> => {
  const [held, accounts, repoKeys, hours, counted] = await Promise.all([
    rows(env, `SELECT key, account, MIN(day) AS first_day FROM contributors WHERE kind = ? AND key IN (SELECT value FROM json_each(?)) GROUP BY key, account`, kind, keys),
    rows(env, `SELECT id, first_seen, provider_created, access FROM accounts WHERE id IN (${HOLDING(kind)})`, keys),
    rows(env, `SELECT account, repo_key FROM account_repo_keys WHERE account IN (${HOLDING(kind)})`, keys),
    rows(env, `SELECT account, day, hour FROM deposit_hours WHERE account IN (${HOLDING(kind)})`, keys),
    rows(env, `SELECT account, MIN(counted_at) AS first FROM deposits WHERE counted_at IS NOT NULL AND tier <> 'none' AND account IN (${HOLDING(kind)}) GROUP BY account`, keys),
  ]);
  const firstCounted = new Map<string, number | undefined>(counted.map((row) => [text(row, 'account'), whole(row, 'first')]));
  const standing = new Set(accounts.filter((row) => fieldOf(row, 'access') === 'standing' || (firstCounted.get(text(row, 'id')) ?? Infinity) <= now - STANDING_AFTER_DAYS * DAY_MS).map((row) => text(row, 'id')));
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
  const everyone = new Map<string, Holder[]>();
  for (const row of held) {
    const account = text(row, 'account');
    const holder = {
      account,
      repoKeys: keysOf.get(account) ?? [],
      createdAt: created.get(account),
      firstDeposit: Date.parse(text(row, 'first_day')),
      cadence: cadence.get(account) ?? new Map<string, Set<number>>(),
    };
    into(everyone, text(row, 'key'), holder);
    if (standing.has(account)) into(holders, text(row, 'key'), holder);
  }
  // A key whose holders have not stood is written 0, not left at the count an earlier recount gave it. `any` counts the holders that have not stood as well: only a clear cell at a floor of 1 reads it (`stored.ts`).
  return [...new Set(held.map((row) => text(row, 'key')))].map((key) => ({ key, count: clusterHolders(holders.get(key) ?? []).count, any: clusterHolders(everyone.get(key) ?? []).count }));
};

/** Every cell or stratum key `account` holds: the signals it adds (repo keys, deposit hours) are the account's, so a deposit can change the cluster of any key it holds, not only this batch's. */
export const heldBy = async (env: Env, account: string, kind: Kind): Promise<string[]> => (await rows(env, 'SELECT DISTINCT key FROM contributors WHERE kind = ? AND account = ?', kind, account)).map((row) => text(row, 'key'));

/**
 * Writes the weighted count of each key in `keys` to its row's `clusters`. It reads what is committed, then writes after awaiting, so a recount that started earlier can write after a later one:
 * a count can lag a deposit until the next deposit that touches the key. A key with no row (a stratum a batch did not write) is left alone. A key none hold stays at the 0 it began with.
 */
export const recount = async (env: Env, kind: Kind, keys: readonly string[], now: number = Date.now()): Promise<void> => {
  for (const chunk of chunksOf(keys)) {
    const counts = await countsOf(env, kind, chunk, now);
    for (const part of chunksOf(counts)) {
      await env.DB.prepare(
        `UPDATE ${TABLE[kind]} SET ${COLUMNS[kind]} FROM (SELECT json_extract(value, '$.key') AS key, json_extract(value, '$.count') AS count, json_extract(value, '$.any') AS any FROM json_each(?)) AS counts WHERE ${TABLE[kind]}.key = counts.key`,
      )
        .bind(part)
        .run();
    }
  }
};
