// What the nightly run tells telemetry about the health of an install: a snapshot of the session store (counts, sizes, verify results, the versions it
// holds) and what the run cost. Counts, bytes, and closed words only; the schema checks them again before anything reaches the spool.
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CAPTURE_VERSION, OLDEST_READABLE_CAPTURE } from '../sessions/schema.js';
import { readSteps } from '../sessions/steps.js';
import { frozenSessions, loadStore, paths, readSkeletons, type SessionsRuntime } from '../sessions/store.js';
import { LITERAL, publicModel, publicVersion } from '../sessions/public-vocabulary.js';
import { verifyAll, verifyCaptured } from '../sessions/verify.js';
import { emitEvent, recordsEvents, type Emitter } from './emit.js';
import { spoolEvents } from './read-events.js';

/** What the nightly run needs to record: the emitter, and a reader for the process's peak memory (a test sets it). */
export interface NightlyTelemetry extends Emitter {
  peakRssMb?: () => number;
}

const MAX_LIST = 32;
const OTHER = 'other';
const WEEK_MS = 7 * 86_400_000;

/**
 * The distinct values seen, each kept when the pool wire's own public vocabulary admits it and written as `other` when it does not, sorted with `other`
 * last. More than the schema's list length folds the tail into `other`.
 */
export const closedList = (values: readonly string[], kind: 'version' | 'model'): string[] => {
  const visible = kind === 'version' ? publicVersion : publicModel;
  const kept = new Set<string>();
  let other = false;
  for (const value of values) {
    const shown = visible(value);
    if (shown === null || shown === LITERAL || shown !== value) other = true;
    else kept.add(value);
  }
  const sorted = [...kept].sort();
  const room = MAX_LIST - 1;
  if (sorted.length > room) return [...sorted.slice(0, room), OTHER];
  return other ? [...sorted, OTHER] : sorted;
};

/** The distinct whole-number versions among the stamps, ascending; a stamp that is not a whole number names no version and is left out. */
export const versionsHeld = (stamps: readonly string[]): number[] =>
  [...new Set(stamps.map(Number).filter((stamp) => Number.isSafeInteger(stamp) && stamp >= 0))].sort((a, b) => a - b).slice(-MAX_LIST);

/** Every byte under a folder; a folder that is not there holds none. */
const bytesUnder = async (dir: string): Promise<number> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) total += entry.isDirectory() ? await bytesUnder(join(dir, entry.name)) : (await stat(join(dir, entry.name))).size;
  return total;
};

/** The bytes the last seven days of sends put on the wire, read from telemetry's own `wire-send` events: nothing is asked of the pool. */
const egressBytes = (dir: string, now: number): number =>
  spoolEvents(dir, 'wire-send').reduce((total, { at, data }) => (data.sent === 1 && typeof data.bytes === 'number' && Date.parse(at) >= now - WEEK_MS ? total + data.bytes : total), 0);

const storeFields = async (runtime: SessionsRuntime): Promise<{ [field: string]: number | number[] | string[] }> => {
  const { storeDir } = runtime;
  const { skeletons, unreadable } = await readSkeletons(storeDir, undefined, true);
  const store = await loadStore(storeDir);
  const steps = await readSteps(storeDir);
  const captured = [...store.sessions, ...store.subagents];
  const frozen = await frozenSessions(runtime, captured.filter((session) => Number(session.cv) >= OLDEST_READABLE_CAPTURE && Number(session.cv) < Number(CAPTURE_VERSION)));
  const results = [...verifyAll(skeletons, skeletons), ...verifyCaptured(captured, store.tools, frozen)];
  return {
    sessions: store.sessions.length,
    subagents: store.subagents.length,
    skeletons: skeletons.length,
    unparseable: unreadable + captured.reduce((sum, session) => sum + session.badLines, 0),
    rawBytes: await bytesUnder(paths(storeDir).raw),
    verifyChecked: results.length,
    verifyFailed: results.filter((result) => result.violations > 0).length,
    // What the store holds: the `cv` of each captured session and the `ev` each pipeline step ran at. A store with a session behind this build lists two.
    captureVersions: versionsHeld(captured.map((session) => session.cv)),
    extractorVersions: versionsHeld(steps.map((step) => step.ev)),
    harnessVersions: closedList(captured.flatMap((session) => session.versions), 'version'),
    models: closedList(captured.flatMap((session) => Object.keys(session.models)), 'model'),
  };
};

/** The store-health event of one nightly run. A store that cannot be read is recorded as that and nothing else; it never stops the run. */
export const recordStoreHealth = async (telemetry: NightlyTelemetry, runtime: SessionsRuntime): Promise<void> => {
  // The pass reads every skeleton and stats every raw file, so an install with telemetry off must not start it.
  if (!recordsEvents(telemetry)) return;
  try {
    const fields = await storeFields(runtime);
    // The outbox is an extra: a folder that cannot be read leaves the two figures out and the snapshot stands.
    const extras = await bytesUnder(join(runtime.storeDir, 'pool-outbox')).then(
      (outboxBytes) => ({ outboxBytes, egressBytes: egressBytes(telemetry.telemetry?.dir ?? '', telemetry.now()) }),
      () => ({}),
    );
    emitEvent(telemetry, 'store-health', { ...fields, ...extras });
  } catch {
    emitEvent(telemetry, 'store-health', { readFailed: 1 });
  }
};

/** What a nightly run cost: the whole run, the deposit's parse, the process's peak memory, and whether it failed. */
export const recordRunCost = (telemetry: NightlyTelemetry, cost: { totalMs: number; parseMs: number; failed: boolean }): void => {
  const peak = telemetry.peakRssMb ?? ((): number => Math.round(process.resourceUsage().maxRSS / 1024));
  emitEvent(telemetry, 'run-cost', { totalMs: Math.max(0, cost.totalMs), parseMs: Math.max(0, cost.parseMs), peakRssMb: peak(), failed: cost.failed ? 1 : 0 });
};
