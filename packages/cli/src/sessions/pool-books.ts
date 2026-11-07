// `oars sessions books`, the pool's side: the set of four (the pool design notes, set of four) from the last fetched bundle. The bundle is the replica a fetch kept, checked again against the key pinned at login, so a
// file edited on disk prints nothing. A field with no source says so and is never printed as zero.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadSignIns } from './pool-command.js';
import { isHarness, verifyBundle, type Books, type Bundle, type Sourced } from './pool-wire.js';
import { contentHash } from './read.js';

interface Candidate {
  file: string;
  server: string;
  harness: string;
  version: string;
  modified: number;
}

const names = async (folder: string): Promise<string[]> => readdir(folder).catch(() => []);

const candidatesOf = async (storeDir: string): Promise<Candidate[]> => {
  const root = join(storeDir, 'pool-replica');
  const found: Candidate[] = [];
  for (const server of await names(root)) {
    for (const harness of await names(join(root, server))) {
      for (const name of await names(join(root, server, harness))) {
        if (!name.endsWith('.json')) continue;
        const file = join(root, server, harness, name);
        found.push({ file, server, harness, version: decodeURIComponent(name.slice(0, -'.json'.length)), modified: (await stat(file)).mtimeMs });
      }
    }
  }
  return found.sort((a, b) => b.modified - a.modified);
};

/** The newest kept bundle that still verifies against the key pinned for its server; undefined when none was fetched or none verifies. */
export const lastFetchedBundle = async (storeDir: string): Promise<Bundle | undefined> => {
  const keys = await loadSignIns(storeDir, 'books').catch(() => []);
  for (const { file, server, harness, version } of await candidatesOf(storeDir)) {
    const key = keys.find((entry) => contentHash(entry.server) === server)?.signingKey;
    if (key === undefined || !isHarness(harness)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const verified = await verifyBundle(parsed, key, harness, version);
    if (verified.ok) return verified.bundle;
  }
  return undefined;
};

const shown = (field: Sourced, unit: string): string => (field.state === 'value' ? `${String(field.value)}${unit}` : `no source yet (${field.reason})`);

const linesOf = (books: Books): string[] => [
  `served cells ${String(books.served.total)}, below floor ${String(books.backlog)}, as of ${books.asOf.day ?? 'no known day'}`,
  books.panel.state === 'value' ? `panel: ${String(books.panel.value)} accounts deposited in the last four weeks${books.panelDay === null ? '' : `, as of ${books.panelDay}`}` : `panel: ${shown(books.panel, '')}`,
  `demand: comparison-read owners ${shown(books.demand.comparisonReadOwners, '')}, follow-on reads ${shown(books.demand.followOnReads, '')}`,
  `goal metric: read yield ${shown(books.goal.readYield, '')}, cost per served cell ${shown(books.goal.costPerServedCell, '')}, yield per served cell ${shown(books.goal.yieldPerServedCell, '')}`,
];

/** The pool lines of `books`: the four, or one plain line when there is nothing to state them from. */
export const booksLines = (bundle: Bundle | undefined): string[] => {
  if (bundle === undefined) return ['no pool bundle yet'];
  return bundle.books === undefined ? ['the last fetched bundle carries no pool books; run oars pool fetch again'] : linesOf(bundle.books);
};
