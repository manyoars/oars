import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexRoot, openCodexStore, rolloutLines } from './codex.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, rolloutLine as line, stage, stageCodex } from './test-support.js';

afterEach(cleanup);

// Every fixture below is written from openai/codex @ ac558e2 (Apache-2.0): the envelope from codex-rs/history/src/lib.rs (`RolloutLine`) and
// rollout_payload.rs, the payloads from codex-rs/protocol/src/protocol.rs (`SessionMeta`, `TurnContextItem`, `TokenUsage`, `ExecCommandEndEvent`,
// `PatchApplyEndEvent`, `UserMessageEvent`, `AgentMessageEvent`) and models.rs (`ResponseItem::FunctionCall`). No live store was read.

const capture = (text: string) =>
  captureSession({
    text,
    session: 'codex-x',
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

const asText = (lines: readonly unknown[]): string => lines.map((entry) => rolloutText(entry)).join('\n');
const rolloutText = (entry: unknown): string => JSON.stringify(entry);
const extractOf = (lines: readonly unknown[]) => {
  const transcript = rolloutLines(asText(lines), 'sess').map((entry) => JSON.stringify(entry)).join('\n');
  return capture(transcript);
};

const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const meta = (cwd: string) => line(T(0), 'session_meta', { id: 'sess-1', timestamp: T(0), cwd, originator: 'codex_cli_rs', cli_version: '0.50.0' });
const turn = (model = 'gpt-5-codex') => line(T(1), 'turn_context', { model, cwd: '/work/app' });
const prompt = (second: number, message: string) => line(T(second), 'event_msg', { type: 'user_message', message });
const say = (second: number, message: string) => line(T(second), 'event_msg', { type: 'agent_message', message });
const usage = (second: number, input: number, cached: number, output: number, reasoning: number, total: number) =>
  line(T(second), 'event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total },
      last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total },
    },
  });
const shellCall = (second: number, id: string, command: string[]) => line(T(second), 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command }), call_id: id });
const shellEnd = (second: number, id: string, exit: number, output: string, status = 'completed') =>
  line(T(second), 'event_msg', { type: 'exec_command_end', call_id: id, command: ['bash', '-lc', 'x'], cwd: '/work/app', exit_code: exit, aggregated_output: output, status });

describe('rolloutLines', () => {
  it('turns a normal session into prompts, calls with outcomes, usage once per response, the model, the cwd, and the version', () => {
    const lines = [
      meta('/work/app'),
      turn(),
      prompt(2, 'fix the build'),
      shellCall(3, 'c1', ['bash', '-lc', 'npm test']),
      shellEnd(4, 'c1', 0, 'ok'),
      say(5, 'done'),
      usage(6, 1000, 400, 200, 50, 1200),
      usage(7, 1000, 400, 200, 50, 1200),
      prompt(8, 'now the docs'),
      line(T(9), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: docs/b.md\n+x\n*** End Patch' }),
      line(T(10), 'event_msg', { type: 'patch_apply_end', call_id: 'c2', success: true, stdout: 'ok', stderr: '', changes: {} }),
      usage(11, 1500, 500, 100, 0, 1600),
    ];
    const out = extractOf(lines);
    expect(out.session.userTurns).toBe(2);
    expect(out.session.assistantTurns).toBe(3);
    expect(out.session.env.harness).toBe('0.50.0');
    expect(out.session.models).toEqual({ 'gpt-5-codex': 3 });
    // Input excludes the cached tokens (capture's convention); the repeated token_count did not double the first response.
    expect(out.session.usage).toMatchObject({ input: 600 + 1000, cacheRead: 900, output: 300, thinking: 50 });
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'ok'], ['Edit', 'ok'], ['Edit', 'ok']]);
    expect(out.session.files).toEqual(expect.arrayContaining(['src/a.ts', 'docs/b.md']));
    expect(out.errorLines).toEqual([]);
    expect(out.session.tsFirst).toBe(T(2));
    expect(out.prompts.map((p) => p.ts)).toEqual([T(2), T(8)]);
  });

  it('records a shell call that returned a nonzero code as an error even when its status reads completed', () => {
    const out = extractOf([meta('/work/app'), turn(), prompt(2, 'run it'), shellCall(3, 'c1', ['bash', '-lc', 'make']), shellEnd(4, 'c1', 2, 'make: *** No rule to make target\nsecond line'), usage(5, 10, 0, 5, 0, 15)]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: 'make: *** No rule to make target' }]);
  });

  it('leaves a declined command with no outcome, so it never counts as a fix', () => {
    const out = extractOf([meta('/work/app'), shellCall(3, 'c1', ['rm', '-rf', 'x']), shellEnd(4, 'c1', 1, '', 'declined')]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'none' }]);
    expect(out.errorLines).toEqual([]);
  });

  it('unwraps a JSON error wrapper so the error line joins a Claude Code signature, and reads the wrapper exit code', () => {
    const wrapped = JSON.stringify({ output: 'EACCES: permission denied, open /etc/x', metadata: { exit_code: 1, duration_seconds: 0.1 } });
    const out = extractOf([
      meta('/work/app'),
      line(T(3), 'response_item', { type: 'function_call', name: 'read_file', arguments: JSON.stringify({ path: '/etc/x' }), call_id: 'c1' }),
      line(T(4), 'response_item', { type: 'function_call_output', call_id: 'c1', output: wrapped }),
      line(T(5), 'response_item', { type: 'function_call', name: 'update_plan', arguments: '{}', call_id: 'c2' }),
      line(T(6), 'response_item', { type: 'function_call_output', call_id: 'c2', output: JSON.stringify({ content: 'bad plan', success: false }) }),
    ]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['Exit code 1', 'bad plan'].map((_, index) => (index === 0 ? 'EACCES: permission denied, open /etc/x' : 'bad plan')));
  });

  it('writes no usage for a session with none, and never a measured zero', () => {
    const out = extractOf([meta('/work/app'), prompt(2, 'hi'), say(3, 'hello'), line(T(4), 'event_msg', { type: 'token_count', info: null }), usage(5, 0, 0, 0, 0, 0)]);
    expect(out.session.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0 });
    const hasUsage = rolloutLines(asText([meta('/work/app'), say(3, 'hello'), usage(5, 0, 0, 0, 0, 0)]), 's').some((entry) => JSON.stringify(entry).includes('"usage"'));
    expect(hasUsage).toBe(false);
  });

  it('gives every assistant line a requestId, so verify --strict has nothing to fail on', () => {
    const lines = rolloutLines(asText([meta('/work/app'), say(2, 'a'), usage(3, 5, 0, 5, 0, 10), say(4, 'b')]), 's');
    const assistants = lines.filter((entry) => entry.type === 'assistant');
    expect(assistants).toHaveLength(2);
    expect(assistants.every((entry) => entry.requestId === undefined)).toBe(false);
    expect(assistants[0]?.requestId).toBeDefined();
  });

  it('keeps each prompt at its own time, and never steps back for a missing, relative, or earlier stamp', () => {
    const lines = rolloutLines(
      asText([
        meta('/work/app'),
        line('+5s', 'event_msg', { type: 'user_message', message: 'relative' }),
        line(T(9), 'event_msg', { type: 'user_message', message: 'later' }),
        line(T(3), 'event_msg', { type: 'user_message', message: 'earlier' }),
        { type: 'event_msg', payload: { type: 'user_message', message: 'none' } },
      ]),
      's',
    );
    expect(lines.filter((entry) => entry.type === 'user').map((entry) => entry.timestamp)).toEqual([T(0), T(9), T(9), T(9)]);
  });

  it('skips torn lines and lines of an unknown type without failing', () => {
    const text = `${rolloutText(meta('/work/app'))}\n{torn\n${rolloutText(line(T(2), 'world_state', { x: 1 }))}\n${rolloutText(prompt(3, 'hi'))}\n`;
    expect(rolloutLines(text, 's').filter((entry) => entry.type === 'user')).toHaveLength(1);
  });

  it('captures a session from a folder that is not a repository', () => {
    const out = extractOf([meta('/tmp/notes'), prompt(2, 'hi'), line(T(3), 'response_item', { type: 'function_call', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }), call_id: 'c1' }), line(T(4), 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'text' })]);
    expect(out.tools).toMatchObject([{ tool: 'read_file', status: 'ok' }]);
  });

  it('redacts a secret and an email, and cuts a 1,500-character error at 1,000 characters', () => {
    const long = `fail: sk-abcdefghijklmnopqrstuvwxyz0123 for alice@example.com ${'x'.repeat(1500)}`;
    const out = extractOf([meta('/work/app'), shellCall(3, 'c1', ['make']), shellEnd(4, 'c1', 1, long)]);
    const [error] = out.errorLines;
    expect(error?.line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(error?.line).not.toContain('alice@example.com');
    expect(error?.line.length).toBe(1000);
  });

  it('settles a shell call from its output wrapper when no exec_command_end exists, and a local_shell_call from its action', () => {
    const out = extractOf([
      meta('/work/app'),
      line(T(2), 'response_item', { type: 'local_shell_call', call_id: 'c1', status: 'completed', action: { type: 'exec', command: ['ls'] } }),
      line(T(3), 'response_item', { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'ls: nope', metadata: { exit_code: 2 } }) }),
      line(T(4), 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: 'ls' }), call_id: 'c2' }),
      line(T(5), 'response_item', { type: 'function_call_output', call_id: 'c2', output: 'plain text with no metadata' }),
    ]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }, { tool: 'Bash', status: 'none' }]);
  });

  it('records a failed patch as an error and leaves a call without an id alone', () => {
    const out = extractOf([
      meta('/work/app'),
      line(T(2), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: 'no files here' }),
      line(T(3), 'event_msg', { type: 'patch_apply_end', call_id: 'c1', success: false, stderr: 'context mismatch' }),
      line(T(4), 'response_item', { type: 'function_call', name: 'shell', arguments: '{}' }),
    ]);
    expect(out.tools).toMatchObject([{ tool: 'Edit', status: 'error' }]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['context mismatch']);
  });
});

describe('openCodexStore', () => {
  it('finds sessions and archived sessions, prefers the active copy, reads cwd from the first line, and stats the file', async () => {
    const s = stage();
    const home = stageCodex(s.root, [
      { id: '11111111-1111-1111-1111-111111111111', lines: [meta('/work/app')] },
      { id: '11111111-1111-1111-1111-111111111111', lines: [meta('/elsewhere')], archived: true },
      { id: '22222222-2222-2222-2222-222222222222', lines: [meta('/work/two')], archived: true },
      { id: '33333333-3333-3333-3333-333333333333', lines: [meta('/work/three')], compressed: true },
      { id: '44444444-4444-4444-4444-444444444444', lines: '{torn' },
    ]);
    const store = await openCodexStore(home);
    expect(store?.sessions.map((entry) => [entry.id.slice(0, 2), entry.folder])).toEqual(expect.arrayContaining([['11', '/work/app'], ['22', '/work/two'], ['33', '/work/three'], ['44', null]]));
    expect(store?.sessions).toHaveLength(4);
    expect(store?.rejected).toBe(0);
    const compressed = store?.sessions.find((entry) => entry.id.startsWith('33'));
    expect(compressed === undefined ? '' : await store?.transcript(compressed)).toBe('');
  });

  it('returns undefined when the home holds no rollout, and names a file it cannot inspect without failing', async () => {
    const s = stage();
    expect(await openCodexStore(join(s.root, 'nothing'))).toBeUndefined();
    const home = join(s.root, 'h');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'rollout-x.jsonl.zst'), 'not zstd');
    const store = await openCodexStore(home);
    expect(store?.sessions).toEqual([]);
    expect(store?.unreadable).toHaveLength(1);
    expect(store?.unreadable[0]).toContain('rollout-x.jsonl.zst');
  });

  it('rejects a file whose id is not a safe file name', async () => {
    const s = stage();
    const home = join(s.root, 'h');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'rollout-a b.jsonl'), '');
    expect((await openCodexStore(home))?.rejected).toBe(1);
  });

  it('reads the Codex home from CODEX_HOME, else ~/.codex', () => {
    expect(codexRoot({ CODEX_HOME: '/x' }, '/home/u')).toBe('/x');
    expect(codexRoot({ CODEX_HOME: '' }, '/home/u')).toBe(join('/home/u', '.codex'));
    expect(readFileSync).toBeDefined();
  });
});
