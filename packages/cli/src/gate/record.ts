// The shape of `crossings.jsonl`, in closed vocabulary. Field classes are in `docs/gate.md` and `docs/sessions-store.md`: a name and a stated
// version are class A because a private package's name can identify private work, and no path, working folder, or command text is kept at all.
import { CROSSING_CLASSES, CROSSING_FORMS, type CrossingClass, type CrossingForm, type UnreadShape, type VersionForm } from './checks.js';

export const GATE_VERSION = 1;

/** Where a row came from. A replay row is read from a transcript, a hook row was written as the call crossed, and `both` is a hook row a replay then filled in. */
export const VIAS = ['hook', 'replay', 'both'] as const;
export type Via = (typeof VIAS)[number];

/** `not-read` on a field says no one has read it for this row yet: a hook row has no transcript, so the fields a transcript gives read `not-read` until a replay fills them. */
export const NOT_READ = 'not-read';

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
  program: string;
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
