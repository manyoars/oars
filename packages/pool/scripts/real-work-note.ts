// The real-work release note: two harness version buckets compared, and one dated JSON file with the three largest moves and their n, or "no change" when every difference is inside noise.
// It is the table's own counting (`countsOf`) and the table's own row builders (`cellRowOf`, `toolRowOf`), read twice, so the note has no derive path of its own. The same gates run before any count:
// the exclusion terms (A38) and the owner filter. The note is data, not prose: no sentence, no score, and no word that judges a move; the page that publishes it writes the words around it.
//   npm run real-work-note -w packages/pool -- <store folder> --terms <file> --owners <file> --out <dir> --harness <name> --from <bucket> --to <bucket> [--projects <folder>] [--min-sessions <n>] [--date <YYYY-MM-DD>]
import type { SessionsRuntime } from '../../cli/src/sessions/store.js';
import { compare, HARNESS_NAMES, LABEL, OTHER, UNKNOWN, cellRowOf, commonOf, countsOf, DEFAULT_MIN_SESSIONS, parseArgs, refuseInsideRepository, runtimeFor, toolRowOf, writeJson, type Counts, type Io, type Row, type Tally } from './real-work-table.js';
import { PackError } from './sample-pack.js';

export { runtimeOf } from './sample-pack.js';

export const NOTE_SPEC = 'real-work-note/1';
/** A note holds at most this many moves. */
export const MAX_MOVES = 3;
/** The width of the intervals of the noise rule: 95 percent, two-sided. */
const Z = 1.96;

const USAGE = [
  'Usage: real-work-note <store folder> --terms <file> --owners <file> --out <dir> --harness <name> --from <bucket> --to <bucket> [--projects <folder>] [--min-sessions <n>] [--date <YYYY-MM-DD>]',
  '  <store folder>      the sessions store to read (never written)',
  '  --terms <file>      the exclusion term list (A38): a session whose transcript holds a term moves no number',
  '  --owners <file>     the owners file of sample-pack: a session in a folder no entry names is left out',
  '  --out <dir>         where the note is written; refused inside a git repository',
  '  --harness <name>    the harness the two buckets belong to (claude-code, cursor, codex, and so on)',
  '  --from <bucket>     the older harness version bucket, as the table names it (2.1.30x)',
  '  --to <bucket>       the newer harness version bucket',
  '  --projects <folder> the harness transcripts the exclusion gate scans (default: the runtime\'s)',
  `  --min-sessions <n>  a bucket or row under n sessions, or a measure under n observations, is not compared (default ${String(DEFAULT_MIN_SESSIONS)}, never under 2)`,
  '  --date <date>       the build date (default: today, UTC)',
].join('\n');

export type Measure = 'failureRate' | 'callsToRecover' | 'editFollowedShare' | 'interventionsPerPrompt' | 'tokensPerPrompt';
/** What a measure's n counts. */
export type Unit = 'calls' | 'failures' | 'recoveries' | 'prompts';

export interface Point {
  value: number;
  n: number;
}

/** One difference that cleared the noise rule: the measure, the row it is on, and both values with their n. No verdict, no size. */
export interface Move {
  measure: Measure;
  kind: 'model' | 'tool';
  name: string;
  /** The prompt class, on `tokensPerPrompt` only. */
  class?: string;
  unit: Unit;
  from: Point;
  to: Point;
}

export interface BucketHeader {
  versionBucket: string;
  /** Sessions that passed the gates and have a call or a prompt in the bucket. */
  sessions: number;
  calls: number;
}

export interface Note {
  spec: string;
  label: string;
  builtOn: string;
  harness: string;
  from: BucketHeader;
  to: BucketHeader;
  minSessions: number;
  result: 'moves' | 'no change';
  moves: Move[];
}

export interface NoteOptions {
  terms: string;
  owners: string;
  minSessions?: number;
  /** The build date, `YYYY-MM-DD`. */
  date: string;
  harness: string;
  /** The older version bucket. */
  from: string;
  /** The newer version bucket. */
  to: string;
}

export interface Interval {
  low: number;
  high: number;
}

/** The 95 percent Wilson score interval of `successes` in `n`, for a rate: it keeps the ends inside 0 and 1 and is not zero-width at 0 or 1, so a rate of none in sixty is not "exact". */
export const wilson = (successes: number, n: number): Interval => {
  const z2 = Z * Z;
  const rate = successes / n;
  const scale = 1 + z2 / n;
  const centre = (rate + z2 / (2 * n)) / scale;
  const half = (Z * Math.sqrt((rate * (1 - rate)) / n + z2 / (4 * n * n))) / scale;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
};

/** The mean and 1.96 standard errors of the mean (the normal approximation, from the sample variance), for a measure that is an average of counts. Needs n of at least 2. */
export const meanInterval = (mean: number, squares: number, n: number): Interval => {
  const variance = Math.max(0, (squares - n * mean * mean) / (n - 1));
  const half = Z * Math.sqrt(variance / n);
  return { low: mean - half, high: mean + half };
};

/** Two intervals are apart when neither reaches the other: sharing an end is not apart. */
export const apart = (a: Interval, b: Interval): boolean => a.high < b.low || b.high < a.low;

interface Reading {
  measure: Measure;
  unit: Unit;
  cls?: string;
  /** The value as the row shows it. */
  value: number;
  n: number;
  interval: Interval;
}

const rateReading = (measure: Measure, unit: Unit, value: number | null, successes: number, n: number): Reading[] => (value === null ? [] : [{ measure, unit, value, n, interval: wilson(successes, n) }]);

const meanReading = (measure: Measure, unit: Unit, value: number, mean: number, squares: number, n: number, cls?: string): Reading => ({ measure, unit, ...(cls === undefined ? {} : { cls }), value, n, interval: meanInterval(mean, squares, n) });

/** Every measure a row holds, with its n and its interval; a measure a row cannot state (a rate of nothing) is not in the list. The interval reads the same tally the row was built from. */
const readingsOf = (row: Row, tally: Tally): Reading[] => {
  const readings = [
    ...rateReading('failureRate', 'calls', row.failureRate, row.failures, row.calls),
    ...(row.callsToRecover === null ? [] : [meanReading('callsToRecover', 'recoveries', row.callsToRecover, tally.recoverySteps / tally.recovered, tally.recoverySquares, tally.recovered)]),
    ...rateReading('editFollowedShare', 'failures', row.editFollowedShare, tally.edited, row.failures),
  ];
  if (row.kind === 'tool') return readings;
  return [
    ...readings,
    ...rateReading('interventionsPerPrompt', 'prompts', row.interventionsPerPrompt, row.interventions, row.promptsKnown),
    ...row.tokensPerPrompt.map(({ class: cls, prompts, tokensPerPrompt }) => {
      const held = tally.tokens.get(cls) ?? { tokens: 0, squares: 0 };
      return meanReading('tokensPerPrompt', 'prompts', tokensPerPrompt, held.tokens / prompts, held.squares, prompts, cls);
    }),
  ];
};

interface Side {
  kind: Move['kind'];
  name: string;
  row: Row;
  tally: Tally;
}

/** The rows of one harness and bucket the note compares: a model row of the table's, and a tool row read inside the bucket. `other` and `unknown` each hold many names, so they are not rows. */
const sidesOf = (counts: Counts, harness: string, bucket: string, minSessions: number): Side[] => {
  const models = [...counts.cells.values()]
    .filter((cell) => cell.harness === harness && cell.versionBucket === bucket && cell.model !== OTHER && cell.model !== UNKNOWN)
    .map((cell): Side => ({ kind: 'model', name: cell.model, row: cellRowOf(cell), tally: cell.tally }));
  const tools = [...counts.toolCells.values()]
    .filter((cell) => cell.harness === harness && cell.versionBucket === bucket && cell.tool !== OTHER)
    .map((cell): Side => ({ kind: 'tool', name: cell.tool, row: toolRowOf(cell.tool, cell.tally), tally: cell.tally }));
  return [...models, ...tools].filter((side) => side.row.sessions >= minSessions);
};

interface Candidate {
  move: Move;
  /** The gap of the two values in the width of the two intervals together; only the order of the moves reads it. */
  size: number;
}

const half = (interval: Interval): number => (interval.high - interval.low) / 2;

/** Every difference that clears the noise rule: both rows at the minimum sessions (`sidesOf`), both n of the measure at the minimum (never under 2), and the two intervals apart. */
const candidatesOf = (from: readonly Side[], to: readonly Side[], minN: number): Candidate[] => {
  const found: Candidate[] = [];
  for (const before of from) {
    const after = to.find((side) => side.kind === before.kind && side.name === before.name);
    if (after === undefined) continue;
    const later = readingsOf(after.row, after.tally);
    for (const a of readingsOf(before.row, before.tally)) {
      const b = later.find((reading) => reading.measure === a.measure && reading.cls === a.cls);
      if (b === undefined || a.n < minN || b.n < minN || !apart(a.interval, b.interval)) continue;
      found.push({
        move: { measure: a.measure, kind: before.kind, name: before.name, ...(a.cls === undefined ? {} : { class: a.cls }), unit: a.unit, from: { value: a.value, n: a.n }, to: { value: b.value, n: b.n } },
        size: Math.abs(b.value - a.value) / Math.hypot(half(a.interval), half(b.interval)),
      });
    }
  }
  return found;
};

/** Largest first; a tie goes by measure, kind, name, and class, so the same store always writes the same file. */
const ranked = (candidates: Candidate[]): Move[] =>
  candidates
    .sort((a, b) => (a.size > b.size ? -1 : a.size < b.size ? 1 : 0) || compare(a.move.measure, b.move.measure) || compare(a.move.kind, b.move.kind) || compare(a.move.name, b.move.name) || compare(a.move.class ?? '', b.move.class ?? ''))
    .slice(0, MAX_MOVES)
    .map(({ move }) => move);

/** A bucket's sessions and calls from the counts, or the plain error that a bucket of fewer than `minSessions` sessions (none, when it is missing) is not compared. */
const bucketHeader = (counts: Counts, harness: string, versionBucket: string, minSessions: number): BucketHeader => {
  const held = [...counts.buckets.values()].find((bucket) => bucket.harness === harness && bucket.versionBucket === versionBucket);
  if (held === undefined || held.tally.sessions.size < minSessions) {
    throw new PackError(`The ${versionBucket} bucket of ${harness} has ${String(held?.tally.sessions.size ?? 0)} sessions after the gates, under the minimum of ${String(minSessions)}. No note was written.`);
  }
  return { versionBucket, sessions: held.tally.sessions.size, calls: held.tally.calls };
};

/** The note over the store `runtime` names: the gates first (`countsOf`), then the two buckets compared. Throws a `PackError` for a bucket that is missing or under the minimum. */
export const noteOf = async (runtime: SessionsRuntime, options: NoteOptions): Promise<Note> => {
  const minSessions = options.minSessions ?? DEFAULT_MIN_SESSIONS;
  const counts = await countsOf(runtime, options);
  const from = bucketHeader(counts, options.harness, options.from, minSessions);
  const to = bucketHeader(counts, options.harness, options.to, minSessions);
  const moves = ranked(candidatesOf(sidesOf(counts, options.harness, options.from, minSessions), sidesOf(counts, options.harness, options.to, minSessions), Math.max(minSessions, 2)));
  return { spec: NOTE_SPEC, label: LABEL, builtOn: options.date, harness: options.harness, from, to, minSessions, result: moves.length === 0 ? 'no change' : 'moves', moves };
};

const VALUED = new Set(['--terms', '--owners', '--out', '--projects', '--min-sessions', '--date', '--harness', '--from', '--to']);
const BUCKET = /^\d+\.\d+\.\d+x$/;

/** The command: 0 when the note was written, 2 on a usage or input error (nothing written). Counts only in what it prints. */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const parsed = parseArgs(argv, VALUED);
  if ('bad' in parsed) {
    io.print(`Unknown or incomplete option: ${parsed.bad}\n${USAGE}`);
    return 2;
  }
  const common = commonOf(parsed.values, io);
  const [harness, from, to] = ['--harness', '--from', '--to'].map((flag) => parsed.values.get(flag));
  if (common === undefined || harness === undefined || from === undefined || to === undefined || !HARNESS_NAMES.some((name) => name === harness) || !BUCKET.test(from) || !BUCKET.test(to) || from === to) {
    io.print(`Missing or invalid option.\n${USAGE}`);
    return 2;
  }
  try {
    refuseInsideRepository(common.out, 'note');
    const note = await noteOf(runtimeFor(io, parsed.positional, parsed.values), { ...common, harness, from, to });
    const file = await writeJson(common.out, `note-${note.builtOn}-${harness}-${from}-to-${to}.json`, note);
    io.print(`Wrote ${file}: ${harness} ${from} to ${to}, result "${note.result}", moves: ${String(note.moves.length)}.`);
    return 0;
  } catch (error) {
    if (!(error instanceof PackError)) throw error;
    io.print(error.message);
    return 2;
  }
};
