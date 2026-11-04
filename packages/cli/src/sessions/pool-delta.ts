import { bucketOf, PACKAGE_REGISTRIES, type BucketKind, type DeltaEntry, type SessionRecords } from './pool-wire.js';
import { PRIVATE, PUBLIC_PACKAGES, publicEffort } from './public-vocabulary.js';

// Local deltas (spec Section 2, "Deltas"): the client compares its own before and after windows and builds each change once. Nothing here reads a store or sends a byte; `pool deposit` hands it the
// sessions that passed the session gates and carries what comes back in the batch of the session that filled the after window.

/** `delta_days` and `delta_min_sessions` (spec Section 7): a week on each side spans a work cycle, and five sessions keep one session from being the delta. */
export const DELTA_DAYS = 7;
export const DELTA_MIN_SESSIONS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A session as a window sees it: when it began (epoch milliseconds) and an id that orders two sessions of one instant. */
export interface Placed {
  id: string;
  at: number;
}

/** A before and an after window, each of `DELTA_DAYS`, and the session that brought the after window to its minimum. */
export interface Windows<T> {
  before: T[];
  after: T[];
  filler: T;
}

/**
 * The pairs of windows a set of sessions holds. Windows are consecutive spans of `days`, counted from the earliest session, so a session belongs to exactly one and a change is compared once. A pair is
 * two windows next to each other that each hold at least `min` sessions; a gap of an empty window, or of one with too few, compares nothing across it. The `filler` is the `min`th session of the after
 * window in time order, so it is the same session whenever the deposit runs.
 */
export const windowsOf = <T extends Placed>(sessions: readonly T[], days: number = DELTA_DAYS, min: number = DELTA_MIN_SESSIONS): Windows<T>[] => {
  const ordered = [...sessions].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const first = ordered[0]?.at ?? 0;
  const span = days * DAY_MS;
  const windows = new Map<number, T[]>();
  for (const session of ordered) {
    const index = Math.floor((session.at - first) / span);
    const held = windows.get(index);
    if (held === undefined) windows.set(index, [session]);
    else held.push(session);
  }
  const pairs: Windows<T>[] = [];
  for (const [index, after] of windows) {
    const before = windows.get(index - 1);
    const filler = after[min - 1];
    if (before !== undefined && before.length >= min && filler !== undefined) pairs.push({ before, after, filler });
  }
  return pairs;
};

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const mean = (values: readonly number[], count: number): number => (count === 0 ? 0 : sum(values) / count);

/** The signed bucket of a move: the bucket of its size, negative when it fell. Zero stays zero, never negative zero. */
const signed = (kind: BucketKind, move: number): number => {
  const bucket = bucketOf(kind, Math.abs(move));
  return move < 0 && bucket > 0 ? -bucket : bucket;
};

/** The value most sessions hold; the smaller of two that tie, so two runs agree. */
const modal = (values: readonly string[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : 1))[0]?.[0];
};

const callsOf = (window: readonly SessionRecords[]): number => mean(window.map((records) => sum(records.transcripts.map(({ tools }) => tools.length))), window.length);

const thinkingOf = (window: readonly SessionRecords[]): number => {
  const prompts = window.flatMap((records) => records.transcripts.flatMap((transcript) => transcript.prompts));
  return mean(
    prompts.map(({ usage }) => usage.thinking),
    prompts.length,
  );
};

/** The effort a session ran at: the one most of its main run's prompts held, read through the public list so a value outside it is one word. */
const effortOf = (records: SessionRecords): string | undefined => modal((records.transcripts[0]?.prompts ?? []).flatMap(({ efforts }) => efforts.flatMap((effort) => publicEffort(effort) ?? [])));

const entryOf = (name: string | null, field: DeltaEntry['field'], deltaKind: DeltaEntry['deltaKind'], metric: DeltaEntry['metric'], change: number, registry: string | null = null): DeltaEntry => ({ deltaKind, field, name, registry, metric, change });

const pluginsIn = (window: readonly SessionRecords[]): Set<string> => new Set(window.flatMap(({ main }) => main.setup?.plugins ?? []));

/** A stored `<ecosystem>:<name>` as the wire spells it: the public name and its registry, else the word `private` with no registry. */
const packageNamed = (stored: string): { name: string; registry: string | null } => {
  const colon = stored.indexOf(':');
  const registry = PACKAGE_REGISTRIES.find((entry) => entry === stored.slice(0, colon));
  const name = stored.slice(colon + 1);
  return registry !== undefined && PUBLIC_PACKAGES.has(name) ? { name, registry } : { name: PRIVATE, registry: null };
};

interface ManifestEvent {
  target: string | null;
  seen: readonly string[];
  added: readonly string[];
  removed: readonly string[];
}

/** The manifests a window's calls showed, in the order they ran. A call that did not come back clean shows none. */
const manifestsIn = (window: readonly SessionRecords[]): ManifestEvent[] =>
  window.flatMap((records) =>
    records.transcripts.flatMap(({ tools }) =>
      [...tools].sort((a, b) => a.n - b.n).flatMap(({ manifest, status, target }) => (manifest === undefined || status !== 'ok' ? [] : [{ target, seen: manifest.seen, added: manifest.added, removed: manifest.removed }])),
    ),
  );

/**
 * Whether the manifests of the after window leave a package gone. An edit that removes it, or a full listing of a file that held it in the before window and no longer does, says gone; a later edit that
 * adds it back, or a listing that holds it, says it stayed. A listing of any other file says nothing, since one repository's manifest is not another's.
 */
const goneFrom = (stored: string, before: readonly ManifestEvent[], after: readonly ManifestEvent[]): boolean => {
  const held = new Set(before.flatMap(({ target, seen }) => (target !== null && seen.includes(stored) ? [target] : [])));
  let gone = false;
  for (const { target, seen, added, removed } of after) {
    if (removed.includes(stored)) gone = true;
    else if (added.includes(stored) || seen.includes(stored)) gone = false;
    else if (seen.length > 0 && target !== null && held.has(target)) gone = true;
  }
  return gone;
};

/** A package's calls per session: tool calls of the window that install or run it. */
const callsNaming = (window: readonly SessionRecords[], stored: string): number =>
  mean(window.map((records) => sum(records.transcripts.map(({ tools }) => tools.filter(({ packages }) => packages?.some(({ package: held }) => held === stored) === true).length))), window.length);

const packagesCalledIn = (window: readonly SessionRecords[]): string[] => [...new Set(window.flatMap((records) => records.transcripts.flatMap(({ tools }) => tools.flatMap(({ packages }) => (packages ?? []).map(({ package: held }) => held)))))].sort();

const order = (a: DeltaEntry, b: DeltaEntry): number => {
  const key = (entry: DeltaEntry): string => [entry.field, entry.deltaKind, entry.name ?? '', entry.registry ?? ''].join(' ');
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
};

/**
 * The entries a pair of windows holds, each window in time order (the caller sorts). A plugin is added or removed, a `permissionMode` or `effort` changed by name alone (the most common value of each
 * window differs, a value outside its list read as one word), and a `package` removed. Each entry carries the move of one metric in its field's own buckets: calls per session for a plugin, a permission
 * mode, and a package, thinking per prompt for an effort. A name outside its list is `private`, and everything that is `private` in one field is one entry.
 */
export const deltasOf = (before: readonly SessionRecords[], after: readonly SessionRecords[]): DeltaEntry[] => {
  const calls = signed('count', callsOf(after) - callsOf(before));
  const entries: DeltaEntry[] = [];
  const pluginsBefore = pluginsIn(before);
  const pluginsAfter = pluginsIn(after);
  // No plugin registry is pinned, so a plugin's name never passes its row: it goes as the word `private`.
  if ([...pluginsAfter].some((plugin) => !pluginsBefore.has(plugin))) entries.push(entryOf(PRIVATE, 'plugin', 'added', 'callsPerSession', calls));
  if ([...pluginsBefore].some((plugin) => !pluginsAfter.has(plugin))) entries.push(entryOf(PRIVATE, 'plugin', 'removed', 'callsPerSession', calls));
  const modeBefore = modal(before.flatMap(({ main }) => main.setup?.permissionMode ?? []));
  const modeAfter = modal(after.flatMap(({ main }) => main.setup?.permissionMode ?? []));
  if (modeBefore !== undefined && modeAfter !== undefined && modeBefore !== modeAfter) entries.push(entryOf(null, 'permissionMode', 'changed', 'callsPerSession', calls));
  const effortBefore = modal(before.flatMap((records) => effortOf(records) ?? []));
  const effortAfter = modal(after.flatMap((records) => effortOf(records) ?? []));
  if (effortBefore !== undefined && effortAfter !== undefined && effortBefore !== effortAfter) entries.push(entryOf(null, 'effort', 'changed', 'thinking', signed('tokens', thinkingOf(after) - thinkingOf(before))));
  const manifestsBefore = manifestsIn(before);
  const manifestsAfter = manifestsIn(after);
  const moves = new Map<string, { name: string; registry: string | null; move: number }>();
  for (const stored of packagesCalledIn(before)) {
    if (!goneFrom(stored, manifestsBefore, manifestsAfter)) continue;
    const { name, registry } = packageNamed(stored);
    const key = `${registry ?? ''}:${name}`;
    moves.set(key, { name, registry, move: (moves.get(key)?.move ?? 0) + callsNaming(after, stored) - callsNaming(before, stored) });
  }
  for (const { name, registry, move } of moves.values()) entries.push(entryOf(name, 'package', 'removed', 'callsPerSession', signed('count', move), registry));
  return entries.sort(order);
};
