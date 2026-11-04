// The fill: a registry ask the hook had to cut is finished by a helper process that outlives the hook and writes the answer to the hook's cache, so the next sight of the
// name reads it inside the budget. The helper calls the installed manager as the hook does (`managerReader`), contacts nothing the manager would not, and a failed or
// unreachable ask writes nothing. One ask per name at a time: a lock file in the store, dated by its mtime, is taken before the helper starts.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CrossingClass } from './checks.js';
import { GATE_VERSION, type RegistryRow } from './record.js';
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

/** Creates the lock, failing if it exists: of two hooks racing for the name, one wins. */
const create = (path: string): Promise<boolean> =>
  writeFile(path, '', { mode: 0o600, flag: 'wx' }).then(
    () => true,
    () => false,
  );

/** Takes the name's lock. False when a younger one is held; an older one is a helper that died, and is taken over. */
const takeLock = async (path: string, now: number): Promise<boolean> => {
  if (await create(path)) return true;
  const held = await stat(path).then(
    (found) => found.mtimeMs,
    () => now,
  );
  if (now - held < FILL_LOCK_MS) return false;
  await rm(path, { force: true });
  return create(path);
};

/**
 * Called by the hook after a cut ask: takes the lock and starts the helper. Nothing here throws into the hook: a store that cannot be written, or a helper that cannot
 * start, is an answer that does not come, which the next sight asks about again.
 */
export const startFill = async (storeDir: string, ask: FillAsk, now: number, start: (storeDir: string, ask: FillAsk) => void): Promise<void> => {
  try {
    await mkdir(storeDir, { recursive: true });
    if (await takeLock(lockPath(storeDir, ask), now)) start(storeDir, ask);
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
  const row: RegistryRow = { kind: 'registry', v: GATE_VERSION, day: at.slice(0, 10), ts: at, class: ask.class, state: answer.state, created: answer.created, name: ask.name, latest: answer.latest };
  await appendFile(join(storeDir, 'gate-registry.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  await rm(lockPath(storeDir, ask), { force: true });
};
