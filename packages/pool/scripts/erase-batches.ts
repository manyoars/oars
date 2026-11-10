// The telemetry batches of an erased account (GDPR Article 17(1)). The Worker kept every batch whole in R2 for `RETENTION_DAYS`, and before t956 a batch carried the account that sent it (the rollup still reads that field), so
// an account erasure rewrites each batch within retention that names the account: the account id becomes the rollup's placeholder, and the install id the batch carries (Article 4(1), an online identifier) becomes one fresh random id per
// erasure, here and in the rollup's rows, so the daily install counts hold. Every other batch, and every other byte of a rewritten one, stays as it was. A batch past retention is left to the nightly sweep.
// No mapping from an old install id to a new one is kept anywhere. A rerun reads it back from what is left: a rewrite sits at a key derived from the old batch's key, so an old batch that still stands beside its rewrite says which id replaced its own.
import { RETENTION_DAYS } from '../src/retention.js';
import { dayOf, ERASED_ACCOUNT, shiftDay } from '../src/telemetry-rollup.js';
import { INSTALL } from '../src/telemetry.js';
import { digestOf } from '../src/tombstones.js';

/** The telemetry bucket as the operator reaches it: wrangler (`erase-wrangler.ts`) or a Miniflare binding (the tests). */
export interface TelemetryStore {
  /** Every key under the prefix, whatever the page size of the listing behind it. */
  list: (prefix: string) => Promise<readonly string[]>;
  /** One object's text; null when it is not there. */
  read: (key: string) => Promise<string | null>;
  /** Writes one object, replacing one at the same key. */
  write: (key: string, text: string) => Promise<void>;
  /** Deletes one object; one that is not there is not an error. */
  remove: (key: string) => Promise<void>;
}

/** What the batch step needs of the erase store: D1 for the tombstones and the rollup's rows, and the bucket. */
export interface BatchStore {
  run: (sql: string, binds: readonly (string | number | null)[]) => Promise<number>;
  telemetry: TelemetryStore;
}

/** A batch that names the erased account, as read from the bucket. */
export interface FoundBatch {
  key: string;
  /** The install id the batch carries, lowercased as the rollup keys it. */
  install: string;
  text: string;
}

const fieldOf = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

/** Where the rewrite of a batch is put: beside it, derived from its key, so a run that stopped between the rewrite and the delete finds the rewrite again and puts a second one nowhere. */
export const rewriteKeyOf = (key: string): string => key.replace(/\.json$/, '-erased.json');

const isRewrite = (key: string): boolean => key.endsWith('-erased.json');

/** The days a batch may still stand: the nightly sweep drops a day once it is `RETENTION_DAYS` old, and a day it has not reached yet is still there. */
const daysOf = (now: Date): string[] => {
  const today = dayOf(now.getTime());
  const days: string[] = [];
  for (let back = RETENTION_DAYS; back >= 0; back -= 1) days.push(shiftDay(today, -back));
  return days;
};

/** The batch in the text when it names `account` and carries an install id; each record is read for itself, and no index is trusted. */
const namingOf = (key: string, text: string, account: string): FoundBatch | undefined => {
  let held: unknown;
  try {
    held = JSON.parse(text);
  } catch {
    return undefined;
  }
  const install = fieldOf(fieldOf(held, 'batch'), 'install');
  if (fieldOf(held, 'account') !== account || typeof install !== 'string' || !INSTALL.test(install)) return undefined;
  return { key, install: install.toLowerCase(), text };
};

/** Every batch within retention whose own record names `account`. A rewrite is never one: it names the placeholder. */
export const findBatches = async (telemetry: TelemetryStore, account: string, now: Date): Promise<FoundBatch[]> => {
  const found: FoundBatch[] = [];
  for (const day of daysOf(now)) {
    for (const key of await telemetry.list(`telemetry/${day}/`)) {
      const text = isRewrite(key) ? null : await telemetry.read(key);
      const batch = text === null ? undefined : namingOf(key, text, account);
      if (batch !== undefined) found.push(batch);
    }
  }
  return found;
};

/** The batch's text with the account and the install replaced and nothing else touched: the same fields in the same order, so every other record is equal to the original. */
const rewrittenText = (text: string, install: string): string => {
  const held: unknown = JSON.parse(text);
  if (typeof held !== 'object' || held === null) throw new Error('a found batch is an object');
  const batch: unknown = Reflect.get(held, 'batch');
  if (typeof batch !== 'object' || batch === null) throw new Error('a found batch holds a batch');
  Reflect.set(held, 'account', ERASED_ACCOUNT);
  Reflect.set(batch, 'install', install);
  return JSON.stringify(held);
};

/** The install id a rewrite carries, or undefined when the text is not one. */
const installOfRewrite = (text: string): string | undefined => {
  const install = fieldOf(fieldOf(JSON.parse(text), 'batch'), 'install');
  return typeof install === 'string' ? install.toLowerCase() : undefined;
};

/**
 * Rewrites every batch within retention that names `account`, and answers how many it rewrote. The order is what makes a stop safe to rerun: the ids are settled first (an old batch whose rewrite already stands lends its id), every rewrite is written,
 * then the rollup's rows take the new ids, then the old batches are tombstoned and deleted. A run that finds no batch naming the account changes nothing.
 */
export const eraseBatches = async (store: BatchStore, account: string, now: Date, newId: () => string = () => crypto.randomUUID()): Promise<number> => {
  const found = await findBatches(store.telemetry, account, now);
  const ids = new Map<string, string>();
  for (const batch of found) {
    const rewrite = await store.telemetry.read(rewriteKeyOf(batch.key));
    const standing = rewrite === null ? undefined : installOfRewrite(rewrite);
    if (standing !== undefined && !ids.has(batch.install)) ids.set(batch.install, standing);
  }
  for (const batch of found) if (!ids.has(batch.install)) ids.set(batch.install, newId().toLowerCase());
  for (const batch of found) {
    if ((await store.telemetry.read(rewriteKeyOf(batch.key))) === null) await store.telemetry.write(rewriteKeyOf(batch.key), rewrittenText(batch.text, ids.get(batch.install) ?? ''));
  }
  // A row of this install that names an erased account takes the new id; a row of the same install that names no account is a record of a batch this step does not touch, and keeps the id its batches carry.
  for (const [old, fresh] of ids) await store.run("UPDATE telemetry_install_days SET install = ? WHERE install = ? AND account LIKE 'erased:%'", [fresh, old]);
  for (const batch of found) {
    await store.run('INSERT OR IGNORE INTO erasure_tombstones (kind, digest, reason, erased_on) VALUES (?, ?, ?, ?)', ['telemetry-batch', await digestOf(batch.key), 'lawful-request', dayOf(now.getTime())]);
    await store.telemetry.remove(batch.key);
  }
  return found.length;
};
