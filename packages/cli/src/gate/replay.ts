// `oars gate replay`: the crossing checks over logs already on disk. It reads raw transcripts under the allowlist and writes one file, `crossings.jsonl`.
// It never calls `localSalt` or the step log, both of which write, and it holds no store lock, since a replay touches nothing a deposit reads.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError, ExitCode } from '../errors.js';
import { compileAllow } from '../sessions/allow.js';
import { makeRedactor } from '../sessions/redact.js';
import { paths, readState, writeAtomic, type SessionsRuntime } from '../sessions/store.js';
import type { Crossing, UnreadShape } from './checks.js';
import { GATE_VERSION, parseRows, type AgainstLatest, type CrossingRecord, type Next, type Novelty, type Origin, type RegistryAge, type RegistryRow, type RunRow } from './record.js';
import { askable, type RegistryAnswer, type RegistryAsk, type RegistryReader } from './registry.js';
import { discover, readCalls, readOrigins, type CallsSeen, type Origins, type Found, type FoundRemoval, type TranscriptFile, type TranscriptRead } from './transcripts.js';

export const crossingsFile = (storeDir: string): string => join(storeDir, 'crossings.jsonl');

export const REGISTRY_NOT_READ = 'registry state not read';

export interface ReplayOptions {
  /** Project folders to read; empty means the saved allowlist. */
  allow: readonly string[];
  /** Only with `--registry-state`. Absent, nothing leaves this machine. */
  registry?: RegistryReader;
  now: () => number;
}

export interface ReplayResult {
  run: RunRow;
  file: string;
  text: string;
}

/** A failed install is looked at for this many calls after it. */
const NEXT_WINDOW = 10;
const DAY_MS = 86_400_000;
const REGISTRY_WORKERS = 4;
/** A kept registry answer older than this many days is asked again: a `latest` goes stale, and a row would otherwise read "as of this run" forever. */
export const REGISTRY_MAX_DAYS = 30;
/** Only these managers read the registry the `npm view` and `pip index` asks reach. A `pnpm` (its own global `rc`), `poetry`, `uv`, `yarn`, or `conda` install may use one they do not. */
const ASKED_PROGRAMS: ReadonlySet<string> = new Set(['npm', 'npx', 'pip', 'python -m pip']);

const keyOf = (crossing: Pick<Crossing, 'class' | 'name'>): string => `${crossing.class}\0${crossing.name}`;

/** Claude Code names a worktree's folder `<repository>--claude-worktrees-<name>`, and a worktree is its repository. */
const repositoryOf = (project: string): string => project.replace(/--claude-worktrees-.*$/, '');

const PACKAGE_CLASSES: ReadonlySet<string> = new Set(['npm-package', 'python-package']);

const nextOf = (found: Found, read: TranscriptRead): Next => {
  if (found.status === 'ok') return 'proceeded';
  if (found.status === 'none') return 'no-result';
  const end = found.call + NEXT_WINDOW;
  const { crossing } = found;
  const later = read.found.find((one) => one.call > found.call && one.call <= end && one.crossing.class === crossing.class && (one.crossing.name === crossing.name || PACKAGE_CLASSES.has(crossing.class)));
  if (read.pipes.some((call) => call > found.call && call <= end && (later === undefined || call < later.call))) return 'routed-around';
  if (later === undefined) return 'stopped';
  if (later.crossing.name !== crossing.name) return 'changed-name';
  return later.crossing.program === crossing.program && later.crossing.form === crossing.form ? 'retried' : 'routed-around';
};

interface Held {
  found: Found;
  transcript: TranscriptFile;
  origin: Origin;
  /** The operator's own prompt named the package before this transcript's first crossing of it. */
  prompted: boolean;
  next: Next;
}

const originsOf = async (transcript: TranscriptFile, read: TranscriptRead): Promise<Origins> => {
  const firstLines = new Map<string, number>();
  const servers = new Set<string>();
  for (const { crossing, line } of read.found) {
    if (!firstLines.has(crossing.name)) firstLines.set(crossing.name, line);
    if (crossing.class === 'mcp-server') servers.add(crossing.name);
  }
  return firstLines.size === 0 ? { origins: new Map<string, Origin>(), prompted: new Set<string>() } : readOrigins(transcript.file, firstLines, servers);
};

const byTime = (one: { ts: string | null }, two: { ts: string | null }): number => {
  if (one.ts === two.ts) return 0;
  if (one.ts === null) return 1;
  if (two.ts === null) return -1;
  return one.ts < two.ts ? -1 : 1;
};

/** The widest scope in which this is the first use, read in time order so a run's result does not depend on the order folders list in. */
const noveltyWalker = (): ((held: Held) => Novelty) => {
  const fleet = new Set<string>();
  const repositories = new Set<string>();
  const sessions = new Set<string>();
  return (held) => {
    const key = keyOf(held.found.crossing);
    const inRepository = `${repositoryOf(held.transcript.project)}\0${key}`;
    const inSession = `${held.transcript.session}\0${key}`;
    let novelty: Novelty = 'none';
    if (!fleet.has(key)) novelty = 'fleet';
    else if (!repositories.has(inRepository)) novelty = 'repository';
    else if (!sessions.has(inSession)) novelty = 'session';
    fleet.add(key);
    repositories.add(inRepository);
    sessions.add(inSession);
    return novelty;
  };
};

const lastRemovals = (removals: readonly { removal: FoundRemoval; transcript: TranscriptFile }[]): Map<string, string> => {
  const last = new Map<string, string>();
  for (const { removal, transcript } of removals) {
    if (removal.status === 'error' || removal.status === 'refused' || removal.ts === null) continue;
    const key = `${repositoryOf(transcript.project)}\0${keyOf(removal.removal)}`;
    if ((last.get(key) ?? '') < removal.ts) last.set(key, removal.ts);
  }
  return last;
};

const ageOf = (answer: RegistryAnswer, ts: string | null): RegistryAge => {
  if (answer.created === null || ts === null) return 'unknown';
  const days = (Date.parse(ts) - Date.parse(answer.created)) / DAY_MS;
  if (Number.isNaN(days)) return 'unknown';
  if (days < 0) return 'after-crossing';
  if (days < 7) return 'under-7-days';
  if (days < 30) return 'under-30-days';
  return days < 365 ? 'under-1-year' : 'older';
};

const againstLatestOf = (crossing: Crossing, answer: RegistryAnswer): AgainstLatest => {
  if (answer.state !== 'found') return 'unknown';
  if (crossing.versionForm === 'unstated') return 'unstated';
  if (crossing.versionForm === 'range') return 'range';
  if (crossing.version === 'latest' || crossing.version === answer.latest) return 'latest';
  return crossing.versionForm === 'pinned' ? 'not-latest' : 'unknown';
};

const asAnswer = (row: RegistryRow): RegistryAnswer => ({ state: row.state, latest: row.latest, created: row.created });

const isFolder = (path: string): Promise<boolean> =>
  stat(path).then(
    (found) => found.isDirectory(),
    () => false,
  );

/** A command, its environment, or an earlier `cd` chose that call's registry or config: the gate cannot read it from here, so the name is not asked, kept answers included. */
const unaskedKeys = (rows: readonly Held[]): Set<string> => new Set(rows.filter(({ found }) => !found.crossing.registryAsked).map(({ found }) => keyOf(found.crossing)));

/** One question per name, from the first call whose folder still exists: the manager reads its registry from there, and a guess at another folder could ask the wrong one. */
const askRegistry = async (rows: readonly Held[], reader: RegistryReader, cached: ReadonlyMap<string, RegistryRow>): Promise<Map<string, RegistryAnswer>> => {
  const unasked = unaskedKeys(rows);
  const answers = new Map<string, RegistryAnswer>([...cached].filter(([key]) => !unasked.has(key)).map(([key, row]) => [key, asAnswer(row)]));
  const folders = new Map<string, boolean>();
  const asks = new Map<string, RegistryAsk>();
  for (const { found } of rows) {
    const { crossing, cwd } = found;
    const key = keyOf(crossing);
    if (cwd === null || unasked.has(key) || answers.has(key) || asks.has(key) || crossing.versionForm === 'url' || !ASKED_PROGRAMS.has(crossing.program) || !askable(crossing.class, crossing.name)) continue;
    const exists = folders.get(cwd) ?? (await isFolder(cwd));
    folders.set(cwd, exists);
    if (exists) asks.set(key, { class: crossing.class, name: crossing.name, cwd });
  }
  const queue = [...asks];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      const [key, ask] = item;
      answers.set(key, await reader(ask).catch((): RegistryAnswer => ({ state: 'unreachable', latest: null, created: null })));
    }
  };
  await Promise.all(Array.from({ length: REGISTRY_WORKERS }, worker));
  return answers;
};

const recordOf = (held: Held, novelty: Novelty, removedAt: string | undefined, answers: ReadonlyMap<string, RegistryAnswer> | undefined): CrossingRecord => {
  const { found, transcript, origin, prompted, next } = held;
  const { crossing, ts, side } = found;
  // An answer reaches a row only when that row's own program was asked and its command left the registry to the default: the same name can cross twice.
  const answer = crossing.registryAsked && ASKED_PROGRAMS.has(crossing.program) ? answers?.get(keyOf(crossing)) : undefined;
  return {
    kind: 'crossing',
    v: GATE_VERSION,
    day: ts === null ? null : ts.slice(0, 10),
    class: crossing.class,
    form: crossing.form,
    program: crossing.program,
    versionForm: crossing.versionForm,
    statusReports: crossing.statusReports,
    origin,
    novelty,
    // The operator named it only on the main line: a subagent's prompt is another model's words.
    decidedBy: prompted && !side ? 'operator' : 'agent',
    permission: found.permission,
    status: found.status,
    next,
    removedLater: removedAt !== undefined && ts !== null && ts < removedAt,
    depth: side ? 'subagent' : 'main',
    miss: found.miss,
    againstLatest: answer === undefined ? 'not-read' : againstLatestOf(crossing, answer),
    registryState: answer?.state ?? 'not-read',
    registryAge: answer === undefined ? 'not-read' : ageOf(answer, ts),
    arm: 'none',
    lineShown: 'none',
    session: transcript.session,
    agent: transcript.agent,
    toolUseId: found.toolUseId,
    ts,
    name: crossing.name,
    version: crossing.version,
  };
};

const cachedAnswers = async (file: string, now: number): Promise<Map<string, RegistryRow>> => {
  const text = await readFile(file, 'utf8').catch(() => '');
  return new Map(
    parseRows(text)
      .filter((row): row is RegistryRow => row.kind === 'registry' && (now - Date.parse(row.day)) / DAY_MS <= REGISTRY_MAX_DAYS)
      .map((row) => [keyOf(row), row]),
  );
};

const registryRows = (answers: ReadonlyMap<string, RegistryAnswer>, rows: readonly Held[], cached: ReadonlyMap<string, RegistryRow>, day: string): RegistryRow[] => {
  const added = new Map<string, RegistryRow>();
  const unasked = unaskedKeys(rows);
  for (const { found } of rows) {
    const key = keyOf(found.crossing);
    const answer = answers.get(key);
    // An unreachable registry says nothing about the name, so a later run asks again.
    if (cached.has(key) || added.has(key) || answer === undefined || answer.state === 'unreachable') continue;
    added.set(key, { kind: 'registry', v: GATE_VERSION, day, class: found.crossing.class, state: answer.state, created: answer.created, name: found.crossing.name, latest: answer.latest });
  }
  return [...[...cached].filter(([key]) => !unasked.has(key)).map(([, row]) => row), ...added.values()];
};

const summaryText = (run: RunRow, file: string): string =>
  [
    `Read ${String(run.transcripts)} transcripts (${String(run.unreadable)} unreadable, ${String(run.badLines)} torn lines) and ${String(run.calls)} tool calls.`,
    `Crossings: ${String(run.crossings)}. Written to ${file}.`,
    run.registryRead ? 'Registry state read through the package manager, as of this run, not as of each crossing.' : REGISTRY_NOT_READ,
    'Counts: oars gate report',
  ].join('\n');

interface Reads {
  reads: { transcript: TranscriptFile; read: TranscriptRead }[];
  transcripts: number;
  unreadable: number;
}

const readAll = async (runtime: Pick<SessionsRuntime, 'storeDir' | 'projectsRoot'>, entries: readonly string[], domains: readonly string[]): Promise<Reads> => {
  const redact = makeRedactor(domains);
  const { files, unreadable: unlisted } = await discover([runtime.projectsRoot, paths(runtime.storeDir).raw], compileAllow(entries));
  const seen: CallsSeen = new Map();
  const reads: Reads['reads'] = [];
  let unreadable = unlisted;
  for (const transcript of files) {
    try {
      reads.push({ transcript, read: await readCalls(transcript.file, transcript.agent, redact, seen) });
    } catch {
      unreadable += 1;
    }
  }
  return { reads, transcripts: files.length, unreadable };
};

export const replay = async (runtime: Pick<SessionsRuntime, 'storeDir' | 'projectsRoot'>, options: ReplayOptions): Promise<ReplayResult> => {
  const state = await readState(runtime.storeDir);
  const entries = options.allow.length > 0 ? options.allow : state.allow;
  if (entries.length === 0) throw new CliError('Name a folder with --allow: nothing is read from a folder you have not named, and no deposit has saved an allowlist.', ExitCode.USAGE, 'usage');
  const { reads, transcripts, unreadable } = await readAll(runtime, entries, state.redactDomains);
  const held: Held[] = [];
  for (const { transcript, read } of reads) {
    const { origins, prompted } = await originsOf(transcript, read).catch((): Origins => ({ origins: new Map<string, Origin>(), prompted: new Set<string>() }));
    for (const found of read.found) held.push({ found, transcript, origin: origins.get(found.crossing.name) ?? 'none-seen', prompted: prompted.has(found.crossing.name), next: nextOf(found, read) });
  }
  held.sort((one, two) => byTime(one.found, two.found));
  const removedAt = lastRemovals(reads.flatMap(({ transcript, read }) => read.removals.map((removal) => ({ removal, transcript }))));
  const file = crossingsFile(runtime.storeDir);
  const cached = await cachedAnswers(file, options.now());
  const answers = options.registry === undefined ? undefined : await askRegistry(held, options.registry, cached);
  const novelty = noveltyWalker();
  const records = held.map((one) => recordOf(one, novelty(one), removedAt.get(`${repositoryOf(one.transcript.project)}\0${keyOf(one.found.crossing)}`), answers));
  const unread: Partial<Record<UnreadShape, number>> = {};
  for (const { read } of reads) {
    for (const shape of read.unread) unread[shape] = (unread[shape] ?? 0) + 1;
  }
  const day = new Date(options.now()).toISOString().slice(0, 10);
  const run: RunRow = {
    kind: 'run',
    v: GATE_VERSION,
    day,
    transcripts,
    unreadable,
    badLines: reads.reduce((sum, { read }) => sum + read.badLines, 0),
    calls: reads.reduce((sum, { read }) => sum + read.fresh, 0),
    crossings: records.length,
    unread,
    registryRead: options.registry !== undefined,
  };
  const registry = registryRows(answers ?? new Map<string, RegistryAnswer>(), held, cached, day);
  await writeAtomic(file, `${[run, ...registry, ...records].map((row) => JSON.stringify(row)).join('\n')}\n`);
  return { run, file, text: summaryText(run, file) };
};
