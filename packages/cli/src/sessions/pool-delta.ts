import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { heldBatchOf, isMissing } from './pool-outbox.js';
import { appendOwnerOnly, mkdirOwnerOnly } from './owner-only.js';
import { contentHash } from './read.js';
import { bucketOf, PACKAGE_REGISTRIES, parseSkeleton, type BucketKind, type DeltaEntry, type SessionRecords } from './pool-wire.js';
import { PRIVATE, PUBLIC_PACKAGES, publicEffort } from './public-vocabulary.js';
import { harnessOf } from './schema.js';

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

/** A before and an after window, each of `DELTA_DAYS`, the after window's place on the grid (its index), and the session that brought the after window to its minimum. */
export interface Windows<T> {
  index: number;
  before: T[];
  after: T[];
  filler: T;
}

/**
 * The pairs of windows a set of sessions holds. Windows are consecutive spans of `days` on a grid counted from the epoch, not from any session, so a session belongs to exactly one window and the grid does
 * not move when a session is added, lost to a gate, or not yet ended: the `index` of a window is the same whenever the deposit runs. A pair is two windows next to each other that each hold at least
 * `min` sessions; a gap of an empty window, or of one with too few, compares nothing across it. The `filler` is the `min`th session of the after window in time order. It chooses which batch carries
 * the delta and can change from one deposit to the next, so nothing that must hold still is keyed on it.
 */
export const windowsOf = <T extends Placed>(sessions: readonly T[], days: number = DELTA_DAYS, min: number = DELTA_MIN_SESSIONS): Windows<T>[] => {
  const ordered = [...sessions].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const span = days * DAY_MS;
  const windows = new Map<number, T[]>();
  for (const session of ordered) {
    const index = Math.floor(session.at / span);
    const held = windows.get(index);
    if (held === undefined) windows.set(index, [session]);
    else held.push(session);
  }
  const pairs: Windows<T>[] = [];
  for (const [index, after] of windows) {
    const before = windows.get(index - 1);
    const filler = after[min - 1];
    if (before !== undefined && before.length >= min && filler !== undefined) pairs.push({ index, before, after, filler });
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

/** Only Claude Code records `setup.plugins`; another harness holds none because it records none, not because none were loaded, so it says nothing of a plugin. */
const recordsPlugins = ({ main }: SessionRecords): boolean => harnessOf(main) === 'claude-code';

const pluginsIn = (window: readonly SessionRecords[]): Set<string> => new Set(window.filter(recordsPlugins).flatMap(({ main }) => main.setup?.plugins ?? []));

/** A stored `<ecosystem>:<name>` as the wire spells it: the public name and its registry, else the word `private` with no registry. */
const packageNamed = (stored: string): { name: string; registry: string | null } => {
  const colon = stored.indexOf(':');
  const registry = PACKAGE_REGISTRIES.find((entry) => entry === stored.slice(0, colon));
  const name = stored.slice(colon + 1);
  return registry !== undefined && PUBLIC_PACKAGES.has(name) ? { name, registry } : { name: PRIVATE, registry: null };
};

interface ManifestEvent {
  tool: string;
  target: string | null;
  seen: readonly string[];
  added: readonly string[];
  removed: readonly string[];
}

/** The manifests a window's calls showed, in the order they ran. A call that did not come back clean shows none. */
const manifestsIn = (window: readonly SessionRecords[]): ManifestEvent[] =>
  window.flatMap((records) =>
    records.transcripts.flatMap(({ tools }) =>
      [...tools].sort((a, b) => a.n - b.n).flatMap(({ manifest, status, target, tool }) => (manifest === undefined || status !== 'ok' ? [] : [{ tool, target, seen: manifest.seen, added: manifest.added, removed: manifest.removed }])),
    ),
  );

/**
 * Whether the manifests of the after window leave a package gone. An edit that removes it, or a Write that lists a file that held it in the before window and no longer does, says gone; a later edit that
 * adds it back, or any listing that holds it, says it stayed. A Read says nothing of what is missing, since it may have shown part of the file (an `offset` or a `limit`), and a listing of any other
 * file says nothing, since one repository's manifest is not another's.
 */
const goneFrom = (stored: string, before: readonly ManifestEvent[], after: readonly ManifestEvent[]): boolean => {
  const held = new Set(before.flatMap(({ target, seen }) => (target !== null && seen.includes(stored) ? [target] : [])));
  let gone = false;
  for (const { tool, target, seen, added, removed } of after) {
    if (removed.includes(stored)) gone = true;
    else if (added.includes(stored) || seen.includes(stored)) gone = false;
    else if (tool === 'Write' && seen.length > 0 && target !== null && held.has(target)) gone = true;
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
  // No plugin registry is pinned, so a plugin's name never passes its row: it goes as the word `private`. Plugins are compared only when both windows hold a session that records them.
  if (before.some(recordsPlugins) && after.some(recordsPlugins)) {
    const pluginsBefore = pluginsIn(before);
    const pluginsAfter = pluginsIn(after);
    if ([...pluginsAfter].some((plugin) => !pluginsBefore.has(plugin))) entries.push(entryOf(PRIVATE, 'plugin', 'added', 'callsPerSession', calls));
    if ([...pluginsBefore].some((plugin) => !pluginsAfter.has(plugin))) entries.push(entryOf(PRIVATE, 'plugin', 'removed', 'callsPerSession', calls));
  }
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

const MARKS_FILE = 'deltas-sent.log';

/**
 * The once-only mark of a delta: a hash of the account, the entry without the size of its move, and the index of its after window on the grid. The move is left out so a recount of the same windows is
 * the same delta, and the index is in so a later pair that shows the same change is a new one. The filler is not in it: which session fills a window moves with the sessions ready, a window's index does not.
 */
export const deltaMark = (account: string, { deltaKind, field, name, registry, metric }: DeltaEntry, index: number): string => contentHash([account, deltaKind, field, name, registry, metric, index]);

/** The marks of the deltas this outbox has already carried in a written batch. A folder with no log holds none; a log that cannot be read is an error, not an empty one, so a delta is never built twice by mistake. */
export const sentDeltas = async (outbox: string): Promise<Set<string>> => {
  try {
    return new Set((await readFile(join(outbox, MARKS_FILE), 'utf8')).split('\n').filter((line) => line !== ''));
  } catch (error) {
    if (isMissing(error)) return new Set();
    throw error;
  }
};

/** Marks deltas as sent, one line each. The caller writes this only after the batch that carries them is written, so a deposit that stopped before it builds them again. */
export const markDeltasSent = async (outbox: string, marks: readonly string[]): Promise<void> => {
  if (marks.length === 0) return;
  await mkdirOwnerOnly(outbox);
  await appendOwnerOnly(join(outbox, MARKS_FILE), marks.map((mark) => `${mark}\n`).join(''));
};

/** A session that passed the session gates, placed for the windows: its records, when it began, and its id. */
export interface Gated extends Placed {
  records: SessionRecords;
}

/** The session placed by when it began (epoch milliseconds) and its own id; none when it has no start that reads as a time, since no window can hold it. */
export const placedOf = (records: SessionRecords): Gated | undefined => {
  const at = records.main.tsFirst === null ? Number.NaN : Date.parse(records.main.tsFirst);
  return Number.isNaN(at) ? undefined : { id: records.main.session, at, records };
};

/** What one batch carries: its delta entries and the marks to write once the batch is written. */
export interface Carried {
  entries: DeltaEntry[];
  marks: string[];
}

/**
 * The deltas not yet sent, by the id of the session that filled their after window: that session's batch carries them, and the mark is the window's index, so it holds whichever session fills. A delta whose mark is held is dropped, so a rebuilt session, or a batch written
 * again under the same key, builds none it already carried. Nothing is marked here: the caller marks them once the batch is written.
 */
export const carriedDeltas = (account: string, sessions: readonly Gated[], sent: ReadonlySet<string>): Map<string, Carried> => {
  const carried = new Map<string, Carried>();
  for (const { index, before, after, filler } of windowsOf(sessions)) {
    // The outcome is fixed at the fill: sessions after the filler change nothing, so a delta is the same whenever it is built.
    const found = carriedIn(account, index, before.map(({ records }) => records), after.slice(0, DELTA_MIN_SESSIONS).map(({ records }) => records), sent);
    if (found.entries.length > 0) carried.set(filler.id, found);
  }
  return carried;
};

const carriedIn = (account: string, index: number, before: readonly SessionRecords[], after: readonly SessionRecords[], sent: ReadonlySet<string>): Carried => {
  const found: Carried = { entries: [], marks: [] };
  for (const entry of deltasOf(before, after)) {
    const mark = deltaMark(account, entry, index);
    if (sent.has(mark)) continue;
    found.entries.push(entry);
    found.marks.push(mark);
  }
  return found;
};

/**
 * The same deltas as `carriedDeltas`, one window at a time: `sessions` are placed from their session records alone, and `load` reads the full records of the ids one window needs (all of the window before, the first `DELTA_MIN_SESSIONS` after).
 * What is held at once is one window's records, never the history.
 */
export const carriedDeltasByWindow = async (account: string, sessions: readonly Gated[], sent: ReadonlySet<string>, load: (ids: ReadonlySet<string>) => Promise<ReadonlyMap<string, SessionRecords>>, fillers?: ReadonlySet<string>): Promise<Map<string, Carried>> => {
  const carried = new Map<string, Carried>();
  for (const { index, before, after, filler } of windowsOf(sessions)) {
    // Only the batch of the session that fills a window carries its delta, so a window whose filler is not being built is not read.
    if (fillers !== undefined && !fillers.has(filler.id)) continue;
    const needed = [...before, ...after.slice(0, DELTA_MIN_SESSIONS)];
    const records = await load(new Set(needed.map(({ id }) => id)));
    const found = carriedIn(
      account,
      index,
      before.flatMap(({ id }) => records.get(id) ?? []),
      after.slice(0, DELTA_MIN_SESSIONS).flatMap(({ id }) => records.get(id) ?? []),
      sent,
    );
    if (found.entries.length > 0) carried.set(filler.id, found);
  }
  return carried;
};

/** The delta entries the batch under `key` in this outbox already carries; none when it has no batch, or one this reader does not take. */
export const heldDeltas = async (outbox: string, key: string): Promise<DeltaEntry[]> => {
  const held = await heldBatchOf(outbox, key);
  if (held === undefined) return [];
  const parsed = parseSkeleton(JSON.parse(held.bytes));
  return parsed.ok ? parsed.skeleton.deltas : [];
};

/**
 * What a machine's Stop writes for the one open session it builds again: the deltas its own earlier batch carried, then the new ones. A session keeps exactly what its own batch carried, so the batch that replaces its own never loses a delta, and one that did
 * not carry a held delta never takes it, whichever session fills the window now. A delta that appears in both (a batch written before its mark was) is written once.
 */
export const keptDeltas = (held: readonly DeltaEntry[], fresh: readonly DeltaEntry[]): DeltaEntry[] => {
  const seen = new Set<string>();
  return [...held, ...fresh].filter(({ deltaKind, field, name, registry, metric, change }) => {
    const identity = JSON.stringify([deltaKind, field, name, registry, metric, change]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};
