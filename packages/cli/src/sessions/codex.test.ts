import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { codexRoot, openCodexStore, rolloutBadLines, rolloutLines } from './codex.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { deposit, loadStore, readSkeletons } from './store.js';
import { cleanup, NOW, rolloutLine as line, stage, stageCodex } from './test-support.js';
import { verifyAll, verifyCaptured } from './verify.js';

afterEach(cleanup);

// Every fixture below is written from openai/codex @ ac558e2 (Apache-2.0): the envelope from codex-rs/history/src/lib.rs (`RolloutLine`) and
// rollout_payload.rs, the payloads from codex-rs/protocol/src/protocol.rs (`SessionMeta`, `TurnContextItem`, `TokenUsage`,
// `PatchApplyEndEvent`, `UserMessageEvent`, `AgentMessageEvent`) and models.rs (`ResponseItem::FunctionCall`; `FunctionCallOutputBody` at :2376 is a
// bare string or an array of `{type: input_text, text}`). SessionMeta carries `history_mode` (protocol.rs:3507). A shell call's outcome is the text of
// its function_call_output: `Exit code: N` then `Output:` (the unified-exec emitter's own text, core/src/tools/events.rs:400, :416, :423), or `Process exited with code N` (core/src/tools/context.rs:556).
// Which events a rollout holds is codex-rs/rollout/src/policy.rs: ExecCommandEnd is never persisted (:165) and so is not read, PatchApplyEnd only in Legacy mode (:143).
// One shape is an older version's and says so where used: the JSON `{output, metadata.exit_code}` wrapper (rust-v0.46.0 core/src/tools/mod.rs:186-210)
// No live store was read.

const capture = (text: string, harness?: 'codex') =>
  captureSession({
    text,
    ...(harness === undefined ? {} : { harness }),
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
const extractOf = (lines: readonly unknown[], harness?: 'codex') => {
  const transcript = rolloutLines(asText(lines), 'sess').map((entry) => JSON.stringify(entry)).join('\n');
  return capture(transcript, harness);
};

const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const meta = (cwd: string) => line(T(0), 'session_meta', { id: 'sess-1', session_id: 'sess-1', timestamp: T(0), cwd, originator: 'codex_cli_rs', cli_version: '0.50.0' });
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
// The persisted shape at ac558e2: the unified-exec emitter's own text (core/src/tools/events.rs:400, :416, :423); `shell` and `shell_command` are older names for it.
const execText = (exit: number, output: string): string => `Exit code: ${String(exit)}\nWall time: 0.1 seconds\nOutput:\n${output}`;
const shellOut = (second: number, id: string, output: unknown) => line(T(second), 'response_item', { type: 'function_call_output', call_id: id, output });

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
    const out = extractOf([meta('/work/app'), shellCall(3, 'c1', ['make']), shellOut(4, 'c1', execText(1, long))]);
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

describe('shell, MCP, patch, and usage outcomes', () => {
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

  it('reads a declined shell call in the plain-text form (events.rs:456) as the user rejecting it', () => {
    const out = extractOf([meta('/work/app'), shellCall(2, 'c1', ['rm', 'x']), shellOut(3, 'c1', 'exec command rejected by user')]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error', errorCode: 'user-rejected' }]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['exec command rejected by user']);
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

  it('reads a declined patch (status declined, protocol.rs:4072) as the user rejecting it, as a declined shell call is', () => {
    const out = extractOf([
      meta('/work/app'),
      line(T(2), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Update File: src/a.ts' }),
      line(T(3), 'event_msg', { type: 'patch_apply_end', call_id: 'p1', success: false, stderr: 'patch rejected by user', status: 'declined' }),
    ]);
    expect(out.tools).toMatchObject([{ tool: 'Edit', status: 'error', errorCode: 'user-rejected' }]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['patch rejected by user']);
  });

  it('reads a declined patch_apply_end whose stderr is the bare refusal text as the user rejecting it', () => {
    const out = extractOf([
      meta('/work/app'),
      line(T(2), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Update File: src/a.ts' }),
      line(T(3), 'event_msg', { type: 'patch_apply_end', call_id: 'p1', success: false, stderr: 'rejected by user', status: 'declined' }),
    ]);
    expect(out.tools).toMatchObject([{ tool: 'Edit', status: 'error', errorCode: 'user-rejected' }]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['patch rejected by user']);
  });

  it('leaves a declined patch_apply_end unsettled when its stderr is a setup failure, not the user refusal text (events.rs:448-458)', () => {
    const out = extractOf([
      meta('/work/app'),
      line(T(2), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Update File: src/a.ts' }),
      line(T(3), 'event_msg', { type: 'patch_apply_end', call_id: 'p1', success: false, stderr: 'sandbox setup failed', status: 'declined' }),
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
    const home = stageCodex(s.root, [{ id, lines: [line(T(0), 'session_meta', { id, session_id: 'sess-1', originator: 'codex_cli_rs', timestamp: T(0), cwd: '/work/app', parent_thread_id: 'sess-1', agent_role: 'explorer' })] }]);
    const store = await openCodexStore(home);
    expect(store?.sessions[0]).toMatchObject({ parent: 'sess-1', agentRole: 'explorer' });
  });

  // rollout/src/rollout_file_name.rs:12-14, :41-47, :66-73: `rollout-<time>-<thread>.jsonl`, and for a reverted thread `rollout-<time>-<thread>_<rollout>.jsonl`. Revert
  // is for a Paginated thread only and writes a new file whose session_meta carries history_base (thread-store/src/local/revert_thread.rs:15-18, :66-70, :198-200;
  // protocol/src/protocol.rs:3508-3510) and takes history_base.end_ordinal_exclusive as its first ordinal (rollout/src/ordinal.rs:29-31).
  it('folds the rollout of a reverted thread into its thread, so one thread is one session, and keeps it a subagent of the thread when the thread is not in the store', async () => {
    const s = stage();
    const thread = '66666666-6666-4666-8666-666666666666';
    const reverted = '77777777-7777-4777-8777-777777777777';
    const base = { thread_id: thread, end_ordinal_exclusive: 3, end_byte_offset: 512 };
    const paginated = { id: thread, session_id: thread, originator: 'codex_cli_rs', timestamp: T(0), cwd: '/work/app', history_mode: 'paginated' };
    const home = stageCodex(s.root, [
      { id: thread, lines: [{ ...line(T(0), 'session_meta', paginated), ordinal: 0 }] },
      { id: `${thread}_${reverted}`, lines: [{ ...line(T(0), 'session_meta', { ...paginated, history_base: base }), ordinal: 3 }] },
    ]);
    const store = await openCodexStore(home);
    expect(store?.sessions.map((session) => [session.id, session.parent, session.revisions.length])).toEqual([[thread, null, 1]]);
    const alone = stageCodex(join(s.root, 'alone'), [{ id: `${thread}_${reverted}`, lines: [{ ...line(T(0), 'session_meta', { ...paginated, history_base: base }), ordinal: 3 }] }]);
    expect((await openCodexStore(alone))?.sessions.map((session) => [session.id, session.parent])).toEqual([[`${thread}_${reverted}`, thread]]);
  });

  // The prompts and heads of a thread's files, as upstream writes them: `item_completed` UserMessage items (policy.rs:142-156) with a rising ordinal.
  describe('the lineage of a reverted thread', () => {
    const thread = '66666666-6666-4666-8666-666666666666';
    const first = '77777777-7777-4777-8777-777777777777';
    const second = '88888888-8888-4888-8888-888888888888';
    const head = { id: thread, session_id: thread, originator: 'codex_cli_rs', timestamp: T(0), cwd: '/work/app', history_mode: 'paginated' };
    const asked = (at: number, ordinal: number, message: string) => ({
      ...line(T(at), 'event_msg', { type: 'item_completed', thread_id: thread, turn_id: `t-${message}`, item: { type: 'UserMessage', id: `u-${message}`, content: [{ type: 'text', text: message, text_elements: [] }] } }),
      ordinal,
    });
    const origin = (...prompts: readonly object[]) => ({ id: thread, lines: [{ ...line(T(0), 'session_meta', head), ordinal: 0 }, ...prompts] });
    const start = (at: number, from: number) => ({
      ...line(T(at), 'session_meta', { ...head, timestamp: T(at), history_base: { thread_id: thread, end_ordinal_exclusive: from, end_byte_offset: 1 } }),
      ordinal: from,
    });
    const promptsOf = async (home: string): Promise<string[]> => {
      const store = await openCodexStore(home);
      const only = store?.sessions.find((session) => session.id === thread);
      if (store === undefined || only === undefined) throw new Error('the store lists no thread');
      return (await store.transcript(only)).split('\n').flatMap((raw) => /"text":"([^"]*)"/.exec(raw)?.[1] ?? []);
    };

    // Each file is read only below the start of the files written after it: the second revert drops the first's own records, and both drop the original's tail.
    it('reads the latest revert over an earlier one, each cutting the records at and after its start from the files before it', async () => {
      const s = stage();
      const home = stageCodex(s.root, [
        origin(asked(1, 1, 'kept'), asked(2, 2, 'dropped by the first revert'), asked(3, 3, 'dropped too')),
        { id: `${thread}_${first}`, lines: [start(4, 2), asked(5, 3, 'dropped by the second revert')] },
        { id: `${thread}_${second}`, lines: [start(6, 3), asked(7, 4, 'last')] },
      ]);
      expect(await promptsOf(home)).toEqual(['kept', 'last']);
    });

    // Two reverts can carry one timestamp (a millisecond), and the later one may go further back. The file name starts with its time, so the walk order is the write order.
    it('keeps the write order of two reverts with one timestamp, though the later one starts at the smaller ordinal', async () => {
      const s = stage();
      const home = stageCodex(s.root, [
        origin(asked(1, 1, 'kept'), asked(2, 2, 'dropped'), asked(3, 3, 'dropped too'), asked(4, 4, 'dropped as well'), asked(5, 5, 'dropped by both')),
        { id: `${thread}_${first}`, lines: [start(6, 5), asked(7, 6, 'dropped by the second revert')] },
        { id: `${thread}_${second}`, lines: [start(6, 2), asked(8, 2, 'last')] },
      ]);
      expect(await promptsOf(home)).toEqual(['kept', 'last']);
    });

    it('folds a revert whose head has no timestamp, and still cuts the thread at its start', async () => {
      const s = stage();
      const bare = { ...line(T(3), 'session_meta', { ...head, timestamp: undefined, history_base: { thread_id: thread, end_ordinal_exclusive: 2, end_byte_offset: 1 } }), ordinal: 2 };
      const home = stageCodex(s.root, [origin(asked(1, 1, 'kept'), asked(2, 2, 'dropped')), { id: `${thread}_${first}`, lines: [bare, asked(3, 3, 'last')] }]);
      expect(await promptsOf(home)).toEqual(['kept', 'last']);
    });

    // history_base is an Option upstream (revert_thread.rs:121): a parsed head without one starts the file at ordinal 0, so the whole thread is superseded.
    it('cuts the whole thread for a revert whose parsed head has no history_base', async () => {
      const s = stage();
      const bare = { ...line(T(4), 'session_meta', { ...head, timestamp: T(4) }), ordinal: 0 };
      const home = stageCodex(s.root, [origin(asked(1, 1, 'dropped')), { id: `${thread}_${first}`, lines: [bare, asked(5, 1, 'last')] }]);
      expect(await promptsOf(home)).toEqual(['last']);
    });

    // A crash can tear the new file's first line. It is not a revert then, and it must not cut the thread it names.
    it('keeps the thread readable when a revert file is torn, and lists the torn file alone', async () => {
      const s = stage();
      const home = stageCodex(s.root, [origin(asked(1, 1, 'kept')), { id: `${thread}_${first}`, lines: '{"timestamp":"2026-06-01T10:00:04.000Z","type":"session_me' }]);
      expect(await promptsOf(home)).toEqual(['kept']);
      const store = await openCodexStore(home);
      expect(store?.sessions.map((session) => session.id).sort()).toEqual([thread, `${thread}_${first}`]);
    });
  });

  // A Copied fork matches its copied records against the parent's lineage as it stood when the fork started: a fork after the revert copied the post-revert
  // turn, and one before it copied a turn the revert later dropped.
  describe('a Copied fork of a reverted thread', () => {
    const thread = '66666666-6666-4666-8666-666666666666';
    const revert = '77777777-7777-4777-8777-777777777777';
    const early = '88888888-8888-4888-8888-888888888888';
    const late = '99999999-9999-4999-8999-999999999999';
    const asked = (at: number, ordinal: number, message: string) => ({
      ...line(T(at), 'event_msg', { type: 'item_completed', thread_id: thread, turn_id: `t-${message}`, item: { type: 'UserMessage', id: `u-${message}`, content: [{ type: 'text', text: message, text_elements: [] }] } }),
      ordinal,
    });
    const head = (id: string, at: number, extra: object = {}) => ({
      ...line(T(at), 'session_meta', { id, session_id: id, originator: 'codex_cli_rs', timestamp: T(at), cwd: '/work/app', history_mode: 'paginated', ...extra }),
      ordinal: 0,
    });
    const fork = (id: string, at: number, copies: readonly object[]) => ({ id, lines: [head(id, at, { forked_from_id: thread }), ...copies, asked(at + 5, copies.length + 1, `own ${id.slice(0, 1)}`)] });
    const promptsOf = async (home: string, id: string): Promise<string[]> => {
      const store = await openCodexStore(home);
      const session = store?.sessions.find((candidate) => candidate.id === id);
      if (store === undefined || session === undefined) throw new Error(`the store lists no ${id}`);
      return (await store.transcript(session)).split('\n').flatMap((raw) => /"text":"([^"]*)"/.exec(raw)?.[1] ?? []);
    };
    const stageForks = (): string => {
      const s = stage();
      const base = { thread_id: thread, end_ordinal_exclusive: 2, end_byte_offset: 1 };
      return stageCodex(s.root, [
        { id: thread, lines: [head(thread, 0), asked(1, 1, 'kept'), asked(2, 2, 'dropped')] },
        { id: `${thread}_${revert}`, lines: [{ ...head(thread, 10, { history_base: base }), ordinal: 2 }, asked(11, 3, 'post-revert')] },
        fork(early, 5, [asked(6, 1, 'kept'), asked(7, 2, 'dropped')]),
        fork(late, 20, [asked(21, 1, 'kept'), asked(22, 2, 'post-revert')]),
      ]);
    };

    it('drops a fork taken after the revert against the reverted lineage, so the copied post-revert turn is not counted twice', async () => {
      expect(await promptsOf(stageForks(), late)).toEqual(['own 9']);
    });

    it('drops a fork taken before the revert against the lineage as it stood then, so its copy of the later-dropped turn goes too', async () => {
      expect(await promptsOf(stageForks(), early)).toEqual(['own 8']);
    });
  });

  it('reports a compressed rollout whose frame is corrupt as unreadable', async () => {
    const s = stage();
    const dir = join(s.root, 'codex-home', 'sessions', '2026', '06', '01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rollout-2026-06-01T10-00-00-66666666-6666-4666-8666-666666666666.jsonl.zst'), 'not a zstd frame');
    const store = await openCodexStore(join(s.root, 'codex-home'));
    expect(store?.sessions).toEqual([]);
    expect(store?.unreadable).toHaveLength(1);
    expect(store?.unreadable[0]?.reason).not.toContain(s.root);
  });

  // A frame that holds the first line and then a megabyte that ends in garbage fails a whole-file decompression but not a read that stops at the line.
  it('lists a compressed rollout from its first line alone, though the rest of the frame is not valid', async () => {
    const s = stage();
    const dir = join(s.root, 'codex-home', 'sessions', '2026', '06', '01');
    mkdirSync(dir, { recursive: true });
    const frame = zstdCompressSync(Buffer.from(`${JSON.stringify(meta('/work/app'))}\n${randomBytes(1 << 20).toString('base64')}\n`));
    writeFileSync(join(dir, 'rollout-2026-06-01T10-00-00-66666666-6666-4666-8666-666666666666.jsonl.zst'), Buffer.concat([frame.subarray(0, frame.length - 8), Buffer.from('garbage!')]));
    const store = await openCodexStore(join(s.root, 'codex-home'));
    expect(store?.unreadable).toEqual([]);
    expect(store?.sessions.map((session) => session.folder)).toEqual(['/work/app']);
  });

  it('keeps every record of a reverted rollout though its ordinals start at history_base.end_ordinal_exclusive, since the prefix is not copied into the file (ordinal.rs:29-31)', () => {
    const lines = rolloutLines(
      asText([
        { ...line(T(0), 'session_meta', { id: 'sess-1', session_id: 'sess-1', originator: 'codex_cli_rs', timestamp: T(0), cwd: '/work/app', history_mode: 'paginated', history_base: { thread_id: 'sess-1', end_ordinal_exclusive: 7, end_byte_offset: 900 } }), ordinal: 7 },
        { ...line(T(2), 'event_msg', { type: 'item_completed', thread_id: 'sess-1', turn_id: 't3', item: { type: 'UserMessage', id: 'u3', content: [{ type: 'text', text: 'after the revert', text_elements: [] }] } }), ordinal: 8 },
      ]),
      's',
    );
    expect(lines.filter((entry) => entry.type === 'user')).toMatchObject([{ message: { content: [{ text: 'after the revert' }] } }]);
  });

  it('reports a rollout that vanishes after it is listed by file name only, even when the root is outside the home folder', async () => {
    const s = stage();
    const id = '88888888-8888-4888-8888-888888888888';
    const home = stageCodex(join(s.root, 'elsewhere-root-name'), [{ id, lines: [line(T(0), 'session_meta', { id, originator: 'codex_cli_rs', timestamp: T(0), cwd: '/work/app' })] }]);
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

// Paginated rollouts are what the cited commit writes by default (thread-store/src/local/mod.rs:512-515): the legacy user_message,
// agent_message, patch_apply_end, and mcp_tool_call_end events are not persisted there (rollout/src/policy.rs:142-156, `persisted_item_completed_event` at :232), and an `item_completed`
// event holding a `TurnItem` (protocol/src/items.rs:50, tag `type`, variant names as written) takes their place. Its content parts carry their own tag: a UserMessage's
// `UserInput` is snake_case (`text`, user_input.rs:16), an AgentMessage's `AgentMessageContent` has no rename_all (`Text`, items.rs:131-135); response_item, turn_context, and
// token_count are persisted in both modes (policy.rs:27-29 response_item, :43 turn_context, :49 session_meta, :134 token_count). Every record carries an `ordinal` in this mode (rollout/src/ordinal.rs:29-30).
describe('Paginated rollouts', () => {
  let next = 0;
  const ord = (entry: object): object => ({ ...entry, ordinal: next++ });
  const pmeta = (extra: object = {}) => ord(line(T(0), 'session_meta', { id: 'sess-1', session_id: 'sess-1', originator: 'codex_cli_rs', timestamp: T(0), cwd: '/work/app', cli_version: '0.60.0', history_mode: 'paginated', ...extra }));
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

  it('settles a patch from its FileChange item (events.rs:610-617, id is the call id): failed is an error, completed is ok, declined is the user rejecting it', () => {
    begin();
    const change = (second: number, id: string, status: string, stderr = '') => done(second, { type: 'FileChange', id, changes: {}, status, stdout: '', stderr });
    const out = extractOf([
      pmeta(),
      patchCall(2, 'p1'),
      change(3, 'p1', 'failed', 'could not apply'),
      patchCall(4, 'p2'),
      change(5, 'p2', 'completed'),
      patchCall(6, 'p3'),
      change(7, 'p3', 'declined', 'patch rejected by user'),
    ]);
    expect(out.tools.map((tool) => [tool.status, tool.errorCode ?? null])).toEqual([['error', 'other'], ['ok', null], ['error', 'user-rejected']]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['could not apply', 'patch rejected by user']);
  });

  it('leaves a declined FileChange item unsettled when its stderr is a setup failure, not the user refusal text', () => {
    begin();
    const out = extractOf([pmeta(), patchCall(2, 'p1'), done(3, { type: 'FileChange', id: 'p1', changes: {}, status: 'declined', stdout: '', stderr: 'sandbox setup failed' })]);
    expect(out.tools).toMatchObject([{ tool: 'Edit', status: 'none' }]);
    expect(out.errorLines).toEqual([]);
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

  it('ignores an item_completed item it has no use for (a Plan) without failing', () => {
    begin();
    const lines = rolloutLines(asText([pmeta(), done(2, { type: 'Plan', id: 'x', text: 'steps' })]), 's');
    expect(lines).toEqual([]);
  });

  // A CommandExecution TurnItem is persisted in a Paginated rollout (policy.rs:253 arm, kept by `_ =>` at :284; a Legacy one keeps only
  // FunctionCallOutput, Plan, Sleep, and a completed SubAgentActivity, :238-251). Its `id` is the exec_command's call id (core/src/tools/events.rs:571),
  // with `exit_code` and `aggregated_output` (protocol/src/items.rs:252-290), written when the process exits (events.rs:561-590): by the exit watcher for
  // a process the model never polls (core/src/unified_exec/async_watcher.rs:158, :224), or by the call itself when it exits in its first yield
  // (process_manager.rs:827). `status` is Completed on exit code 0 and Failed otherwise (events.rs:530-534); a rejected call is Declined with exit code -1
  // (:552-554).
  describe('a CommandExecution item (items.rs:252-290)', () => {
    const running = 'Chunk ID: ab12\nWall time: 0.0100 seconds\nProcess running with session ID 9\nOriginal token count: 3\nOutput:\n';
    const execCall = (second: number, id: string, cmd: string) => call(second, id, 'exec_command', { arguments: JSON.stringify({ cmd }) });
    const backgrounded = (second: number, id: string) => ord(shellOut(second, id, running));
    // The fields upstream's struct has no default for: command, cwd, parsed_cmd, source, and status (items.rs:263-280).
    const exited = (second: number, id: string, rest: object) =>
      done(second, { type: 'CommandExecution', id, command: ['bash', '-lc', 'x'], cwd: '/work/app', parsed_cmd: [], source: 'unified_exec_startup', ...rest });

    it('settles an exec_command the model never polled with the failure its exit watcher wrote', () => {
      begin();
      const out = extractOf([
        pmeta(),
        execCall(2, 'u1', 'npm test'),
        backgrounded(3, 'u1'),
        exited(4, 'u1', { status: 'failed', exit_code: 1, aggregated_output: '1 test failed\nsecond line' }),
      ]);
      expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
      expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: '1 test failed' }]);
    });

    it('settles a completed exec_command nothing polled with its output, so a git commit records its sha', () => {
      begin();
      const out = extractOf([
        pmeta(),
        execCall(2, 'u1', 'git commit -m x'),
        backgrounded(3, 'u1'),
        exited(4, 'u1', { status: 'completed', exit_code: 0, aggregated_output: '[main abc1234] x\n 1 file changed, 1 insertion(+)' }),
      ]);
      expect(out.tools[0]).toMatchObject({ tool: 'Bash', status: 'ok', commits: ['abc1234'] });
      expect(out.errorLines).toEqual([]);
    });

    it('settles an exec_command that exited in its first yield once, whichever of the item and the output comes first', () => {
      begin();
      const finished = 'Chunk ID: ab12\nWall time: 0.0100 seconds\nProcess exited with code 2\nOriginal token count: 3\nOutput:\nboom';
      const itemFirst = extractOf([pmeta(), execCall(2, 'u1', 'make'), exited(3, 'u1', { status: 'failed', exit_code: 2, aggregated_output: 'boom' }), ord(shellOut(4, 'u1', finished))]);
      expect(itemFirst.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
      expect(itemFirst.errorLines.map((entry) => entry.line)).toEqual(['boom']);
      begin();
      const outputFirst = extractOf([pmeta(), execCall(2, 'u1', 'make'), ord(shellOut(3, 'u1', finished)), exited(4, 'u1', { status: 'failed', exit_code: 2, aggregated_output: 'boom' })]);
      expect(outputFirst.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
      expect(outputFirst.errorLines.map((entry) => entry.line)).toEqual(['boom']);
    });

    it('reads a Declined item (exit code -1, events.rs:552-554) as the user rejecting the call, and leaves an item with no exit_code (an Option, skipped when None, items.rs:284-286) and an item for a call it never saw unsettled', () => {
      begin();
      const out = extractOf([
        pmeta(),
        execCall(2, 'u1', 'rm -rf x'),
        backgrounded(3, 'u1'),
        exited(4, 'u1', { status: 'declined', exit_code: -1, aggregated_output: 'exec command rejected by user' }),
        execCall(5, 'u2', 'sleep 100'),
        backgrounded(6, 'u2'),
        exited(7, 'u2', { status: 'failed' }),
        exited(8, 'nope', { status: 'failed', exit_code: 1, aggregated_output: 'x' }),
      ]);
      // An item no call owns is its own Bash record (a code-mode cell's command), so 'nope' is a third, failed one.
      expect(out.tools.map((tool) => [tool.status, tool.errorCode ?? null])).toEqual([['error', 'user-rejected'], ['none', null], ['error', '1']]);
      expect(out.errorLines.map((entry) => entry.line)).toEqual(['exec command rejected by user', 'x']);
    });

    // Codex 0.166+ runs its shell inside a code-mode cell: a `custom_tool_call` named `exec` whose input is JavaScript, answered by a `custom_tool_call_output`
    // whose first part's header is `Script completed`, `Script failed`, or `Script running with cell ID <id>`; `wait` polls a cell. Each command the cell ran
    // persists its own CommandExecution item, `exec-<uuid>`, which no call owns (live store, 2026-11-06).
    describe('code-mode cells (Codex 0.166+)', () => {
      const cell = (second: number, id: string, js: string) => ord(line(T(second), 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: id, input: js, status: 'completed' }));
      const cellOut = (second: number, id: string, parts: string[]) =>
        ord(line(T(second), 'response_item', { type: 'custom_tool_call_output', call_id: id, output: parts.map((text) => ({ type: 'input_text', text })) }));
      const item = (second: number, id: string, text: string, rest: object) =>
        done(second, {
          type: 'CommandExecution',
          id,
          process_id: '75375',
          command: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-Command', text],
          cwd: 'file:///C:/work/app',
          parsed_cmd: [{ type: 'unknown', cmd: text }],
          source: 'unified_exec_startup',
          duration: { secs: 0, nanos: 500000000 },
          ...rest,
        });
      const fixture = () => {
        begin();
        return [
          pmeta({ cli_version: '0.167.0' }),
          done(1, { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'look around', text_elements: [] }] }),
          cell(2, 'c1', 'text(await tools.exec_command({cmd:"ls /nonexistent"}));\n'),
          item(3, 'exec-1', 'echo hi', { status: 'completed', exit_code: 0, aggregated_output: 'hi' }),
          item(4, 'exec-2', 'ls /nonexistent', { status: 'failed', exit_code: 1, aggregated_output: "ls: cannot access '/nonexistent': No such file or directory" }),
          cellOut(5, 'c1', ['Script completed\nWall time 0.4 seconds\nOutput:\nhi']),
          cell(6, 'c2', 'text(await tools.exec_command({cmd:"sleep 30"}));\n'),
          cellOut(7, 'c2', ['Script running with cell ID 14\nWall time 1 seconds\nOutput:\n']),
          item(8, 'exec-3', 'sleep 30', { status: 'completed', exit_code: 0, aggregated_output: '' }),
          call(9, 'w1', 'wait', { arguments: JSON.stringify({ cell_id: 14, max_tokens: 1000, yield_time_ms: 1000 }) }),
          ord(shellOut(10, 'w1', [{ type: 'input_text', text: 'Script completed\nWall time 30 seconds\nOutput:\ndone' }])),
          cell(11, 'c3', 'text(await tools.nope());\n'),
          cellOut(12, 'c3', ['Script failed\nWall time 0.1 seconds\nOutput:\n', 'Script error:\nexec_command failed: no such tool']),
        ];
      };

      it('records each command a cell ran as its own Bash record, with its exit code, output, and duration', () => {
        const out = extractOf(fixture(), 'codex');
        const blocks = (entry: Record<string, unknown>): Array<Record<string, unknown>> => {
          const message = entry.message;
          const content = typeof message === 'object' && message !== null && 'content' in message ? message.content : [];
          return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null) : [];
        };
        const uses = rolloutLines(asText(fixture()), 's').flatMap((entry) => (entry.type === 'assistant' ? blocks(entry) : [])).filter((block) => block.type === 'tool_use');
        expect(uses.filter((block) => block.native === 'exec_command').map((block) => block.input)).toEqual([{ command: 'echo hi' }, { command: 'ls /nonexistent' }, { command: 'sleep 30' }]);
        expect(uses.filter((block) => block.native === 'exec' || block.native === 'wait').map((block) => [block.native, block.input])).toEqual([['exec', {}], ['exec', {}], ['wait', {}], ['exec', {}]]);
        // Only the item-owned records have a native name the action table reads; a cell's `exec` and `wait` are not listed there, so a step stores them as `<literal>`.
        const shell = out.tools.filter((tool) => tool.steps?.[0]?.native === 'exec_command');
        expect(shell.map((tool) => [tool.status, tool.durationMs])).toEqual([['ok', 500], ['error', 500], ['ok', 500]]);
        expect(out.errorLines.map((entry) => entry.line)).toContain("ls: cannot access '/nonexistent': No such file or directory");
      });

      it('settles a cell from its own header: completed ok, running then waited ok, failed with the Script error text', () => {
        const out = extractOf(fixture(), 'codex');
        const cells = out.tools.filter((tool) => tool.steps?.[0]?.native !== 'exec_command');
        expect(cells.map((tool) => tool.status)).toEqual(['ok', 'ok', 'ok', 'error']);
        expect(out.errorLines.map((entry) => entry.line)).toContain('exec_command failed: no such tool');
      });

      it('holds every verify invariant, including --strict, for the deposited fixture', async () => {
        const s = stage();
        const home = stageCodex(s.root, [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', lines: fixture() }]);
        const result = await deposit({ ...s.runtime, sourceRoots: { codex: home } }, { allow: ['codex'], redactDomains: [], now: () => NOW });
        expect(result).toMatchObject({ sessions: 1 });
        const { skeletons } = await readSkeletons(s.storeDir);
        const store = await loadStore(s.storeDir);
        expect([...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((entry) => entry.violations > 0)).toEqual([]);
      });
    });

    it('leaves a Declined item unsettled when its output is a setup failure, not the user refusal text (events.rs:448-458)', () => {
      begin();
      const out = extractOf([
        pmeta(),
        execCall(2, 'u1', 'rm -rf x'),
        backgrounded(3, 'u1'),
        exited(4, 'u1', { status: 'declined', exit_code: -1, aggregated_output: 'sandbox setup failed' }),
      ]);
      expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'none' }]);
      expect(out.errorLines).toEqual([]);
    });

    it('settles a polled exec_command once: the write_stdin that saw it exit and then the item', () => {
      begin();
      const out = extractOf([
        pmeta(),
        execCall(2, 'u1', 'npm test'),
        backgrounded(3, 'u1'),
        call(4, 'u2', 'write_stdin', { arguments: JSON.stringify({ session_id: 9, chars: '' }) }),
        ord(shellOut(5, 'u2', 'Chunk ID: ab12\nWall time: 0.0100 seconds\nProcess exited with code 1\nOriginal token count: 3\nOutput:\nfailed')),
        exited(6, 'u1', { status: 'failed', exit_code: 1, aggregated_output: 'failed' }),
      ]);
      expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'error'], ['Bash', 'error']]);
      expect(out.errorLines.map((entry) => entry.line)).toEqual(['failed', 'failed']);
    });

    // The watcher's item carries the whole `aggregated_output`, so a Paginated poll that sees the exit leaves the polled exec_command to it: the poll's own last chunk
    // would lose a `[branch sha]` line printed in an earlier chunk, and which of the two is recorded first is a race upstream (unified_exec/async_watcher.rs:158, :224).
    it('leaves the exec_command a poll saw exit to its item in a Paginated rollout, so a sha printed in an earlier chunk is kept', () => {
      begin();
      const out = extractOf([
        pmeta(),
        execCall(2, 'u1', 'git commit -m x'),
        ord(shellOut(3, 'u1', running.replace('Output:\n', 'Output:\n[main abc1234] x\n'))),
        call(4, 'u2', 'write_stdin', { arguments: JSON.stringify({ session_id: 9, chars: '' }) }),
        ord(shellOut(5, 'u2', 'Chunk ID: ab12\nWall time: 0.0100 seconds\nProcess exited with code 0\nOriginal token count: 3\nOutput:\n done')),
        exited(6, 'u1', { status: 'completed', exit_code: 0, aggregated_output: '[main abc1234] x\n done' }),
      ]);
      expect(out.tools[0]).toMatchObject({ status: 'ok', commits: ['abc1234'] });
    });

    // A poll that fails says nothing about the process it polled: a non-empty write to a process with no tty is `StdinClosed` (unified_exec/process_manager.rs:1021-1026,
    // errors.rs:19-22), answered `write_stdin failed: <err>` (handlers/unified_exec/write_stdin.rs:123), and the process runs on to its own exit.
    it('does not settle the exec_command a failed write_stdin polled: the poll is the error, and the item carries the real exit, so the commit records its sha', () => {
      begin();
      const closed = 'write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open';
      const out = extractOf([
        pmeta(),
        execCall(2, 'u1', 'git commit -m x'),
        backgrounded(3, 'u1'),
        call(4, 'u2', 'write_stdin', { arguments: JSON.stringify({ session_id: 9, chars: 'y' }) }),
        ord(shellOut(5, 'u2', closed)),
        exited(6, 'u1', { status: 'completed', exit_code: 0, aggregated_output: '[main abc1234] x' }),
      ]);
      expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'ok'], ['Bash', 'error']]);
      expect(out.tools[0]).toMatchObject({ commits: ['abc1234'] });
      expect(out.errorLines.map((entry) => entry.line)).toEqual([closed]);
    });

    // A tool failure message is written as an item with exit_code -1 (tools/events.rs:538-542, the `execution error: ...` of :438), and the item is emitted before
    // the output is returned (events.rs:471-472), so in a Paginated rollout it settles the call first and the output that holds the same text is ignored. -1 is no
    // exit status, and capture's `Exit code (\d+)` cannot read it, so the message itself must be the error line. The tail of the message is `{err:?}` (:438); the
    // test depends only on its prefix.
    it('records the message of a failed item with exit code -1 as the error line, not "Exit code -1" (events.rs:538-542, :471-472)', () => {
      begin();
      const message = 'execution error: sandbox setup failed';
      const out = extractOf([
        pmeta(),
        execCall(2, 'u1', 'make'),
        exited(3, 'u1', { status: 'failed', exit_code: -1, aggregated_output: message }),
        ord(shellOut(4, 'u1', message)),
      ]);
      expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
      expect(out.errorLines.map((entry) => entry.line)).toEqual([message]);
    });

    // The exit watcher writes -1 for a process with no exit status (unified_exec/async_watcher.rs:213) and for a failure message (:409), here for an exec_command
    // the model never polled.
    it('records the text of a backgrounded process\'s failed item with exit code -1 as the error line (async_watcher.rs:213, :409)', () => {
      begin();
      const out = extractOf([
        pmeta(),
        execCall(2, 'u1', 'make'),
        backgrounded(3, 'u1'),
        exited(4, 'u1', { status: 'failed', exit_code: -1, aggregated_output: 'fatal: lost connection\nsecond line' }),
      ]);
      expect(out.errorLines.map((entry) => entry.line)).toEqual(['fatal: lost connection']);
    });

    it('keeps "Exit code -1" for a failed item whose text is only whitespace, since there is no line to show', () => {
      begin();
      const out = extractOf([pmeta(), execCall(2, 'u1', 'make'), backgrounded(3, 'u1'), exited(4, 'u1', { status: 'failed', exit_code: -1, aggregated_output: '\n' })]);
      expect(out.errorLines.map((entry) => entry.line)).toEqual(['Exit code -1']);
    });

    it('keeps "Exit code -1" for a failed item with exit code -1 and no text, since nothing better exists', () => {
      begin();
      const out = extractOf([pmeta(), execCall(2, 'u1', 'make'), backgrounded(3, 'u1'), exited(4, 'u1', { status: 'failed', exit_code: -1, aggregated_output: '' })]);
      expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
      expect(out.errorLines.map((entry) => entry.line)).toEqual(['Exit code -1']);
    });
  });

  it('applies only the first session_meta: a copy from fork history keeps the fork id and cwd (recorder.rs:1157-1158, :1173), in a Legacy rollout, which has no ordinals (ordinal.rs:37)', () => {
    const fork = line(T(0), 'session_meta', { id: 'sess-2', session_id: 'sess-2', originator: 'codex_cli_rs', timestamp: T(0), cwd: '/work/app', cli_version: '0.60.0', forked_from_id: 'sess-1' });
    const copied = line(T(0), 'session_meta', { id: 'sess-1', session_id: 'sess-1', originator: 'codex_cli_rs', timestamp: T(0), cwd: '/work/parent', cli_version: '0.60.0' });
    const lines = rolloutLines(asText([fork, copied, prompt(4, 'own')]), 's');
    expect(lines.filter((entry) => entry.type === 'user')).toHaveLength(1);
    expect(lines.every((entry) => entry.sessionId === 'sess-2' && entry.cwd === '/work/app')).toBe(true);
  });

  // ordinal.rs:30, :47-53: a rollout's first record takes history_base.end_ordinal_exclusive (0 with none) and every record after it one more. A subagent's file
  // starts with its own session_meta, then the parent's prefix through subagent_history_start_ordinal - 1, which is model context only (ordinal.rs:86-89,
  // protocol.rs:3511-3516). A Referenced fork's file holds no inherited records: its history_base points at the parent's rollout instead (protocol.rs:3508-3510,
  // session.rs:1139-1140). A Copied fork's does (thread_manager.rs:1680, session.rs:1139), in either mode: see 'a Copied fork' below.
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

// A Copied fork writes the parent's history into its own file in either mode (thread_manager.rs:1680, session.rs:1139: no history_base). A Legacy one has no
// ordinals; a Paginated one numbers the copy afresh from 0 (ordinal.rs:28-33), so no ordinal marks it and the match against the parent finds it in both.
describe('a Copied fork', () => {
  const [m0, p1, r2, p3] = [meta('/work/app'), prompt(1, 'first'), say(2, 'reply'), prompt(3, 'second')] as const;
  const parent = [m0, p1, r2, p3];
  const forkMeta = (id: string) => line(T(10), 'session_meta', { id, session_id: id, originator: 'codex_cli_rs', timestamp: T(10), cwd: '/work/app', forked_from_id: 'sess-1' });
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

  it('keeps a Referenced fork whole: a history_base means it copied none, so a leading record equal to the first of the parent is its own (protocol.rs:3508-3510)', () => {
    const referenced = line(T(10), 'session_meta', { id: 'sess-2', session_id: 'sess-2', originator: 'codex_cli_rs', timestamp: T(10), cwd: '/work/app', forked_from_id: 'sess-1', history_base: { thread_id: 'sess-1', end_ordinal_exclusive: 4, end_byte_offset: 800 } });
    const lines = rolloutLines(asText([referenced, at(11, p1), prompt(20, 'own prompt')]), 'sess-2', asText(parent));
    expect(prompts(lines)).toHaveLength(2);
  });

  it('drops the copy in a Paginated fork too, where the copied records carry fresh ordinals and the meta has no history_base', () => {
    const item = (second: number, body: object) => line(T(second), 'event_msg', { type: 'item_completed', thread_id: 'sess-1', turn_id: 't1', item: body });
    const asked = item(1, { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'first', text_elements: [] }] });
    const replied = item(2, { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'reply' }] });
    const numbered = (entries: readonly object[], from: number): object[] => entries.map((entry, index) => ({ ...entry, ordinal: from + index }));
    const parentMeta = line(T(0), 'session_meta', { id: 'sess-1', session_id: 'sess-1', originator: 'codex_cli_rs', timestamp: T(0), cwd: '/work/app', history_mode: 'paginated' });
    const forked = line(T(10), 'session_meta', { id: 'sess-2', session_id: 'sess-2', originator: 'codex_cli_rs', timestamp: T(10), cwd: '/work/app', history_mode: 'paginated', forked_from_id: 'sess-1' });
    const own = item(20, { type: 'UserMessage', id: 'u2', content: [{ type: 'text', text: 'own prompt', text_elements: [] }] });
    // The fork's own session_meta is ordinal 0 (no history_base), then the copy of the parent's records, then its own turn.
    const child = numbered([forked, at(11, parentMeta), at(12, asked), at(13, replied), own], 0);
    const lines = rolloutLines(asText(child), 'sess-2', asText(numbered([parentMeta, asked, replied], 0)));
    expect(prompts(lines)).toMatchObject([{ message: { content: [{ text: 'own prompt' }] } }]);
    expect(lines.filter((entry) => entry.type === 'assistant')).toHaveLength(0);
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

  // The exit code is the header's (context.rs:556), never the output's: `cat ci.log` exits 0 and may print a line that reads like a failure header.
  it('records a call that exited 0 as ok, though its output starts with Exit code 2', () => {
    const out = extractOf([
      meta('/work/app'),
      unified(2, 'u1', 'exec_command', { cmd: 'cat ci.log' }),
      shellOut(3, 'u1', `${head('Process exited with code 0')}Exit code 2\nlog line`),
    ]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'ok' }]);
    expect(out.errorLines).toEqual([]);
  });

  it('records a polled exec_command that exited 0 as ok, though its output starts with Exit code 2', () => {
    const out = extractOf([
      meta('/work/app'),
      unified(2, 'u1', 'exec_command', { cmd: 'cat ci.log' }),
      shellOut(3, 'u1', head('Process running with session ID 9')),
      unified(4, 'u2', 'write_stdin', { session_id: 9, chars: '' }),
      shellOut(5, 'u2', `${head('Process exited with code 0')}Exit code 2\nlog line`),
    ]);
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'ok'], ['Bash', 'ok']]);
    expect(out.errorLines).toEqual([]);
  });

  // A child that exits with code -1 is written as `Process exited with code -1` (unified_exec/process.rs:222, context.rs:555-557). -1 is no exit status and capture's
  // `Exit code (\d+)` cannot read it, so the output's text must be the error line, as it is for code 1.
  it('records the output of a call that exited with code -1 as the error line, not "Exit code -1" (process.rs:222, context.rs:555-557)', () => {
    const out = extractOf([
      meta('/work/app'),
      unified(2, 'u1', 'exec_command', { cmd: 'git push' }),
      shellOut(3, 'u1', `${head('Process exited with code -1')}fatal: lost connection`),
    ]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['fatal: lost connection']);
  });

  it('records a call that exited with code 1 the same way, as the contrast to code -1', () => {
    const out = extractOf([
      meta('/work/app'),
      unified(2, 'u1', 'exec_command', { cmd: 'git push' }),
      shellOut(3, 'u1', `${head('Process exited with code 1')}fatal: lost connection`),
    ]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['fatal: lost connection']);
  });

  // `None` for the exit status writes no exit line and no running line (context.rs:555-557; its -1 goes only to the item, process_manager.rs:823, :839): the call is neither
  // failed nor finished, and it stays unsettled.
  it('leaves a reply header with neither an exit line nor a running line unsettled', () => {
    const out = extractOf([meta('/work/app'), unified(2, 'u1', 'exec_command', { cmd: 'sleep 9' }), shellOut(3, 'u1', 'Chunk ID: ab12\nWall time: 0.0100 seconds\nOriginal token count: 3\nOutput:\npartial')]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'none' }]);
    expect(out.errorLines).toEqual([]);
  });

  it('records a call that exited 0 with no output as ok, and still finds a commit sha past a first line that is not one', () => {
    const quiet = extractOf([meta('/work/app'), unified(2, 'u1', 'exec_command', { cmd: 'true' }), shellOut(3, 'u1', head('Process exited with code 0'))]);
    expect(quiet.tools).toMatchObject([{ status: 'ok' }]);
    const commit = extractOf([meta('/work/app'), unified(2, 'u1', 'exec_command', { cmd: 'git commit -m x' }), shellOut(3, 'u1', `${head('Process exited with code 0')}hint: waiting\n[main abc1234] x`)]);
    expect(commit.tools[0]).toMatchObject({ status: 'ok', commits: ['abc1234'] });
  });

  it('records exec_command failed: <err> (exec_command.rs:270, UnifiedExecError::CreateProcess, errors.rs:9) as an error, with its text as the error line', () => {
    const out = extractOf([meta('/work/app'), unified(2, 'u1', 'exec_command', { cmd: 'nope' }), shellOut(3, 'u1', 'exec_command failed: CreateProcess { message: "not found" }')]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['exec_command failed: CreateProcess { message: "not found" }']);
  });

  it('records write_stdin failed: <err> and write_stdin approval failed: <err> (write_stdin.rs:123, :121) as errors', () => {
    const out = extractOf([
      meta('/work/app'),
      unified(2, 'u1', 'write_stdin', { session_id: 5, chars: 'y' }),
      shellOut(3, 'u1', 'write_stdin failed: Unknown process id 5'),
      unified(4, 'u2', 'write_stdin', { session_id: 6, chars: 'y' }),
      shellOut(5, 'u2', 'write_stdin approval failed: sandbox denied'),
    ]);
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'error'], ['Bash', 'error']]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['write_stdin failed: Unknown process id 5', 'write_stdin approval failed: sandbox denied']);
  });

  // The Legacy form of the case in a CommandExecution describe above: no item exists to say how the process ended, so the exec_command stays unsettled.
  it('leaves the exec_command a failed write_stdin polled unsettled (process_manager.rs:1026, write_stdin.rs:123): the poll is the error, the process runs on', () => {
    const closed = 'write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open';
    const out = extractOf([
      meta('/work/app'),
      unified(2, 'u1', 'exec_command', { cmd: 'git commit -m x' }),
      shellOut(3, 'u1', head('Process running with session ID 9')),
      unified(4, 'u2', 'write_stdin', { session_id: 9, chars: 'y' }),
      shellOut(5, 'u2', closed),
    ]);
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'none'], ['Bash', 'error']]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual([closed]);
  });

  it('leaves write_stdin rejected: <reason> (write_stdin.rs:118) unsettled: the approval policy gave the reason', () => {
    const out = extractOf([meta('/work/app'), unified(2, 'u1', 'write_stdin', { session_id: 5, chars: 'y' }), shellOut(3, 'u1', 'write_stdin rejected: not allowed')]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'none' }]);
    expect(out.errorLines).toEqual([]);
  });
});

// A step keeps the tool's own name in `native` (the contract at extract.ts, as cursor.ts does), so Codex's action-table rows are reached: the reader names a
// shell or patch call in the Claude Code vocabulary for the extractor, and the step still says which Codex tool it was.
describe('a Codex step', () => {
  const fn = (second: number, id: string, name: string, args: unknown) => line(T(second), 'response_item', { type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });
  const patch = line(T(6), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' });
  const stepsOf = (out: ReturnType<typeof extractOf>): Array<[string, string, string]> =>
    out.tools.flatMap((tool) => (tool.steps ?? []).map((step): [string, string, string] => [tool.tool, step.action, step.native]));

  it('keeps the Codex tool name and reaches its action row, for a shell, a local shell, a patch, and a write_stdin', () => {
    const out = extractOf(
      [
        meta('/work/app'),
        fn(2, 'c1', 'exec_command', { cmd: 'ls' }),
        fn(3, 'c2', 'shell', { command: ['ls'] }),
        line(T(4), 'response_item', { type: 'local_shell_call', call_id: 'c3', status: 'completed', action: { type: 'exec', command: ['ls'] } }),
        fn(5, 'c4', 'write_stdin', { session_id: 7, chars: '' }),
        patch,
      ],
      'codex',
    );
    expect(stepsOf(out)).toEqual([
      ['Bash', 'shell.exec', 'exec_command'],
      ['Bash', 'shell.exec', 'shell'],
      ['Bash', 'shell.exec', 'local_shell'],
      ['Bash', 'other', 'write_stdin'],
      ['Edit', 'file.edit', 'apply_patch'],
    ]);
  });
});

// A web search is persisted as its own response item, not a function_call: `ResponseItem::WebSearchCall {id?, status?, action?}` (protocol/src/models.rs:1270),
// kept by should_persist_response_item (rollout/src/policy.rs:94). The example payload is the Responses API's `response.output_item.done` (models.rs:1262-1269) with
// `action: {type: search, query}`; `WebSearchAction` is tagged by `type` in snake_case with `query`, `queries`, `url`, and `pattern` optional (:2123-2150), and
// upstream's own serialization cases are a search with `queries` (:4030-4040) and an `open_page` with status `open` (:4050-4056).
describe('a web_search_call', () => {
  const search = (second: number, extra: object) => line(T(second), 'response_item', { type: 'web_search_call', status: 'completed', ...extra });

  it('is a WebSearch call with the query, a web.search step, and no failure signal (recorded ok)', () => {
    const out = extractOf([meta('/work/app'), search(2, { id: 'ws_1', action: { type: 'search', query: 'weather: San Francisco, CA' } })], 'codex');
    expect(out.tools).toMatchObject([{ tool: 'WebSearch', status: 'ok', steps: [{ action: 'web.search', native: 'web_search' }] }]);
    expect(out.session.searches).toEqual(['weather: San Francisco, CA']);
    expect(out.errorLines).toEqual([]);
  });

  it('takes the first of queries when there is no query, and no query for an action that is not a search, and works without an id', () => {
    const out = extractOf([meta('/work/app'), search(2, { action: { type: 'search', queries: ['weather seattle', 'seattle weather now'] } }), search(3, { status: 'open', action: { type: 'open_page', url: 'https://example.com' } })], 'codex');
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['WebSearch', 'ok'], ['WebSearch', 'ok']]);
    expect(out.session.searches).toEqual(['weather seattle']);
  });
});
