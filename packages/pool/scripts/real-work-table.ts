// The real-work table (t1231, brief L1 of the one-fleet leaderboard): how real sessions went, per model, harness, and harness version bucket, and per tool, each row with its n.
// It reads an operator's sessions store, runs the exclusion gate (A38) and the owner filter before any count, and writes one `table.json` that must sit outside every repository.
// It reports counts and rates with n: no ranking score, no pass or fail label. The store's derived records (`loadStore`) and the pool's version bucketing (`harnessBucket`, as `bundleOf` keys a harness's bundle) are reused, not copied.
//   npm run real-work-table -w packages/pool -- <store folder> --terms <file> --owners <file> --out <dir> [--projects <folder>] [--min-sessions <n>] [--date <YYYY-MM-DD>]
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { harnessBucket } from '../../cli/src/sessions/cells.js';
import { stepsOfCall } from '../../cli/src/sessions/motif.js';
import { recoveryCallsOf, type Followed } from '../../cli/src/sessions/recovery-calls.js';
import { checkSession } from '../../cli/src/sessions/exclusion.js';
import { LITERAL, publicModel, TOOL_INPUT_KEYS } from '../../cli/src/sessions/public-vocabulary.js';
import { harnessOf, PROMPT_CLASSES, type Harness, type PromptObservation, type ToolObservation } from '../../cli/src/sessions/schema.js';
import { loadStore, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { insideRepository, ownerOf, PackError, parseOwners } from './sample-pack.js';

export { runtimeOf } from './sample-pack.js';

export const SPEC_VERSION = 'real-work-table/1';
export const LABEL = 'one fleet';
/** A row under this many sessions is left out; `--min-sessions` changes it. */
export const DEFAULT_MIN_SESSIONS = 5;
/** The harness names, as the store records them (`Harness`); the type check below keeps this list whole. */
export const HARNESS_NAMES = ['claude-code', 'cursor', 'codex', 'copilot', 'gemini', 'grok', 'opencode', 'pi', 'vscode-copilot', 'otel'] as const satisfies readonly Harness[];
const OTHER = 'other';
const UNKNOWN = 'unknown';

const USAGE = [
  'Usage: real-work-table <store folder> --terms <file> --owners <file> --out <dir> [--projects <folder>] [--min-sessions <n>] [--date <YYYY-MM-DD>]',
  '  <store folder>      the sessions store to read (never written)',
  '  --terms <file>      the exclusion term list (A38): a session whose transcript holds a term moves no number',
  '  --owners <file>     the owners file of sample-pack: a session in a folder no entry names is left out',
  '  --out <dir>         where table.json is written; refused inside a git repository',
  '  --projects <folder> the harness transcripts the exclusion gate scans (default: the runtime\'s)',
  `  --min-sessions <n>  a row under n sessions is left out (default ${String(DEFAULT_MIN_SESSIONS)})`,
  '  --date <date>       the build date (default: today, UTC)',
].join('\n');

export interface TableOptions {
  terms: string;
  owners: string;
  minSessions?: number;
  /** The build date, `YYYY-MM-DD`. */
  date: string;
}

export interface CellRow {
  kind: 'cell';
  model: string;
  harness: string;
  versionBucket: string;
  sessions: number;
  calls: number;
  failures: number;
  failureRate: number | null;
  recovered: number;
  callsToRecover: number | null;
  editFollowedShare: number | null;
  prompts: number;
  /** Prompts whose intervention the records can say (not `unknown`, not absent): the n of `interventionsPerPrompt`. */
  promptsKnown: number;
  interventions: number;
  interventionsPerPrompt: number | null;
  tokensPerPrompt: { class: string; prompts: number; tokensPerPrompt: number }[];
}

export interface ToolRow {
  kind: 'tool';
  tool: string;
  sessions: number;
  calls: number;
  failures: number;
  failureRate: number | null;
  recovered: number;
  callsToRecover: number | null;
  editFollowedShare: number | null;
}

export type Row = CellRow | ToolRow;

export interface Header {
  spec: string;
  label: string;
  builtOn: string;
  /** Main sessions in the store, before any gate. */
  sessions: number;
  /** Sessions that passed the exclusion gate and the owner filter. */
  counted: number;
  excluded: { term: number; noRaw: number; noTerms: number; unreadable: number; noOwner: number };
  minSessions: number;
  /** Rows dropped for being under the minimum. */
  leftOut: number;
}

export interface Table {
  header: Header;
  rows: Row[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const rounded = (value: number): number => Math.round(value * 10_000) / 10_000;
const share = (part: number, whole: number): number | null => (whole === 0 ? null : rounded(part / whole));

const harnessName = (harness: Harness): string => (HARNESS_NAMES.includes(harness) ? harness : OTHER);
const toolName = (tool: string): string => (TOOL_INPUT_KEYS.has(tool) ? tool : OTHER);
const modelName = (model: string | undefined): string => {
  if (model === undefined || model === '') return UNKNOWN;
  // The closed grammar of the wire (`publicModel`): a name it does not pass through unchanged is private or unknown.
  return model !== LITERAL && publicModel(model) === model ? model : OTHER;
};
/** `harnessBucket` gives a patch by tens (`2.1.3x`) and `unknown` for none; a version with no patch, and any other unmatched form, is `other`. */
const bucketName = (version: string | null | undefined): string => {
  const bucket = harnessBucket(version ?? null);
  return /^\d+\.\d+\.\d+x$/.test(bucket) || bucket === UNKNOWN ? bucket : OTHER;
};

/**
 * What a failed call leads to, from the pool's own `recoveryCallsOf`: the window is its next calls of the same prompt and run, and an edit counts only when its own result did not fail.
 * Calls to recover is the size of the shortest window in which such an edit appears (null when none does).
 */
const recoveryOf = (calls: readonly Followed[], at: number): { recoveredIn: number | null; edited: boolean } => {
  const whole = recoveryCallsOf(calls, at);
  if (whole === null || !whole.editFollowed) return { recoveredIn: null, edited: false };
  for (let end = at + 2; end <= calls.length; end += 1) {
    const window = recoveryCallsOf(calls.slice(0, end), at);
    if (window?.editFollowed === true) return { recoveredIn: window.next.length, edited: true };
  }
  return { recoveredIn: whole.next.length, edited: true };
};

interface Tally {
  sessions: Set<string>;
  calls: number;
  failures: number;
  recoverySteps: number;
  recovered: number;
  edited: number;
  prompts: number;
  promptsKnown: number;
  interventions: number;
  tokens: Map<string, { prompts: number; tokens: number }>;
}

const newTally = (): Tally => ({ sessions: new Set(), calls: 0, failures: 0, recoverySteps: 0, recovered: 0, edited: 0, prompts: 0, promptsKnown: 0, interventions: 0, tokens: new Map() });

const tokensOf = (prompt: PromptObservation): number => prompt.usage.input + prompt.usage.cacheWrite + prompt.usage.cacheRead + prompt.usage.output;

const callRates = (tally: Tally) => ({
  failures: tally.failures,
  failureRate: share(tally.failures, tally.calls),
  recovered: tally.recovered,
  callsToRecover: tally.recovered === 0 ? null : rounded(tally.recoverySteps / tally.recovered),
  editFollowedShare: share(tally.edited, tally.failures),
});

/** The table over the store `runtime` names: the gates first, then every count from the sessions that passed. */
export const tableOf = async (runtime: SessionsRuntime, options: TableOptions): Promise<Table> => {
  const minSessions = options.minSessions ?? DEFAULT_MIN_SESSIONS;
  const owners = parseOwners(await readFile(options.owners, 'utf8'));
  const store = await loadStore(runtime.storeDir);
  const main = store.sessions.filter((session) => session.supersededBy === undefined);
  const excluded = { term: 0, noRaw: 0, noTerms: 0, unreadable: 0, noOwner: 0 };
  const counted = new Map<string, Harness>();
  // The exclusion gate first, then the owner filter: a session either gate leaves out reaches no count below.
  for (const session of main) {
    const verdict = await checkSession(runtime, options.terms, session.project, session.session);
    if (verdict.reason === 'term') excluded.term += 1;
    else if (verdict.reason === 'no-raw') excluded.noRaw += 1;
    else if (verdict.reason === 'no-terms') excluded.noTerms += 1;
    else if (verdict.reason === 'unreadable') excluded.unreadable += 1;
    else if (ownerOf(owners, session.project) === undefined) excluded.noOwner += 1;
    else counted.set(session.session, harnessOf(session));
  }
  const versionOf = new Map(main.map((session) => [session.session, session.versions.at(-1)]));
  const modelOf = new Map(main.map((session) => [session.session, Object.entries(session.models).sort((a, b) => b[1] - a[1] || compare(a[0], b[0]))[0]?.[0]]));
  // A prompt's model is its frame's majority, else its own tally; `?` is the extractor's mark for a prompt that names none, and the session's most-used model stands in.
  const promptModelOf = (prompt: PromptObservation): string | undefined => prompt.frame?.model ?? (prompt.model === '?' ? undefined : prompt.model) ?? modelOf.get(prompt.session);
  const promptModel = new Map(store.prompts.map((prompt) => [`${prompt.session}#${String(prompt.index)}`, promptModelOf(prompt)]));

  const cells = new Map<string, { model: string; harness: string; versionBucket: string; tally: Tally }>();
  const tools = new Map<string, Tally>();
  const cellOf = (model: string, harness: string, versionBucket: string): Tally => {
    const key = JSON.stringify([model, harness, versionBucket]);
    const known = cells.get(key) ?? { model, harness, versionBucket, tally: newTally() };
    cells.set(key, known);
    return known.tally;
  };

  const toolOf = (tool: string): Tally => {
    const known = tools.get(tool) ?? newTally();
    tools.set(tool, known);
    return known;
  };

  // Calls, per transcript in call order, so a failed call looks forward over its own transcript only.
  const transcripts = new Map<string, ToolObservation[]>();
  for (const call of store.tools) {
    if (!counted.has(call.parent)) continue;
    transcripts.set(call.session, [...(transcripts.get(call.session) ?? []), call]);
  }
  for (const calls of transcripts.values()) {
    calls.sort((a, b) => a.n - b.n);
    // A call is read by its first step's action, as the pool's cells read it.
    const followed = calls.map((call) => ({ side: call.side, prompt: call.prompt, status: call.status, steps: stepsOfCall(call, counted.get(call.parent) ?? 'claude-code') }));
    calls.forEach((call, at) => {
      const harness = counted.get(call.parent) ?? 'claude-code';
      const model = modelName(call.model ?? promptModel.get(`${call.parent}#${String(call.prompt ?? -1)}`) ?? modelOf.get(call.parent));
      const bucket = bucketName(call.harnessVersion ?? versionOf.get(call.parent));
      const failed = call.status === 'error';
      const recovery = failed ? recoveryOf(followed, at) : undefined;
      for (const tally of [cellOf(model, harnessName(harness), bucket), toolOf(toolName(call.tool))]) {
        tally.sessions.add(call.parent);
        tally.calls += 1;
        if (recovery === undefined) continue;
        tally.failures += 1;
        if (recovery.edited) tally.edited += 1;
        if (recovery.recoveredIn !== null) {
          tally.recovered += 1;
          tally.recoverySteps += recovery.recoveredIn;
        }
      }
    });
  }

  for (const prompt of store.prompts) {
    const harness = counted.get(prompt.session);
    if (harness === undefined) continue;
    const model = modelName(promptModelOf(prompt));
    const bucket = bucketName(prompt.frame?.harnessVersion ?? versionOf.get(prompt.session));
    const tally = cellOf(model, harnessName(harness), bucket);
    tally.sessions.add(prompt.session);
    tally.prompts += 1;
    if (prompt.intervention !== undefined && prompt.intervention !== 'unknown') {
      tally.promptsKnown += 1;
      if (prompt.intervention !== 'none') tally.interventions += 1;
    }
    const cls = PROMPT_CLASSES.includes(prompt.cls) ? prompt.cls : OTHER;
    const held = tally.tokens.get(cls) ?? { prompts: 0, tokens: 0 };
    held.prompts += 1;
    held.tokens += tokensOf(prompt);
    tally.tokens.set(cls, held);
  }
  return finish(options, minSessions, main.length, counted.size, excluded, cells, tools);
};


const finish = (
  options: TableOptions,
  minSessions: number,
  sessions: number,
  counted: number,
  excluded: Header['excluded'],
  cells: ReadonlyMap<string, { model: string; harness: string; versionBucket: string; tally: Tally }>,
  tools: ReadonlyMap<string, Tally>,
): Table => {
  const all: Row[] = [
    ...[...cells.values()].map(({ model, harness, versionBucket, tally }): CellRow => ({
      kind: 'cell',
      model,
      harness,
      versionBucket,
      sessions: tally.sessions.size,
      calls: tally.calls,
      ...callRates(tally),
      prompts: tally.prompts,
      promptsKnown: tally.promptsKnown,
      interventions: tally.interventions,
      interventionsPerPrompt: share(tally.interventions, tally.promptsKnown),
      tokensPerPrompt: [...tally.tokens.entries()].sort((a, b) => compare(a[0], b[0])).map(([cls, held]) => ({ class: cls, prompts: held.prompts, tokensPerPrompt: Math.round(held.tokens / held.prompts) })),
    })),
    ...[...tools.entries()].map(([tool, tally]): ToolRow => ({ kind: 'tool', tool, sessions: tally.sessions.size, calls: tally.calls, ...callRates(tally) })),
  ];
  const kept = all.filter((row) => row.sessions >= minSessions);
  const key = (row: Row): string => (row.kind === 'cell' ? `0/${row.harness}/${row.versionBucket}/${row.model}` : `1/${row.tool}`);
  kept.sort((a, b) => compare(key(a), key(b)));
  return { header: { spec: SPEC_VERSION, label: LABEL, builtOn: options.date, sessions, counted, excluded, minSessions, leftOut: all.length - kept.length }, rows: kept };
};

export interface Io {
  runtime: SessionsRuntime;
  print: (text: string) => void;
  now?: () => number;
}

const VALUED = new Set(['--terms', '--owners', '--out', '--projects', '--min-sessions', '--date']);

/** The command: 0 when table.json was written, 2 on a usage or input error (nothing written). Counts only in what it prints. */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at] ?? '';
    if (!flag.startsWith('--')) {
      positional.push(flag);
      continue;
    }
    const value = argv[at + 1];
    if (!VALUED.has(flag) || value === undefined) {
      io.print(`Unknown or incomplete option: ${flag}\n${USAGE}`);
      return 2;
    }
    values.set(flag, value);
    at += 1;
  }
  const [terms, owners, out] = ['--terms', '--owners', '--out'].map((flag) => values.get(flag));
  const minText = values.get('--min-sessions');
  const minSessions = minText === undefined ? DEFAULT_MIN_SESSIONS : Number(minText);
  const date = values.get('--date') ?? new Date((io.now ?? Date.now)()).toISOString().slice(0, 10);
  if (terms === undefined || owners === undefined || out === undefined || !Number.isInteger(minSessions) || minSessions < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    io.print(`Missing or invalid option.\n${USAGE}`);
    return 2;
  }
  try {
    if (insideRepository(out)) throw new PackError('The output folder is inside a git repository. Write the table to a folder outside every repository, then publish it by the page build.');
    const store = positional[0];
    const runtime: SessionsRuntime = {
      ...(store === undefined ? io.runtime : { ...io.runtime, storeDir: resolve(store) }),
      ...(values.has('--projects') ? { projectsRoot: resolve(values.get('--projects') ?? '') } : {}),
    };
    const table = await tableOf(runtime, { terms, owners, minSessions, date });
    await mkdir(resolve(out), { recursive: true });
    const file = join(resolve(out), 'table.json');
    await writeFile(`${file}.tmp`, `${JSON.stringify(table, null, 2)}\n`);
    await rename(`${file}.tmp`, file);
    io.print(`Wrote ${file}: ${String(table.rows.length)} rows from ${String(table.header.counted)} of ${String(table.header.sessions)} sessions (${String(table.header.leftOut)} rows under ${String(minSessions)} sessions left out).`);
    return 0;
  } catch (error) {
    if (!(error instanceof PackError)) throw error;
    io.print(error.message);
    return 2;
  }
};
