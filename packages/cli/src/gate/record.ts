// The shape of `crossings.jsonl`, in closed vocabulary. Field classes are in `docs/gate.md` and `docs/sessions-store.md`: a name and a stated
// version are class A because a private package's name can identify private work, and no path, working folder, or command text is kept at all.
import { CROSSING_CLASSES, CROSSING_FORMS, type CrossingClass, type CrossingForm, type UnreadShape, type VersionForm } from './checks.js';

export const GATE_VERSION = 1;

export const ORIGINS = ['prompt', 'repo-file', 'web', 'tool-output', 'skill', 'harness', 'none-seen'] as const;
export type Origin = (typeof ORIGINS)[number];

export const NOVELTIES = ['fleet', 'repository', 'session', 'none'] as const;
export type Novelty = (typeof NOVELTIES)[number];

export const DECIDERS = ['operator', 'agent'] as const;
export type Decider = (typeof DECIDERS)[number];

export const PERMISSIONS = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto', 'other', 'unknown'] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const STATUSES = ['ok', 'error', 'refused', 'none'] as const;
export type Status = (typeof STATUSES)[number];

export const NEXTS = ['proceeded', 'retried', 'routed-around', 'changed-name', 'stopped', 'no-result'] as const;
export type Next = (typeof NEXTS)[number];

export const MISSES = ['none', 'not-found'] as const;
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
  removedLater: boolean;
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

/** One kept registry answer, the cache of the `--registry-state` option. Held here so a replay writes one file. `name` and `latest` are class A. */
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
