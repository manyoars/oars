// The operator's export (`erase export`, docs/pool-rights.md "Art. 15 and 20"): the pages `oars pool export` saves, built by the route's own page builder (`src/export.ts`) over the operator's D1 reads, and with `--raw` each raw object not erased.
// It reads and writes nothing in the pool. The account comes from the command, so the operator runs it only for a requester confirmed by a token proof.
import { createHash } from 'node:crypto';
import { buildExportPage } from '../src/export.js';
import { objectKey } from '../src/raw.js';
import { nameOf, type EraseStore } from './erase.js';

/** Where the export is written: a folder, by relative name. The command's own is on disk (`erase-files.ts`); the tests' is in memory. */
export interface ExportFolder {
  /** Writes one file; bytes come in pieces, so a raw object is never held whole. */
  write: (name: string, content: string | AsyncIterable<Uint8Array>) => Promise<void>;
  /** Removes the file; one that is not there is not an error. */
  remove: (name: string) => Promise<void>;
}

/** What one export wrote: pages, the raw objects saved, the ledger rows whose object was erased (not written, by design), and each object that should have been saved and was not. */
export interface Exported {
  pages: number;
  rawObjects: number;
  rawErased: number;
  failed: string[];
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The page's file, numbered from 1 in the order the pages are built, as `oars pool export` names it. */
const pageFile = (page: number): string => `account-export-${String(page).padStart(4, '0')}.json`;

const fieldOf = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

/** Saves one account's export to the folder: every page, and with `raw` each object the ledger lists that still stands, verified against its name. A missing or altered object is named in `failed` and does not stop the others. */
export const exportAccount = async (store: EraseStore, folder: ExportFolder, accountId: string, raw: boolean): Promise<Exported> => {
  const account = nameOf(accountId, 'the account');
  if ((await store.rows('SELECT 1 AS found FROM accounts WHERE id = ?', [account])).length === 0) throw new Error(`No account ${account} in the pool.`);
  const standing: string[] = [];
  let pages = 0;
  let rawErased = 0;
  let cursor: string | null = null;
  do {
    const built = await buildExportPage(account, null, cursor, (sql, binds) => store.rows(sql, binds));
    // The cursor is the builder's own last answer, so a refusal is the compiler's question, not a state a run reaches.
    if ('code' in built) throw new Error(built.message);
    pages += 1;
    await folder.write(pageFile(pages), `${JSON.stringify(built, null, 2)}\n`);
    for (const row of built.section === 'rawLedger' ? built.rows : []) {
      const hash = fieldOf(row, 'sha256');
      if (fieldOf(row, 'tombstone') !== null) rawErased += 1;
      else if (typeof hash === 'string' && SHA256.test(hash)) standing.push(hash);
    }
    cursor = built.next;
  } while (cursor !== null);

  const failed: string[] = [];
  let rawObjects = 0;
  for (const hash of raw ? standing : []) {
    const pieces = await store.readObject(objectKey(account, hash));
    if (pieces === null) {
      failed.push(`${hash} is not in the bucket`);
      continue;
    }
    const digest = createHash('sha256');
    await folder.write(
      `raw/${hash}`,
      (async function* hashed() {
        for await (const piece of pieces) {
          digest.update(piece);
          yield piece;
        }
      })(),
    );
    if (digest.digest('hex') === hash) rawObjects += 1;
    else {
      await folder.remove(`raw/${hash}`);
      failed.push(`${hash} does not hash to its name`);
    }
  }
  return { pages, rawObjects, rawErased, failed };
};
