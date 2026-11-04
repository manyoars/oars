import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copilotRoot, eventBadLines, eventLines, openCopilotStore } from './copilot.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, copilotEvent as event, stage, stageCopilot } from './test-support.js';

afterEach(cleanup);

// Every fixture below is written from the generated event types of github/copilot-sdk @ d28a136 (MIT), nodejs/src/generated/session-events.ts:
// the envelope `{id, parentId, timestamp, type, data, agentId?}` on every event; `session.start` data (StartData: sessionId, copilotVersion, selectedModel,
// startTime, context.cwd); `user.message` (UserMessageData.content, isAutopilotContinuation); `assistant.message` (AssistantMessageData: content, model,
// outputTokens, requestId, messageId, toolRequests[AssistantMessageToolRequest]); `tool.execution_start` (shellToolInfo, toolCallId, toolName);
// `tool.execution_complete` (ToolExecutionCompleteData: success, error.message, result.content, shellExecution.exitCode, fileEdits; the schema's
// `shell_exit` contents are not used, since it says persisted result contents are stripped); `session.shutdown` (ShutdownData.modelMetrics[model].usage,
// agentMetrics.main); `session.resume` and `session.context_changed` (cwd, selectedModel); `user.message.source`; `assistant.message` apiCallId and chunks. `assistant.usage` is `ephemeral: true`, which that file defines
// as "not persisted to the session event log on disk", so no fixture holds one. No live store was read.

const capture = (text: string) =>
  captureSession({
    text,
    harness: 'copilot',
    session: 'copilot-x',
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

const asText = (events: readonly unknown[]): string => events.map((entry) => JSON.stringify(entry)).join('\n');
const extractOf = (events: readonly unknown[]) => capture(eventLines(asText(events), 'sess').map((entry) => JSON.stringify(entry)).join('\n'));

const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const start = (cwd = '/work/app', extra: { checkpoint?: boolean } = {}) => event(T(0), 'session.start', { sessionId: 'sess-1', copilotVersion: '1.0.105', producer: 'copilot-agent', selectedModel: 'claude-sonnet-4.5', startTime: T(0), version: 1, context: { cwd } }, extra);
const prompt = (second: number, content: string) => event(T(second), 'user.message', { content });
const say = (second: number, content: string, extra: object = {}, toolRequests: readonly unknown[] = []) =>
  event(T(second), 'assistant.message', { messageId: `m${String(second)}`, content, ...(toolRequests.length === 0 ? {} : { toolRequests }), ...extra });
const ask = (id: string, name: string, args: object = {}) => ({ toolCallId: id, name, arguments: args });
const begin = (second: number, id: string, name: string, extra: object = {}) => event(T(second), 'tool.execution_start', { toolCallId: id, toolName: name, ...extra });
const shellStart = (second: number, id: string, command: string) => begin(second, id, 'bash', { arguments: { command }, shellToolInfo: { hasWriteFileRedirection: false, possiblePaths: [] } });
const done = (second: number, id: string, data: object) => event(T(second), 'tool.execution_complete', { toolCallId: id, success: true, ...data });
const shutdown = (second: number, modelMetrics: object) => event(T(second), 'session.shutdown', { shutdownType: 'routine', totalApiDurationMs: 5, sessionStartTime: 0, codeChanges: {}, modelMetrics });

describe('the Copilot CLI reader', () => {
  it('turns a normal session into prompts, calls with outcomes, usage from the shutdown totals, the model, the cwd, and the version', () => {
    const events = [
      start(),
      prompt(1, 'fix the build'),
      say(2, 'running it', { model: 'claude-sonnet-4.5', outputTokens: 20 }, [ask('c1', 'bash', { command: 'npm test' })]),
      shellStart(3, 'c1', 'npm test'),
      done(4, 'c1', { shellExecution: { exitCode: 0 }, result: { content: 'ok' } }),
      say(5, 'now the edit', { model: 'claude-sonnet-4.5', outputTokens: 30 }, [ask('c2', 'edit', { path: 'src/a.ts' })]),
      begin(6, 'c2', 'edit'),
      done(7, 'c2', { fileEdits: [{ kind: 'edit', path: 'src/a.ts' }, { kind: 'create', path: 'docs/b.md' }], result: { content: 'edited' } }),
      say(8, 'done', { model: 'claude-sonnet-4.5', outputTokens: 10 }),
      shutdown(9, { 'claude-sonnet-4.5': { requests: { count: 3 }, usage: { inputTokens: 900, outputTokens: 60, cacheReadTokens: 400, cacheWriteTokens: 100, reasoningTokens: 7 } } }),
    ];
    const out = extractOf(events);
    expect(out.session.userTurns).toBe(1);
    expect(out.session.assistantTurns).toBe(3);
    expect(out.session.env.harness).toBe('1.0.105');
    expect(out.session.models).toEqual({ 'claude-sonnet-4.5': 3 });
    // Input, cache, and reasoning come from the shutdown totals and land once, on the last response of that model; output is the sum of the responses' own.
    expect(out.session.usage).toMatchObject({ input: 400, cacheRead: 400, cacheWrite: 100, output: 60, thinking: 7 });
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'ok'], ['Edit', 'ok'], ['Edit', 'ok']]);
    expect(out.session.files).toEqual(expect.arrayContaining(['src/a.ts', 'docs/b.md']));
    expect(out.errorLines).toEqual([]);
    expect(out.session.tsFirst).toBe(T(1));
  });

  it('records a shell call that exited nonzero as an error even when its success flag says true, with the output as its error line', () => {
    const out = extractOf([start(), prompt(1, 'run it'), say(2, '', {}, [ask('c1', 'bash', { command: 'make' })]), shellStart(3, 'c1', 'make'), done(4, 'c1', { success: true, shellExecution: { exitCode: 2 }, result: { content: 'make: *** No rule to make target\nsecond' } })]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: 'make: *** No rule to make target' }]);
  });

  it('records a shell call with no exit code and success false as an error with its message, and one with neither as ok', () => {
    const out = extractOf([
      start(),
      prompt(1, 'run them'),
      say(2, '', {}, [ask('c', 'bash'), ask('d', 'bash')]),
      shellStart(3, 'c', 'three'),
      done(4, 'c', { success: false, error: { message: 'spawn failed' }, result: { content: '' } }),
      shellStart(5, 'd', 'four'),
      done(6, 'd', { result: { content: 'fine' } }),
    ]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['error', 'ok']);
    expect(out.errorLines.map((error) => error.line)).toEqual(['spawn failed']);
  });

  it('reads a rotated head: a journal link and checkpoint events are the only record of the earlier part, and are read once', () => {
    const lines = eventLines(
      asText([event(T(0), 'session.journal_link', { previousFile: 'events.1.jsonl', sessionId: 'sess-1', version: 1 }), start('/work/app', { checkpoint: true }), event(T(0), 'user.message', { content: 'earlier prompt' }, { checkpoint: true }), prompt(1, 'later prompt')]),
      's',
    );
    expect(lines.filter((entry) => entry.type === 'user')).toHaveLength(2);
  });

  it('puts the output the responses did not report on the first line of the last response', () => {
    const lines = eventLines(asText([start(), prompt(1, 'a'), say(2, 'one', { model: 'm1' }), shutdown(3, { m1: { requests: {}, usage: { inputTokens: 10, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 } } })]), 's');
    expect(capture(lines.map((entry) => JSON.stringify(entry)).join('\n')).session.usage).toMatchObject({ input: 10, output: 40 });
  });

  it('takes the totals of a model from its last shutdown and lands them once on its last response', () => {
    const usage = (inputTokens: number, outputTokens: number) => ({ m1: { requests: {}, usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } } });
    const lines = eventLines(asText([start(), prompt(1, 'a'), say(2, 'one', { model: 'm1', outputTokens: 4 }), shutdown(3, usage(10, 4)), prompt(4, 'b'), say(5, 'two', { model: 'm1', outputTokens: 6 }), shutdown(6, usage(25, 12))]), 's');
    const usages = lines.filter((entry) => entry.type === 'assistant').map((entry) => (typeof entry.message === 'object' && entry.message !== null && 'usage' in entry.message ? entry.message.usage : undefined));
    // The second shutdown replaces the first rather than adding to it; its output beyond the responses' own (12 - 10) lands on the last response.
    expect(usages).toEqual([{ output_tokens: 4 }, expect.objectContaining({ input_tokens: 25, output_tokens: 8 })]);
  });

  it('keeps the totals of a model that only an earlier shutdown holds', () => {
    const usage = (model: string, inputTokens: number, outputTokens: number) => ({ [model]: { requests: {}, usage: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } } });
    const lines = eventLines(asText([start(), prompt(1, 'a'), say(2, 'one', { model: 'm1' }), shutdown(3, usage('m1', 10, 4)), prompt(4, 'b'), say(5, 'two', { model: 'm2' }), shutdown(6, usage('m2', 20, 6))]), 's');
    const inputs = lines.filter((entry) => entry.type === 'assistant').map((entry) => (typeof entry.message === 'object' && entry.message !== null && 'usage' in entry.message && typeof entry.message.usage === 'object' && entry.message.usage !== null && 'input_tokens' in entry.message.usage ? entry.message.usage.input_tokens : undefined));
    expect(inputs).toEqual([10, 20]);
  });

  it('floors input at 0 when the cache tokens exceed the input total', () => {
    const lines = eventLines(asText([start(), prompt(1, 'a'), say(2, 'one', { model: 'm1' }), shutdown(3, { m1: { requests: {}, usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 0 } } })]), 's');
    expect(capture(lines.map((entry) => JSON.stringify(entry)).join('\n')).session.usage).toMatchObject({ input: 0, cacheRead: 20 });
  });

  it('keeps the output as the error line when the exit code is -1, which is no exit status', () => {
    const out = extractOf([start(), prompt(1, 'x'), say(2, '', {}, [ask('c1', 'bash')]), shellStart(3, 'c1', 'x'), done(4, 'c1', { shellExecution: { exitCode: -1 }, result: { content: 'killed by signal' } })]);
    expect(out.errorLines).toMatchObject([{ line: 'killed by signal' }]);
  });

  it('unwraps an error object to its message, never the wrapper, so the error line joins a Claude Code signature', () => {
    const out = extractOf([
      start(),
      prompt(1, 'read it'),
      say(2, '', {}, [ask('c1', 'view', { path: '/nope' }), ask('c2', 'view'), ask('c3', 'view')]),
      begin(3, 'c1', 'view'),
      done(4, 'c1', { success: false, error: { code: 'ENOENT', message: 'ENOENT: no such file or directory, open /nope' } }),
      begin(5, 'c2', 'view'),
      done(6, 'c2', { success: false, result: { content: 'plain output text' } }),
      begin(7, 'c3', 'view'),
      done(8, 'c3', { success: false }),
    ]);
    expect(out.errorLines.map((error) => error.line)).toEqual(['ENOENT: no such file or directory, open /nope', 'plain output text', 'tool failed']);
    expect(JSON.stringify(out.errorLines)).not.toContain('"code"');
  });

  it('leaves a call with no completion event (an abort, a crash) unsettled, and a completion with no known call alone', () => {
    const out = extractOf([start(), prompt(1, 'x'), say(2, '', {}, [ask('c1', 'bash')]), shellStart(3, 'c1', 'sleep 9'), event(T(4), 'abort', { reason: 'user_initiated' }), done(5, 'ghost', {}), begin(6, 'ghost', 'bash', { shellToolInfo: {} })]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'none' }]);
  });

  it('settles a call once, and names an MCP call the way Claude Code does', () => {
    const lines = eventLines(
      asText([start(), prompt(1, 'x'), say(2, '', {}, [{ toolCallId: 'm1', name: 'github-get_issue', arguments: {}, mcpServerName: 'github', mcpToolName: 'get_issue' }]), begin(3, 'm1', 'github-get_issue'), done(4, 'm1', {}), done(5, 'm1', { success: false })]),
      's',
    );
    expect(JSON.stringify(lines)).toContain('"name":"mcp__github__get_issue"');
    expect(lines.filter((entry) => JSON.stringify(entry).includes('tool_result'))).toHaveLength(1);
  });

  it('writes no usage for a session with none, and gives every assistant line a requestId', () => {
    const lines = eventLines(asText([start(), prompt(1, 'hi'), say(2, 'hello'), event(T(3), 'assistant.message', { content: 'more' })]), 's');
    expect(JSON.stringify(lines)).not.toContain('"usage"');
    const assistants = lines.filter((entry) => entry.type === 'assistant');
    expect(assistants.map((entry) => typeof entry.requestId)).toEqual(['string', 'string']);
    expect(new Set(assistants.map((entry) => entry.requestId)).size).toBe(2);
    expect(capture(lines.map((entry) => JSON.stringify(entry)).join('\n')).session.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0 });
  });

  it('attaches a shutdown total to the last response of that model only, and to nothing when no response names it', () => {
    const lines = eventLines(
      asText([
        start(),
        prompt(1, 'a'),
        say(2, 'one', { model: 'm1' }),
        say(3, 'two', { model: 'm1', outputTokens: 5 }),
        shutdown(4, { m1: { requests: {}, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }, other: { requests: {}, usage: { inputTokens: 99, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }, broken: 5 }),
        prompt(5, 'b'),
        say(6, 'three', { model: 'm1' }),
      ]),
      's',
    );
    const usages = lines.filter((entry) => entry.type === 'assistant').map((entry) => (typeof entry.message === 'object' && entry.message !== null && 'usage' in entry.message ? entry.message.usage : undefined));
    // The totals are the model's latest, so they sit on its last response overall (a line after the shutdown included); the responses' own output stays where it was.
    expect(usages).toEqual([undefined, { output_tokens: 5 }, { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }]);
  });

  it('gives a prompt with a missing, relative, or earlier stamp the latest time so far, never an earlier one', () => {
    const lines = eventLines(
      asText([start(), event('+5s', 'user.message', { content: 'relative' }), prompt(9, 'later'), prompt(3, 'earlier'), { type: 'user.message', data: { content: 'none' } }]),
      's',
    );
    expect(lines.filter((entry) => entry.type === 'user').map((entry) => entry.timestamp)).toEqual([T(0), T(9), T(9), T(9)]);
  });

  it('does not read an autopilot continuation as a prompt, nor a subagent’s own events, nor an empty message', () => {
    const lines = eventLines(
      asText([start(), prompt(1, 'real'), event(T(2), 'user.message', { content: 'keep going', isAutopilotContinuation: true }), event(T(3), 'user.message', { content: '' }), event(T(4), 'user.message', { content: 'inner' }, { agentId: 'sub-1' })]),
      's',
    );
    expect(lines.filter((entry) => entry.type === 'user')).toHaveLength(1);
  });

  it('skips torn lines, lines of an unknown shape, and a tool request with no id, and counts the torn ones', () => {
    const text = `${asText([start(), prompt(1, 'x'), say(2, 'y', {}, [{ name: 'bash' }, { toolCallId: 'z' }, 7])])}\n{torn\n[1]\n${JSON.stringify({ type: 5, data: {} })}\n`;
    expect(eventBadLines(text)).toEqual(['{torn']);
    expect(eventLines(text, 's').filter((entry) => entry.type === 'assistant')).toHaveLength(1);
    expect(() => eventLines('{torn\nnot json\n', 's')).toThrow(/no parseable line/);
    expect(eventLines('', 's')).toEqual([]);
  });

  it('follows a model change, and falls back to the session id when the head names none', () => {
    const lines = eventLines(asText([prompt(1, 'x'), event(T(2), 'session.model_change', { newModel: 'gpt-5' }), say(3, 'y')]), 'fallback');
    expect(lines.find((entry) => entry.type === 'assistant')).toMatchObject({ requestedModel: 'gpt-5', sessionId: 'fallback' });
    expect(eventLines(asText([event(T(1), 'session.start', { sessionId: 'x' }), event(T(2), 'session.model_change', {}), say(3, 'y')]), 's').find((entry) => entry.type === 'assistant')).not.toHaveProperty('requestedModel');
  });

  it('redacts a secret and an email, and cuts a 1,500-character error at 1,000 characters', () => {
    const long = `fail: sk-abcdefghijklmnopqrstuvwxyz0123 for alice@example.com ${'x'.repeat(1500)}`;
    const out = extractOf([start(), prompt(1, 'go'), say(2, '', {}, [ask('c1', 'bash')]), shellStart(3, 'c1', 'make'), done(4, 'c1', { shellExecution: { exitCode: 1 }, result: { content: long } })]);
    const error = out.errorLines[0];
    expect(error?.line.length).toBeLessThanOrEqual(1000);
    expect(error?.line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(error?.line).not.toContain('alice@example.com');
    const tool = extractOf([start(), prompt(1, 'go'), say(2, '', {}, [ask('c1', 'view')]), begin(3, 'c1', 'view'), done(4, 'c1', { success: false, error: { message: long } })]).errorLines[0];
    expect(tool?.line.length).toBeLessThanOrEqual(1000);
    expect(tool?.line).not.toContain('alice@example.com');
  });
});

describe('the Copilot CLI reader, fix round 1', () => {
  it('decides a shell call by the completion alone: no shellToolInfo on the start, success true, exit 2 is an error', () => {
    const out = extractOf([start(), prompt(1, 'run'), say(2, '', {}, [ask('c1', 'bash', { command: 'make' })]), begin(3, 'c1', 'bash', { arguments: { command: 'make' } }), done(4, 'c1', { success: true, shellExecution: { exitCode: 2 }, result: { content: 'make: *** No rule' } })]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: 'make: *** No rule' }]);
  });

  it('lets the exit code decide whatever success says: exit 0 with success false is ok', () => {
    const out = extractOf([start(), prompt(1, 'run'), say(2, '', {}, [ask('a', 'bash')]), shellStart(3, 'a', 'x'), done(4, 'a', { success: false, shellExecution: { exitCode: 0 }, result: { content: 'fine' } })]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['ok']);
  });

  it('keeps the error message when a nonzero exit has no output', () => {
    const lines = eventLines(asText([start(), prompt(1, 'x'), say(2, '', {}, [ask('b', 'bash')]), shellStart(3, 'b', 'y'), done(4, 'b', { success: false, shellExecution: { exitCode: 3 }, error: { message: 'permission denied' }, result: { content: '' } })]), 's');
    expect(JSON.stringify(lines)).toContain('permission denied');
  });

  it('keys a response on requestId, else apiCallId, else messageId, so chunks of one call get the shutdown totals once', () => {
    const lines = eventLines(
      asText([
        start(),
        prompt(1, 'a'),
        say(2, 'one', { model: 'm1', requestId: 'r1', apiCallId: 'api1', outputTokens: 3 }),
        say(3, 'two', { model: 'm1', requestId: 'r1', apiCallId: 'api1', outputTokens: 4 }),
        shutdown(4, { m1: { requests: {}, usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 20, cacheWriteTokens: 0 } } }),
      ]),
      's',
    );
    expect(lines.filter((entry) => entry.type === 'assistant').map((entry) => entry.requestId)).toEqual(['r1', 'r1']);
    expect(capture(lines.map((entry) => JSON.stringify(entry)).join('\n')).session.usage).toMatchObject({ input: 80, cacheRead: 20, output: 7 });
    expect(eventLines(asText([start(), say(2, 'x', { apiCallId: 'api9', messageId: 'mm' })]), 's').find((entry) => entry.type === 'assistant')?.requestId).toBe('api9');
  });

  it('reads powershell as a shell call whose step is shell.exec, and an edit by its name with no fileEdits', () => {
    const lines = eventLines(
      asText([
        start(),
        prompt(1, 'x'),
        say(2, '', {}, [ask('p', 'powershell', { command: 'dir' }), ask('e', 'edit', { path: 'src/a.ts' }), ask('f', 'str_replace_editor', { path: 'src/b.ts' })]),
        begin(3, 'p', 'powershell', { arguments: { command: 'dir' }, shellToolInfo: {} }),
        done(4, 'p', { shellExecution: { exitCode: 0 }, result: { content: 'x' } }),
        begin(5, 'e', 'edit'),
        done(6, 'e', { success: false, error: { message: 'no match' } }),
        begin(7, 'f', 'str_replace_editor'),
        done(8, 'f', {}),
      ]),
      's',
    );
    const text = lines.map((entry) => JSON.stringify(entry)).join('\n');
    const out = capture(text);
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'ok'], ['Edit', 'error'], ['Edit', 'ok']]);
    expect(out.session.files).toEqual(expect.arrayContaining(['src/b.ts']));
    expect(out.tools.map((tool) => tool.steps?.[0]?.action)).toEqual(['shell.exec', 'file.edit', 'file.edit']);
  });

  it('skips events that carry only the deprecated parentToolCallId, and user messages from skills and other agents', () => {
    const lines = eventLines(
      asText([
        start(),
        prompt(1, 'real'),
        event(T(2), 'assistant.message', { messageId: 'x', content: 'inner', parentToolCallId: 'task1' }),
        event(T(3), 'user.message', { content: 'skill body', source: 'skill-pdf' }),
        event(T(4), 'user.message', { content: 'from a peer', source: 'agent-7' }),
        event(T(5), 'user.message', { content: 'typed', source: 'user' }),
      ]),
      's',
    );
    expect(lines.filter((entry) => entry.type === 'assistant')).toHaveLength(0);
    expect(lines.filter((entry) => entry.type === 'user')).toHaveLength(2);
  });

  it('follows a resume or a directory change for the cwd and the model', () => {
    const lines = eventLines(
      asText([
        start('/work/a'),
        prompt(1, 'one'),
        event(T(2), 'session.context_changed', { cwd: '/work/b' }),
        prompt(3, 'two'),
        event(T(4), 'session.resume', { resumeTime: T(4), eventCount: 1, selectedModel: 'gpt-5', context: { cwd: '/work/c' } }),
        say(5, 'three'),
      ]),
      's',
    );
    expect(lines.map((entry) => entry.cwd)).toEqual(['/work/a', '/work/b', '/work/c']);
    expect(lines.find((entry) => entry.type === 'assistant')).toMatchObject({ requestedModel: 'gpt-5' });
  });

  it('takes the totals from agentMetrics.main when present, else from modelMetrics', () => {
    const usage = (n: number) => ({ requests: {}, usage: { inputTokens: n, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    const run = (data: object) =>
      capture(
        eventLines(asText([start(), prompt(1, 'a'), say(2, 'one', { model: 'm1' }), event(T(3), 'session.shutdown', { shutdownType: 'routine', totalApiDurationMs: 5, sessionStartTime: 0, codeChanges: {}, ...data })]), 's')
          .map((entry) => JSON.stringify(entry))
          .join('\n'),
      ).session.usage;
    expect(run({ modelMetrics: { m1: usage(500) }, agentMetrics: { main: { modelMetrics: { m1: usage(40) } } } })).toMatchObject({ input: 40 });
    expect(run({ modelMetrics: { m1: usage(500) }, agentMetrics: { other: {} } })).toMatchObject({ input: 500 });
    expect(run({ modelMetrics: { m1: usage(500) } })).toMatchObject({ input: 500 });
  });

  it('captures a session from a folder that is not a repository', () => {
    const out = extractOf([start('/tmp/notes'), prompt(1, 'hi'), say(2, '', {}, [ask('c1', 'view', { path: 'a.txt' })]), begin(3, 'c1', 'view'), done(4, 'c1', { result: { content: 'text' } })]);
    expect(out.tools).toMatchObject([{ tool: 'view', status: 'ok' }]);
    expect(out.session.repo).toBeNull();
  });
});

describe('the Copilot home', () => {
  it('is COPILOT_HOME, else ~/.copilot', () => {
    expect(copilotRoot({ COPILOT_HOME: '/x/y' }, '/home/u')).toBe('/x/y');
    expect(copilotRoot({ COPILOT_HOME: '' }, '/home/u')).toBe(join('/home/u', '.copilot'));
    expect(copilotRoot({}, '/home/u')).toBe(join('/home/u', '.copilot'));
  });

  it('lists sessions by folder name with the cwd the head names, skips what is no session, and reports what it cannot read', async () => {
    const s = stage();
    const home = stageCopilot(s.root, [
      { id: 'aaa', lines: [start('/work/a'), prompt(1, 'x')] },
      { id: 'bbb', lines: [event(T(0), 'session.journal_link', { previousFile: 'events.1.jsonl', sessionId: 'bbb', version: 1 }), start('/work/b')] },
      { id: 'ccc', lines: [event(T(0), 'session.error', {})] },
      { id: 'ddd', lines: [event(T(0), 'session.start', {})] },
      { id: 'bad id', lines: [start()] },
      { id: 'eee', lines: '{torn\n' },
    ]);
    mkdirSync(join(home, 'session-state', 'empty'));
    writeFileSync(join(home, 'session-state', 'stray.txt'), 'x');
    const store = await openCopilotStore(home);
    expect(store?.sessions.map((session) => [session.id, session.folder])).toEqual([['aaa', '/work/a'], ['bbb', '/work/b'], ['ccc', null], ['ddd', null], ['eee', null]]);
    expect(store?.rejected).toBe(1);
    expect(store?.unreadable).toEqual([]);
    const first = store?.sessions[0];
    expect(await store?.transcript(first ?? never())).toContain('"text":"x"');
    expect(await openCopilotStore(join(s.root, 'nowhere'))).toBeUndefined();
    await expect(store?.transcript({ ...(first ?? never()), file: join(home, 'gone.jsonl'), archives: [] })).rejects.toThrow();
  });

  it('joins a rotated session: the cwd from the oldest file, a torn line and an id-less line kept, an empty archive and a repeated id dropped, the size summed', async () => {
    const s = stage();
    const home = stageCopilot(s.root, [
      {
        id: 'rot',
        archives: [
          { n: 3, lines: '' },
          { n: 1, lines: [start('/work/old'), prompt(1, 'first')] },
          { n: 2, lines: ['{torn', JSON.stringify({ type: 'user.message', timestamp: T(2), data: { content: 'no id' } }), JSON.stringify(prompt(1, 'first'))].join('\n') },
        ],
        lines: [event(T(5), 'session.journal_link', { previousFile: 'events.3.jsonl', sessionId: 'rot', version: 1 }), prompt(6, 'last')],
      },
    ]);
    const store = await openCopilotStore(home);
    const rotated = store?.sessions[0];
    expect(rotated?.folder).toBe('/work/old');
    expect(rotated?.archives.map((path) => basename(path))).toEqual(['events.1.jsonl', 'events.2.jsonl', 'events.3.jsonl']);
    const text = await store?.transcript(rotated ?? never());
    expect(text?.match(/"text":"first"/g)).toHaveLength(1);
    expect(text).toContain('no id');
    expect(text).toContain('"text":"last"');
    expect(text).toContain('{torn');
  });

  it('reports a store folder that cannot be listed by its base name, never fatal', async () => {
    const s = stage();
    const home = join(s.root, 'copilot-file');
    mkdirSync(home);
    writeFileSync(join(home, 'session-state'), 'a file, not a folder');
    const store = await openCopilotStore(home);
    expect(store?.sessions).toEqual([]);
    expect(store?.unreadable).toHaveLength(1);
    expect(store?.unreadable[0]?.reason).not.toContain(s.root);
    await expect(store?.transcript({ id: 'x', folder: null, file: 'x', archives: [], size: 0, mtimeMs: 0 })).rejects.toThrow();
  });
});

const never = (): never => {
  throw new Error('no session');
};
