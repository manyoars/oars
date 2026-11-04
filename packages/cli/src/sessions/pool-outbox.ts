// The outbox (`oars pool deposit` and `oars pool outbox`): every batch that may leave this machine is first written here, as canonical JSON lines, and `deposit` stops. Nothing in this file
// looks inside a batch except to name its top-level fields for `--explain`; what a batch holds is the projection's business.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VOCAB_VERSION } from './pool-wire.js';
import { contentHash } from './read.js';

/** Keys sorted at every depth, so two writers of one batch write the same bytes. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
};

/** The batch as one canonical JSON line: sorted keys, no optional whitespace, UTF-8 when written, and a newline at the end. These are the bytes that are hashed, printed, and sent. */
export const canonicalBytes = (batch: unknown): string => `${JSON.stringify(canonical(batch))}\n`;

export const batchHash = (bytes: string): string => createHash('sha256').update(Buffer.from(bytes, 'utf8')).digest('hex');

/**
 * The top-level fields a batch holds under this client. A batch is filed under this list and `VOCAB_VERSION`, so one built under an older list or vocabulary is never printed or sent (spec Section 1.4).
 * Every name here needs a row in `FIELD_ROWS`.
 */
export const BATCH_FIELDS: readonly string[] = ['format', 'id', 'transcripts'];

/** `--explain`: each top-level field of a batch and the rule that admits its values. A field with no row is a failure there, so a new field adds its row with the field. */
export const FIELD_ROWS: { readonly [field: string]: string } = {
  format: 'The skeleton format number: a constant of this client, never a value from a session.',
  id: 'A hash the client computes per account from the account and the session, so a redeposit replaces and two accounts\' sessions cannot be joined. Never the session\'s own id.',
  transcripts: 'The main transcript, then each subagent\'s: its frame, prompts, and tool steps, every value checked against the closed vocabulary before the batch is built (interim form, until the skeleton form replaces it).',
};

const fieldsStamp = (fields: readonly string[]): string => createHash('sha256').update(fields.join(',')).digest('hex').slice(0, 8);

/** The folder name of the batches this client builds now. A folder of any other name holds batches built under an older vocabulary or field list. */
export const currentStamp = (fields: readonly string[] = BATCH_FIELDS): string => `v${VOCAB_VERSION}-${fieldsStamp(fields)}`;

/** One server's outbox: batches are per server, since a printed batch carries that server's credential. */
export const outboxFolder = (storeDir: string, server: string): string => join(storeDir, 'pool-outbox', contentHash(server));

const BATCH_FILE = /^([0-9a-f]{16})\.([0-9a-f]{64})\.jsonl$/;

/** Writes one session's batch under the current stamp. A session has one batch: an older batch of it is removed, and an identical one is left as it is. */
export const writeBatch = async (outbox: string, key: string, batch: unknown, stamp: string = currentStamp()): Promise<{ hash: string; folder: string }> => {
  const bytes = canonicalBytes(batch);
  const hash = batchHash(bytes);
  const folder = join(outbox, stamp);
  await mkdir(folder, { recursive: true });
  for (const name of await readdir(folder)) {
    const found = BATCH_FILE.exec(name);
    if (found?.[1] === key && found[2] !== hash) await rm(join(folder, name), { force: true });
  }
  await writeFile(join(folder, `${key}.${hash}.jsonl`), bytes, 'utf8');
  return { hash, folder };
};

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** The names in a folder; a folder that does not exist yet holds none. */
const namesIn = async (folder: string): Promise<string[]> => {
  try {
    return (await readdir(folder)).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

/** The bytes of a batch file, when they still hash to the name the file was written under; undefined when the file is gone or was edited. */
export const unchangedBytes = async (file: string, hash: string): Promise<string | undefined> => {
  let bytes: string;
  try {
    bytes = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return batchHash(bytes) === hash ? bytes : undefined;
};

export interface Held {
  /** The session's key in the outbox (the batch's account-hashed id). */
  key: string;
  hash: string;
  file: string;
  bytes: string;
}

/** The batches built under this client's vocabulary and field list, and how many of their files no longer hash to their names. An edited file is not printed and cannot be sent: run `deposit` again to rebuild it. */
export const heldBatches = async (outbox: string, stamp: string = currentStamp()): Promise<{ batches: Held[]; edited: number }> => {
  const folder = join(outbox, stamp);
  const batches: Held[] = [];
  let edited = 0;
  for (const name of await namesIn(folder)) {
    const found = BATCH_FILE.exec(name);
    if (found === null) continue;
    const [, key = '', hash = ''] = found;
    const file = join(folder, name);
    const bytes = await unchangedBytes(file, hash);
    if (bytes === undefined) edited += 1;
    else batches.push({ key, hash, file, bytes });
  }
  return { batches, edited };
};

const shownFile = (outbox: string): string => join(outbox, 'shown.log');

/** Records that this hash was printed, one line to a hash: the lock below sends only what appears here. */
export const markShown = async (outbox: string, hash: string, at: number): Promise<void> => {
  await mkdir(outbox, { recursive: true });
  await appendFile(shownFile(outbox), `${hash} ${new Date(at).toISOString()}\n`, 'utf8');
};

const wasShown = async (outbox: string, hash: string): Promise<boolean> => {
  try {
    return (await readFile(shownFile(outbox), 'utf8')).split('\n').some((line) => line.split(' ')[0] === hash);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
};

export type LockRefusal = 'batch_unknown' | 'batch_not_shown' | 'batch_changed';

/** The lock on `deposit --send`: a batch goes only if it is in the outbox, its hash was printed, and its file still hashes to that hash. The first check that fails names why. */
export const lockedBatch = async (outbox: string, hash: string, stamp: string = currentStamp()): Promise<{ ok: true; file: string; bytes: string } | { ok: false; code: LockRefusal }> => {
  const folder = join(outbox, stamp);
  const name = (await namesIn(folder)).find((entry) => BATCH_FILE.exec(entry)?.[2] === hash);
  if (name === undefined) return { ok: false, code: 'batch_unknown' };
  if (!(await wasShown(outbox, hash))) return { ok: false, code: 'batch_not_shown' };
  const file = join(folder, name);
  const bytes = await unchangedBytes(file, hash);
  return bytes === undefined ? { ok: false, code: 'batch_changed' } : { ok: true, file, bytes };
};

/** Folders of an outbox other than the current stamp's: batches built under another vocabulary or field list. */
const staleFolders = async (outbox: string, stamp: string): Promise<string[]> => {
  const names: string[] = [];
  for (const name of await namesIn(outbox)) {
    if (name !== stamp && STAMP_FOLDER.test(name)) names.push(join(outbox, name));
  }
  return names;
};

const STAMP_FOLDER = /^v[^./]+-[0-9a-f]{8}$/;

const batchesIn = async (folder: string): Promise<number> => (await namesIn(folder)).filter((name) => BATCH_FILE.test(name)).length;

/** Batches in one server's outbox that were built under another vocabulary or field list: never printed, never sent. */
export const staleBatches = async (outbox: string, stamp: string = currentStamp()): Promise<number> => {
  let count = 0;
  for (const folder of await staleFolders(outbox, stamp)) count += await batchesIn(folder);
  return count;
};

/** Every server's stale batches, for `verify`. */
export const staleBatchesAnywhere = async (storeDir: string, stamp: string = currentStamp()): Promise<number> => {
  const root = join(storeDir, 'pool-outbox');
  let count = 0;
  for (const name of await namesIn(root)) count += await staleBatches(join(root, name), stamp);
  return count;
};

/** Removes one server's stale batches, and returns how many there were. */
export const discardStale = async (outbox: string, stamp: string = currentStamp()): Promise<number> => {
  const count = await staleBatches(outbox, stamp);
  for (const folder of await staleFolders(outbox, stamp)) await rm(folder, { recursive: true, force: true });
  return count;
};

/** The top-level field names of a batch. */
export const fieldsOf = (batchBytes: string): string[] => {
  const parsed: unknown = JSON.parse(batchBytes);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? Object.keys(parsed) : [];
};
