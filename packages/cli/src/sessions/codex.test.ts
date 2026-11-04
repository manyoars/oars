import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexRoot, openCodexStore, rolloutBadLines, rolloutLines } from './codex.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, rolloutLine as line, stage, stageCodex } from './test-support.js';

afterEach(cleanup);

// Every fixture below is written from openai/codex @ ac558e2 (Apache-2.0): the envelope from codex-rs/history/src/lib.rs (`RolloutLine`) and
// rollout_payload.rs, the payloads from codex-rs/protocol/src/protocol.rs (`SessionMeta`, `TurnContextItem`, `TokenUsage`, `ExecCommandEndEvent`,
// `PatchApplyEndEvent`, `UserMessageEvent`, `AgentMessageEvent`) and models.rs (`ResponseItem::FunctionCall`; `FunctionCallOutputBody` at :2376 is a
// bare string or an array of `{type: input_text, text}`). SessionMeta carries `history_mode` (protocol.rs:3507). A shell call's outcome is the text of
// its function_call_output: `Exit code: N` then `Output:` (core/src/tools/mod.rs:107-113), or `Process exited with code N` (core/src/tools/context.rs:556).
// Which events a rollout holds is codex-rs/rollout/src/policy.rs: ExecCommandEnd is never persisted (:165), PatchApplyEnd only in Legacy mode (:143).
// Two shapes are older versions' and say so where used: the JSON `{output, metadata.exit_code}` wrapper (rust-v0.46.0 core/src/tools/mod.rs:186-210)
// and a persisted exec_command_end (read only if a rollout carries one). No live store was read.

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
// The persisted shape at ac558e2: the text core/src/tools/mod.rs:107-113 writes for `shell` / `shell_command`.
const execText = (exit: number, output: string): string => `Exit code: ${String(exit)}\nWall time: 0.1 seconds\nOutput:\n${output}`;
const shellOut = (second: number, id: string, output: unknown) => line(T(second), 'response_item', { type: 'function_call_output', call_id: id, output });
const shellEnd = (second: number, id: string, exit: number, output: string, status = 'completed') =>
  line(T(second), 'event_msg', { type: 'exec_command_end', call_id: id, command: ['bash', '-lc', 'x'], cwd: '/work/app', exit_code: exit, aggregated_output: output, status });

describe('rolloutLines', () => {
  it('turns a normal session into prompts, calls with outcomes, usage once per response, the model, the cwd, and the version', () => {
    const lines = [
      meta('/work/app'),
      turn(),
      prompt(2, 'fix the build'),
      shellCall(3, 'c1', ['bash', '-lc', 'npm test']),
      shellOut(4, 'c1', execText(0, 'ok')),
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

  it('records a shell call whose output text says Exit code: 2 as an error, with the text after Output: as its error line', () => {
    const out = extractOf([meta('/work/app'), turn(), prompt(2, 'run it'), shellCall(3, 'c1', ['bash', '-lc', 'make']), shellOut(4, 'c1', execText(2, 'make: *** No rule to make target\nsecond line')), usage(5, 10, 0, 5, 0, 15)]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: 'make: *** No rule to make target' }]);
  });

  it('leaves a declined command with no outcome, so it never counts as a fix', () => {
    const out = extractOf([meta('/work/app'), shellCall(3, 'c1', ['rm', '-rf', 'x']), shellEnd(4, 'c1', 1, '', 'declined')]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'none' }]);
    expect(out.errorLines).toEqual([]);
  });

  it('reads the unified-exec header Process exited with code N (context.rs:556), and leaves a still-running process unsettled', () => {
    const header = (rest: string): string => `Chunk ID: ab12\nWall time: 0.0100 seconds\n${rest}\nOriginal token count: 3\nOutput:\n`;
    const call = (second: number, id: string, cmd: string) => line(T(second), 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd }), call_id: id });
    const out = extractOf([
      meta('/work/app'),
      call(2, 'u1', 'npm test'),
      shellOut(3, 'u1', `${header('Process exited with code 1')}1 test failed`),
      call(4, 'u2', 'ls'),
      shellOut(5, 'u2', `${header('Process exited with code 0')}a.txt`),
      call(6, 'u3', 'sleep 100'),
      shellOut(7, 'u3', header('Process running with session ID 42')),
    ]);
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'error'], ['Bash', 'ok'], ['Bash', 'none']]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['1 test failed']);
  });

  it('reads the content-item array form of an output (models.rs:2376)', () => {
    const out = extractOf([
      meta('/work/app'),
      shellCall(2, 'c1', ['make']),
      shellOut(3, 'c1', [{ type: 'input_text', text: execText(3, 'boom: it broke') }, { type: 'input_image', image_url: 'x' }]),
    ]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['boom: it broke']);
  });

  it('unwraps the older JSON wrapper (rust-v0.46.0 tools/mod.rs:186-210) so the error line joins a Claude Code signature', () => {
    const wrapped = JSON.stringify({ output: 'EACCES: permission denied, open /etc/x', metadata: { exit_code: 1, duration_seconds: 0.1 } });
    const out = extractOf([meta('/work/app'), shellCall(3, 'c1', ['cat', '/etc/x']), shellOut(4, 'c1', wrapped)]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['EACCES: permission denied, open /etc/x']);
  });

  it('records a non-shell call as ok: ac558e2 writes no failure signal for it', () => {
    const out = extractOf([
      meta('/work/app'),
      line(T(3), 'response_item', { type: 'function_call', name: 'update_plan', arguments: '{}', call_id: 'c2' }),
      shellOut(4, 'c2', 'plan rejected: bad plan'),
    ]);
    expect(out.tools).toMatchObject([{ tool: 'update_plan', status: 'ok' }]);
    expect(out.errorLines).toEqual([]);
  });

  it('treats a persisted exec_command_end with status failed and no exit_code as a failure, and settles a call only once', () => {
    const out = extractOf([
      meta('/work/app'),
      shellCall(2, 'c1', ['x']),
      line(T(3), 'event_msg', { type: 'exec_command_end', call_id: 'c1', status: 'failed', aggregated_output: 'no code here' }),
      shellOut(4, 'c1', execText(0, 'ignored: already settled')),
    ]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
  });

  it('counts torn lines, and treats a nonblank file with no parseable line as unreadable', () => {
    const text = `${rolloutText(meta('/work/app'))}\n{torn\n\n{also torn\n`;
    expect(rolloutBadLines(text)).toEqual(['{torn', '{also torn']);
    expect(() => rolloutLines('{torn\nnot json\n', 's')).toThrow(/no parseable line/);
    expect(rolloutLines('\n\n', 's')).toEqual([]);
  });

  it('writes no usage for a session with none, and never a measured zero', () => {
    const out = extractOf([meta('/work/app'), prompt(2, 'hi'), say(3, 'hello'), line(T(4), 'event_msg', { type: 'token_count', info: null }), usage(5, 0, 0, 0, 0, 0)]);
    expect(out.session.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0 });
    const hasUsage = rolloutLines(asText([meta('/work/app'), say(3, 'hello'), usage(5, 0, 0, 0, 0, 0)]), 's').some((entry) => JSON.stringify(entry).includes('"usage"'));
    expect(hasUsage).toBe(false);
  });

  it('gives every assistant line a requestId, including one after the last token_count and in a session with no usage', () => {
    const assistants = (lines: readonly unknown[]) => rolloutLines(asText(lines), 's').filter((entry) => entry.type === 'assistant');
    const trailing = assistants([meta('/work/app'), say(2, 'a'), usage(3, 5, 0, 5, 0, 10), say(4, 'b')]);
    expect(trailing).toHaveLength(2);
    expect(trailing.every((entry) => typeof entry.requestId === 'string')).toBe(true);
    expect(trailing[0]?.requestId).not.toBe(trailing[1]?.requestId);
    expect(assistants([meta('/work/app'), say(2, 'a'), say(3, 'b')]).every((entry) => typeof entry.requestId === 'string')).toBe(true);
  });

  it('gives a prompt with a missing, relative, or earlier stamp the latest time so far, never an earlier one', () => {
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
    // /tmp/notes is under no git root, so the skeleton names no repository.
    expect(out.session.repo).toBeNull();
  });

  it('redacts a secret and an email, and cuts a 1,500-character error at 1,000 characters', () => {
    const long = `fail: sk-abcdefghijklmnopqrstuvwxyz0123 for alice@example.com ${'x'.repeat(1500)}`;
    const out = extractOf([meta('/work/app'), shellCall(3, 'c1', ['make']), shellEnd(4, 'c1', 1, long)]);
    const [error] = out.errorLines;
    expect(error?.line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(error?.line).not.toContain('alice@example.com');
    expect(error?.line.length).toBe(1000);
  });

  it('settles a local_shell_call (action.command) from its output, and leaves a shell output with no exit code unsettled', () => {
    const out = extractOf([
      meta('/work/app'),
      line(T(2), 'response_item', { type: 'local_shell_call', call_id: 'c1', status: 'completed', action: { type: 'exec', command: ['ls'] } }),
      shellOut(3, 'c1', JSON.stringify({ output: 'ls: nope', metadata: { exit_code: 2 } })),
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
    expect(store?.unreadable[0]?.file).toContain('rollout-x.jsonl.zst');
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
  });
});

describe('fix round 2 behaviors', () => {
  const unified = (second: number, id: string, name: string, args: unknown) => line(T(second), 'response_item', { type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });
  const head = (rest: string): string => `Chunk ID: ab12\nWall time: 0.0100 seconds\n${rest}\nOriginal token count: 3\nOutput:\n`;

  it('reads write_stdin as a shell call: its exit header fails it and the exec_command it polls (shell_spec.rs:113, context.rs:556)', () => {
    const out = extractOf([
      meta('/work/app'),
      unified(2, 'u1', 'exec_command', { cmd: 'npm test' }),
      shellOut(3, 'u1', head('Process running with session ID 42')),
      unified(4, 'u2', 'write_stdin', { session_id: 42, chars: '' }),
      shellOut(5, 'u2', `${head('Process exited with code 1')}2 tests failed`),
    ]);
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'error'], ['Bash', 'error']]);
    expect(out.errorLines.map((entry) => entry.line)).toContain('2 tests failed');
  });

  it('leaves write_stdin and its exec_command unsettled while the process is still running', () => {
    const out = extractOf([
      meta('/work/app'),
      unified(2, 'u1', 'exec_command', { cmd: 'sleep 9' }),
      shellOut(3, 'u1', head('Process running with session ID 7')),
      unified(4, 'u2', 'write_stdin', { session_id: 7, chars: '' }),
      shellOut(5, 'u2', head('Process running with session ID 7')),
    ]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['none', 'none']);
  });

  it('records a shell call that failed to spawn (execution error: ..., events.rs:438) as an error', () => {
    const out = extractOf([meta('/work/app'), shellCall(2, 'c1', ['nope']), shellOut(3, 'c1', 'execution error: Os { code: 2, kind: NotFound }')]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['execution error: Os { code: 2, kind: NotFound }']);
  });

  it('leaves a declined shell call in the plain-text form (events.rs:456) with no outcome', () => {
    const out = extractOf([meta('/work/app'), shellCall(2, 'c1', ['rm', 'x']), shellOut(3, 'c1', 'exec command rejected by user')]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'none' }]);
    expect(out.errorLines).toEqual([]);
  });

  const mcpCall = (second: number, id: string) => line(T(second), 'response_item', { type: 'function_call', name: 'mcp__notes__find', arguments: '{}', call_id: id });
  const mcpEnd = (second: number, id: string, result: unknown) =>
    line(T(second), 'event_msg', { type: 'mcp_tool_call_end', call_id: id, invocation: { server: 'notes', tool: 'find' }, duration: { secs: 0, nanos: 1 }, result });

  it('settles an MCP call from mcp_tool_call_end: a result.Err and an Ok with isError are failures, an Ok is not (protocol.rs:3047, :3076)', () => {
    const out = extractOf([
      meta('/work/app'),
      mcpCall(2, 'm1'),
      mcpEnd(3, 'm1', { Err: 'server unavailable' }),
      shellOut(4, 'm1', 'ignored'),
      mcpCall(5, 'm2'),
      mcpEnd(6, 'm2', { Ok: { content: [{ type: 'text', text: 'no such note' }], isError: true } }),
      mcpCall(7, 'm3'),
      mcpEnd(8, 'm3', { Ok: { content: [{ type: 'text', text: 'found' }], isError: false } }),
    ]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['error', 'error', 'ok']);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['server unavailable', 'no such note']);
  });

  it('leaves a patch with no patch_apply_end unsettled, so a rejected patch is not a good Edit (apply_patch.rs:351)', () => {
    const out = extractOf([
      meta('/work/app'),
      line(T(2), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' }),
      line(T(3), 'response_item', { type: 'custom_tool_call_output', call_id: 'p1', output: 'apply_patch verification failed: Failed to find expected lines' }),
    ]);
    expect(out.tools).toMatchObject([{ tool: 'Edit', status: 'none' }]);
  });

  it('leaves a declined patch (status declined, protocol.rs:4072) unsettled, as a declined shell call is', () => {
    const out = extractOf([
      meta('/work/app'),
      line(T(2), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Update File: src/a.ts' }),
      line(T(3), 'event_msg', { type: 'patch_apply_end', call_id: 'p1', success: false, stderr: 'patch rejected by user', status: 'declined' }),
    ]);
    expect(out.tools).toMatchObject([{ tool: 'Edit', status: 'none' }]);
    expect(out.errorLines).toEqual([]);
  });

  it('reads cache_write_input_tokens as cache creation, outside input: input 100 = cached 40 + write 60 (responses.rs:889-911)', () => {
    const withWrite = line(T(4), 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 30, output_tokens: 10, total_tokens: 110 } } });
    const out = extractOf([meta('/work/app'), say(3, 'hello'), withWrite]);
    expect(out.session.usage).toMatchObject({ input: 50, cacheRead: 20, cacheWrite: 30, output: 10 });
  });

  it('cuts at 1,000 characters and redacts on the live text path (a function_call_output, not an exec_command_end)', () => {
    const long = `fail: sk-abcdefghijklmnopqrstuvwxyz0123 for alice@example.com ${'x'.repeat(1500)}`;
    const out = extractOf([meta('/work/app'), shellCall(3, 'c1', ['make']), shellOut(4, 'c1', execText(1, long))]);
    const [error] = out.errorLines;
    expect(error?.line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(error?.line).not.toContain('alice@example.com');
    expect(error?.line.length).toBe(1000);
  });

  it('names a sessions folder it cannot read instead of reporting no store', async () => {
    const s = stage();
    const home = join(s.root, 'h');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'sessions'), 'a plain file, not a folder');
    const store = await openCodexStore(home);
    expect(store?.sessions).toEqual([]);
    expect(store?.unreadable).toHaveLength(1);
    expect(store?.unreadable[0]?.file).toContain('sessions');
    // The reason carries no path, so a log line built from it cannot leak the home folder.
    expect(store?.unreadable[0]?.reason).not.toContain(home);
  });

  it('carries parent_thread_id and agent_role from session_meta on the listed session', async () => {
    const s = stage();
    const id = '55555555-5555-4555-8555-555555555555';
    const home = stageCodex(s.root, [{ id, lines: [line(T(0), 'session_meta', { id, timestamp: T(0), cwd: '/work/app', parent_thread_id: 'sess-1', agent_role: 'explorer' })] }]);
    const store = await openCodexStore(home);
    expect(store?.sessions[0]).toMatchObject({ parent: 'sess-1', agentRole: 'explorer' });
  });

  // rollout/src/rollout_file_name.rs:12-14, :41-47, :66-73: `rollout-<time>-<thread>.jsonl`, and for a reverted thread `rollout-<time>-<thread>_<rollout>.jsonl`. Revert
  // is for a Paginated thread only and writes a new file whose session_meta carries history_base (thread-store/src/local/revert_thread.rs:15-18, :66-70, :198-200;
  // protocol/src/protocol.rs:3508-3510) and takes history_base.end_ordinal_exclusive as its first ordinal (rollout/src/ordinal.rs:29-31).
  it('keys the rollout of a reverted thread <thread>_<rollout> and files it under its thread, so one thread is one session', async () => {
    const s = stage();
    const thread = '66666666-6666-4666-8666-666666666666';
    const reverted = '77777777-7777-4777-8777-777777777777';
    const base = { thread_id: thread, end_ordinal_exclusive: 3, end_byte_offset: 512 };
    const paginated = { id: thread, session_id: thread, timestamp: T(0), cwd: '/work/app', history_mode: 'paginated' };
    const home = stageCodex(s.root, [
      { id: thread, lines: [{ ...line(T(0), 'session_meta', paginated), ordinal: 0 }] },
      { id: `${thread}_${reverted}`, lines: [{ ...line(T(0), 'session_meta', { ...paginated, history_base: base }), ordinal: 3 }] },
    ]);
    const store = await openCodexStore(home);
    expect(store?.sessions.map((session) => [session.id, session.parent])).toEqual(
      expect.arrayContaining([
        [thread, null],
        [`${thread}_${reverted}`, thread],
      ]),
    );
    expect(store?.sessions).toHaveLength(2);
  });

  it('keeps every record of a reverted rollout though its ordinals start at history_base.end_ordinal_exclusive, since the prefix is not copied into the file (ordinal.rs:29-31)', () => {
    const lines = rolloutLines(
      asText([
        { ...line(T(0), 'session_meta', { id: 'sess-1', session_id: 'sess-1', timestamp: T(0), cwd: '/work/app', history_mode: 'paginated', history_base: { thread_id: 'sess-1', end_ordinal_exclusive: 7, end_byte_offset: 900 } }), ordinal: 7 },
        { ...line(T(2), 'event_msg', { type: 'item_completed', thread_id: 'sess-1', turn_id: 't3', item: { type: 'UserMessage', id: 'u3', content: [{ type: 'text', text: 'after the revert', text_elements: [] }] } }), ordinal: 8 },
      ]),
      's',
    );
    expect(lines.filter((entry) => entry.type === 'user')).toMatchObject([{ message: { content: [{ text: 'after the revert' }] } }]);
  });

  it('reports a rollout that vanishes after it is listed by file name only, even when the root is outside the home folder', async () => {
    const s = stage();
    const id = '88888888-8888-4888-8888-888888888888';
    const home = stageCodex(join(s.root, 'elsewhere-root-name'), [{ id, lines: [line(T(0), 'session_meta', { id, timestamp: T(0), cwd: '/work/app' })] }]);
    const store = await openCodexStore(home);
    const session = store?.sessions[0];
    if (store === undefined || session === undefined) throw new Error('the staged store lists no rollout');
    rmSync(session.file);
    const failure = await store.transcript(session).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toContain('ENOENT');
    expect(failure).not.toContain('elsewhere-root-name');
  });
});

// Fix round 3. Paginated rollouts are what the cited commit writes by default (thread-store/src/local/mod.rs:512-515): the legacy user_message,
// agent_message, patch_apply_end, and mcp_tool_call_end events are not persisted there (rollout/src/policy.rs:142-156, `persisted_item_completed_event` at :232), and an `item_completed`
// event holding a `TurnItem` (protocol/src/items.rs:50, tag `type`, variant names as written) takes their place. Its content parts carry their own tag: a UserMessage's
// `UserInput` is snake_case (`text`, user_input.rs:16), an AgentMessage's `AgentMessageContent` has no rename_all (`Text`, items.rs:131-135); response_item, turn_context, and
// token_count are persisted in both modes (policy.rs:27-29 response_item, :43 turn_context, :49 session_meta, :134 token_count). Every record carries an `ordinal` in this mode (rollout/src/ordinal.rs:28).
describe('Paginated rollouts', () => {
  let next = 0;
  const ord = (entry: object): object => ({ ...entry, ordinal: next++ });
  const pmeta = (extra: object = {}) => ord(line(T(0), 'session_meta', { id: 'sess-1', timestamp: T(0), cwd: '/work/app', cli_version: '0.60.0', history_mode: 'paginated', ...extra }));
  const done = (second: number, item: object) => ord(line(T(second), 'event_msg', { type: 'item_completed', thread_id: 'sess-1', turn_id: 't1', item }));
  const call = (second: number, id: string, name: string, extra: object = {}) => ord(line(T(second), 'response_item', { type: 'function_call', name, arguments: '{}', call_id: id, ...extra }));
  const patchCall = (second: number, id: string) => ord(line(T(second), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: id, input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' }));
  const begin = (): void => {
    next = 0;
  };

  it('reads a UserMessage and an AgentMessage item_completed as the prompt and the reply (items.rs:85, :160)', () => {
    begin();
    const lines = rolloutLines(
      asText([
        pmeta(),
        done(2, { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'fix the build', text_elements: [] }, { type: 'text', text: 'and the docs', text_elements: [] }] }),
        done(3, { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'done' }] }),
      ]),
      's',
    );
    expect(lines.filter((entry) => entry.type === 'user')).toMatchObject([{ message: { content: [{ type: 'text', text: 'fix the build\nand the docs' }] } }]);
    expect(lines.filter((entry) => entry.type === 'assistant')).toMatchObject([{ message: { content: [{ type: 'text', text: 'done' }] } }]);
  });

  it('keeps reading turn_context, token_count, and the shell response_items, which Paginated mode still persists', () => {
    begin();
    const out = extractOf([
      pmeta(),
      ord(turn()),
      done(2, { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'run it', text_elements: [] }] }),
      call(3, 'c1', 'shell', { arguments: JSON.stringify({ command: ['make'] }) }),
      ord(shellOut(4, 'c1', execText(2, 'make: *** No rule'))),
      done(5, { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'it failed' }] }),
      ord(usage(6, 100, 40, 10, 0, 110)),
    ]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['make: *** No rule']);
    expect(out.session.usage).toMatchObject({ input: 60, cacheRead: 40, output: 10 });
  });

  it('settles a patch from its FileChange item (events.rs:610-617, id is the call id): failed is an error, completed is ok, declined settles nothing', () => {
    begin();
    const change = (second: number, id: string, status: string, stderr = '') => done(second, { type: 'FileChange', id, changes: {}, status, stdout: '', stderr });
    const out = extractOf([
      pmeta(),
      patchCall(2, 'p1'),
      change(3, 'p1', 'failed', 'could not apply'),
      patchCall(4, 'p2'),
      change(5, 'p2', 'completed'),
      patchCall(6, 'p3'),
      change(7, 'p3', 'declined', 'rejected by user'),
    ]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['error', 'ok', 'none']);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['could not apply']);
  });

  it('settles an MCP call from its McpToolCall item (mcp_tool_call.rs:1189-1207, items.rs:459): an error or an isError result fails it', () => {
    begin();
    const mcp = (second: number, id: string, rest: object) => done(second, { type: 'McpToolCall', id, server: 'notes', tool: 'find', arguments: {}, ...rest });
    const out = extractOf([
      pmeta(),
      call(2, 'm1', 'mcp__notes__find'),
      mcp(3, 'm1', { status: 'failed', error: { message: 'server unavailable' } }),
      call(4, 'm2', 'mcp__notes__find'),
      mcp(5, 'm2', { status: 'completed', result: { content: [{ type: 'text', text: 'no such note' }], isError: true } }),
      call(6, 'm3', 'mcp__notes__find'),
      mcp(7, 'm3', { status: 'completed', result: { content: [{ type: 'text', text: 'found' }] } }),
    ]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['error', 'error', 'ok']);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['server unavailable', 'no such note']);
  });

  it('ignores item_completed items it has no use for (a Plan, a CommandExecution) without failing', () => {
    begin();
    const lines = rolloutLines(asText([pmeta(), done(2, { type: 'Plan', id: 'x', text: 'steps' }), done(3, { type: 'CommandExecution', id: 'y', status: 'completed' })]), 's');
    expect(lines).toEqual([]);
  });

  it('applies only the first session_meta: a copy from fork history keeps the fork id and cwd (recorder.rs:1157-1158, :1173), in a Legacy rollout, which has no ordinals (ordinal.rs:37)', () => {
    const fork = line(T(0), 'session_meta', { id: 'sess-2', timestamp: T(0), cwd: '/work/app', cli_version: '0.60.0', forked_from_id: 'sess-1' });
    const copied = line(T(0), 'session_meta', { id: 'sess-1', timestamp: T(0), cwd: '/work/parent', cli_version: '0.60.0' });
    const lines = rolloutLines(asText([fork, copied, prompt(4, 'own')]), 's');
    expect(lines.filter((entry) => entry.type === 'user')).toHaveLength(1);
    expect(lines.every((entry) => entry.sessionId === 'sess-2' && entry.cwd === '/work/app')).toBe(true);
  });

  // ordinal.rs:30, :47-53: a rollout's first record takes history_base.end_ordinal_exclusive (0 with none) and every record after it one more. A subagent's file
  // starts with its own session_meta, then the parent's prefix through subagent_history_start_ordinal - 1, which is model context only (ordinal.rs:86-89,
  // protocol.rs:3511-3516). A fork's file holds no inherited records: its history_base points at the parent's rollout instead (protocol.rs:3508-3510).
  it('drops the parent prefix a subagent rollout copied (ordinals below subagent_history_start_ordinal), keeping its own records', () => {
    begin();
    const lines = rolloutLines(
      asText([
        pmeta({ id: 'sess-2', parent_thread_id: 'sess-1', subagent_history_start_ordinal: 3 }),
        done(1, { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'inherited prompt', text_elements: [] }] }),
        done(2, { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'inherited reply' }] }),
        done(4, { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: 'own prompt', text_elements: [] }] }),
        done(5, { type: 'AgentMessage', id: 'a2', content: [{ type: 'Text', text: 'own reply' }] }),
      ]),
      's',
    );
    expect(lines.filter((entry) => entry.type === 'user')).toMatchObject([{ message: { content: [{ text: 'own prompt' }] } }]);
    expect(lines.filter((entry) => entry.type === 'assistant')).toMatchObject([{ message: { content: [{ text: 'own reply' }] } }]);
  });

  it('puts the token_count of a text-only response on its reply (an AgentMessage is {type: Text}, items.rs:131-135)', () => {
    begin();
    const out = extractOf([
      pmeta(),
      ord(turn()),
      done(2, { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'explain it', text_elements: [] }] }),
      done(3, { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'here is why' }] }),
      ord(usage(4, 100, 40, 10, 0, 110)),
    ]);
    expect(out.session.assistantTurns).toBe(1);
    expect(out.session.usage).toMatchObject({ input: 60, cacheRead: 40, output: 10 });
  });
});

describe('a Legacy fork (no ordinals)', () => {
  const [m0, p1, r2, p3] = [meta('/work/app'), prompt(1, 'first'), say(2, 'reply'), prompt(3, 'second')] as const;
  const parent = [m0, p1, r2, p3];
  const forkMeta = (id: string) => line(T(10), 'session_meta', { id, timestamp: T(10), cwd: '/work/app', forked_from_id: 'sess-1' });
  const at = (offset: number, entry: { timestamp: string }) => ({ ...entry, timestamp: T(offset) });
  const prompts = (lines: ReturnType<typeof rolloutLines>) => lines.filter((entry) => entry.type === 'user');

  it('drops the leading records that match the parent rollout, payload for payload with timestamps excluded', () => {
    const child = [forkMeta('sess-2'), at(11, m0), at(12, p1), at(13, r2), at(14, p3), prompt(20, 'own prompt')];
    const lines = rolloutLines(asText(child), 'sess-2', asText(parent));
    expect(prompts(lines)).toMatchObject([{ message: { content: [{ text: 'own prompt' }] } }]);
    expect(lines.filter((entry) => entry.type === 'assistant')).toHaveLength(0);
  });

  it('stops matching at the first record that differs, so a later repeat of a parent prompt belongs to the fork', () => {
    const child = [forkMeta('sess-2'), at(11, p1), prompt(20, 'own prompt'), at(21, p3)];
    expect(prompts(rolloutLines(asText(child), 'sess-2', asText(parent)))).toHaveLength(2);
  });

  it('keeps every record when the parent rollout is absent, since nothing can be matched', () => {
    const child = [forkMeta('sess-2'), at(11, p1), prompt(20, 'own prompt')];
    expect(prompts(rolloutLines(asText(child), 'sess-2'))).toHaveLength(2);
  });
});

describe('a namespaced function_call (models.rs:1154)', () => {
  const named = (name: string, namespace: string | undefined) =>
    extractOf([meta('/work/app'), line(T(2), 'response_item', { type: 'function_call', name, ...(namespace === undefined ? {} : { namespace }), arguments: '{}', call_id: 'c1' }), line(T(3), 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' })]).tools[0]?.tool;

  // A function_call carries the namespace (`ResponseItem::FunctionCall`, models.rs:3406-3412 and :3484-3489). Upstream flattens a namespaced tool to
  // `namespace` + `name` with no delimiter (core/src/tools/mod.rs:55-60, codex-mcp/src/tools.rs:296), and an MCP namespace ends in its own `__`
  // (codex-mcp/src/tools.rs:253 strips that suffix). The reader keeps that form; the `__` it adds to any other namespace is its own labeled choice.
  it('joins an MCP namespace that ends in __ to the name with nothing between, as upstream does (tools.rs:296)', () => {
    expect(named('find', 'mcp__notes__')).toBe('mcp__notes__find');
  });

  it('labels its own choice: __ between a namespace without a trailing __ and a bare name (models.rs:3485-3486: collaboration + spawn_agent)', () => {
    expect(named('spawn_agent', 'collaboration')).toBe('collaboration__spawn_agent');
  });

  it('keeps a name that already starts with its namespace (models.rs:3409-3410: mcp__codex_apps__gmail)', () => {
    expect(named('mcp__codex_apps__gmail_get_recent_emails', 'mcp__codex_apps__gmail')).toBe('mcp__codex_apps__gmail_get_recent_emails');
  });

  it('does not class a namespaced shell or exec_command as Bash, but still does without a namespace', () => {
    expect(named('shell', 'collaboration')).toBe('collaboration__shell');
    expect(named('exec_command', 'collaboration')).toBe('collaboration__exec_command');
    expect(named('shell', undefined)).toBe('Bash');
  });

  // The default namespace is `functions` (protocol/src/tool_name.rs:6-7); `None`, an empty string, and `functions` are all the plain tool
  // (:46-50, core/src/tools/mod.rs:51-53), and the router makes every function_call that way (core/src/tools/router.rs:285).
  it('reads a shell call under the default namespace functions as Codex\'s own shell, so its exit code is the outcome', () => {
    const call = line(T(3), 'response_item', { type: 'function_call', name: 'shell', namespace: 'functions', arguments: JSON.stringify({ command: ['bash', '-lc', 'make'] }), call_id: 'c1' });
    const out = extractOf([meta('/work/app'), turn(), prompt(2, 'run it'), call, shellOut(4, 'c1', execText(2, 'make: *** No rule to make target'))]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: 'make: *** No rule to make target' }]);
  });

  it('reads an empty namespace and functions as no namespace for any name, and an apply_patch under functions as the patch tool', () => {
    expect(named('read_file', 'functions')).toBe('read_file');
    expect(named('read_file', '')).toBe('read_file');
    const patch = line(T(2), 'response_item', { type: 'function_call', name: 'apply_patch', namespace: 'functions', arguments: JSON.stringify({ input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' }), call_id: 'c1' });
    expect(extractOf([meta('/work/app'), patch, line(T(3), 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'ok' })]).tools[0]?.tool).toBe('Edit');
  });
});

// The default shell tool at ac558e2 is unified exec: ConfigShellToolType is only UnifiedExec | Disabled (protocol/src/openai_models.rs:330-333). Its
// reply is `response_header` + the output (core/src/tools/context.rs:544-570, the exit code at :556), and a call that fails before it has an exit code
// comes back as a plain message through `RespondToModel` (tools/src/function_call_error.rs:5-7), written as the output with `success: false`
// (core/src/tools/parallel.rs:454-480).
describe('a unified-exec shell call (core/src/tools/handlers/unified_exec)', () => {
  const unified = (second: number, id: string, name: string, args: unknown) => line(T(second), 'response_item', { type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });
  const head = (rest: string): string => `Chunk ID: ab12\nWall time: 0.0100 seconds\n${rest}\nOriginal token count: 3\nOutput:\n`;

  it('hands a clean call\'s output on, so a git commit records the sha its [branch sha] line printed (context.rs:556)', () => {
    const out = extractOf([
      meta('/work/app'),
      unified(2, 'u1', 'exec_command', { cmd: 'git commit -m x' }),
      shellOut(3, 'u1', `${head('Process exited with code 0')}[main abc1234] x\n 1 file changed, 1 insertion(+)`),
    ]);
    expect(out.tools[0]).toMatchObject({ tool: 'Bash', status: 'ok', commits: ['abc1234'] });
  });

  it('hands on the output of the write_stdin that saw a backgrounded git commit exit, to the exec_command that started it', () => {
    const out = extractOf([
      meta('/work/app'),
      unified(2, 'u1', 'exec_command', { cmd: 'git commit -m x' }),
      shellOut(3, 'u1', head('Process running with session ID 9')),
      unified(4, 'u2', 'write_stdin', { session_id: 9, chars: '' }),
      shellOut(5, 'u2', `${head('Process exited with code 0')}[main def5678] x`),
    ]);
    expect(out.tools[0]).toMatchObject({ status: 'ok', commits: ['def5678'] });
  });

  it('records exec_command failed: <err> (exec_command.rs:270) as an error, with its text as the error line', () => {
    const out = extractOf([meta('/work/app'), unified(2, 'u1', 'exec_command', { cmd: 'nope' }), shellOut(3, 'u1', 'exec_command failed: Os { code: 2, kind: NotFound }')]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['exec_command failed: Os { code: 2, kind: NotFound }']);
  });

  it('records write_stdin failed: <err> and write_stdin approval failed: <err> (write_stdin.rs:121, :123) as errors', () => {
    const out = extractOf([
      meta('/work/app'),
      unified(2, 'u1', 'write_stdin', { session_id: 5, chars: 'y' }),
      shellOut(3, 'u1', 'write_stdin failed: UnknownSessionId { process_id: 5 }'),
      unified(4, 'u2', 'write_stdin', { session_id: 6, chars: 'y' }),
      shellOut(5, 'u2', 'write_stdin approval failed: sandbox denied'),
    ]);
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'error'], ['Bash', 'error']]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['write_stdin failed: UnknownSessionId { process_id: 5 }', 'write_stdin approval failed: sandbox denied']);
  });

  it('leaves write_stdin rejected: <reason> (write_stdin.rs:118) unsettled, as a declined call is', () => {
    const out = extractOf([meta('/work/app'), unified(2, 'u1', 'write_stdin', { session_id: 5, chars: 'y' }), shellOut(3, 'u1', 'write_stdin rejected: not allowed')]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'none' }]);
    expect(out.errorLines).toEqual([]);
  });
});
