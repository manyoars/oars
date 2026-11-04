// The fill: a registry ask the hook had to cut is finished by a helper process that outlives the hook and writes the answer to the hook's cache, so the next sight of the
// name reads it inside the budget. The helper calls the installed manager as the hook does (`managerReader`), contacts nothing the manager would not, and a failed or
// unreachable ask writes nothing. One ask per name at a time: a lock file in the store, dated by its mtime, is taken before the helper starts.
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CrossingClass } from './checks.js';
import { GATE_VERSION, folderKey, type RegistryRow } from './record.js';
import { askable, type RegistryReader } from './registry.js';

export interface FillAsk {
  class: CrossingClass;
  name: string;
  cwd: string;
}

/** The helper gives the manager this long. A lock younger than five minutes keeps a second helper from starting, whether the first is still asking or has failed. */
export const FILL_TIMEOUT_MS = 15_000;
export const FILL_LOCK_MS = 300_000;

const lockPath = (storeDir: string, ask: Pick<FillAsk, 'class' | 'name'>): string =>
  join(storeDir, `gate-ask-${createHash('sha256').update(`${ask.class}\0${ask.name}`).digest('hex').slice(0, 16)}.lock`);

/**
 * Creates the lock, failing if it exists: of two hooks racing for the name, one wins. It is synchronous so the lock never exists across a turn of the event loop before the
 * helper starts: a deadline timer firing in such a turn would end the hook with a lock held and nothing behind it.
 */
const create = (path: string): boolean => {
  try {
    writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
};

/** Takes the name's lock. False when a younger one is held; an older one is a helper that died, and is taken over. */
const takeLock = async (path: string, now: number): Promise<boolean> => {
  if (create(path)) return true;
  const held = await stat(path).then(
    (found) => found.mtimeMs,
    () => now,
  );
  if (now - held < FILL_LOCK_MS) return false;
  await rm(path, { force: true });
  return create(path);
};

/** Whether a helper holds the name now: the lock is there and younger than `FILL_LOCK_MS`. The hook asks nothing of the manager itself while it is, so one name has one ask. */
export const isLocked = async (storeDir: string, ask: Pick<FillAsk, 'class' | 'name'>, now: number): Promise<boolean> => {
  const held = await stat(lockPath(storeDir, ask)).then(
    (found) => found.mtimeMs,
    () => undefined,
  );
  return held !== undefined && now - held < FILL_LOCK_MS;
};

/**
 * Takes the lock back: a helper that never started will never release it, and the name would go unasked until `FILL_LOCK_MS` passed. Synchronous, like `create`, so a deadline's
 * `exit(0)` cannot end the process between the failed start and the removal.
 */
export const releaseLock = (storeDir: string, ask: Pick<FillAsk, 'class' | 'name'>): void => {
  try {
    rmSync(lockPath(storeDir, ask), { force: true });
  } catch {
    // Fail-open: a lock that stays is only a name left unasked until it ages out.
  }
};

/** The part of `child_process.spawn` the helper start uses, so a test can hand in a child that fails to start. */
export type HelperSpawn = (
  command: string,
  args: string[],
  options: { detached: true; stdio: 'ignore'; windowsHide: true },
) => { on: (event: 'error', listener: () => void) => unknown; unref: () => void };

/** The helper outlives the hook: detached, no stdio, never waited on, so the harness's call does not wait for it either. One that cannot start never releases its lock, so the lock goes on its `error`. */
export const startHelper = (spawn: HelperSpawn, storeDir: string, ask: FillAsk): void => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./hook-fill-main.js', import.meta.url)), storeDir, ask.class, ask.name, ask.cwd], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {
    releaseLock(storeDir, ask);
  });
  child.unref();
};

/**
 * Called by the hook after a cut ask: takes the lock and starts the helper. Nothing here throws into the hook: a store that cannot be written, or a helper that cannot
 * start, is an answer that does not come. The lock goes when the start throws, so the next sight asks about the name again.
 */
export const startFill = async (storeDir: string, ask: FillAsk, now: number, start: (storeDir: string, ask: FillAsk) => void): Promise<void> => {
  try {
    await mkdir(storeDir, { recursive: true });
    if (!(await takeLock(lockPath(storeDir, ask), now))) return;
    try {
      start(storeDir, ask);
    } catch {
      releaseLock(storeDir, ask);
    }
  } catch {
    // Fail-open.
  }
};

/** The helper's work: ask, and keep a `found` or `not-found` answer in the cache. The lock goes once an answer is kept; after a failure it stays, so a down registry is asked about at most every five minutes. */
export const runFill = async (storeDir: string, ask: FillAsk, deps: { registry: RegistryReader; now: () => number }): Promise<void> => {
  if (!askable(ask.class, ask.name)) return;
  const answer = await deps.registry(ask);
  if (answer.state === 'unreachable') return;
  const at = new Date(deps.now()).toISOString();
  const row: RegistryRow = { kind: 'registry', v: GATE_VERSION, day: at.slice(0, 10), ts: at, folder: folderKey(ask.cwd), class: ask.class, state: answer.state, created: answer.created, name: ask.name, latest: answer.latest };
  await appendFile(join(storeDir, 'gate-registry.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  await rm(lockPath(storeDir, ask), { force: true });
};
