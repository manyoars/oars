// The failure and continuation index (docs/pool.md, "The failure and continuation index"): every distinct tool-error episode of a built pack, with what the agent did next, read from the pack's
// skeletons. With `--text-sample` it also opens a seeded draw of the pack's transcripts at each episode's pointer and records whether the text holds the error and the continuation.
// It writes field values from the skeletons, a class, and a reason word; never transcript text.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseSkeleton, type SessionSkeleton, type SkeletonTool, type SkeletonTranscript } from '../../cli/src/sessions/pool-wire.js';
import { RECOVERY_CALLS } from '../../cli/src/sessions/recovery-calls.js';
import { EXIT_CLASSES, HTTP_STATUSES } from '../../cli/src/sessions/schema.js';
import { parseArgs, refuseInsideRepository, writeJson } from './real-work-table.js';
import { PackError } from './sample-pack.js';
import { MATCH_ID } from './skeleton-trace.js';

export const USAGE = [
  'Usage: npm run failure-index -w packages/pool -- <pack folder> --out <dir> [--text-sample <n> --seed <text>]',
  '  <pack folder>       a built pack: manifest.jsonl and sessions/<match id>/<skeleton>, read only',
  '  --out <dir>         where failure-index.jsonl and failure-index.summary.json are written; refused inside a git repository',
  '  --text-sample <n>   also open n seeded sessions\' transcripts at each episode\'s pointer (dossier-yield.jsonl, dossier-yield.summary.json)',
  '  --seed <text>       the draw\'s seed; needed with --text-sample',
].join('\n');

const VALUED = new Set(['--out', '--text-sample', '--seed']);
const STAND_IN_ID = '0'.repeat(16);
const EXIT: ReadonlySet<string> = new Set(EXIT_CLASSES);
const HTTP: ReadonlySet<string> = new Set(HTTP_STATUSES);

export interface Io {
  print: (text: string) => void;
}

/** Where an episode's calls are: the transcript, its run and prompt, each attempt's position in the transcript's `tools`, the first attempt's tool name, and the transcript's file under the session folder. */
export interface Pointer {
  transcript: number;
  side: boolean;
  prompt: number | null;
  calls: number[];
  native: string;
  file: string | null;
}

export interface Episode {
  session: string;
  family: string;
  errorCodes: string[];
  attempts: number;
  continuation: string[];
  editFollowed: boolean;
  retryChanges: string[];
  pointer: Pointer;
}

export interface FamilyCount {
  episodes: number;
  attempts: number;
  sessions: number;
}

export interface Summary {
  spec: 'failure-index/1';
  sessionsRead: number;
  sessionsWithEpisode: number;
  episodes: number;
  failedCalls: number;
  editFollowedCalls: number;
  editFollowedEpisodes: number;
  noContinuationEpisodes: number;
  families: { [family: string]: FamilyCount };
}

/** One session of the pack as the index reads it: its match id, its skeleton, and how many transcript files the row ships. */
export interface PackSession {
  matchId: string;
  transcriptFiles: number;
  skeleton: SessionSkeleton;
}

const isFields = (value: unknown): value is { readonly [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A failed call's code as a group: a shell exit status and an HTTP status each form one group; a harness class and `other` are their own; a failure captured without a code is `uncoded`. */
const groupOf = (code: string | null): string => (code === null ? 'uncoded' : EXIT.has(code) ? 'exit' : HTTP.has(code) ? 'http' : code);

const actionOf = (tool: SkeletonTool): string => tool.steps[0]?.action ?? 'other';

/** The error family: the failed call's action and the group of its code. */
export const familyOf = (tool: SkeletonTool): string => `${actionOf(tool)} ${groupOf(tool.errorCode)}`;

/** The positions of the calls that followed the call at `at`, counted as `recoveryCallsOf` counts them: the same run, the same prompt, up to five; a call of the other run is skipped, another prompt ends it. */
export const followingOf = (tools: readonly SkeletonTool[], at: number): number[] => {
  const from = tools[at];
  const found: number[] = [];
  if (from === undefined) return found;
  for (let index = at + 1; index < tools.length && found.length < RECOVERY_CALLS; index += 1) {
    const call = tools[index];
    if (call === undefined || call.side !== from.side) continue;
    if (call.prompt !== from.prompt) break;
    found.push(index);
  }
  return found;
};

interface Open {
  family: string;
  calls: number[];
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** The episodes of one transcript, in the order their first attempts ran. */
const episodesOfTranscript = (session: string, transcript: SkeletonTranscript, at: number, transcriptFiles: number): Episode[] => {
  const { tools } = transcript;
  const opened: Open[] = [];
  tools.forEach((tool, position) => {
    if (tool.status !== 'error') return;
    const family = familyOf(tool);
    const joins = opened.find((open) => open.family === family && followingOf(tools, open.calls[open.calls.length - 1] ?? -1).includes(position));
    if (joins === undefined) opened.push({ family, calls: [position] });
    else joins.calls.push(position);
  });
  return opened.map(({ family, calls }) => {
    const attempts = calls.map((position) => tools[position]).filter((tool): tool is SkeletonTool => tool !== undefined);
    const [first] = attempts;
    const last = attempts[attempts.length - 1];
    return {
      session,
      family,
      errorCodes: sorted(attempts.map(({ errorCode }) => errorCode ?? 'uncoded')),
      attempts: attempts.length,
      continuation: [...(last?.recoveryCalls?.next ?? [])],
      editFollowed: last?.recoveryCalls?.editFollowed ?? false,
      retryChanges: sorted(attempts.slice(1).flatMap(({ changeKind }) => changeKind ?? [])),
      pointer: { transcript: at, side: first?.side ?? false, prompt: first?.prompt ?? null, calls, native: first?.steps[0]?.native ?? 'other', file: at === 0 && transcriptFiles > 0 ? 'main.jsonl' : null },
    };
  });
};

/** Every episode of one session, transcript by transcript. */
export const episodesOf = ({ matchId, transcriptFiles, skeleton }: PackSession): Episode[] =>
  skeleton.transcripts.flatMap((transcript, at) => episodesOfTranscript(matchId, transcript, at, transcriptFiles));

/** The counts and the denominator of an index. */
export const summaryOf = (sessions: readonly PackSession[], episodes: readonly Episode[]): Summary => {
  let failedCalls = 0;
  let editFollowedCalls = 0;
  for (const { skeleton } of sessions) {
    for (const { tools } of skeleton.transcripts) {
      for (const tool of tools) {
        if (tool.status === 'error') failedCalls += 1;
        if (tool.recoveryCalls?.editFollowed === true) editFollowedCalls += 1;
      }
    }
  }
  const families = new Map<string, { episodes: number; attempts: number; sessions: Set<string> }>();
  for (const { family, attempts, session } of episodes) {
    const held = families.get(family) ?? { episodes: 0, attempts: 0, sessions: new Set<string>() };
    held.episodes += 1;
    held.attempts += attempts;
    held.sessions.add(session);
    families.set(family, held);
  }
  return {
    spec: 'failure-index/1',
    sessionsRead: sessions.length,
    sessionsWithEpisode: new Set(episodes.map(({ session }) => session)).size,
    episodes: episodes.length,
    failedCalls,
    editFollowedCalls,
    editFollowedEpisodes: episodes.filter(({ editFollowed }) => editFollowed).length,
    noContinuationEpisodes: episodes.filter(({ continuation }) => continuation.length === 0).length,
    families: Object.fromEntries(sorted(families.keys()).map((family) => {
      const held = families.get(family);
      return [family, { episodes: held?.episodes ?? 0, attempts: held?.attempts ?? 0, sessions: held?.sessions.size ?? 0 }];
    })),
  };
};

const readText = async (file: string, what: string): Promise<string> => {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw new PackError(`No ${what} at ${file}.`);
    throw error;
  }
};

/** Parses one JSON text; a failure names `where` and never the text, which can hold transcript words. */
const jsonOf = (source: string, where: string): unknown => {
  try {
    return JSON.parse(source);
  } catch {
    throw new PackError(`${where} is not valid JSON.`);
  }
};

/** The pack's sessions in match id order, each skeleton read by the pool's own reader; a row or a skeleton it cannot read stops the run, naming the file and never a value. */
export const readPack = async (pack: string): Promise<PackSession[]> => {
  const manifest = join(pack, 'manifest.jsonl');
  const rows = (await readText(manifest, 'manifest')).split('\n').filter((line) => line.trim() !== '');
  const sessions: PackSession[] = [];
  for (const [index, line] of rows.entries()) {
    const where = `${manifest}:${String(index + 1)}`;
    const row = jsonOf(line, where);
    if (!isFields(row) || typeof row.matchId !== 'string' || !MATCH_ID.test(row.matchId) || typeof row.skeleton !== 'string' || typeof row.transcripts !== 'number') throw new PackError(`${where} lacks a match id, a skeleton, or a transcript count.`);
    const file = join(pack, 'sessions', row.matchId, row.skeleton);
    const value = jsonOf(await readText(file, 'skeleton'), file);
    const parsed = parseSkeleton(isFields(value) ? { ...value, id: STAND_IN_ID } : value);
    if (!parsed.ok) throw new PackError(`${file} is not a skeleton the pool reads (${parsed.field}: ${parsed.reason}).`);
    sessions.push({ matchId: row.matchId, transcriptFiles: row.transcripts, skeleton: parsed.skeleton });
  }
  return sessions.sort((a, b) => (a.matchId < b.matchId ? -1 : 1));
};

/** The text check's classes (docs/pool.md): the error and the continuation are both in the text, one of them is short, the call is not there, or a subagent transcript the check does not open. */
export const TEXT_CLASSES = ['supports', 'partly', 'missing', 'unresolved'] as const;
export type TextClass = (typeof TEXT_CLASSES)[number];

export interface TextCheck {
  session: string;
  family: string;
  calls: number[];
  class: TextClass;
  reason: string;
}

export interface YieldSummary {
  spec: 'dossier-yield/1';
  seed: string;
  sessionsDrawn: number;
  episodes: number;
  classes: { [name in TextClass]: { episodes: number; per100Sessions: number } };
}

interface Use {
  name: string;
  /** The JSON length of the call's input: 2 for `{}`. */
  inputLength: number;
}

interface Result {
  isError: boolean;
  textLength: number;
  line: number;
}

/** What the check reads of a transcript: its distinct calls in order, each call's result by call position, and the lines an assistant wrote. Lengths and flags, never the text. */
export interface Transcript {
  uses: Use[];
  results: Map<number, Result>;
  assistantLines: number[];
  /** The lines where a user turn starts: a user line with text of its own, not a tool result. */
  promptLines: number[];
}

const textLengthOf = (content: unknown): number => {
  if (typeof content === 'string') return content.trim().length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) if (isFields(block) && typeof block.text === 'string') total += block.text.trim().length;
  return total;
};

/** A user turn starts with a string, or with a text block; a tool result, even with hook text beside it, is the harness answering the assistant. */
const startsPrompt = (content: unknown): boolean => typeof content === 'string' || (Array.isArray(content) && content.some((block) => isFields(block) && block.type === 'text') && !content.some((block) => isFields(block) && block.type === 'tool_result'));

/** Reads a Claude Code transcript: call k is the k-th distinct `tool_use` id of the assistant lines, the order the skeleton's `tools` holds. */
export const transcriptOf = (text: string, file = 'transcript'): Transcript => {
  const positions = new Map<string, number>();
  const uses: Use[] = [];
  const results = new Map<number, Result>();
  const assistantLines: number[] = [];
  const promptLines: number[] = [];
  text.split('\n').forEach((source, line) => {
    if (source.trim() === '') return;
    const value = jsonOf(source, `${file}:${String(line + 1)}`);
    if (isFields(value) && value.type === 'user' && isFields(value.message) && startsPrompt(value.message.content)) promptLines.push(line);
    if (!isFields(value) || !isFields(value.message) || !Array.isArray(value.message.content)) return;
    if (value.type === 'assistant') assistantLines.push(line);
    for (const block of value.message.content) {
      if (!isFields(block)) continue;
      if (value.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string' && !positions.has(block.id)) {
        positions.set(block.id, uses.length);
        uses.push({ name: typeof block.name === 'string' ? block.name : '', inputLength: JSON.stringify(block.input ?? {}).length });
      }
      const position = value.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string' ? positions.get(block.tool_use_id) : undefined;
      if (position !== undefined && !results.has(position)) results.set(position, { isError: block.is_error === true, textLength: textLengthOf(block.content), line });
    }
  });
  return { uses, results, assistantLines, promptLines };
};

/** One episode against its transcript's text. `tools` is the transcript's skeleton calls, so a call is found by position and its name checked against the skeleton's. */
export const checkEpisode = (episode: Episode, tools: readonly SkeletonTool[], text: Transcript | undefined): TextCheck => {
  const { session, family, pointer } = episode;
  const verdict = (cls: TextClass, reason: string): TextCheck => ({ session, family, calls: pointer.calls, class: cls, reason });
  if (pointer.transcript !== 0) return verdict('unresolved', 'subagent transcript');
  if (text === undefined) return verdict('missing', 'no transcript file');
  if (text.uses.length !== tools.length) return verdict('missing', 'call count differs');
  const named = (position: number): boolean => text.uses[position]?.name === tools[position]?.steps[0]?.native;
  if (!pointer.calls.every(named)) return verdict('missing', 'call not at pointer');
  const results = pointer.calls.map((position) => text.results.get(position));
  if (results.some((result) => result === undefined)) return verdict('partly', 'error result missing');
  if (results.some((result) => result?.isError !== true)) return verdict('partly', 'result not flagged an error');
  if (results.some((result) => result?.textLength === 0)) return verdict('partly', 'error result empty');
  const following = followingOf(tools, pointer.calls[pointer.calls.length - 1] ?? 0).slice(0, episode.continuation.length);
  if (following.length === 0) {
    const after = results[results.length - 1]?.line ?? 0;
    // The reply is the assistant's next lines before the next prompt; a later prompt's reply is another episode's.
    const next = text.promptLines.find((line) => line > after) ?? Infinity;
    return text.assistantLines.some((line) => line > after && line < next) ? verdict('supports', 'no call followed, reply present') : verdict('partly', 'no reply after the error');
  }
  if (!following.every((position) => named(position) && (text.uses[position]?.inputLength ?? 0) > 2)) return verdict('partly', 'continuation call missing or empty');
  return verdict('supports', 'error and continuation present');
};

const hexOf = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The seeded draw: the match ids ordered by the SHA-256 of the seed, a colon, and the id; the first `size`. */
export const drawOf = (ids: readonly string[], seed: string, size: number): string[] =>
  ids
    .map((id) => ({ id, key: hexOf(`${seed}:${id}`) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .slice(0, size)
    .map(({ id }) => id);

/** The text check over the drawn sessions; a session's transcript is read once and dropped before the next. */
export const yieldOf = async (pack: string, sessions: readonly PackSession[], episodes: readonly Episode[], seed: string, size: number): Promise<{ checks: TextCheck[]; summary: YieldSummary }> => {
  const drawn = new Set(drawOf(sessions.map(({ matchId }) => matchId), seed, size));
  const checks: TextCheck[] = [];
  for (const session of sessions) {
    const own = episodes.filter((episode) => episode.session === session.matchId);
    if (!drawn.has(session.matchId) || own.length === 0) continue;
    const file = join(pack, 'sessions', session.matchId, 'main.jsonl');
    const text = session.transcriptFiles > 0 ? transcriptOf(await readText(file, 'transcript'), file) : undefined;
    const tools = session.skeleton.transcripts[0]?.tools ?? [];
    for (const episode of own) checks.push(checkEpisode(episode, tools, text));
  }
  const countOf = (name: TextClass): { episodes: number; per100Sessions: number } => {
    const count = checks.filter((check) => check.class === name).length;
    return { episodes: count, per100Sessions: Math.round((count * 10000) / drawn.size) / 100 };
  };
  return { checks, summary: { spec: 'dossier-yield/1', seed, sessionsDrawn: drawn.size, episodes: checks.length, classes: { supports: countOf('supports'), partly: countOf('partly'), missing: countOf('missing'), unresolved: countOf('unresolved') } } };
};

/** Writes rows as JSON lines through a temporary file, so a reader never sees half of them. */
const writeLines = async (dir: string, name: string, rows: readonly unknown[]): Promise<void> => {
  await mkdir(resolve(dir), { recursive: true });
  const file = join(resolve(dir), name);
  await writeFile(`${file}.tmp`, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  await rename(`${file}.tmp`, file);
};

/** The command: 0 when the files were written, 2 on a usage or input error. Counts only in what it prints. */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const parsed = parseArgs(argv, VALUED);
  if ('bad' in parsed) {
    io.print(`Unknown or incomplete option: ${parsed.bad}\n${USAGE}`);
    return 2;
  }
  const [pack] = parsed.positional;
  const out = parsed.values.get('--out');
  const sampleText = parsed.values.get('--text-sample');
  const seed = parsed.values.get('--seed');
  const sample = sampleText === undefined ? undefined : Number(sampleText);
  if (pack === undefined || parsed.positional.length > 1 || out === undefined || (sample !== undefined && (!Number.isInteger(sample) || sample < 1)) || (sample === undefined) !== (seed === undefined)) {
    io.print(`Missing or invalid option.\n${USAGE}`);
    return 2;
  }
  try {
    refuseInsideRepository(out, 'index');
    const sessions = await readPack(resolve(pack));
    const episodes = sessions.flatMap(episodesOf);
    const summary = summaryOf(sessions, episodes);
    await writeLines(out, 'failure-index.jsonl', episodes);
    const file = await writeJson(out, 'failure-index.summary.json', summary);
    io.print(`Wrote ${file}: ${String(summary.episodes)} episodes in ${String(summary.sessionsWithEpisode)} of ${String(summary.sessionsRead)} sessions.`);
    if (sample !== undefined && seed !== undefined) {
      const { checks, summary: yielded } = await yieldOf(resolve(pack), sessions, episodes, seed, sample);
      await writeLines(out, 'dossier-yield.jsonl', checks);
      const yieldFile = await writeJson(out, 'dossier-yield.summary.json', yielded);
      io.print(`Wrote ${yieldFile}: ${String(yielded.episodes)} episodes checked in ${String(yielded.sessionsDrawn)} drawn sessions.`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof PackError)) throw error;
    io.print(error.message);
    return 2;
  }
};
