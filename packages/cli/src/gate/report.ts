// `oars gate report`: counts over the rows the hook and a replay wrote, each crossing once. No judgment word appears here; a count says what was seen, and `LIMITS` says what was not.
import {
  AGAINST_LATEST,
  ARMS,
  LINE_IDS,
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
  VIAS,
  crossingsOf,
  type CrossingRecord,
  type Row,
  type RunRow,
} from './record.js';
import { POLICY_SOURCES } from './policy.js';
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
  /** Whether a replay has run: when it has not, only the hook's rows are here and the transcript fields read `not-read`. */
  replayed: boolean;
  registryRead: boolean;
  via: Tally[];
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
  /** Whether a note that would show did (`shown`) or was held back (`held`); `none` is every row with no note to show, and every block. */
  arm: Tally[];
  /** The fixed id of the line a row showed. */
  lineShown: Tally[];
  /** The fixed id of the line a held note withheld. */
  lineHeld: Tally[];
  /** Which policy stood for the rows the hook wrote: no file, a file that fit, or one that did not (the defaults stood). Rows with no policy read (replay) are not counted. */
  policy: Tally[];
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
  'a session in Codex, Cursor, Copilot, Gemini CLI, Grok Build, OpenCode, Pi, or VS Code Copilot Chat, which replay does not read (`--allow codex`, `--allow cursor`, `--allow copilot`, `--allow gemini`, `--allow grok`, `--allow opencode`, `--allow pi`, and `--allow vscode-copilot` add nothing to it): they keep sessions in their own formats, not as transcript files',
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
  const crossings = crossingsOf(rows);
  return {
    ok: true,
    transcripts: run?.transcripts ?? 0,
    unreadable: run?.unreadable ?? 0,
    badLines: run?.badLines ?? 0,
    calls: run?.calls ?? 0,
    crossings: crossings.length,
    replayed: run !== undefined,
    // A hook row carries the registry as it stood at its crossing, so a file with such a row has registry state to show even when no replay asked for it.
    registryRead: (run?.registryRead ?? false) || crossings.some((row) => row.registryState !== 'not-read'),
    via: tally(VIAS, crossings, (row) => row.via ?? 'replay'),
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
    arm: tally(ARMS, crossings, (row) => row.arm),
    lineShown: tally(LINE_IDS, crossings, (row) => row.lineShown),
    lineHeld: tally(LINE_IDS, crossings, (row) => row.lineHeld),
    policy: tally(POLICY_SOURCES, crossings.filter((row) => row.policy !== undefined), (row) => row.policy ?? 'default'),
    removedLater: crossings.filter((row) => row.removedLater === true).length,
    unseen: Object.entries(run?.unread ?? {}).map(([value, count]) => ({ value, count })),
    limits: [...LIMITS],
  };
};

const line = (label: string, counts: readonly Tally[]): string => {
  const shown = counts.filter((one) => one.count > 0).map((one) => `${one.value} ${String(one.count)}`);
  return `${label}: ${shown.length === 0 ? 'none' : shown.join(', ')}`;
};

export const formatReport = (report: Report): string => {
  const registry = report.registryRead
    ? [line('Against latest', report.againstLatest), line('Registry state', report.registryState), line('Registry age', report.registryAge)]
    : [REGISTRY_NOT_READ];
  const books = report.replayed
    ? [`Read ${String(report.transcripts)} transcripts (${String(report.unreadable)} unreadable, ${String(report.badLines)} torn lines) and ${String(report.calls)} tool calls.`]
    : ['No replay has run: these rows come from the hook, and what a transcript gives reads not-read until `oars gate replay` fills it in.'];
  return [
    ...books,
    `Crossings: ${String(report.crossings)}`,
    line('Recorded by', report.via),
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
    line('Notes', report.arm),
    line('Line shown', report.lineShown),
    line('Line held', report.lineHeld),
    ...(report.policy.some((one) => one.count > 0) ? [line('Policy', report.policy)] : []),
    ...registry,
    'Replay cannot see:',
    ...report.unseen.map((one) => `- ${String(one.count)} ${one.value} commands that state no name to record`),
    ...report.limits.map((limit) => `- ${limit}`),
  ].join('\n');
};
