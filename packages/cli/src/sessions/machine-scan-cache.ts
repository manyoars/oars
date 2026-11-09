// What a Stop remembers about the sessions it does not build. A Stop names one session and only reads the others to fill the windows of a delta, but each read is the whole exclusion gate (every transcript, scanned for the terms): measured on a
// store of 5,000 sessions it was 17.8 s of the 18.6 s a Stop took on Windows. So a session that passed the gate is remembered for ten minutes, per term list: the same list and the same session are not scanned again at the Stop after.
// A session that gains a term inside the window is still excluded from every batch (the session a Stop builds is always scanned in full); it can only fill a window for ten minutes more. `<store>/machine-scan-cache.json`, owner-only.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdirOwnerOnly, writeOwnerOnly } from './owner-only.js';

/** How long a clean verdict of a session this Stop does not build is reused. */
export const SCAN_TTL_MS = 10 * 60 * 1000;

const FILE = 'machine-scan-cache.json';

export interface ScanCache {
  /** Whether this session passed the gate at most `SCAN_TTL_MS` ago, under this term list. */
  fresh: (project: string, session: string) => boolean;
  /** Records a pass of the gate now. */
  note: (project: string, session: string) => void;
  /** Writes the cache when a pass was noted. */
  save: () => Promise<void>;
}

const keyOf = (project: string, session: string): string => JSON.stringify([project, session]);

const timesOf = (text: string, terms: string): Map<string, number> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }
  const same: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'terms') : undefined;
  const listed: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'passed') : undefined;
  if (same !== terms || typeof listed !== 'object' || listed === null) return new Map();
  return new Map(Object.entries(listed).flatMap(([key, at]) => (typeof at === 'number' ? [[key, at] as [string, number]] : [])));
};

/** The cache for this term list (`terms` is the list's hash, so a changed list starts empty). An unreadable or damaged file is an empty cache. */
export const scanCache = async (storeDir: string, terms: string, now: () => number): Promise<ScanCache> => {
  const passed = timesOf(await readFile(join(storeDir, FILE), 'utf8').catch(() => ''), terms);
  let changed = false;
  return {
    fresh: (project, session) => {
      const at = passed.get(keyOf(project, session));
      return at !== undefined && at <= now() && now() - at < SCAN_TTL_MS;
    },
    note: (project, session) => {
      passed.set(keyOf(project, session), now());
      changed = true;
    },
    save: async () => {
      if (!changed) return;
      // Entries past their window go: the file never holds more than the sessions of the last ten minutes' Stops.
      const live = [...passed].filter(([, at]) => at <= now() && now() - at < SCAN_TTL_MS);
      await mkdirOwnerOnly(storeDir);
      await writeOwnerOnly(join(storeDir, FILE), `${JSON.stringify({ terms, passed: Object.fromEntries(live) })}\n`);
    },
  };
};
