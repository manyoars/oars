// The failure and continuation index (docs/pool.md): episodes, their continuation, the summary's denominator, and the seeded text check, on a fixture pack of made-up calls.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SKELETON_FORMAT } from '../../cli/src/sessions/pool-wire.js';
import { recoveryCallsOf } from '../../cli/src/sessions/recovery-calls.js';
import { checkEpisode, drawOf, episodesOf, main, readPack, transcriptOf, type Episode, type PackSession } from './failure-index.js';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const C = 'c3'.repeat(32);

const frame = (): object => ({ harness: 'claude-code', platform: 'linux', stack: { languages: [], frameworks: [] } });
const promptOf = (): object => ({ cls: 'other', errors: 0, usage: { input: null, cacheWrite: null, cacheRead: null, output: null, thinking: null }, frame: frame() });

const NATIVE = { 'file.read': 'Read', 'file.edit': 'Edit', 'file.search': 'Grep' } as const;
type Action = keyof typeof NATIVE;

interface Call {
  action: Action;
  /** The failed call's code; null for a failure captured without one; absent for a call that did not fail. */
  error?: string | null;
  prompt?: number;
  side?: boolean;
  changeKind?: string[];
}

interface FixtureTool {
  side: boolean;
  prompt: number;
  status: 'ok' | 'error';
  errorCode: string | null;
  changeKind?: string[];
  recoveryCalls?: ReturnType<typeof recoveryCallsOf>;
  steps: object[];
}

/** A transcript's calls as the skeleton holds them, each failed call's `recoveryCalls` computed by the pool's own rule (the reader refuses any other). */
const toolsOf = (calls: readonly Call[], agentType: string | null): FixtureTool[] => {
  const tools: FixtureTool[] = calls.map(({ action, error, prompt = 0, side = false, changeKind }) => ({
    side,
    prompt,
    status: error === undefined ? 'ok' : 'error',
    errorCode: error ?? null,
    ...(changeKind === undefined ? {} : { changeKind }),
    steps: [{ action, native: NATIVE[action], identity: null, status: error === undefined ? 'ok' : 'error', agentType, frame: 0 }],
  }));
  const read = calls.map(({ action, error, prompt = 0, side = false }) => ({ side, prompt, status: error === undefined ? ('ok' as const) : ('error' as const), steps: [{ action }] }));
  tools.forEach((tool, at) => {
    const followed = recoveryCallsOf(read, at);
    if (followed !== null) tool.recoveryCalls = followed;
  });
  return tools;
};

const skeletonOf = (id: string, transcripts: readonly (readonly Call[])[]): object => ({
  format: SKELETON_FORMAT,
  vocabVersion: '1',
  fieldsVersion: 1,
  id,
  timingPrint: null,
  transcripts: transcripts.map((calls, at) => ({ merkleRoot: 'c3'.repeat(32), leaves: 2, harness: 'claude-code', frame: frame(), frames: [frame()], spawnedIn: at === 0 ? null : 0, prompts: [promptOf(), promptOf()], tools: toolsOf(calls, at === 0 ? null : 'custom') })),
});

// Session A: an Edit fails, a Read, the Edit fails again (one episode, two attempts) and an Edit then succeeds; a Grep fails as the prompt's last call (no continuation).
const SESSION_A: Call[] = [
  { action: 'file.read' },
  { action: 'file.edit', error: 'tool-use-error' },
  { action: 'file.read' },
  { action: 'file.edit', error: 'tool-use-error', changeKind: ['value-changed'] },
  { action: 'file.edit', changeKind: ['value-changed'] },
  { action: 'file.search', error: '1' },
  { action: 'file.read', prompt: 1 },
];
// Session B: a Grep fails and an Edit follows; a Read fails and an Edit fails right after it, two families, so two episodes.
const SESSION_B: Call[] = [
  { action: 'file.search', error: '2' },
  { action: 'file.edit' },
  { action: 'file.read', error: 'other' },
  { action: 'file.edit', error: 'tool-use-error' },
  { action: 'file.read' },
];
const SESSION_C: Call[] = [{ action: 'file.read' }, { action: 'file.edit' }];

/** A transcript that holds each call and its result, in the skeleton's order, then an assistant reply; `blank` empties the result text of those calls. */
const transcriptText = (calls: readonly Call[], blank: readonly number[] = []): string => {
  const lines: string[] = [];
  calls.forEach(({ action, error, prompt }, at) => {
    // A new prompt opens with a user text line, and the reply to the one before it comes first.
    if (at > 0 && prompt !== undefined && prompt !== calls[at - 1]?.prompt) {
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'made-up reply 0' }] } }));
      lines.push(JSON.stringify({ type: 'user', message: { content: 'made-up prompt' } }));
    }
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `toolu_${String(at)}`, name: NATIVE[action], input: { n: at } }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${String(at)}`, is_error: error !== undefined, content: blank.includes(at) ? '' : [{ type: 'text', text: 'made-up result' }] }] } }));
  });
  lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'made-up reply 1' }] } }));
  lines.push('{"type":"summary"}');
  return `${lines.join('\n')}\n`;
};

const dirs: string[] = [];
const temp = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-failure-index-'));
  dirs.push(folder);
  return folder;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  id: string;
  transcripts: (readonly Call[])[];
  text?: string;
}

/** A built pack in a temporary folder: a manifest row per session, its skeleton, and its main transcript when `text` is given. */
const packOf = (sessions: readonly Fixture[]): string => {
  const pack = temp();
  const rows = sessions.map(({ id, transcripts, text }) => {
    mkdirSync(join(pack, 'sessions', id), { recursive: true });
    writeFileSync(join(pack, 'sessions', id, 'skeleton.json'), JSON.stringify(skeletonOf(id, transcripts)));
    if (text !== undefined) writeFileSync(join(pack, 'sessions', id, 'main.jsonl'), text);
    return JSON.stringify({ matchId: id, transcripts: text === undefined ? 0 : transcripts.length, skeleton: 'skeleton.json' });
  });
  writeFileSync(join(pack, 'manifest.jsonl'), `${rows.reverse().join('\n')}\n`);
  return pack;
};

const FIXTURE: Fixture[] = [
  { id: A, transcripts: [SESSION_A], text: transcriptText(SESSION_A) },
  { id: B, transcripts: [SESSION_B], text: transcriptText(SESSION_B, [2]) },
  { id: C, transcripts: [SESSION_C] },
];

const run = async (argv: readonly string[]): Promise<{ code: number; printed: string[] }> => {
  const printed: string[] = [];
  const code = await main(argv, { print: (text) => printed.push(text) });
  return { code, printed };
};

const rowsIn = (file: string): unknown[] => readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line): unknown => JSON.parse(line));

const only = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('the fixture holds no such value');
  return value;
};

describe('episodes', () => {
  it('folds two failed attempts of one family into one episode, its continuation the last attempt\'s', async () => {
    const [a] = await readPack(packOf(FIXTURE));
    const [first] = episodesOf(only(a));
    expect(first).toEqual({
      session: A,
      family: 'file.edit tool-use-error',
      errorCodes: ['tool-use-error'],
      attempts: 2,
      continuation: ['file.edit', 'file.search'],
      editFollowed: true,
      retryChanges: ['value-changed'],
      pointer: { transcript: 0, side: false, prompt: 0, calls: [1, 3], native: 'Edit', file: 'main.jsonl' },
    });
  });

  it('records an error no call followed as an empty continuation', async () => {
    const [a] = await readPack(packOf(FIXTURE));
    const episodes = episodesOf(only(a));
    expect(episodes).toHaveLength(2);
    expect(episodes[1]).toMatchObject({ family: 'file.search exit', errorCodes: ['1'], attempts: 1, continuation: [], editFollowed: false, retryChanges: [], pointer: { calls: [5] } });
  });

  it('keeps an edit-followed error and an adjacent error of another family apart', async () => {
    const [, b] = await readPack(packOf(FIXTURE));
    const episodes = episodesOf(only(b));
    expect(episodes.map(({ family, attempts, editFollowed, continuation }) => ({ family, attempts, editFollowed, continuation }))).toEqual([
      { family: 'file.search exit', attempts: 1, editFollowed: true, continuation: ['file.edit', 'file.read', 'file.edit', 'file.read'] },
      { family: 'file.read other', attempts: 1, editFollowed: false, continuation: ['file.edit', 'file.read'] },
      { family: 'file.edit tool-use-error', attempts: 1, editFollowed: false, continuation: ['file.read'] },
    ]);
  });

  it('names no file for a skeleton-only session or a subagent transcript', async () => {
    const [sub] = await readPack(packOf([{ id: A, transcripts: [SESSION_C, [{ action: 'file.read', error: 'timeout' }]], text: transcriptText(SESSION_C) }]));
    expect(episodesOf(only(sub)).map(({ family, pointer }) => ({ family, transcript: pointer.transcript, file: pointer.file }))).toEqual([{ family: 'file.read timeout', transcript: 1, file: null }]);
  });
});

describe('the command', () => {
  it('writes the index and a summary with the denominator, the same bytes on a second run', async () => {
    const pack = packOf(FIXTURE);
    const out = temp();
    const { code, printed } = await run([pack, '--out', out]);
    expect(code).toBe(0);
    expect(printed.join('\n')).toMatch(/5 episodes in 2 of 3 sessions/);
    expect(rowsIn(join(out, 'failure-index.jsonl')).map((row) => JSON.stringify(row).slice(12, 16))).toEqual([A, A, B, B, B].map((id) => id.slice(0, 4)));
    const summary: unknown = JSON.parse(readFileSync(join(out, 'failure-index.summary.json'), 'utf8'));
    expect(summary).toEqual({
      spec: 'failure-index/1',
      sessionsRead: 3,
      sessionsWithEpisode: 2,
      episodes: 5,
      failedCalls: 6,
      editFollowedCalls: 3,
      editFollowedEpisodes: 2,
      noContinuationEpisodes: 1,
      families: {
        'file.edit tool-use-error': { episodes: 2, attempts: 3, sessions: 2 },
        'file.read other': { episodes: 1, attempts: 1, sessions: 1 },
        'file.search exit': { episodes: 2, attempts: 2, sessions: 2 },
      },
    });
    const before = readFileSync(join(out, 'failure-index.jsonl'), 'utf8');
    expect((await run([pack, '--out', out])).code).toBe(0);
    expect(readFileSync(join(out, 'failure-index.jsonl'), 'utf8')).toBe(before);
  });

  it('checks the drawn sessions\' text and writes classes and rates, never the text', async () => {
    const out = temp();
    const { code, printed } = await run([packOf(FIXTURE), '--out', out, '--text-sample', '3', '--seed', 's']);
    expect(code).toBe(0);
    expect(printed.join('\n')).toMatch(/5 episodes checked in 3 drawn sessions/);
    expect(rowsIn(join(out, 'dossier-yield.jsonl'))).toEqual([
      { session: A, family: 'file.edit tool-use-error', calls: [1, 3], class: 'supports', reason: 'error and continuation present' },
      { session: A, family: 'file.search exit', calls: [5], class: 'supports', reason: 'no call followed, reply present' },
      { session: B, family: 'file.search exit', calls: [0], class: 'supports', reason: 'error and continuation present' },
      { session: B, family: 'file.read other', calls: [2], class: 'partly', reason: 'error result empty' },
      { session: B, family: 'file.edit tool-use-error', calls: [3], class: 'supports', reason: 'error and continuation present' },
    ]);
    expect(JSON.parse(readFileSync(join(out, 'dossier-yield.summary.json'), 'utf8'))).toEqual({
      spec: 'dossier-yield/1',
      seed: 's',
      sessionsDrawn: 3,
      episodes: 5,
      classes: { supports: { episodes: 4, per100Sessions: 133.33 }, partly: { episodes: 1, per100Sessions: 33.33 }, missing: { episodes: 0, per100Sessions: 0 }, unresolved: { episodes: 0, per100Sessions: 0 } },
    });
    expect(readFileSync(join(out, 'dossier-yield.jsonl'), 'utf8')).not.toMatch(/made-up/);
  });

  it('refuses an output folder inside a git repository, and a bad command line, before reading anything', async () => {
    const repo = temp();
    mkdirSync(join(repo, '.git'));
    const inside = await run([join(repo, 'nowhere'), '--out', join(repo, 'out')]);
    expect(inside.code).toBe(2);
    expect(inside.printed.join('\n')).toMatch(/inside a git repository/);
    for (const argv of [['--out', temp()], [temp(), temp(), '--out', temp()], [temp()], [temp(), '--out', temp(), '--text-sample', '0', '--seed', 's'], [temp(), '--out', temp(), '--text-sample', '2']]) {
      expect((await run(argv)).printed.join('\n')).toMatch(/^Missing or invalid option/);
    }
    expect((await run([temp(), '--bogus', 'x'])).printed.join('\n')).toMatch(/^Unknown or incomplete option: --bogus/);
  });

  it('stops on a pack it cannot read, naming the file and never a value', async () => {
    const out = temp();
    const empty = await run([temp(), '--out', out]);
    expect(empty.printed.join('\n')).toMatch(/^No manifest at /);
    const pack = temp();
    writeFileSync(join(pack, 'manifest.jsonl'), '{"matchId":"secret-value"}\n');
    const bad = await run([pack, '--out', out]);
    expect(bad.code).toBe(2);
    expect(bad.printed.join('\n')).toMatch(/manifest\.jsonl:1 lacks a match id/);
    expect(bad.printed.join('\n')).not.toMatch(/secret-value/);
    // A line that is not JSON is named by file and line number, and its content is never printed.
    const garbled = packOf([{ id: A, transcripts: [SESSION_A], text: `${transcriptText(SESSION_A).split('\n')[0] ?? ''}\nmade-up garbled text {\n` }]);
    const garbledRun = await run([garbled, '--out', out, '--text-sample', '5', '--seed', 's']);
    expect(garbledRun.code).toBe(2);
    expect(garbledRun.printed.join('\n')).toMatch(/main\.jsonl:2 is not valid JSON/);
    expect(garbledRun.printed.join('\n')).not.toContain('garbled');
    writeFileSync(join(pack, 'manifest.jsonl'), 'made-up garbled manifest {\n');
    const garbledManifest = await run([pack, '--out', out]);
    expect(garbledManifest.printed.join('\n')).toMatch(/manifest\.jsonl:1 is not valid JSON/);
    expect(garbledManifest.printed.join('\n')).not.toContain('garbled');
    const garbledSkeleton = packOf([{ id: A, transcripts: [SESSION_C] }]);
    writeFileSync(join(garbledSkeleton, 'sessions', A, 'skeleton.json'), 'made-up garbled skeleton {');
    const skeletonRun = await run([garbledSkeleton, '--out', out]);
    expect(skeletonRun.printed.join('\n')).toMatch(/skeleton\.json is not valid JSON/);
    expect(skeletonRun.printed.join('\n')).not.toContain('garbled');
    const broken = packOf([{ id: A, transcripts: [SESSION_C] }]);
    writeFileSync(join(broken, 'sessions', A, 'skeleton.json'), '{"format":1}');
    expect((await run([broken, '--out', out])).printed.join('\n')).toMatch(/is not a skeleton the pool reads/);
    rmSync(join(broken, 'sessions', A, 'skeleton.json'));
    expect((await run([broken, '--out', out])).printed.join('\n')).toMatch(/^No skeleton at /);
  });
});

describe('the text check', () => {
  const episodeOf = async (fixture: Fixture, at = 0): Promise<{ episode: Episode; session: PackSession }> => {
    const session = only((await readPack(packOf([fixture])))[0]);
    return { episode: only(episodesOf(session)[at]), session };
  };
  const toolsIn = (session: PackSession) => session.skeleton.transcripts[0]?.tools ?? [];

  it('finds a call missing when the transcript is absent, its calls do not line up, or the name differs', async () => {
    const { episode, session } = await episodeOf({ id: A, transcripts: [SESSION_A] });
    expect(checkEpisode(episode, toolsIn(session), undefined).reason).toBe('no transcript file');
    expect(checkEpisode(episode, toolsIn(session), transcriptOf(transcriptText(SESSION_A.slice(0, 3)))).reason).toBe('call count differs');
    const renamed = transcriptText(SESSION_A).replace('"name":"Edit"', '"name":"Write"');
    expect(checkEpisode(episode, toolsIn(session), transcriptOf(renamed))).toMatchObject({ class: 'missing', reason: 'call not at pointer' });
  });

  it('reads a result that is absent, not flagged, or empty as partly', async () => {
    const { episode, session } = await episodeOf({ id: A, transcripts: [SESSION_A] });
    const text = transcriptText(SESSION_A);
    const lines = text.split('\n');
    const noResult = lines.filter((line) => !line.includes('"tool_use_id":"toolu_3"')).join('\n');
    expect(checkEpisode(episode, toolsIn(session), transcriptOf(noResult)).reason).toBe('error result missing');
    const unflagged = text.replace(/"tool_use_id":"toolu_1","is_error":true/, '"tool_use_id":"toolu_1","is_error":false');
    expect(checkEpisode(episode, toolsIn(session), transcriptOf(unflagged)).reason).toBe('result not flagged an error');
    expect(checkEpisode(episode, toolsIn(session), transcriptOf(transcriptText(SESSION_A, [3]))).reason).toBe('error result empty');
    const stringResult = text.replaceAll('"content":[{"type":"text","text":"made-up result"}]', '"content":"made-up"');
    expect(checkEpisode(episode, toolsIn(session), transcriptOf(stringResult)).class).toBe('supports');
  });

  it('reads a continuation call with an empty input, or no reply after a last error, as partly', async () => {
    const { episode, session } = await episodeOf({ id: A, transcripts: [SESSION_A] });
    const emptyInput = transcriptText(SESSION_A).replace('"input":{"n":4}', '"input":{}');
    expect(checkEpisode(episode, toolsIn(session), transcriptOf(emptyInput)).reason).toBe('continuation call missing or empty');
    const last = await episodeOf({ id: A, transcripts: [SESSION_A] }, 1);
    const noReply = transcriptText(SESSION_A).split('\n').filter((line) => !line.includes('made-up reply') && !line.includes('"toolu_6"')).join('\n');
    expect(checkEpisode(last.episode, toolsIn(last.session).slice(0, 6), transcriptOf(noReply))).toMatchObject({ class: 'partly', reason: 'no reply after the error' });
    // A reply that only the next prompt has is not this episode's reply.
    const laterOnly = transcriptText(SESSION_A).split('\n').filter((line) => !line.includes('made-up reply 0')).join('\n');
    expect(checkEpisode(last.episode, toolsIn(last.session), transcriptOf(laterOnly))).toMatchObject({ class: 'partly', reason: 'no reply after the error' });
  });

  it('leaves a subagent transcript unresolved and skips a line that is not a message', async () => {
    const { episode, session } = await episodeOf({ id: A, transcripts: [SESSION_C, [{ action: 'file.read', error: 'timeout' }]] });
    expect(checkEpisode(episode, toolsIn(session), undefined)).toMatchObject({ class: 'unresolved', reason: 'subagent transcript' });
    const odd = transcriptOf('\n"text"\n{"type":"assistant","message":{"content":[7,{"type":"tool_use","id":"toolu_x"}]}}\n{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_x"}]}}\n');
    expect(odd.uses).toEqual([{ name: '', inputLength: 2 }]);
    expect(odd.results.get(0)).toEqual({ isError: false, textLength: 0, line: 3 });
  });

  it('groups an HTTP status as http and a failure with no code as uncoded', async () => {
    const session = only((await readPack(packOf([{ id: A, transcripts: [[{ action: 'file.read', error: '404' }, { action: 'file.search', error: null }]] }])))[0]);
    expect(episodesOf(session).map(({ family, errorCodes }) => ({ family, errorCodes }))).toEqual([{ family: 'file.read http', errorCodes: ['404'] }, { family: 'file.search uncoded', errorCodes: ['uncoded'] }]);
  });

  it('draws by seed: the same ids for the same seed, at most the size asked', () => {
    const ids = [A, B, C];
    expect(drawOf(ids, 'one', 2)).toEqual(drawOf([C, B, A], 'one', 2));
    expect(drawOf(ids, 'one', 2)).toHaveLength(2);
    expect(drawOf(ids, 'one', 9)).toHaveLength(3);
  });
});
