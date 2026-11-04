// The pending list (t832, register row A55): the sessions a Stop hook deposit could not take because another deposit held the store lock.
//
// One small file per session under `<store>/pending/`, named by a hash of the transcript path and holding `{"transcript": "<path>"}`: what a
// later deposit needs to find the transcript, and nothing else (no prompt text, no id, no project name beyond the path). One file per session,
// not one shared list, because the hook that defers must not take the store lock (it just failed to) and two hooks may defer at once: they never
// write the same file unless they are the same session, whose content is identical, and the drain deletes only the file it handled, so an append
// racing a drain is never lost. Each file is written to a temp name and renamed, so a drain never reads a torn one.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** How many pending sessions one Stop hook deposit takes before its own: the hook has a 5 s budget, so a backlog drains over several hooks (a whole-store deposit takes all). */
export const PENDING_HOOK_CAP = 5;

export const pendingDir = (storeDir: string): string => join(storeDir, 'pending');

export interface PendingEntry {
  /** The entry's file name inside the pending folder. */
  name: string;
  /** The transcript to deposit; undefined for a file that is not a pending entry (it is dropped). */
  transcript: string | undefined;
}

const nameOf = (transcript: string): string => `${createHash('sha256').update(transcript).digest('hex').slice(0, 32)}.json`;

/** Records `transcript` as pending without taking the store lock. The same session twice is the same file. */
export const deferSession = async (storeDir: string, transcript: string): Promise<void> => {
  const dir = pendingDir(storeDir);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify({ transcript }), { mode: 0o600 });
  await rename(temp, join(dir, nameOf(transcript)));
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

/** The first `limit` pending entries in name order, read; a store with no pending folder has none. */
export const listPending = async (storeDir: string, limit: number): Promise<PendingEntry[]> => {
  let names: string[];
  try {
    names = (await readdir(pendingDir(storeDir))).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(names.slice(0, limit).map(async (name) => ({ name, transcript: transcriptOf(await readFile(join(pendingDir(storeDir), name), 'utf8')) })));
};

/** Removes the entries a deposit settled, after its `state.json` was written, so a crash before that leaves them for the next run. */
export const removePending = async (storeDir: string, entries: readonly PendingEntry[]): Promise<void> => {
  for (const entry of entries) await rm(join(pendingDir(storeDir), entry.name), { force: true });
};
