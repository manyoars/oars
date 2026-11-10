// The operator's erasure. Three things can be erased from the pool and nothing else: a raw object, a deposit row that holds a leaked secret, and the content of one account named in a lawful request.
// This is a script the operator runs with their own `wrangler` login (`erase-cli.ts`), never a route: the Worker has no way to erase anything and holds no token for it.
// The ledger never deletes (migrations 0009 and 0011), so a row's content is replaced in place and the row, its counts, and its tier stay. Every step is written so a run that stops halfway runs again to the end: the
// tombstone goes first (so nothing can come back), then the content, then the audit row.
import { admittedNative, bucketOf, PACKAGE_REGISTRIES, parseSkeleton, type DeltaEntry, type SkeletonFrame, type SkeletonPrompt, type SkeletonStep, type SkeletonTool, type WireHarness } from '../../cli/src/sessions/pool-wire.js';
import { projectedAgentType, VOCAB_VERSION } from '../../cli/src/sessions/public-vocabulary.js';
import { ERROR_CODES } from '../../cli/src/sessions/schema.js';
import { recount, type Counting, type Kind } from '../src/cluster-store.js';
import { isListed } from '../src/field-classes.js';
import { depositDigest, digestOf, rawDigest } from '../src/tombstones.js';
import { eraseBatches, type TelemetryStore } from './erase-batches.js';

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
  /** One R2 object's bytes in pieces, read as a stream so a large object is never held whole; null when the object is not there. */
  readObject: (key: string) => Promise<AsyncIterable<Uint8Array> | null>;
  /** The telemetry bucket, where an account's batches are rewritten (`erase-batches.ts`). */
  telemetry: TelemetryStore;
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

/** The marker a deposit row holds in place of its skeleton. It parses as no skeleton, and the deposit tombstone refuses a resend of the session before `previousOf` reads it. */
const markerOf = (reason: ErasureReason): string => JSON.stringify({ erased: reason });

const OTHER = 'other';
const DAY_MS = 86_400_000;

/** SQL for a millisecond time cut to the Monday (UTC) of its ISO week: the epoch day 0 is a Thursday, so the days since Monday are (day + 3) % 7. A null stays null. */
const weekMs = (column: string): string => `(${column} / ${String(DAY_MS)} - (${column} / ${String(DAY_MS)} + 3) % 7) * ${String(DAY_MS)}`;

/** SQL for a `YYYY-MM-DD` text cut to the Monday of its week (`strftime('%w')` counts Sunday as 0). A null stays null. */
const weekDay = (column: string): string => `date(${column}, '-' || ((CAST(strftime('%w', ${column}) AS INTEGER) + 6) % 7) || ' days')`;

/** A name that is on the public list stays; any other becomes `other`, so the list (the same for everyone) is all that is kept of it. A null stays null. */
const listedOr = (field: string, value: string | null, context?: string): string | null => (value === null ? null : isListed(field, value, context) ? value : OTHER);
const listedText = (field: string, value: string, context?: string): string => listedOr(field, value, context) ?? OTHER;

/** The Monday (UTC) of the ISO week a UTC day falls in: a day on a kept row would pair with a sign-in or an upload of that day on a small pool, a week does not. */
export const weekOf = (day: string | null): string | null => {
  if (day === null) return null;
  const at = Date.parse(`${day}T00:00:00Z`);
  return new Date(at - ((new Date(at).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
};

/** An optional field: present in the result only when the source held it. */
const held = (key: string, value: unknown): object => (value === undefined ? {} : { [key]: value });

const frameOf = (frame: SkeletonFrame): object => ({
  harness: frame.harness,
  harnessVersion: listedOr('harnessVersion', frame.harnessVersion),
  model: listedOr('model', frame.model),
  effort: frame.effort,
  day: weekOf(frame.day),
  platform: frame.platform,
  shell: frame.shell,
  stack: { languages: frame.stack.languages, frameworks: frame.stack.frameworks, size: frame.stack.size, languageShares: frame.stack.languageShares.map(({ language, languageShare }) => ({ language, languageShare })) },
  // The parser holds a plugin as `other` alone (no list names one), so only the mcp servers and skills are looked up.
  ...held('reach', frame.reach === undefined ? undefined : { filled: frame.reach.filled, mcp: frame.reach.mcp.map((name) => listedText('mcp', name)), skills: frame.reach.skills.map((name) => listedText('skills', name)), plugins: frame.reach.plugins.map(() => OTHER) }),
  ...held('orgSize', frame.orgSize),
  ...held('team', frame.team),
  ...held('repoVisibility', frame.repoVisibility),
});

const identityOf = (identity: SkeletonStep['identity']): object | null => {
  if (identity === null) return null;
  if ('program' in identity) return { program: listedText('program', identity.program), sub: listedOr('sub', identity.sub, identity.program), flags: identity.flags.map((flag) => listedText('flags', flag)) };
  if ('server' in identity) return { server: listedText('server', identity.server), tool: listedText('tool', identity.tool, identity.server) };
  if ('skill' in identity) return { skill: listedText('skill', identity.skill) };
  return { host: null };
};

const stepOf = (harness: WireHarness) => (step: SkeletonStep): object => ({
  action: step.action,
  // A native name outside the harness's action table is a long-tail name (a private MCP or custom tool): only the table's rows, `private`, and `other` stay.
  native: step.native === OTHER || admittedNative(harness, step.native) ? step.native : OTHER,
  identity: identityOf(step.identity),
  status: step.status,
  tokens: step.tokens,
  ms: step.ms,
  remainingTokens: step.remainingTokens,
  // `isListed` has no agentType case, so the projection the reader applies is what closes it.
  agentType: step.agentType === null ? null : projectedAgentType(step.agentType) === step.agentType ? step.agentType : OTHER,
  parent: step.parent,
  frame: step.frame,
  ...held('edges', step.edges?.map(({ kind, target }) => ({ kind, target }))),
  ...held('allocated', step.allocated),
  ...held('skill', step.skill === undefined ? undefined : listedText('skill', step.skill)),
});

const toolOf = (harness: WireHarness) => (tool: SkeletonTool): object => ({
  side: tool.side,
  prompt: tool.prompt,
  status: tool.status,
  // The exact duration is what `timingPrint` hashes, so someone holding the session's timings could re-derive it: only its bucket stays.
  durationMs: tool.durationMs === null ? null : bucketOf('ms', tool.durationMs),
  errorCode: tool.errorCode === null ? null : ERROR_CODES.has(tool.errorCode) ? tool.errorCode : OTHER,
  ...held('recoveryCalls', tool.recoveryCalls === undefined ? undefined : { next: tool.recoveryCalls.next, editFollowed: tool.recoveryCalls.editFollowed }),
  ...held('keys', tool.keys?.map((key) => listedText('key', key))),
  ...held('keysDropped', tool.keysDropped),
  ...held('targetClass', tool.targetClass),
  ...held('argClass', tool.argClass),
  ...held('argFeatures', tool.argFeatures?.map(({ key, ...rest }) => ({ ...rest, key: listedText('key', key) }))),
  ...held('argValues', tool.argValues?.map(({ key, enumValue }) => ({ key: listedText('key', key), enumValue }))),
  ...held('changeKind', tool.changeKind),
  ...held('namesDropped', tool.namesDropped),
  ...held('templatesDropped', tool.templatesDropped),
  ...held('diffShape', tool.diffShape),
  steps: tool.steps.map(stepOf(harness)),
});

const promptOf = (prompt: SkeletonPrompt): object => ({
  cls: prompt.cls,
  errors: prompt.errors,
  wallSec: prompt.wallSec,
  usage: { input: prompt.usage.input, cacheWrite: prompt.usage.cacheWrite, cacheRead: prompt.usage.cacheRead, output: prompt.usage.output, thinking: prompt.usage.thinking },
  explore: prompt.explore,
  ...held('usageResponses', prompt.usageResponses),
  ...held('intervention', prompt.intervention),
  frame: frameOf(prompt.frame),
});

const deltaOf = (entry: DeltaEntry): object => ({
  deltaKind: entry.deltaKind,
  field: entry.field,
  name: listedOr('name', entry.name),
  registry: entry.registry === null ? null : PACKAGE_REGISTRIES.some((known) => known === entry.registry) ? entry.registry : OTHER,
  metric: entry.metric,
  change: entry.change,
});

/**
 * The anonymous shape of a stored Skeleton, or null when the text is no Skeleton the reader parses (the caller then keeps the marker alone). It is rebuilt field by field from what the parser read, never copied, so a field this
 * function does not name is gone: what stays is closed lists, buckets, and names on the public list (any other name becomes `other`), in the order sent (transcripts, prompts, calls, steps). Dropped: the session id, `repoKey`, every
 * hash of the person's own lines (`merkleRoot`, `timingPrint`, the edit `digests`, a recommendation's `id`), the free-text `names` and `templates`, the hour, a recommendation's `poolVersion` (the instant the pool answered), and the bag of fields the reader did not know.
 * A UTC day becomes the Monday of its week, and a tool's exact duration becomes its bucket.
 */
export const anonymizeSkeleton = (stored: unknown, reason: ErasureReason): { readonly [field: string]: unknown } | null => {
  const parsed = parseSkeleton(stored);
  if (!parsed.ok) return null;
  const { skeleton } = parsed;
  return {
    erased: reason,
    format: skeleton.format,
    vocabVersion: skeleton.vocabVersion === VOCAB_VERSION ? skeleton.vocabVersion : OTHER,
    fieldsVersion: skeleton.fieldsVersion,
    transcripts: skeleton.transcripts.map((transcript) => ({ harness: transcript.harness, frame: frameOf(transcript.frame), frames: transcript.frames.map(frameOf), spawnedIn: transcript.spawnedIn, prompts: transcript.prompts.map(promptOf), tools: transcript.tools.map(toolOf(transcript.harness)) })),
    deltas: skeleton.deltas.map(deltaOf),
    // A skeleton stored before migration 0025 may still hold `claimed`, and erasure must reach it.
    ...held('claimed', skeleton.claimed === undefined ? undefined : { hostClass: skeleton.claimed.hostClass, launcher: skeleton.claimed.launcher }),
    ...held('recommendations', skeleton.recommendations?.map(({ arm, from, to }) => ({ arm, from, to }))),
  };
};

const nameOf = (value: string, what: string): string => {
  if (!NAME.test(value)) throw new Error(`${what} is not a pool id: letters, digits, dot, dash, and underscore, 1 to 128`);
  return value;
};

const tombstone = async (store: EraseStore, kind: 'raw-object' | 'deposit' | 'value' | 'account', digest: string, reason: ErasureReason, now: Date): Promise<void> => {
  await store.run('INSERT OR IGNORE INTO erasure_tombstones (kind, digest, reason, erased_on) VALUES (?, ?, ?, ?)', [kind, digest, reason, dayOf(now)]);
};

const audit = async (store: EraseStore, kind: 'raw-object' | 'row' | 'account' | 'close' | 'restrict' | 'lift', reason: ErasureReason | 'account-close' | 'account-restrict' | 'account-lift', account: string, erased: Erased, now: Date): Promise<void> => {
  await store.run('INSERT INTO erasure_audit (kind, reason, erased_on, rows_erased, objects_erased, account) VALUES (?, ?, ?, ?, ?, ?)', [kind, reason, dayOf(now), erased.rows, erased.objects, account]);
};

/** The raw object at `account`/`sha256`: tombstoned, deleted from R2, and its ledger row marked. Answers whether a ledger row was marked. */
const dropObject = async (store: EraseStore, account: string, sha256: string, reason: ErasureReason, now: Date): Promise<number> => {
  const key = `raw/${account}/${sha256}`;
  await tombstone(store, 'raw-object', await rawDigest(key), reason, now);
  await store.deleteObject(key);
  return store.run('UPDATE raw_objects SET erased_on = ? WHERE account = ? AND sha256 = ? AND erased_on IS NULL', [dayOf(now), account, sha256]);
};

/**
 * The Skeleton an erased deposit holds: the marker alone for a leaked secret (that Deposit is not a 6.6(c) unlink, and a secret may sit anywhere in it), else the marker with the anonymous shape beside it (`anonymizeSkeleton`).
 * A row whose text is no Skeleton the reader parses keeps the marker alone. The `erased` field stays either way, so a resend is refused.
 */
const keptSkeleton = async (store: EraseStore, account: string, id: string, reason: ErasureReason): Promise<string> => {
  if (reason !== 'lawful-request') return markerOf(reason);
  const text = (await store.rows('SELECT skeleton FROM deposits WHERE account = ? AND id = ? AND erased_on IS NULL', [account, id])).map((row) => textOf(row, 'skeleton'))[0] ?? '';
  try {
    return JSON.stringify(anonymizeSkeleton(JSON.parse(text), reason) ?? { erased: reason });
  } catch {
    return markerOf(reason);
  }
};

/** The deposit row `account`/`id`: tombstoned, its content replaced by the marker (and, under a lawful request, the anonymous shape), its tier and counts left. Answers whether a row was changed. */
const dropDeposit = async (store: EraseStore, account: string, id: string, reason: ErasureReason, now: Date): Promise<number> => {
  await tombstone(store, 'deposit', await depositDigest(account, id), reason, now);
  return store.run("UPDATE deposits SET skeleton = ?, extensions = '[]', deltas = '[]', request_country = NULL, erased_on = ? WHERE account = ? AND id = ? AND erased_on IS NULL", [await keptSkeleton(store, account, id, reason), dayOf(now), account, id]);
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
const scan = async (store: EraseStore, table: string, columns: readonly string[], keys: readonly string[], visit: (row: unknown) => Promise<void>, also = '', alsoBinds: readonly string[] = []): Promise<void> => {
  let after: (string | number)[] = keys.map(() => '');
  for (;;) {
    const page = await store.rows(`SELECT ${columns.join(', ')} FROM ${table} WHERE ${also}(${keys.join(', ')}) > (${keys.map(() => '?').join(', ')}) ORDER BY ${keys.join(', ')} LIMIT ${String(PAGE)}`, [...alsoBinds, ...after]);
    for (const row of page) await visit(row);
    if (page.length < PAGE) return;
    after = keys.map((key) => {
      const last: unknown = page[page.length - 1];
      return typeof fieldOf(last, key) === 'number' ? numberOf(last, key) : textOf(last, key);
    });
  }
};

/** The columns of a cell that keep a name the pool stores in clear. */
const CELL_TEXT = ['key', 'harness_bucket', 'frame_bucket'];

/** Reads a table whole, a page at a time by `LIMIT` and `OFFSET`, and answers the rows `keep` accepts. Nothing is written while it reads, so the offsets hold, and no cursor is ever a value taken from a row. */
const readAll = async (store: EraseStore, table: string, columns: readonly string[], order: string, keep: (row: unknown) => boolean): Promise<unknown[]> => {
  const kept: unknown[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await store.rows(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY ${order} LIMIT ${String(PAGE)} OFFSET ${String(offset)}`, []);
    kept.push(...page.filter(keep));
    if (page.length < PAGE) return kept;
  }
};

/** A condition on `key` that holds the text around each occurrence of `value` and the key's length, and never the value: what names a row whose key holds the value without writing it into a statement. Positions count characters, as SQLite does. */
const aroundOf = (key: string, value: string): { sql: string; binds: (string | number)[] } => {
  const sql = ['length(key) = ?'];
  const binds: (string | number)[] = [Array.from(key).length];
  let at = 1;
  for (const [index, piece] of key.split(value).entries()) {
    if (index > 0) at += Array.from(value).length;
    const length = Array.from(piece).length;
    if (length > 0) {
      sql.push('substr(key, ?, ?) = ?');
      binds.push(at, length, piece);
    }
    at += length;
  }
  return { sql: sql.join(' AND '), binds };
};

/**
 * Erases a deposit row that holds a leaked secret: its content is replaced by a marker in place (no row is dropped), and its key is tombstoned. With the value, every other deposit row that holds it goes the same way, the
 * motifs, cells (key, harness bucket, and frame bucket, where a frame's `model` and `harnessVersion` are kept; the value becomes `[erased:<12 hex of its SHA-256>]`, so two values stay two keys), and contributor records that name it are scrubbed of it (their counts stand), the unfinished staged parts of every account that held it are dropped, and a tombstone of its
 * SHA-256 makes ingest refuse a deposit that carries it again. A raw object that holds it is erased by key.
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
    }, "erased_on IS NULL AND account NOT LIKE 'erased:%' AND ");
    let aggregates = 0;
    await scan(store, 'motifs', ['motif_id', 'motif'], ['motif_id'], async (row) => {
      const motif = textOf(row, 'motif');
      if (motif.includes(stored)) aggregates += await store.run('UPDATE motifs SET motif = ? WHERE motif_id = ?', [motif.replaceAll(stored, SCRUBBED), textOf(row, 'motif_id')]);
    });
    // A frame's `model` and `harnessVersion` are names the pool stores in clear: in the cell's key, harness bucket, and frame bucket, and in the contributor record that names the cell. Each table is read whole before any of it is written, and a row is
    // changed by its rowid or by the text around the value, so the value is on no wrangler command line. The marker carries the first 12 hex of the value's SHA-256, so two leaked values stay two keys.
    const marker = `[erased:${(await digestOf(value)).slice(0, 12)}]`;
    const scrubbed = (text: string): string => text.replaceAll(stored, marker);
    for (const row of await readAll(store, 'cells', ['rowid', 'key', 'harness_bucket', 'frame_bucket'], 'rowid', (one) => CELL_TEXT.some((column) => textOf(one, column).includes(stored)))) {
      aggregates += await store.run('UPDATE cells SET key = ?, harness_bucket = ?, frame_bucket = ? WHERE rowid = ?', [scrubbed(textOf(row, 'key')), scrubbed(textOf(row, 'harness_bucket')), scrubbed(textOf(row, 'frame_bucket')), numberOf(row, 'rowid')]);
    }
    for (const row of await readAll(store, 'contributors', ['kind', 'key', 'account', 'day'], 'kind, key, account, day', (one) => textOf(one, 'key').includes(stored))) {
      const key = textOf(row, 'key');
      const [kind, account, day] = [textOf(row, 'kind'), textOf(row, 'account'), textOf(row, 'day')];
      const around = aroundOf(key, stored);
      const shape = `kind = ? AND account = ? AND day = ? AND ${around.sql}`;
      const binds = [kind, account, day, ...around.binds];
      // The text around the value cannot tell apart two records that differ only in what stands where the value does (two leaked models of one length), and the statement may not hold the value to tell them: it names the record by its place in the order of that shape.
      const place = (await store.rows(`SELECT key FROM contributors WHERE ${shape} ORDER BY key`, binds)).findIndex((one) => textOf(one, 'key') === key);
      if (place < 0) throw new Error('a contributor record changed while it was read: run the erasure again');
      aggregates += await store.run(`UPDATE contributors SET key = ? WHERE kind = ? AND account = ? AND day = ? AND key = (SELECT key FROM contributors WHERE ${shape} ORDER BY key LIMIT 1 OFFSET ?)`, [scrubbed(key), kind, account, day, ...binds, place]);
    }
    rows += aggregates;
    // A scrub of a motif, cell, or contributor moves no count, so no trigger bumps the generation; a client holding the old ETag would be told its copy is current.
    if (aggregates > 0) await store.run('UPDATE pool_generation SET generation = generation + 1', []);
    // Staged parts are sealed with a key the command does not hold, so their text cannot be searched. The unfinished ones of every account that held the value are dropped whole; another account's wait for its own sweep.
    for (const holder of new Set(held.map((one) => one.account).concat(account))) rows += await store.run('DELETE FROM deposit_parts WHERE account = ? AND deposit IS NULL', [holder]);
  }
  for (const one of held) rows += await dropDeposit(store, one.account, one.id, 'leaked-secret', now);
  const erased = { rows, objects: 0 };
  await audit(store, 'row', 'leaked-secret', account, erased, now);
  return erased;
};

/** A random 128-bit id as 32 hex digits. It is drawn, never derived from an account, a machine, or a session, so no key and no input recomputes it. */
const randomId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** A random negative rowid, -(1 + a random below 2^52): a kept row moved here sits off the positive range, so the next live row still takes `max(rowid) + 1` and an erased row's place never dates it or orders it by `erasure_audit.id`. */
const randomRowid = (): number => {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
  return -(1 + (high % 2 ** 20) * 2 ** 32 + low);
};

/**
 * Unlinks the rows an erasure keeps that covenant 6.6(d) does not list (`machines` and `deposits`): they leave the account's pseudonym for one random id per erasure (`erased:` and 32 hex, with a minimal `accounts` row, since the foreign keys need one),
 * so they still join to each other (the counts) and to no one. A machine and a deposit also take a random id each, the machine's fingerprint is blanked and its key revoked and replaced by a random hash (an export and the person's own client hold the old exact values), a deposit's `ingest` mark is replaced, every time is cut to the Monday (UTC) of its ISO week (a machine's expiry too, since it is a fixed span from a time that was), and
 * `erased_on` is cleared on the deposits, because a date there would pick out the audit row of that day: a reader that needs "erased" reads the `erased:` prefix. The `accounts` row and each deposit take a random negative rowid for the same reason (a deposit would otherwise keep its place among live ones, which pins its time). `accounts.provider_created`, GitHub's public creation time, is cleared.
 * Raw objects stay on the pseudonym, their date cut to the day: they are 6.6(d)'s hash, size, and date, and their tombstone (the unkeyed hash of the key `raw/<account>/<sha256>`) would give the account back from any row that kept the hash.
 * Rows are found by the account, so a rerun finds none and changes nothing; a run that stops between two statements leaves the rest for a rerun under a second id, which splits the join and links nothing. The random id is written nowhere else, least of all beside the pseudonym.
 */
const unlink = async (store: EraseStore, account: string): Promise<void> => {
  await store.run('UPDATE accounts SET provider_created = NULL WHERE id = ? AND provider_created IS NOT NULL', [account]);
  await store.run('UPDATE raw_objects SET stored_at = stored_at - stored_at % ? WHERE account = ? AND stored_at % ? <> 0', [DAY_MS, account, DAY_MS]);
  const machines = new Set([...(await store.rows('SELECT id AS machine FROM machines WHERE account = ?', [account])), ...(await store.rows('SELECT DISTINCT machine FROM deposits WHERE account = ? AND machine IS NOT NULL', [account]))].map((row) => textOf(row, 'machine')));
  const deposits = (await store.rows('SELECT id FROM deposits WHERE account = ?', [account])).map((row) => textOf(row, 'id'));
  if (machines.size === 0 && deposits.length === 0) return;
  const erased = `erased:${randomId()}`;
  await store.run('INSERT INTO accounts (rowid, id, source) SELECT ?, ?, source FROM accounts WHERE id = ?', [randomRowid(), erased, account]);
  for (const machine of machines) {
    const renamed = randomId();
    await store.run('UPDATE deposits SET machine = ? WHERE account = ? AND machine = ?', [renamed, account, machine]);
    await store.run(`UPDATE machines SET id = ?, account = ?, fingerprint_hash = NULL, state = 'revoked', key_hash = ?, retired_hash = NULL, created_at = ${weekMs('created_at')}, activated_at = ${weekMs('activated_at')}, rotated_at = ${weekMs('rotated_at')}, expires_at = ${weekMs('expires_at')}, last_deposit_day = ${weekDay('last_deposit_day')} WHERE id = ? AND account = ?`, [renamed, erased, randomId() + randomId(), machine, account]);
  }
  for (const deposit of deposits) await store.run(`UPDATE deposits SET rowid = ?, id = ?, account = ?, ingest = ?, erased_on = NULL, counted_at = ${weekMs('counted_at')} WHERE account = ? AND id = ?`, [randomRowid(), randomId(), erased, randomId(), account, deposit]);
};

/**
 * Erases one account's content under a lawful request (GDPR Articles 17(1) and 17(3)(e)): every deposit row it holds is replaced by the marker and tombstoned, every raw object it holds is deleted and tombstoned, its staged parts are dropped, the label and allow list of its
 * machines are scrubbed, its repo keys and deposit hours are deleted, its tokens stop working and hold no credential, and the account id leaves its telemetry days and its contributor records. Every telemetry batch within retention that names it is rewritten with the rollup's placeholder and a fresh install id (`erase-batches.ts`). A telemetry day keeps its counts (the account column holds a placeholder that names no account, one per row, so
 * two erased accounts of one install never collide), and a token row keeps that a sign-in happened (its expiry). The generation moves, before the links go, when the account held any repo key, deposit hour, or contributor record, so a client fetches the bundle again.
 * Then the rows that stay but are not 6.6(d)'s (`machines`, `deposits`) leave the pseudonym for a random id (`unlink`); `rows` counts erased content and not those rewrites.
 * What stays: the totals (`cells`, `strata`, and the clusters held in them: a recount drops the account the next time a deposit touches the cell), `covenant_acceptances` (append-only, and the pool's proof that the covenant was accepted, Article 17(3)(e)), the tombstones, the audit, and the hash, size, and date of every raw object.
 * The `account` tombstone goes first: it is what lets the database delete the contributor records (migration 0027), and a run that stops halfway runs again to the end.
 */
export const eraseAccount = async (store: EraseStore, accountId: string, now: Date): Promise<Erased> => {
  const account = nameOf(accountId, 'the account');
  await tombstone(store, 'account', account, 'lawful-request', now);
  let rows = await store.run('DELETE FROM deposit_parts WHERE account = ?', [account]);
  // A machine's label and allow list are free text and repository names the account typed: they are scrubbed in place, and the row stays because its hashes are what refuse the key. The guard keeps a rerun at zero rows, as every other step does.
  rows += await store.run("UPDATE machines SET label = '[erased]', allow_repos = '[]' WHERE account = ? AND (label <> '[erased]' OR allow_repos <> '[]')", [account]);
  // A token's hash is the credential and its primary key: it becomes `erased:<rowid>`, which no token hashes to, and the row keeps its expiry and its account, so that a sign-in happened is still on record.
  rows += await store.run("UPDATE tokens SET hash = 'erased:' || rowid WHERE account = ? AND hash NOT LIKE 'erased:%'", [account]);
  // The rollup keys a day by install and account, so the account column cannot be emptied for two rows of one install and day: each takes its own placeholder, and the counts it holds stand.
  rows += await store.run("UPDATE telemetry_install_days SET account = 'erased:' || rowid WHERE account = ?", [account]);
  // Nothing in a served count changes, so no trigger moves the generation; a client holding the bundle built with the account would be told its copy is current. The generation moves before the links go, while they still show there is something to move it for: a run that stops between the two
  // moves it again on the rerun (a bump too many), where one moved after the deletes would never move on a rerun that finds the links gone.
  const held = numberOf((await store.rows('SELECT (SELECT COUNT(*) FROM account_repo_keys WHERE account = ?) + (SELECT COUNT(*) FROM deposit_hours WHERE account = ?) + (SELECT COUNT(*) FROM contributors WHERE account = ?) AS held', [account, account, account]))[0], 'held');
  if (held > 0) await store.run('UPDATE pool_generation SET generation = generation + 1', []);
  rows += (await store.run('DELETE FROM account_repo_keys WHERE account = ?', [account])) + (await store.run('DELETE FROM deposit_hours WHERE account = ?', [account])) + (await store.run('DELETE FROM contributors WHERE account = ?', [account]));
  // The board counts (migration 0036) are the account's own: its weekly counts, the nickname it typed in each club, and the standing granted to it by hand go. Its consent rows stay beside `covenant_acceptances`: append-only, a text hash and a time, with no nickname.
  rows += (await store.run('DELETE FROM account_weeks WHERE account = ?', [account])) + (await store.run('DELETE FROM club_members WHERE account = ?', [account])) + (await store.run('DELETE FROM board_standing WHERE account = ?', [account]));
  for (const row of await store.rows('SELECT id FROM deposits WHERE account = ? AND erased_on IS NULL', [account])) rows += await dropDeposit(store, account, textOf(row, 'id'), 'lawful-request', now);
  let objects = 0;
  for (const row of await store.rows('SELECT sha256 FROM raw_objects WHERE account = ? AND erased_on IS NULL', [account])) objects += await dropObject(store, account, textOf(row, 'sha256'), 'lawful-request', now);
  // The batches the Worker kept in R2 before it stopped reading the account (t956) still name it: they are rewritten last, so a stop anywhere above leaves them for the rerun, and a rerun finds none. They count with the objects.
  objects += await eraseBatches(store, account, now);
  await unlink(store, account);
  const erased = { rows, objects };
  await audit(store, 'account', 'lawful-request', account, erased, now);
  return erased;
};

/**
 * Closes one account (covenant 6.1 and 7.2(a)): the time it closed is recorded, every token it holds stops working (the rows go), and every machine key moves to `revoked`. Sign-in, enrollment, and activation refuse it from then on (`account_closed`).
 * Nothing is erased: its Deposits, raw objects, and the shared totals stay, and erasure is a separate request (`eraseAccount`). The first closed-at time stands, so a rerun changes nothing and writes no audit row; a run that stopped after the record finishes the revocations on the rerun.
 * The record goes first, so no sign-in can mint a credential between the steps. An account the pool has never seen is an error, since closing a mistyped id would otherwise look like success.
 */
export const closeAccount = async (store: EraseStore, accountId: string, now: Date): Promise<Erased> => {
  const account = nameOf(accountId, 'the account');
  if ((await store.rows('SELECT 1 AS found FROM accounts WHERE id = ?', [account])).length === 0) throw new Error(`No account ${account} in the pool.`);
  let rows = await store.run('UPDATE accounts SET closed_at = ? WHERE id = ? AND closed_at IS NULL', [now.getTime(), account]);
  // An erased account's tokens already hold no credential (`erased:<rowid>`) and stay as the record that a sign-in happened.
  rows += await store.run("DELETE FROM tokens WHERE account = ? AND hash NOT LIKE 'erased:%'", [account]);
  rows += await store.run("UPDATE machines SET state = 'revoked' WHERE account = ? AND state <> 'revoked'", [account]);
  const closed = { rows, objects: 0 };
  if (rows > 0) await audit(store, 'close', 'account-close', account, closed, now);
  return closed;
};

const KINDS: readonly Kind[] = ['cell', 'stratum'];
/** A recount's chunk, small because `wrangler d1 execute` takes the values inside a command line, not as bindings. */
const RECOUNT_CHUNK_BYTES = 8 * 1024;

/** The store as the recount reads it: the same statements the Worker runs, through the operator's own connection. */
const countingOf = (store: EraseStore): Counting => ({
  DB: {
    prepare: (sql) => ({
      bind: (...values) => ({
        all: async () => ({ results: await store.rows(sql, values) }),
        run: async () => ({ meta: { changes: await store.run(sql, values) } }),
      }),
    }),
  },
});

/**
 * Restricts one account at the person's request (GDPR Art. 18), or lifts the restriction: it sets `accounts.restricted_at` or clears it. While it is set a deposit, a raw request, a machine enrollment, and a club create or join refuse the account 403 `account_restricted`, its rows leave every club board and the open board, a telemetry batch that names it rolls into no row, and its
 * contributor records count toward no cell's holder count: the same run recounts every cell and stratum the account contributes to, so a cell only it holds (or that falls under its floor without it) stops serving at once, and a lift recounts the same ones with it counted again. A shared cell still above its floor keeps its totals, which relate to no identifiable person (Art. 4(1)), so no recompute is built. Nothing is erased and no credential is revoked, so its export, an erasure, the withdrawal sweep, and the retention sweeps still run, and a lift restores the account whole.
 * The first restricted-at time stands, so a rerun changes no account row and writes no audit row (it recounts again, which writes the same numbers and finishes a run that stopped between the two steps); a lift of an account that is not restricted is the same. An account the pool has never seen is an error, since a mistyped id would otherwise look like success.
 */
export const restrictAccount = async (store: EraseStore, accountId: string, lift: boolean, now: Date): Promise<Erased> => {
  const account = nameOf(accountId, 'the account');
  if ((await store.rows('SELECT 1 AS found FROM accounts WHERE id = ?', [account])).length === 0) throw new Error(`No account ${account} in the pool.`);
  const rows = lift ? await store.run('UPDATE accounts SET restricted_at = NULL WHERE id = ? AND restricted_at IS NOT NULL', [account]) : await store.run('UPDATE accounts SET restricted_at = ? WHERE id = ? AND restricted_at IS NULL', [now.getTime(), account]);
  const changed = { rows, objects: 0 };
  // The cells are read from the account's own contributor rows, not through the restricted-aware read, which would answer none once the account is restricted.
  for (const kind of KINDS) {
    const held = await store.rows('SELECT DISTINCT key FROM contributors WHERE kind = ? AND account = ?', [kind, account]);
    await recount(countingOf(store), kind, held.map((row) => textOf(row, 'key')), now.getTime(), RECOUNT_CHUNK_BYTES);
  }
  if (rows > 0) await audit(store, lift ? 'lift' : 'restrict', lift ? 'account-lift' : 'account-restrict', account, changed, now);
  return changed;
};

/** A raw object that holds the text the find looked for: its R2 key, its account, and its size as the ledger recorded it. Nothing of what the object says. */
export interface RawHit {
  key: string;
  account: string;
  bytes: number;
}

/** What a find read: the objects it opened, how many held the text, and how many ledger rows named an object R2 no longer holds. */
export interface RawFind {
  read: number;
  matched: number;
  missing: number;
}

/**
 * Whether the stream holds any of the texts, found as bytes. Only the last (longest text - 1) bytes of what was read are kept between pieces, so a match across a read boundary is found and memory holds one piece and that tail,
 * however large the object. It stops reading at the first match. UTF-8 is self-synchronizing, so a byte match of a valid text is a match of the text.
 */
export const holdsValue = async (pieces: AsyncIterable<Uint8Array>, texts: readonly Buffer[]): Promise<boolean> => {
  const keep = Math.max(...texts.map((text) => text.length)) - 1;
  let tail = Buffer.alloc(0);
  for await (const piece of pieces) {
    const window = Buffer.concat([tail, piece]);
    if (texts.some((text) => window.includes(text))) return true;
    tail = Buffer.from(window.subarray(Math.max(0, window.length - keep)));
  }
  return false;
};

/**
 * Finds the raw objects that hold `value`, for a request from a person a deposit names (GDPR Article 17: a third party does not know whose deposit it is, so `allAccounts` looks in every account). It reads each object the ledger holds
 * and has not marked erased, one at a time and a piece at a time, and calls `found` for each object that holds the value, as it is found. It changes nothing: it runs SELECTs and object reads and no other call, and it reports keys, accounts,
 * and sizes, never the value or a byte an object holds. The keys it reports go to `eraseRawObject`. The match is an exact substring of the bytes, in the text as given and in the form a JSON transcript writes it (the value scrub's own form).
 */
export const findRawContaining = async (store: EraseStore, selector: { account?: string; allAccounts?: boolean }, value: string, found: (hit: RawHit) => void): Promise<RawFind> => {
  if ((selector.account === undefined) === (selector.allAccounts !== true)) throw new Error('name exactly one of an account and every account');
  const account = selector.account === undefined ? undefined : nameOf(selector.account, 'the account');
  if (value.length < MIN_VALUE_LENGTH) throw new Error(`a text to find is at least ${String(MIN_VALUE_LENGTH)} characters, or it would match objects that do not name anyone`);
  const texts = [...new Set([value, JSON.stringify(value).slice(1, -1)])].map((text) => Buffer.from(text, 'utf8'));
  const total = { read: 0, matched: 0, missing: 0 };
  await scan(store, 'raw_objects', ['account', 'sha256', 'bytes'], ['account', 'sha256'], async (row) => {
    const hit: RawHit = { key: `raw/${textOf(row, 'account')}/${textOf(row, 'sha256')}`, account: textOf(row, 'account'), bytes: numberOf(row, 'bytes') };
    const pieces = await store.readObject(hit.key);
    if (pieces === null) {
      total.missing += 1;
      return;
    }
    total.read += 1;
    if (await holdsValue(pieces, texts)) {
      total.matched += 1;
      found(hit);
    }
  }, account === undefined ? 'erased_on IS NULL AND ' : 'erased_on IS NULL AND account = ? AND ', account === undefined ? [] : [account]);
  return total;
};
