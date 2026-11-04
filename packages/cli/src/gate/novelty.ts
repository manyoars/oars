// The kept index behind the hook's `novelty`: which names have been seen in the whole record, in a repository, and in a session. The hook reads it instead of scanning
// `crossings.jsonl`, which a long-lived record would make slow. It holds hashes only (a name, a repository, or a session id is never written here), one per line, and a
// line is only ever appended, so two hooks running at once cannot lose each other's update. A file that does not read cleanly is `damaged`: the row says `not-read`.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Novelty } from './record.js';

export const INDEX_HEADER = 'oars-gate-index 1';
export const indexFile = (storeDir: string): string => join(storeDir, 'gate-index.txt');

const LINE = /^[frs][0-9a-f]{12}$/;
const TORN = /^(?:[frs][0-9a-f]{0,11})?$/;

const digest = (...parts: string[]): string => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 12);

/** The entries of one crossing, as the lines the index keeps. `read` is the session's sight of the name that had a registry reading, which is what spends the session's one note. */
export interface Scopes {
  fleet: string;
  repository: string;
  session: string;
  read: string;
}

/** `key` is the class and name; the repository and session ids are as the caller knows them. */
export const scopesOf = (key: string, repository: string, session: string): Scopes => ({
  fleet: `f${digest(key)}`,
  repository: `r${digest(repository, key)}`,
  session: `s${digest(session, key)}`,
  read: `s${digest(session, key, 'read')}`,
});

/**
 * `ready`: read cleanly. `fresh`: no index and no record, so an empty one is right. `unseeded`: no index but a record exists, so what is new cannot be told without a
 * scan; `oars gate replay` seeds it. `damaged`: it did not read cleanly, and nothing is written to it.
 */
export type KeptIndex = { state: 'ready'; lines: ReadonlySet<string> } | { state: 'fresh' | 'unseeded' | 'damaged' };

const notFound = (error: unknown): boolean => error instanceof Error && Reflect.get(error, 'code') === 'ENOENT';

const hasRecord = (file: string): Promise<boolean> =>
  stat(file).then(
    (found) => found.size > 0,
    () => false,
  );

const parseIndex = (text: string): KeptIndex => {
  const parts = text.split('\n');
  // The last part is empty after a complete line; anything else there is a line that was being appended, and says nothing yet.
  parts.pop();
  if (parts[0] !== INDEX_HEADER) return { state: 'damaged' };
  const lines = new Set<string>();
  for (const [at, line] of parts.entries()) {
    if (line === INDEX_HEADER) continue;
    // A torn line that the next append closed with a line break: a cut-off hash, or an empty line when two appends raced on the same torn tail. Skipped, and only ever before a later line.
    if (at < parts.length - 1 && TORN.test(line)) continue;
    if (!LINE.test(line)) return { state: 'damaged' };
    lines.add(line);
  }
  return { state: 'ready', lines };
};

export const loadIndex = async (storeDir: string, record: string): Promise<KeptIndex> => {
  try {
    return parseIndex(await readFile(indexFile(storeDir), 'utf8'));
  } catch (error) {
    if (!notFound(error)) return { state: 'damaged' };
    return (await hasRecord(record)) ? { state: 'unseeded' } : { state: 'fresh' };
  }
};

export const noveltyOf = (index: KeptIndex, scopes: Scopes): { novelty: Novelty; add: string[]; noted: boolean } => {
  // With no readable index there is no telling whether the name was noted, and no line can be kept to say so: it counts as noted, so no note shows until a replay seeds the index. A block does not read `noted`.
  if (index.state === 'damaged' || index.state === 'unseeded') return { novelty: 'not-read', add: [], noted: true };
  const held: ReadonlySet<string> = index.state === 'ready' ? index.lines : new Set<string>();
  const add = [scopes.fleet, scopes.repository, scopes.session].filter((line) => !held.has(line));
  const noted = held.has(scopes.read);
  if (!held.has(scopes.fleet)) return { novelty: 'fleet', add, noted };
  if (!held.has(scopes.repository)) return { novelty: 'repository', add, noted };
  return { novelty: held.has(scopes.session) ? 'none' : 'session', add, noted };
};

/** True when the file's last byte is a line break, so an append starts a line of its own. The caller has read the header, so the file is not empty. */
const endsClean = async (file: string): Promise<boolean> => {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    await handle.close();
  }
};

/**
 * Appends the lines a crossing added. A `fresh` index starts with its header (a second header from a hook racing this one is skipped on read). A torn tail (a line cut off
 * before its line break) gets one first, so the append is its own lines and the torn one costs only itself.
 */
export const keepIndex = async (storeDir: string, index: KeptIndex, add: readonly string[]): Promise<void> => {
  if (add.length === 0 || (index.state !== 'ready' && index.state !== 'fresh')) return;
  await mkdir(storeDir, { recursive: true });
  const file = indexFile(storeDir);
  const lead = index.state === 'fresh' ? `${INDEX_HEADER}\n` : (await endsClean(file)) ? '' : '\n';
  await appendFile(file, `${lead}${add.join('\n')}\n`, { mode: 0o600 });
};

/** Writes the index from every line given plus the ones already kept, whole and atomic. Used by `replay`, which is not in a hurry. */
export const seedIndex = async (storeDir: string, record: string, lines: Iterable<string>): Promise<void> => {
  const kept = await loadIndex(storeDir, record);
  const all = new Set<string>(kept.state === 'ready' ? kept.lines : []);
  for (const line of lines) all.add(line);
  await mkdir(storeDir, { recursive: true });
  const file = indexFile(storeDir);
  const temp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(temp, `${[INDEX_HEADER, ...all].join('\n')}\n`, { mode: 0o600 });
  await rename(temp, file);
};
