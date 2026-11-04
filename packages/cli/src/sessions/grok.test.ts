import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { grokBadLines, grokLines, grokRoot, openGrokStore } from './grok.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, grokUpdate as line, stage, stageGrok } from './test-support.js';

afterEach(cleanup);

// Every fixture below is written from xai-org/grok-build @ 2bdd1d6 (Apache-2.0), under crates/codegen/, and from the ACP schema it implements
// (agentclientprotocol/agent-client-protocol @ 0e486bc, schema/v1/schema.json):
//   updates.jsonl line `{timestamp: u64 seconds, method, params: {sessionId, update}}`  xai-grok-shell storage/mod.rs:721-725
//   update kinds `user_message_chunk`, `agent_message_chunk` (content {type:"text", text}, _meta), `tool_call` (toolCallId, title, kind, status, rawInput),
//     `tool_call_update` (toolCallId, status, content[], rawOutput)                                         ACP schema.json SessionUpdate
//   `_meta.hostTurn` and `_meta.interjection` mark text the harness wrote                                   storage/mod.rs:966, :974
//   `title` is the tool's name                                                                              xai-grok-shell tool_calls.rs:1487
//   rawOutput of a shell call: `{type:"Bash", exit_code, output: bytes, output_for_prompt, signal, timed_out, current_dir}`   xai-grok-tools types/output.rs:384-405
//   a call is `failed` only on a timeout or a signal, so exit 2 arrives `completed`                         acp_conversion.rs:241-250
//   edit keys: `file_path` (search_replace, write, hashline_edit), `filePath` (edit, camelCase), `patch` (apply_patch)   xai-grok-tools implementations/{grok_build/search_replace/mod.rs:74,
//     opencode/edit/mod.rs:64,:138,:579, opencode/write/mod.rs:31, grok_build_hashline/edit/types.rs:12, codex/apply_patch/tool.rs:104}; the patch format's
//     `*** Update File: <path>` headers are codex/apply_patch/parser.rs:40-42
//   usage.json `{turns: [{endedAt, inputTokens, outputTokens, cachedReadTokens, cacheCreationTokens, reasoningTokens, primaryModelId}]}`   usage_file.rs:10-80
// `inputTokens` includes cache reads and writes (xai-grok-sampling-types conversation.rs:771-773). No live store was read.

const capture = (text: string) =>
  captureSession({
    text,
    harness: 'grok',
    session: 'grok-x',
    project: 'p',
    rev: 1,
    at: '2026-06-01T00:00:00Z',
    bytes: text.length,
    redact: makeRedactor(),
    salt: 'salt',
    sid: 'abcd1234',
    repoRoot: makeRepoRoot(),
    repoIdentity: makeRepoIdentity(),
  });

const BASE = Date.parse('2026-06-01T10:00:00Z') / 1000;
const S = (second: number): number => BASE + second;
const iso = (second: number): string => new Date((BASE + second) * 1000).toISOString();
const asText = (events: readonly unknown[]): string => events.map((entry) => JSON.stringify(entry)).join('\n');
type Obj = { [key: string]: unknown };
const summaryOf = (extra: Obj = {}): Obj => ({ info: { id: 'sess', cwd: '/work/app' }, created_at: iso(0), current_model_id: 'grok-build', ...extra });
const linesOf = (events: readonly unknown[], summary: Obj = summaryOf(), usage?: Obj) => grokLines(asText(events), 'sess', summary, usage);
const extractOf = (events: readonly unknown[], summary: Obj = summaryOf(), usage?: Obj) => capture(linesOf(events, summary, usage).map((entry) => JSON.stringify(entry)).join('\n'));

const prompt = (second: number, text: string, meta?: object) => line(S(second), { sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, ...(meta === undefined ? {} : { _meta: meta }) });
const say = (second: number, text: string, meta?: object) => line(S(second), { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(meta === undefined ? {} : { _meta: meta }) });
const call = (second: number, toolCallId: string, title: string, rawInput: object = {}, kind = 'other') => line(S(second), { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending', rawInput });
const finish = (second: number, toolCallId: string, status: string, extra: object = {}) => line(S(second), { sessionUpdate: 'tool_call_update', toolCallId, status, ...extra });
const bytes = (text: string): number[] => [...Buffer.from(text)];
const bash = (exit: number, text: string, extra: object = {}) => ({ type: 'Bash', exit_code: exit, command: 'x', output: bytes(text), output_for_prompt: text, signal: null, timed_out: false, current_dir: '/work/app', ...extra });
const turn = (second: number, extra: object = {}) => ({ turnNumber: 1, endedAt: iso(second), inputTokens: 900, outputTokens: 60, cachedReadTokens: 400, cacheCreationTokens: 100, reasoningTokens: 7, modelCalls: 2, primaryModelId: 'grok-build', ...extra });
const usageOf = (...turns: Obj[]): Obj => ({ sessionId: 'sess', updatedAt: iso(99), session: {}, turns });

describe('the Grok Build reader', () => {
  it('turns a normal session into prompts, calls with outcomes, usage from usage.json, the model, and the cwd', () => {
    const events = [
      prompt(1, 'fix the '),
      prompt(1, 'build'),
      say(2, 'running '),
      say(2, 'it'),
      call(3, 'c1', 'run_terminal_cmd', { command: 'npm test' }, 'execute'),
      finish(4, 'c1', 'completed', { rawOutput: bash(0, 'ok') }),
      call(5, 'c2', 'search_replace', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'edit'),
      finish(6, 'c2', 'completed', { content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a', newText: 'b' }] }),
      call(7, 'c3', 'apply_patch', { patch: '*** Begin Patch\n*** Update File: docs/b.md\n@@\n-x\n+y\n*** Add File: docs/c.md\n+z\n*** End Patch' }, 'edit'),
      finish(8, 'c3', 'completed'),
      say(9, 'done'),
    ];
    const out = extractOf(events, summaryOf(), usageOf(turn(10)));
    expect(out.session.userTurns).toBe(1);
    expect(out.session.assistantTurns).toBe(4);
    expect(out.session.models).toEqual({ 'grok-build': 4 });
    // inputTokens includes the cache reads and writes, and capture's fields are disjoint: 900 - 400 - 100.
    expect(out.session.usage).toMatchObject({ input: 400, cacheRead: 400, cacheWrite: 100, output: 60, thinking: 7 });
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'ok'], ['Edit', 'ok'], ['Edit', 'ok'], ['Edit', 'ok']]);
    expect(out.session.files).toEqual(expect.arrayContaining(['src/a.ts', 'docs/b.md', 'docs/c.md']));
    expect(out.errorLines).toEqual([]);
    expect(out.session.tsFirst).toBe(iso(1));
  });

  it('records a shell call whose exit code is nonzero as an error even though its status says completed', () => {
    const out = extractOf([prompt(1, 'run it'), call(2, 'c1', 'run_terminal_cmd', { command: 'make' }, 'execute'), finish(3, 'c1', 'completed', { rawOutput: bash(2, 'make: *** No rule to make target\nsecond') })]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: 'make: *** No rule to make target' }]);
  });

  it('records a shell call that exited zero with status failed as an error, and one cut by a signal with its output', () => {
    const out = extractOf([
      prompt(1, 'run them'),
      call(2, 'c', 'bash', { command: 'sleep 9' }, 'execute'),
      finish(3, 'c', 'failed', { rawOutput: bash(-1, 'timed out after 5s', { timed_out: true }) }),
      call(4, 'd', 'bash', { command: 'true' }, 'execute'),
      finish(5, 'd', 'failed', { rawOutput: bash(0, '') }),
    ]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['error', 'error']);
    expect(out.errorLines.map((error) => error.line)[0]).toBe('timed out after 5s');
  });

  it('reads the output bytes when output_for_prompt is empty, and says "Exit code" when there is no output at all', () => {
    const out = extractOf([
      prompt(1, 'x'),
      call(2, 'c', 'bash', { command: 'a' }, 'execute'),
      finish(3, 'c', 'completed', { rawOutput: bash(1, 'raw bytes only', { output_for_prompt: '' }) }),
      call(4, 'd', 'bash', { command: 'b' }, 'execute'),
      finish(5, 'd', 'completed', { rawOutput: bash(3, '') }),
    ]);
    expect(out.errorLines.map((error) => error.line)).toEqual(['raw bytes only', 'Exit code 3']);
  });

  it('unwraps a failed tool to the text of its content, never the rawOutput wrapper, so the error line joins a Claude Code signature', () => {
    const out = extractOf([
      prompt(1, 'read it'),
      call(2, 'c1', 'read_file', { path: '/nope' }, 'read'),
      finish(3, 'c1', 'failed', { content: [{ type: 'content', content: { type: 'text', text: 'ENOENT: no such file or directory, open /nope' } }], rawOutput: { type: 'ReadFile', FileNotFound: 'wrapped' } }),
      call(4, 'c2', 'read_file', {}, 'read'),
      finish(5, 'c2', 'failed', { rawOutput: { type: 'ReadFile' } }),
      call(6, 'c3', 'bash', { command: 'x' }, 'execute'),
      finish(7, 'c3', 'failed', { content: [{ type: 'content', content: { type: 'text', text: 'killed' } }] }),
    ]);
    expect(out.errorLines.map((error) => error.line)).toEqual(['ENOENT: no such file or directory, open /nope', 'tool failed', 'killed']);
  });

  it('writes no usage for a session with no usage.json, and gives every assistant line a requestId', () => {
    const lines = linesOf([prompt(1, 'hi'), say(2, 'hello'), prompt(3, 'again'), say(4, 'more')]);
    const assistant = lines.filter((entry) => entry.type === 'assistant');
    expect(assistant).toHaveLength(2);
    expect(assistant.every((entry) => typeof entry.requestId === 'string' && entry.requestId !== '')).toBe(true);
    expect(new Set(assistant.map((entry) => entry.requestId)).size).toBe(2);
    expect(extractOf([prompt(1, 'hi'), say(2, 'hello')]).session.usage).toMatchObject({ input: 0, output: 0 });
  });

  it('captures a session from a folder that is not a repository', () => {
    const out = extractOf([prompt(1, 'hi'), call(2, 'c1', 'read_file', { path: 'a.txt' }, 'read'), finish(3, 'c1', 'completed')], summaryOf({ info: { id: 'sess', cwd: '/tmp/notes' } }));
    expect(out.tools).toMatchObject([{ tool: 'read_file', status: 'ok' }]);
    expect(out.session.repo).toBeNull();
  });

  it('sums every turn once, lands each on the last response before its endedAt, and takes the turn’s model', () => {
    const events = [prompt(1, 'a'), say(2, 'one'), prompt(5, 'b'), say(6, 'two')];
    const lines = linesOf(events, summaryOf(), usageOf(turn(3, { turnNumber: 1, inputTokens: 100, cachedReadTokens: 40, cacheCreationTokens: 0, outputTokens: 5, reasoningTokens: 0, primaryModelId: 'm-a' }), turn(7, { turnNumber: 2, inputTokens: 300, cachedReadTokens: 100, cacheCreationTokens: 50, outputTokens: 9, reasoningTokens: 2, primaryModelId: 'm-b' })));
    const usages = lines.filter((entry) => entry.type === 'assistant').map((entry) => [entry.requestedModel, typeof entry.message === 'object' && entry.message !== null && 'usage' in entry.message ? entry.message.usage : undefined]);
    expect(usages).toEqual([
      ['m-a', { input_tokens: 60, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, output_tokens: 5, output_tokens_details: { thinking_tokens: 0 } }],
      ['m-b', { input_tokens: 150, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 9, output_tokens_details: { thinking_tokens: 2 } }],
    ]);
    expect(extractOf(events, summaryOf(), usageOf(turn(3), turn(7))).session.usage).toMatchObject({ input: 800, cacheRead: 800, output: 120 });
  });

  it('attaches a turn that ends before any response to the first one, and drops usage when there is no response', () => {
    const early = linesOf([prompt(5, 'a'), say(6, 'one')], summaryOf(), usageOf(turn(1)));
    expect(early.filter((entry) => entry.type === 'assistant')).toMatchObject([{ message: { usage: { output_tokens: 60 } } }]);
    expect(() => linesOf([prompt(5, 'a')], summaryOf(), usageOf(turn(1)))).not.toThrow();
  });

  it('never subtracts below zero when the vendor’s cache fields exceed its input', () => {
    const lines = linesOf([prompt(1, 'a'), say(2, 'x')], summaryOf(), usageOf(turn(3, { inputTokens: 10, cachedReadTokens: 30, cacheCreationTokens: 0 })));
    expect(lines.filter((entry) => entry.type === 'assistant')).toMatchObject([{ message: { usage: { input_tokens: 0, cache_read_input_tokens: 30 } } }]);
  });

  it('skips the lines and the usage a fork copied from its parent, keeping what happened after forked_at', () => {
    const forked = { session_kind: 'fork', parent_session_id: 'parent', forked_at: iso(10) };
    const events = [prompt(1, 'parent prompt'), say(2, 'parent answer'), prompt(11, 'child prompt'), say(12, 'child answer')];
    const out = extractOf(events, summaryOf(forked), usageOf(turn(3), turn(13, { turnNumber: 2, inputTokens: 50, cachedReadTokens: 0, cacheCreationTokens: 0, outputTokens: 4, reasoningTokens: 0 })));
    expect(out.session.userTurns).toBe(1);
    expect(out.session.usage).toMatchObject({ input: 50, output: 4 });
    // A restore or a resume keeps its own file: nothing is skipped without a fork.
    expect(extractOf(events, summaryOf({ forked_at: undefined })).session.userTurns).toBe(2);
  });

  it('does not read the harness’s own text as the operator’s: a host-turn marker ends a prompt, an interjection is not one', () => {
    const lines = linesOf([prompt(1, 'real '), prompt(1, 'prompt'), prompt(2, 'turn boundary', { hostTurn: true }), prompt(3, 'steer', { interjection: true }), say(4, 'ok'), prompt(5, 'second')]);
    expect(lines.filter((entry) => entry.type === 'user').map((entry) => JSON.stringify(entry.message))).toEqual([
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'real prompt' }] }),
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'second' }] }),
    ]);
  });

  it('gives a prompt with timestamp 0, a missing one, or an earlier one the latest time so far, never an earlier one', () => {
    const lines = linesOf([line(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'zero' } }), say(9, 'a'), prompt(3, 'earlier'), say(10, 'b'), { method: 'session/update', params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'none' } } } }]);
    expect(lines.filter((entry) => entry.type === 'user').map((entry) => entry.timestamp)).toEqual([iso(0), iso(9), iso(10)]);
  });

  it('follows the shell’s current_dir for the cwd after a directory change', () => {
    const lines = linesOf([prompt(1, 'cd'), call(2, 'c1', 'bash', { command: 'cd /other' }, 'execute'), finish(3, 'c1', 'completed', { rawOutput: bash(0, '', { current_dir: '/other' }) }), prompt(4, 'next')]);
    expect(lines.filter((entry) => entry.type === 'user' && typeof entry.cwd === 'string').map((entry) => entry.cwd)).toEqual(['/work/app', '/other', '/other']);
  });

  it('records an MCP call the way Claude Code does, a user bash-mode command by its kind, and a call with no completion as none', () => {
    const out = extractOf([
      prompt(1, 'go'),
      call(2, 'c1', 'oars__oars_recall', {}, 'other'),
      finish(3, 'c1', 'completed'),
      call(4, 'bash-mode-1', 'Execute `ls -a`', {}, 'execute'),
      finish(5, 'bash-mode-1', 'failed', { rawOutput: bash(2, 'ls: no such file') }),
      call(6, 'c3', 'grep', { pattern: 'x' }, 'search'),
      finish(7, 'c3', 'in_progress'),
    ]);
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['mcp__oars__oars_recall', 'ok'], ['Bash', 'error'], ['grep', 'none']]);
  });

  it('skips torn lines, lines of an unknown shape, an update with no id, and a completion with no known call, and counts the torn ones', () => {
    const text = `${asText([prompt(1, 'hi'), line(S(2), { sessionUpdate: 'plan', entries: [] }), call(3, '', 'bash'), finish(4, 'ghost', 'completed')])}\n{torn\n[1]\n`;
    expect(grokBadLines(text)).toEqual(['{torn']);
    const lines = grokLines(text, 'sess', summaryOf(), undefined);
    expect(lines.filter((entry) => entry.type === 'user')).toHaveLength(1);
    expect(() => grokLines('{torn\nnot json\n', 'sess', summaryOf(), undefined)).toThrow('no parseable line');
  });

  it('settles a call once', () => {
    const out = extractOf([prompt(1, 'x'), call(2, 'c1', 'bash', { command: 'a' }, 'execute'), finish(3, 'c1', 'completed', { rawOutput: bash(0, 'ok') }), finish(4, 'c1', 'failed', { rawOutput: bash(1, 'late') })]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['ok']);
  });

  it('redacts a secret and an email, and cuts a 1,500-character error at 1,000 characters', () => {
    const long = `fail: sk-abcdefghijklmnopqrstuvwxyz0123 for alice@example.com ${'x'.repeat(1500)}`;
    const out = extractOf([prompt(1, 'x'), call(2, 'c1', 'bash', { command: 'run' }, 'execute'), finish(3, 'c1', 'completed', { rawOutput: bash(1, long) })]);
    const error = out.errorLines[0];
    expect(error?.line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(error?.line).not.toContain('alice@example.com');
    expect(error?.line.length).toBeLessThanOrEqual(1000);
    const failed = extractOf([prompt(1, 'x'), call(2, 'c1', 'read_file', {}, 'read'), finish(3, 'c1', 'failed', { content: [{ type: 'content', content: { type: 'text', text: long } }] })]).errorLines[0];
    expect(failed?.line.length).toBeLessThanOrEqual(1000);
    expect(failed?.line).not.toContain('alice@example.com');
  });

  it('records an edit by its name even when it fails or the tool reports no path, with the original name kept for the table', () => {
    const out = extractOf([
      prompt(1, 'edit'),
      call(2, 'c1', 'write', { file_path: 'src/new.ts', content: 'x' }, 'edit'),
      finish(3, 'c1', 'failed', { content: [{ type: 'content', content: { type: 'text', text: 'denied' } }] }),
      call(4, 'c2', 'edit', {}, 'other'),
      finish(5, 'c2', 'completed'),
      call(6, 'c3', 'edit', { filePath: 'src/a.ts', oldString: 'a', newString: 'b' }, 'other'),
      finish(7, 'c3', 'failed', { content: [{ type: 'content', content: { type: 'text', text: 'oldString not found' } }] }),
    ]);
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Edit', 'error'], ['Edit', 'ok'], ['Edit', 'error']]);
    // The opencode `edit` tool's wire key is camelCase (`filePath`: opencode/edit/mod.rs:64, :138, :579), so a failed edit, which has no diff part, still names its file.
    expect(out.session.files).toEqual(expect.arrayContaining(['src/new.ts', 'src/a.ts']));
  });
});

describe('the Grok home', () => {
  it('is GROK_HOME, else ~/.grok', () => {
    expect(grokRoot({ GROK_HOME: '/x/y' }, '/home/u')).toBe('/x/y');
    expect(grokRoot({ GROK_HOME: '' }, '/home/u')).toBe(join('/home/u', '.grok'));
    expect(grokRoot({}, '/home/u')).toBe(join('/home/u', '.grok'));
  });

  it('lists sessions by folder name with the cwd summary.json names, skips subagents, husks, and what is no session, and reports what it cannot read', async () => {
    const s = stage();
    const updates = [prompt(1, 'x')];
    const home = stageGrok(s.root, [
      { id: 'aaa', cwd: '/work/a', updates },
      { id: 'bbb', cwd: '/work/b', updates: [prompt(1, 'x'), say(2, 'y')], usage: usageOf(turn(2)) },
      { id: 'sub1', cwd: '/work/a', updates, summary: { session_kind: 'subagent' } },
      { id: 'sub2', cwd: '/work/a', updates, summary: { session_kind: 'subagent_fork' } },
      { id: 'husk', cwd: '/work/a', updates: [], summary: { num_messages: 0 } },
      { id: 'noupd', cwd: '/work/a', updates: null },
      { id: 'bad id', cwd: '/work/a', updates },
      { id: 'torn', cwd: '/work/c', updates: '{torn\n' },
    ]);
    expect(home.startsWith(s.root)).toBe(true);
    mkdirSync(join(home, 'sessions', 'stray'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'stray.txt'), 'x');
    writeFileSync(join(home, 'sessions', encodeURIComponent('/work/a'), 'stray.txt'), 'x');
    mkdirSync(join(home, 'sessions', 'stray', 'nosummary'));
    const store = await openGrokStore(home);
    expect(store?.sessions.map((session) => [session.id, session.folder]).sort()).toEqual([['aaa', '/work/a'], ['bbb', '/work/b'], ['torn', '/work/c']]);
    expect(store?.rejected).toBe(1);
    expect(store?.unreadable).toEqual([]);
    const withUsage = store?.sessions.find((session) => session.id === 'bbb');
    expect(await store?.transcript(withUsage ?? never())).toContain('"output_tokens":60');
    expect(await openGrokStore(join(s.root, 'nowhere'))).toBeUndefined();
    await expect(store?.transcript({ ...(withUsage ?? never()), dir: join(home, 'gone') })).rejects.toThrow();
  });

  it('names a session whose summary.json is corrupt, never fatal, and does not name its folder', async () => {
    const s = stage();
    const home = stageGrok(s.root, [{ id: 'good', cwd: '/work/a', updates: [prompt(1, 'x')] }, { id: 'broken', cwd: '/work/a', updates: [prompt(1, 'x')] }]);
    writeFileSync(join(home, 'sessions', encodeURIComponent('/work/a'), 'broken', 'summary.json'), '{not json');
    const store = await openGrokStore(home);
    expect(store?.sessions.map((session) => session.id)).toEqual(['good']);
    expect(store?.unreadable).toHaveLength(1);
    expect(store?.unreadable[0]?.file).toContain('broken');
    expect(store?.unreadable[0]?.reason).not.toContain(s.root);
  });

  it('reports a sessions folder that cannot be listed by its base name, never fatal', async () => {
    const s = stage();
    const home = join(s.root, 'grok-file');
    mkdirSync(home);
    writeFileSync(join(home, 'sessions'), 'a file, not a folder');
    const store = await openGrokStore(home);
    expect(store?.sessions).toEqual([]);
    expect(store?.unreadable).toHaveLength(1);
    expect(store?.unreadable[0]?.reason).not.toContain(s.root);
    await expect(store?.transcript({ id: 'x', folder: null, dir: 'x', size: 0, mtimeMs: 0 })).rejects.toThrow();
  });

  it('lists a session whose summary names no cwd with no folder', async () => {
    const s = stage();
    const home = stageGrok(s.root, [{ id: 'long', cwd: '/work/a', updates: [prompt(1, 'x')], summary: { info: { id: 'long', cwd: '' } } }]);
    const store = await openGrokStore(home);
    expect(store?.sessions[0]?.folder).toBeNull();
  });
});

const never = (): never => {
  throw new Error('no session');
};
