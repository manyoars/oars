// The operator's pull of third-party deposits (docs/pool-deposit-title.md, section 5, brief 1). It copies the deposits the pool may sell, with each account's proved covenant acceptances and each deposit's `counted_at`, out of the pool store into a local folder, so a later build runs offline.
// It reads and writes nothing in the pool: it takes only `rows` and `readObject` of the erasure store, and every statement it sends is a SELECT. The rules the page assigns to the build (tier none, protected region, exclusion terms, harness terms, redaction, objections) are not applied here; the pulled row carries the tier and country the build needs.
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { sha256Of } from '../src/covenant.js';
import { COVENANT_FULL_TEXTS, COVENANT_TEXTS } from '../src/covenant-texts.js';
import { objectKey } from '../src/raw.js';
import { nameOf, type EraseStore } from './erase.js';
import type { ExportFolder } from './export-account.js';
import { wranglerStore, type ObjectFiles, type Target, type Wrangler } from './erase-wrangler.js';

export { nodeFiles, nodeFolder } from './erase-files.js';

/** The only two calls of the store the pull makes. */
export type ReadOnlyStore = Pick<EraseStore, 'rows' | 'readObject'>;

/** What one pull wrote, and what it left out and why. */
export interface Pulled {
  accounts: number;
  deposits: number;
  rawCopies: number;
  /** Raw Copies the ledger lists and the bucket does not hold, or that do not hash to their name; they are not written. */
  failed: string[];
  /** Accounts left out whole: an `erased:` account, restricted, no raw yes in force, or no proved acceptance. */
  leftOut: { erased: number; restricted: number; noRawYes: number; noProvedAcceptance: number };
}

const ERASED = 'erased:';

const SHA256 = /^[0-9a-f]{64}$/;

const fieldOf = (row: unknown, key: string): unknown => (typeof row === 'object' && row !== null ? Reflect.get(row, key) : undefined);

const textOf = (row: unknown, key: string): string => {
  const found = fieldOf(row, key);
  if (typeof found !== 'string') throw new Error(`no text at ${key} in a row`);
  return found;
};

const numberOrNull = (row: unknown, key: string): number | null => {
  const found = fieldOf(row, key);
  return typeof found === 'number' ? found : null;
};

const textOrNull = (row: unknown, key: string): string | null => {
  const found = fieldOf(row, key);
  return typeof found === 'string' ? found : null;
};

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** Rows a read takes at a time, as `erase` reads: a table of any size is never one result. */
const PAGE = 25;

const ACCOUNTS = `SELECT id, restricted_at, raw_consent_version FROM accounts WHERE id > ? ORDER BY id LIMIT ${String(PAGE)}`;

/** Every acceptance with a text hash and an input; the hash is checked against the held screen in code, since SQL cannot hold the screen. */
const ACCEPTANCES = 'SELECT version, text_sha256, accepted_at FROM covenant_acceptances WHERE account = ? AND text_sha256 IS NOT NULL AND input IS NOT NULL ORDER BY accepted_at, version';

const DEPOSITS = `SELECT id, tier, counted_at, request_country, skeleton FROM deposits WHERE account = ? AND erased_on IS NULL AND id > ? ORDER BY id LIMIT ${String(PAGE)}`;

const RAW_COPIES = 'SELECT sha256 FROM raw_objects WHERE account = ? AND erased_on IS NULL ORDER BY sha256';

/** Every row of a query that ends in `id > ?`, a page at a time in `id` order, after the leading binds; the cursor is read from the last row and bound, never written into the statement. */
const paged = async function* (store: ReadOnlyStore, sql: string, leading: readonly string[]): AsyncGenerator<unknown> {
  let after = '';
  for (;;) {
    const page = await store.rows(sql, [...leading, after]);
    yield* page;
    if (page.length < PAGE) return;
    after = textOf(page[page.length - 1], 'id');
  }
};

interface Proved {
  version: string;
  text_sha256: string;
  accepted_at: number;
}

/** A proved acceptance: a version the pool holds the full text of, whose hash is the hash of the screen held for that version. */
const proved = (row: unknown): Proved | null => {
  const version = textOrNull(row, 'version');
  const hash = textOrNull(row, 'text_sha256');
  const at = numberOrNull(row, 'accepted_at');
  const screen = version === null ? undefined : COVENANT_TEXTS.get(version);
  if (version === null || hash === null || at === null || screen === undefined || !COVENANT_FULL_TEXTS.has(version) || hash !== sha256Of(screen)) return null;
  return { version, text_sha256: hash, accepted_at: at };
};

/** Pulls every eligible account into the folder: `accounts.jsonl`, then per account `<account>/deposits.jsonl` and `<account>/projects/deposit/<sha256>.jsonl` for each Raw Copy not erased. */
export const pullDeposits = async (store: ReadOnlyStore, folder: ExportFolder): Promise<Pulled> => {
  const pulled: Pulled = { accounts: 0, deposits: 0, rawCopies: 0, failed: [], leftOut: { erased: 0, restricted: 0, noRawYes: 0, noProvedAcceptance: 0 } };
  let accountsFile = '';
  for await (const row of paged(store, ACCOUNTS, [])) {
    const id = textOf(row, 'id');
    // `erase account` moves what it keeps onto an `erased:<hex>` account, which is no pool id and nobody's to sell.
    if (id.startsWith(ERASED)) {
      pulled.leftOut.erased += 1;
      continue;
    }
    const account = nameOf(id, 'the account');
    // Fail closed: any value set in either column leaves the account out, whatever type the driver returns.
    if (fieldOf(row, 'restricted_at') !== null && fieldOf(row, 'restricted_at') !== undefined) {
      pulled.leftOut.restricted += 1;
      continue;
    }
    if (fieldOf(row, 'raw_consent_version') === null || fieldOf(row, 'raw_consent_version') === undefined) {
      pulled.leftOut.noRawYes += 1;
      continue;
    }
    const acceptances = (await store.rows(ACCEPTANCES, [account])).map(proved).filter((found): found is Proved => found !== null);
    if (acceptances.length === 0) {
      pulled.leftOut.noProvedAcceptance += 1;
      continue;
    }
    pulled.accounts += 1;
    accountsFile += line({ account, acceptances });
    let depositsFile = '';
    for await (const deposit of paged(store, DEPOSITS, [account])) {
      pulled.deposits += 1;
      depositsFile += line({ id: textOf(deposit, 'id'), tier: textOf(deposit, 'tier'), counted_at: numberOrNull(deposit, 'counted_at'), request_country: textOrNull(deposit, 'request_country'), skeleton: textOf(deposit, 'skeleton') });
    }
    await folder.write(`${account}/deposits.jsonl`, depositsFile);
    for (const copy of await store.rows(RAW_COPIES, [account])) {
      const hash = textOf(copy, 'sha256');
      if (!SHA256.test(hash)) {
        pulled.failed.push(`${hash} is not a SHA-256`);
        continue;
      }
      const pieces = await store.readObject(objectKey(account, hash));
      if (pieces === null) {
        pulled.failed.push(`${hash} of ${account} is not in the bucket`);
        continue;
      }
      const name = `${account}/projects/deposit/${hash}.jsonl`;
      const digest = createHash('sha256');
      await folder.write(
        name,
        (async function* hashed() {
          for await (const piece of pieces) {
            digest.update(piece);
            yield piece;
          }
        })(),
      );
      if (digest.digest('hex') === hash) pulled.rawCopies += 1;
      else {
        await folder.remove(name);
        pulled.failed.push(`${hash} of ${account} does not hash to its name`);
      }
    }
  }
  await folder.write('accounts.jsonl', accountsFile);
  return pulled;
};

/** Whether the folder, or any folder above it, holds a `.git`: a pull holds other people's transcripts and must never sit where `git add` can reach it. */
export const insideRepository = async (path: string): Promise<boolean> => {
  for (let at = resolve(path); ; at = dirname(at)) {
    if (await access(join(at, '.git')).then(() => true, () => false)) return true;
    if (dirname(at) === at) return false;
  }
};

export const USAGE = [
  'Usage: pull-deposits --out <folder> [--local]',
  '  Copies the eligible third-party deposits out of the pool into a new, empty folder outside every repository: accounts.jsonl, and per account deposits.jsonl and projects/deposit/<sha256>.jsonl.',
  "  It reads the pool and changes nothing. --local reads the local wrangler state instead of the account's.",
].join('\n');

export interface Io {
  print: (text: string) => void;
  wrangler: Wrangler;
  files: ObjectFiles;
  folder: (path: string) => ExportFolder;
  /** Whether the path is inside a git repository. */
  inRepository: (path: string) => Promise<boolean>;
}

const TARGET = { database: 'oars-pool', bucket: 'oars-pool-raw', telemetryBucket: 'oars-telemetry' } as const;

/** Runs the command; answers the exit code. */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  let out: string | undefined;
  let local = false;
  for (let at = 0; at < argv.length; at += 1) {
    const next = argv[at + 1];
    if (argv[at] === '--local') local = true;
    else if (argv[at] === '--out' && next !== undefined && !next.startsWith('--')) {
      out = next;
      at += 1;
    } else {
      io.print(USAGE);
      return 2;
    }
  }
  if (out === undefined) {
    io.print(USAGE);
    return 2;
  }
  if (await io.inRepository(out)) {
    io.print(`${out} is inside a git repository. Use a folder outside every repository: the pull holds other people's transcripts.`);
    return 1;
  }
  const target: Target = { ...TARGET, local };
  try {
    const pulled = await pullDeposits(wranglerStore(io.wrangler, target, io.files), io.folder(out));
    for (const failure of pulled.failed) io.print(`Not saved: raw copy ${failure}.`);
    io.print(JSON.stringify(pulled));
    return pulled.failed.length > 0 ? 1 : 0;
  } catch (error) {
    io.print(error instanceof Error ? error.message : 'the pull failed');
    return 1;
  }
};
