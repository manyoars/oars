// The operator's erasure. Three things can be erased from the pool and nothing else: a raw object, a deposit row that holds a leaked secret, and the content of one account named in a lawful request.
// This is a script the operator runs with their own `wrangler` login (`erase-cli.ts`), never a route: the Worker has no way to erase anything and holds no token for it.
// The ledger never deletes (migrations 0009 and 0011), so a row's content is replaced in place and the row, its counts, and its tier stay. Every step is written so a run that stops halfway runs again to the end: the
// tombstone goes first (so nothing can come back), then the content, then the audit row.
import { depositDigest, digestOf, rawDigest } from '../src/tombstones.js';

/** The class of an erasure, as the audit and the tombstone record it. */
export type ErasureReason = 'raw' | 'leaked-secret' | 'lawful-request';

/** What a store runs the erasure against: the pool's D1 and its raw bucket, by wrangler (`erase-wrangler.ts`) or by a Miniflare binding (the tests). */
export interface EraseStore {
  /** Rows a SELECT returns. */
  rows: (sql: string, binds: readonly (string | number | null)[]) => Promise<readonly unknown[]>;
  /** Runs one statement and answers how many rows it changed. */
  run: (sql: string, binds: readonly (string | number | null)[]) => Promise<number>;
  /** Deletes one R2 object; one that is not there is not an error. */
  deleteObject: (key: string) => Promise<void>;
}

/** What one erasure removed: ledger rows and aggregate rows whose content was replaced, staged parts dropped, and raw objects deleted. */
export interface Erased {
  rows: number;
  objects: number;
}

const RAW_KEY = /^raw\/([A-Za-z0-9._-]{1,128})\/([0-9a-f]{64})$/;
const NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** The shortest leaked value the command will scrub. A shorter one would also match inside names that are not secrets. */
const MIN_VALUE_LENGTH = 8;

/** What stands in an aggregate row where the leaked value was. */
const SCRUBBED = '[erased]';

const fieldOf = (row: unknown, key: string): unknown => (typeof row === 'object' && row !== null ? Reflect.get(row, key) : undefined);

const textOf = (row: unknown, key: string): string => {
  const found = fieldOf(row, key);
  if (typeof found !== 'string') throw new Error(`no text at ${key} in a row`);
  return found;
};

const numberOf = (row: unknown, key: string): number => {
  const found = fieldOf(row, key);
  if (typeof found !== 'number') throw new Error(`no number at ${key} in a row`);
  return found;
};

const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

/** The marker a deposit row holds in place of its skeleton. It parses as no skeleton, so a resend over it nets nothing. */
const markerOf = (reason: ErasureReason): string => JSON.stringify({ erased: reason });

const nameOf = (value: string, what: string): string => {
  if (!NAME.test(value)) throw new Error(`${what} is not a pool id: letters, digits, dot, dash, and underscore, 1 to 128`);
  return value;
};

const tombstone = async (store: EraseStore, kind: 'raw-object' | 'deposit' | 'value', digest: string, reason: ErasureReason, now: Date): Promise<void> => {
  await store.run('INSERT OR IGNORE INTO erasure_tombstones (kind, digest, reason, erased_on) VALUES (?, ?, ?, ?)', [kind, digest, reason, dayOf(now)]);
};

const audit = async (store: EraseStore, kind: 'raw-object' | 'row' | 'account', reason: ErasureReason, account: string, erased: Erased, now: Date): Promise<void> => {
  await store.run('INSERT INTO erasure_audit (kind, reason, erased_on, rows_erased, objects_erased, account) VALUES (?, ?, ?, ?, ?, ?)', [kind, reason, dayOf(now), erased.rows, erased.objects, account]);
};

/** The raw object at `account`/`sha256`: tombstoned, deleted from R2, and its ledger row marked. Answers whether a ledger row was marked. */
const dropObject = async (store: EraseStore, account: string, sha256: string, reason: ErasureReason, now: Date): Promise<number> => {
  const key = `raw/${account}/${sha256}`;
  await tombstone(store, 'raw-object', await rawDigest(key), reason, now);
  await store.deleteObject(key);
  return store.run('UPDATE raw_objects SET erased_on = ? WHERE account = ? AND sha256 = ? AND erased_on IS NULL', [dayOf(now), account, sha256]);
};

/** The deposit row `account`/`id`: tombstoned, its content replaced by the marker, its tier and counts left. Answers whether a row was changed. */
const dropDeposit = async (store: EraseStore, account: string, id: string, reason: ErasureReason, now: Date): Promise<number> => {
  await tombstone(store, 'deposit', await depositDigest(account, id), reason, now);
  return store.run("UPDATE deposits SET skeleton = ?, extensions = '[]', deltas = '[]', erased_on = ? WHERE account = ? AND id = ? AND erased_on IS NULL", [markerOf(reason), dayOf(now), account, id]);
};

/**
 * Erases one raw object by its R2 key (`raw/<account>/<sha256>`): the object is deleted, a tombstone of the key's hash is written so a later deposit of the same object is refused, and the object's ledger row is marked. The row
 * holds a hash and a byte count and nothing else, so it stays. Staged parts of the same object are not listed (wrangler cannot list); they expire in 7 days and the tombstone refuses their completion.
 */
export const eraseRawObject = async (store: EraseStore, key: string, now: Date): Promise<Erased> => {
  const found = RAW_KEY.exec(key);
  if (found === null) throw new Error('a raw key is raw/<account>/<sha256, 64 lowercase hex>');
  const [, account = '', sha256 = ''] = found;
  const objects = await dropObject(store, account, sha256, 'raw', now);
  const erased = { rows: 0, objects };
  await audit(store, 'raw-object', 'raw', account, erased, now);
  return erased;
};

/** What names a leaked secret: the deposit that held it, and optionally the value itself, which turns on the scrub and the ingest check. */
export interface LeakedSecret {
  account: string;
  id: string;
  /** The leaked value. Never stored: only its SHA-256 is. */
  value?: string;
}

/** Rows read per round trip when the command looks for a value. The match is made here, never in SQL, so the value does not reach wrangler's arguments (the process table, wrangler's logs). */
const PAGE = 25;

/** Whether the deposit row `account`/`id` exists, erased or not. The dry run asks it, and the confirmed run refuses a mistyped selector before it writes a tombstone for a session that was never deposited. */
export const depositExists = async (store: EraseStore, accountId: string, sessionId: string): Promise<boolean> => (await store.rows('SELECT 1 AS found FROM deposits WHERE account = ? AND id = ?', [nameOf(accountId, 'the account'), nameOf(sessionId, 'the session id')])).length > 0;

/** Reads a table a page at a time in key order, so the caller can look at every row without the value ever being written into a statement. */
const scan = async (store: EraseStore, table: string, columns: readonly string[], keys: readonly string[], visit: (row: unknown) => Promise<void>, also = ''): Promise<void> => {
  let after: (string | number)[] = keys.map(() => '');
  for (;;) {
    const page = await store.rows(`SELECT ${columns.join(', ')} FROM ${table} WHERE ${also}(${keys.join(', ')}) > (${keys.map(() => '?').join(', ')}) ORDER BY ${keys.join(', ')} LIMIT ${String(PAGE)}`, after);
    for (const row of page) await visit(row);
    if (page.length < PAGE) return;
    after = keys.map((key) => {
      const last: unknown = page[page.length - 1];
      return typeof fieldOf(last, key) === 'number' ? numberOf(last, key) : textOf(last, key);
    });
  }
};

/**
 * Erases a deposit row that holds a leaked secret: its content is replaced by a marker in place (no row is dropped), and its key is tombstoned. With the value, every other deposit row that holds it goes the same way, the
 * motifs that name it are scrubbed of it (their counts stand), staged parts that hold it are dropped, and a tombstone of its SHA-256 makes ingest refuse a deposit that carries it again. A raw object that holds it is erased by key.
 * A session that was never deposited is refused when no value is given: its tombstone would refuse that id forever.
 */
export const eraseLeakedSecret = async (store: EraseStore, secret: LeakedSecret, now: Date): Promise<Erased> => {
  const account = nameOf(secret.account, 'the account');
  const id = nameOf(secret.id, 'the session id');
  const { value } = secret;
  if (value !== undefined && value.length < MIN_VALUE_LENGTH) throw new Error(`a leaked value is at least ${String(MIN_VALUE_LENGTH)} characters, or it would also match names that are not secrets`);
  const named = await depositExists(store, account, id);
  if (!named && value === undefined) throw new Error(`no deposit row for account ${account}, session ${id}: nothing was erased`);
  const held: { account: string; id: string }[] = named ? [{ account, id }] : [];
  let rows = 0;
  if (value !== undefined) {
    await tombstone(store, 'value', await digestOf(value), 'leaked-secret', now);
    // A row holds the value as JSON wrote it, so that is the text to look for.
    const stored = JSON.stringify(value).slice(1, -1);
    await scan(store, 'deposits', ['account', 'id', 'skeleton', 'extensions'], ['account', 'id'], (row) => {
      if (textOf(row, 'skeleton').includes(stored) || textOf(row, 'extensions').includes(stored)) held.push({ account: textOf(row, 'account'), id: textOf(row, 'id') });
      return Promise.resolve();
    }, 'erased_on IS NULL AND ');
    await scan(store, 'deposit_parts', ['account', 'batch', 'part', 'body'], ['account', 'batch', 'part'], async (row) => {
      if (textOf(row, 'body').includes(stored)) rows += await store.run('DELETE FROM deposit_parts WHERE account = ? AND batch = ? AND part = ?', [textOf(row, 'account'), textOf(row, 'batch'), numberOf(row, 'part')]);
    });
    await scan(store, 'motifs', ['motif_id', 'motif'], ['motif_id'], async (row) => {
      const motif = textOf(row, 'motif');
      if (motif.includes(stored)) rows += await store.run('UPDATE motifs SET motif = ? WHERE motif_id = ?', [motif.replaceAll(stored, SCRUBBED), textOf(row, 'motif_id')]);
    });
  }
  for (const one of held) rows += await dropDeposit(store, one.account, one.id, 'leaked-secret', now);
  const erased = { rows, objects: 0 };
  await audit(store, 'row', 'leaked-secret', account, erased, now);
  return erased;
};

/**
 * Erases one account's content under a lawful request: every deposit row it holds is replaced by the marker and tombstoned, every raw object it holds is deleted and tombstoned, and its staged parts are dropped. What stays is
 * the account's contribution to the aggregates (cells, strata, and the contributor records that tell a returning cluster from a new one): opting out removes nothing from them.
 */
export const eraseAccount = async (store: EraseStore, accountId: string, now: Date): Promise<Erased> => {
  const account = nameOf(accountId, 'the account');
  let rows = await store.run('DELETE FROM deposit_parts WHERE account = ?', [account]);
  for (const row of await store.rows('SELECT id FROM deposits WHERE account = ? AND erased_on IS NULL', [account])) rows += await dropDeposit(store, account, textOf(row, 'id'), 'lawful-request', now);
  let objects = 0;
  for (const row of await store.rows('SELECT sha256 FROM raw_objects WHERE account = ? AND erased_on IS NULL', [account])) objects += await dropObject(store, account, textOf(row, 'sha256'), 'lawful-request', now);
  const erased = { rows, objects };
  await audit(store, 'account', 'lawful-request', account, erased, now);
  return erased;
};
