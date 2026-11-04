// The pending list (t832, register row A55): the sessions a Stop hook deposit could not take because another deposit held the store lock.
//
// One small file per deferral under `<store>/pending/`, named `<hash of the transcript path>.<uuid>.json` and holding `{"transcript": "<path>"}`:
// what a later deposit needs to find the transcript, and nothing else (no prompt text, no id, no project name beyond the path). One file per
// deferral, not one shared list, because the hook that defers must not take the store lock (it just failed to) and two hooks may defer at once:
// each writes a file name no one else uses. A drain removes only the file names it read, so a session that defers again while a drain runs leaves
// its newer file behind for the next deposit, and an append racing a drain is never lost. The drain dedupes by the hash, so a session that
// deferred twice is one entry. Each file is written to a temp name and renamed, so a drain never reads a torn one.
//
// A deposit that fails on an entry renames it `<hash>.<uuid>.f<n>.json`, so the number of failures is in the name and ordering the list needs
// no read of the file: entries with fewer failures come first, and an entry that always fails cannot fill the hook's cap for good.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * How many pending sessions one Stop hook deposit takes before its own. The cap bounds the COUNT, not the time: a hook that gets the lock late can
 * still deposit this many transcripts of any size, so the only time limit is the harness's own ceiling on the hook (30 s, install.ts), and a backlog
 * drains over several hooks (a whole-store deposit takes all).
 */
export const PENDING_HOOK_CAP = 5;

/** How many failed deposits a pending entry survives: at this many it is removed and counted as dropped, since a whole-store walk still reaches any transcript on the allowlist. */
export const PENDING_MAX_FAILURES = 5;

export const pendingDir = (storeDir: string): string => join(storeDir, 'pending');

export interface PendingEntry {
  /** The file names of this entry that were read (one per deferral of the same transcript); the files of an unreadable entry are not here. */
  names: string[];
  /** The transcript to deposit; undefined for a file that is not a pending entry (it is dropped) or one that could not be read. */
  transcript: string | undefined;
  /** True when no file of the entry could be read: it is kept and counted, never removed. */
  unreadable: boolean;
  /** Failed deposits so far, the highest over the entry's files. */
  failures: number;
}

const hashOf = (transcript: string): string => createHash('sha256').update(transcript).digest('hex').slice(0, 32);

/** The part of a file name before the first dot: the hash, which is what makes two deferrals one entry. */
const keyOf = (name: string): string => name.slice(0, name.indexOf('.'));

const FAILED = /\.f(\d+)\.json$/;

const failuresOf = (name: string): number => Number(FAILED.exec(name)?.[1] ?? 0);

/** Records `transcript` as pending without taking the store lock. The same session twice is two files and one entry. */
export const deferSession = async (storeDir: string, transcript: string): Promise<void> => {
  const dir = pendingDir(storeDir);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify({ transcript }), { mode: 0o600 });
  await rename(temp, join(dir, `${hashOf(transcript)}.${randomUUID()}.json`));
};

const transcriptOf = (text: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    const transcript: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'transcript') : undefined;
    return typeof transcript === 'string' && transcript !== '' ? transcript : undefined;
  } catch {
    return undefined;
  }
};

const entryOf = async (storeDir: string, names: readonly string[]): Promise<PendingEntry> => {
  const failures = Math.max(...names.map(failuresOf));
  const read: string[] = [];
  let transcript: string | undefined;
  for (const name of names) {
    try {
      const found = transcriptOf(await readFile(join(pendingDir(storeDir), name), 'utf8'));
      read.push(name);
      transcript ??= found;
    } catch {
      // A file that cannot be read stays where it is: it is not in `names`, so a drain never removes it.
    }
  }
  return { names: read, transcript, unreadable: read.length === 0, failures };
};

/**
 * The first `limit` pending entries, read: fewest failures first, then name order. A store with no pending folder has none, and a pending
 * folder that cannot be listed is an empty list with one line on stderr, so it never fails the deposit it was read for.
 */
export const listPending = async (storeDir: string, limit: number): Promise<PendingEntry[]> => {
  let names: string[];
  try {
    names = (await readdir(pendingDir(storeDir))).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    process.stderr.write(`oars: the pending list could not be read and is skipped: ${error instanceof Error ? error.message : String(error)}\n`);
    return [];
  }
  const groups = new Map<string, string[]>();
  for (const name of names.sort()) groups.set(keyOf(name), [...(groups.get(keyOf(name)) ?? []), name]);
  const ordered = [...groups.values()].map((group) => ({ group, failures: Math.max(...group.map(failuresOf)) })).sort((a, b) => a.failures - b.failures);
  return Promise.all(ordered.slice(0, limit).map((entry) => entryOf(storeDir, entry.group)));
};

/** Removes the files of the entries a deposit settled, after its `state.json` was written, so a crash before that leaves them for the next run. */
export const removePending = async (storeDir: string, entries: readonly PendingEntry[]): Promise<void> => {
  for (const entry of entries) for (const name of entry.names) await rm(join(pendingDir(storeDir), name), { force: true });
};

/** Counts one more failed deposit of `entry`, in the name of its first file; returns the new count. The caller holds the store lock, so no one else renames or removes it. */
export const failPending = async (storeDir: string, entry: PendingEntry): Promise<number> => {
  const failures = entry.failures + 1;
  const first = entry.names[0];
  if (first !== undefined) {
    const base = first.replace(FAILED, '.json').replace(/\.json$/, `.f${String(failures)}.json`);
    await rename(join(pendingDir(storeDir), first), join(pendingDir(storeDir), base));
  }
  return failures;
};

/** Removes the `*.tmp` files a hook died before renaming, once they are older than `staleMs`: the age no live write reaches. */
export const sweepPendingTemps = async (storeDir: string, staleMs: number): Promise<void> => {
  const dir = pendingDir(storeDir);
  const names = await readdir(dir).catch(() => []);
  for (const name of names.filter((entry) => entry.endsWith('.tmp'))) {
    const age = await stat(join(dir, name)).then((info) => Date.now() - info.mtimeMs, () => 0);
    if (age > staleMs) await rm(join(dir, name), { force: true });
  }
};
