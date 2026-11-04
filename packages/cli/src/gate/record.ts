// The shape of `crossings.jsonl`, in closed vocabulary. Field classes are in `docs/gate.md` and `docs/sessions-store.md`: a name and a stated
// version are class A because a private package's name can identify private work, and no path, working folder, or command text is kept at all.
import type { PolicySource } from './policy.js';
import { CROSSING_CLASSES, CROSSING_FORMS, type CrossingClass, type CrossingForm, type UnreadShape, type VersionForm } from './checks.js';

export const GATE_VERSION = 1;

/** Where a row came from. A replay row is read from a transcript, a hook row was written as the call crossed, and `both` is a hook row a replay then filled in. */
export const VIAS = ['hook', 'replay', 'both'] as const;
export type Via = (typeof VIAS)[number];

/** `not-read` on a field says no one has read it for this row yet: a hook row has no transcript, so the fields a transcript gives read `not-read` until a replay fills them. */
export const NOT_READ = 'not-read';

/** Every program a crossing can name: the package managers and runners the gate reads, their `python -m` forms, and the `mcp` and `skill` tools. */
export const PROGRAMS = ['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'pip', 'python -m pip', 'python -m pipx', 'python -m uv', 'uv', 'uvx', 'pipx', 'poetry', 'pdm', 'rye', 'pipenv', 'conda', 'mamba', 'micromamba', 'mcp', 'skill'] as const;
export type Program = (typeof PROGRAMS)[number];

export const ORIGINS = ['prompt', 'repo-file', 'web', 'tool-output', 'skill', 'harness', 'none-seen', 'not-read'] as const;
export type Origin = (typeof ORIGINS)[number];

export const NOVELTIES = ['fleet', 'repository', 'session', 'none', 'not-read'] as const;
export type Novelty = (typeof NOVELTIES)[number];

export const DECIDERS = ['operator', 'agent', 'not-read'] as const;
export type Decider = (typeof DECIDERS)[number];

export const PERMISSIONS = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto', 'other', 'unknown'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const STATUSES = ['ok', 'error', 'refused', 'none', 'not-read'] as const;
export type Status = (typeof STATUSES)[number];

export const NEXTS = ['proceeded', 'retried', 'routed-around', 'changed-name', 'stopped', 'no-result', 'not-read'] as const;
export type Next = (typeof NEXTS)[number];

export const MISSES = ['none', 'not-found', 'not-read'] as const;
export type Miss = (typeof MISSES)[number];

export const AGAINST_LATEST = ['not-read', 'latest', 'not-latest', 'range', 'unstated', 'unknown'] as const;
export type AgainstLatest = (typeof AGAINST_LATEST)[number];

export const REGISTRY_STATES = ['not-read', 'found', 'not-found', 'unreachable'] as const;
export type RegistryState = (typeof REGISTRY_STATES)[number];

export const REGISTRY_AGES = ['not-read', 'after-crossing', 'under-7-days', 'under-30-days', 'under-1-year', 'older', 'unknown'] as const;
export type RegistryAge = (typeof REGISTRY_AGES)[number];

export const DEPTHS = ['main', 'subagent'] as const;
export type Depth = (typeof DEPTHS)[number];

/** Replay shows nothing to an agent, so these two read `none`; they stay in the shape so a hook's records and a replay's compare. */
export type NotShown = 'none';

export interface CrossingRecord {
  kind: 'crossing';
  v: number;
  /** Absent in a row an earlier build wrote: those were all replays. */
  via?: Via;
  // Class P: closed vocabulary, booleans, and a UTC day.
  day: string | null;
  class: CrossingClass;
  form: CrossingForm;
  program: Program;
  versionForm: VersionForm;
  statusReports: boolean;
  origin: Origin;
  novelty: Novelty;
  decidedBy: Decider;
  permission: Permission;
  status: Status;
  next: Next;
  removedLater: boolean | typeof NOT_READ;
  depth: Depth;
  miss: Miss;
  againstLatest: AgainstLatest;
  registryState: RegistryState;
  registryAge: RegistryAge;
  arm: NotShown;
  lineShown: NotShown;
  /** Which policy stood when the hook wrote the row. Absent in a replay row and in a row an earlier build wrote: no policy was read. */
  policy?: PolicySource;
  // Class A: join ids, a finer time, and what the command stated.
  session: string;
  agent: string | null;
  toolUseId: string | null;
  ts: string | null;
  name: string;
  version: string | null;
}

/** The run's own books, so `report` can say what this replay read and could not. Counts and a day: class P. */
export interface RunRow {
  kind: 'run';
  v: number;
  day: string;
  transcripts: number;
  unreadable: number;
  badLines: number;
  calls: number;
  crossings: number;
  unread: Partial<Record<UnreadShape, number>>;
  registryRead: boolean;
}

/** One kept registry answer, the cache of the `--registry-state` option. Held here so a replay writes one file. `name`, `latest`, and `created` are class A; `created` is a full timestamp, which class P cannot hold. */
export interface RegistryRow {
  kind: 'registry';
  v: number;
  day: string;
  /** When the answer was read, to the millisecond; a row an earlier build wrote has none. A not-found answer is trusted for minutes, not days. */
  ts?: string;
  class: CrossingClass;
  state: 'found' | 'not-found';
  created: string | null;
  name: string;
  latest: string | null;
}

export type Row = CrossingRecord | RunRow | RegistryRow;

/** The harness's permission mode, in the closed vocabulary: a mode this version does not know reads `other`. */
export const permissionOf = (value: string): Permission => PERMISSIONS.find((known) => known === value) ?? 'other';

const isRow = (value: unknown): value is Row => {
  const kind: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, 'kind') : undefined;
  return kind === 'crossing' || kind === 'run' || kind === 'registry';
};

/** A line this version cannot read is skipped: a torn tail or a newer row kind says nothing about the rest. */
export const parseRows = (text: string): Row[] =>
  text.split('\n').flatMap((line) => {
    if (line === '') return [];
    try {
      const parsed: unknown = JSON.parse(line);
      return isRow(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });

export { CROSSING_CLASSES, CROSSING_FORMS };

const isLive = (row: CrossingRecord): boolean => row.via === 'hook' || row.via === 'both';

/** A hook never saw these, so a hook row says them as `not-read`, `null`, or `unknown`: then the replay's value stands. */
const unsaid = (value: unknown): boolean => value === NOT_READ || value === null || value === 'unknown';

const pick = <K extends keyof CrossingRecord>(key: K, live: CrossingRecord, replayed: CrossingRecord): CrossingRecord[K] => (unsaid(live[key]) ? replayed[key] : live[key]);

/**
 * One crossing seen twice. The hook's fields from the time of the crossing win: its clock, its permission mode, the registry as it stood, and what was new. A replay's
 * fields from the transcript fill in what the hook could not read. A row that came out of an earlier merge is a hook row again here, so a second replay refreshes
 * only the transcript fields and keeps what the hook saw.
 */
const merged = (live: CrossingRecord, replayed: CrossingRecord): CrossingRecord => ({
  ...replayed,
  via: 'both',
  // The folder as it was at the crossing: a bin installed or removed since must not turn a fetch into a local run, or the reverse.
  form: live.form,
  day: pick('day', live, replayed),
  ts: pick('ts', live, replayed),
  version: pick('version', live, replayed),
  permission: pick('permission', live, replayed),
  novelty: pick('novelty', live, replayed),
  // One reading, so all three come from one side: the registry as it stood at the crossing when the hook read it, else the replay's. Picked field by field, a hook's
  // `unreachable` (with `unknown` beside it) would take a later replay's `not-latest`, a row that contradicts itself.
  // A local bin run was never asked of the registry (docs/gate.md), so a replay that saw no bin and asked cannot give it a reading.
  ...(live.registryState === NOT_READ && live.form !== 'local-bin-run'
    ? { againstLatest: replayed.againstLatest, registryState: replayed.registryState, registryAge: replayed.registryAge }
    : live.form === 'local-bin-run'
      ? { againstLatest: NOT_READ, registryState: NOT_READ, registryAge: NOT_READ }
      : { againstLatest: live.againstLatest, registryState: live.registryState, registryAge: live.registryAge }),
  ...(live.policy === undefined ? {} : { policy: live.policy }),
  arm: pick('arm', live, replayed),
  lineShown: pick('lineShown', live, replayed),
});

/** The key a call crossing is counted by: nothing counts twice when a row has a tool use id and another row has the same one. */
const crossingKey = (row: CrossingRecord): string | null => (row.toolUseId === null ? null : [row.session, row.toolUseId, row.class, row.name].join('\0'));

/** The first row of each key; a row with no key cannot repeat, so it stays. */
const once = (rows: readonly CrossingRecord[]): CrossingRecord[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = crossingKey(row);
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/**
 * Every crossing once. The rows of `replayed` are replay rows and the rows of `live` are hook rows (or merged ones); rows with the same session, tool use id, class, and
 * name are one row, whether two sources saw it or one wrote it twice, so the same name twice in one call counts once. A row with no tool use id cannot be paired and stays.
 */
export const mergeCrossings = (replayed: readonly CrossingRecord[], live: readonly CrossingRecord[]): CrossingRecord[] => {
  const hooked = once(live);
  const waiting = new Map<string, CrossingRecord>();
  for (const row of hooked) {
    const key = crossingKey(row);
    if (key !== null) waiting.set(key, row);
  }
  const paired = new Set<CrossingRecord>();
  const result = once(replayed).map((row) => {
    const key = crossingKey(row);
    const mate = key === null ? undefined : waiting.get(key);
    if (mate === undefined) return row;
    paired.add(mate);
    return merged(mate, row);
  });
  return [...result, ...hooked.filter((row) => !paired.has(row))];
};

/** The crossings of a file's rows with each counted once: replay rows and hook rows of the same call become one. */
export const crossingsOf = (rows: readonly Row[]): CrossingRecord[] => {
  const crossings = rows.filter((row): row is CrossingRecord => row.kind === 'crossing');
  return mergeCrossings(
    crossings.filter((row) => !isLive(row)),
    crossings.filter(isLive),
  );
};

/** The hook-written rows (and merged ones) of a file, which a replay keeps when it rewrites the rest. */
export const liveCrossings = (rows: readonly Row[]): CrossingRecord[] => rows.filter((row): row is CrossingRecord => row.kind === 'crossing' && isLive(row));
