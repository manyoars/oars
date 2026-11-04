// `oars gate report`: counts over the rows a replay wrote. No judgment word appears here; a count says what was seen, and `LIMITS` says what was not.
import {
  AGAINST_LATEST,
  CROSSING_CLASSES,
  CROSSING_FORMS,
  DEPTHS,
  DECIDERS,
  MISSES,
  NEXTS,
  NOVELTIES,
  ORIGINS,
  PERMISSIONS,
  REGISTRY_AGES,
  REGISTRY_STATES,
  STATUSES,
  type CrossingRecord,
  type Row,
  type RunRow,
} from './record.js';
import { REGISTRY_NOT_READ } from './replay.js';

export interface Tally {
  value: string;
  count: number;
}

export interface ClassCount {
  class: string;
  form: string;
  count: number;
  distinct: number;
}

export interface Report {
  ok: true;
  transcripts: number;
  unreadable: number;
  badLines: number;
  calls: number;
  crossings: number;
  registryRead: boolean;
  classes: ClassCount[];
  origin: Tally[];
  novelty: Tally[];
  decidedBy: Tally[];
  permission: Tally[];
  status: Tally[];
  next: Tally[];
  miss: Tally[];
  depth: Tally[];
  againstLatest: Tally[];
  registryState: Tally[];
  registryAge: Tally[];
  removedLater: number;
  unseen: Tally[];
  limits: string[];
}

/** What a replay of logs on disk cannot see, said every time so a count is never read as the whole. */
export const LIMITS: readonly string[] = [
  'a command run from a script, an alias, or a Makefile target, because only the call the agent made is in the log',
  'a change to a manifest or lockfile that a later bare install picked up',
  'what a person saw or approved on screen; the permission mode is what the log kept',
  'an MCP server that was started and never called',
  'folders off the allowlist, and logs the harness has already cleaned up',
  'a session in Codex or Cursor, which replay does not read: Codex keeps rollouts in its own format, and Cursor has no transcript files',
  'pool reads, sign-in, and deposit prompts; this release reads none of them',
];

const tally = <T extends string>(vocabulary: readonly T[], rows: readonly CrossingRecord[], pick: (row: CrossingRecord) => T): Tally[] =>
  vocabulary.map((value) => ({ value, count: rows.filter((row) => pick(row) === value).length }));

const classCounts = (rows: readonly CrossingRecord[]): ClassCount[] =>
  CROSSING_CLASSES.flatMap((cls) =>
    CROSSING_FORMS.flatMap((form) => {
      const these = rows.filter((row) => row.class === cls && row.form === form);
      return these.length === 0 ? [] : [{ class: cls, form, count: these.length, distinct: new Set(these.map((row) => row.name)).size }];
    }),
  );

export const reportOf = (rows: readonly Row[]): Report => {
  const run = rows.find((row): row is RunRow => row.kind === 'run');
  const crossings = rows.filter((row): row is CrossingRecord => row.kind === 'crossing');
  return {
    ok: true,
    transcripts: run?.transcripts ?? 0,
    unreadable: run?.unreadable ?? 0,
    badLines: run?.badLines ?? 0,
    calls: run?.calls ?? 0,
    crossings: crossings.length,
    registryRead: run?.registryRead ?? false,
    classes: classCounts(crossings),
    origin: tally(ORIGINS, crossings, (row) => row.origin),
    novelty: tally(NOVELTIES, crossings, (row) => row.novelty),
    decidedBy: tally(DECIDERS, crossings, (row) => row.decidedBy),
    permission: tally(PERMISSIONS, crossings, (row) => row.permission),
    status: tally(STATUSES, crossings, (row) => row.status),
    next: tally(NEXTS, crossings, (row) => row.next),
    miss: tally(MISSES, crossings, (row) => row.miss),
    depth: tally(DEPTHS, crossings, (row) => row.depth),
    againstLatest: tally(AGAINST_LATEST, crossings, (row) => row.againstLatest),
    registryState: tally(REGISTRY_STATES, crossings, (row) => row.registryState),
    registryAge: tally(REGISTRY_AGES, crossings, (row) => row.registryAge),
    removedLater: crossings.filter((row) => row.removedLater).length,
    unseen: Object.entries(run?.unread ?? {}).map(([value, count]) => ({ value, count })),
    limits: [...LIMITS],
  };
};

const line = (label: string, counts: readonly Tally[]): string => `${label}: ${counts.filter((one) => one.count > 0).map((one) => `${one.value} ${String(one.count)}`).join(', ')}`;

export const formatReport = (report: Report): string => {
  const registry = report.registryRead
    ? [line('Against latest', report.againstLatest), line('Registry state', report.registryState), line('Registry age', report.registryAge)]
    : [REGISTRY_NOT_READ];
  return [
    `Read ${String(report.transcripts)} transcripts (${String(report.unreadable)} unreadable, ${String(report.badLines)} torn lines) and ${String(report.calls)} tool calls.`,
    `Crossings: ${String(report.crossings)}`,
    ...report.classes.map((one) => `  ${one.class} ${one.form}: ${String(one.count)} (${String(one.distinct)} distinct)`),
    line('Name came from', report.origin),
    line('New to', report.novelty),
    line('Decided by', report.decidedBy),
    line('Permission mode', report.permission),
    line('Result', report.status),
    line('What happened next', report.next),
    line('Name not found', report.miss),
    line('Line', report.depth),
    `Removed later: ${String(report.removedLater)}`,
    ...registry,
    'Replay cannot see:',
    ...report.unseen.map((one) => `- ${String(one.count)} ${one.value} commands that state no name to record`),
    ...report.limits.map((limit) => `- ${limit}`),
  ].join('\n');
};
