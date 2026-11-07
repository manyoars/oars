import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { openPiStore, piBadLines, piLines, piRoot } from './pi.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, piEntry, piHeader, stage, stagePi } from './test-support.js';

afterEach(cleanup);

// Every fixture below is written from badlogic/pi-mono @ 085c84e (the `pi` coding agent, now earendil-works/pi), under packages/coding-agent/, and cites the document or
// source line that can write it:
//   file location and header                 docs/session-format.md:10-14, :64-76; src/core/session-manager.ts:590-593
//   entry base (`id`, `parentId`, ISO time)  docs/session-format.md:49-59; the message's own `timestamp` is Unix ms (docs/message-types.md:5)
//   message roles, usage, stop reasons       docs/message-types.md:67-175
//   `toolCall {id, name, arguments}`         docs/message-types.md:52-63; tool inputs: tools/bash.ts:40 (`command`), tools/edit.ts:29-37 (`path`, `edits[]`), tools/write.ts:10-13 (`path`, `content`), tools/read.ts:14-18
//   a non-zero shell exit                    tools/bash.ts:434-440: `isError: true`, text ending "\n\nCommand exited with code N"; an abort or a timeout is a thrown error (:402-413)
//   a tool error                             agent-loop.ts:780-783: the thrown error's `message` as one text part, `isError: true` (no wrapper)
//   the user's `!cmd`                        docs/message-types.md:200-216 (`bashExecution`: command, output, exitCode, cancelled), persisted by agent-session.ts:4043
//   branching, the leaf, a fork's copy       session-manager.ts:1104-1112 (the leaf is the last entry), :1643-1735 (`createBranchedSession` copies the path, keeping its old times)
//   version 1 (no ids, one chain)            session-manager.ts:287-313
// `usage.input` is already net of cache reads and writes: openai-completions.ts:1536-1550, openai-responses-shared.ts:636-642, anthropic-messages.ts:967-972.
// No live Pi store was read.

const capture = (text: string) =>
  captureSession({
    text,
    harness: 'pi',
    session: 'pi-x',
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

type Obj = { [key: string]: unknown };
const BASE = Date.parse('2026-06-01T10:00:00Z');
const at = (second: number): string => new Date(BASE + second * 1000).toISOString();
const asText = (events: readonly unknown[]): string => events.map((entry) => JSON.stringify(entry)).join('\n');
const linesOf = (events: readonly unknown[], header: Obj = piHeader()) => piLines(asText([header, ...events]), 'sess');
const extractOf = (events: readonly unknown[], header: Obj = piHeader()) => capture(linesOf(events, header).map((entry) => JSON.stringify(entry)).join('\n'));

type Make = (id: string, parent: string | null) => Obj;
/** Entries in one chain: each names the one before it as its parent, ids `e1`, `e2`, ... */
const chain = (...parts: Make[]): Obj[] => {
  let parent: string | null = null;
  return parts.map((make, index) => {
    const id = `e${String(index + 1)}`;
    const entry = make(id, parent);
    parent = id;
    return entry;
  });
};
const message = (second: number, body: Obj, extra: Obj = {}): Make => (id, parent) => piEntry('message', id, parent, at(second), { message: { ...body, timestamp: BASE + second * 1000 }, ...extra });

const usageOf = (input: number, output: number, cacheRead = 0, cacheWrite = 0, reasoning?: number): Obj => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  ...(reasoning === undefined ? {} : { reasoning }),
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const prompt = (second: number, text: string | readonly Obj[]): Make => message(second, { role: 'user', content: text });
const reply = (second: number, content: readonly Obj[], extra: Obj = {}): Make =>
  message(second, { role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'claude-sonnet-4-5', usage: usageOf(10, 5), stopReason: 'stop', ...extra });
const say = (second: number, text: string, extra: Obj = {}): Make => reply(second, [{ type: 'text', text }], extra);
const toolCall = (id: string, name: string, args: Obj): Obj => ({ type: 'toolCall', id, name, arguments: args });
const callOf = (second: number, id: string, name: string, args: Obj, extra: Obj = {}): Make => reply(second, [toolCall(id, name, args)], { stopReason: 'toolUse', ...extra });
const outcome = (second: number, id: string, name: string, text: string, isError = false, extra: Obj = {}): Make =>
  message(second, { role: 'toolResult', toolCallId: id, toolName: name, content: text === '' ? [] : [{ type: 'text', text }], isError, ...extra });
const bashFailure = (code: number, output: string): string => `${output === '' ? '' : `${output}\n\n`}Command exited with code ${String(code)}`;

describe('the Pi reader', () => {
  it('turns a normal session into prompts, calls with outcomes, usage from each message, the model, and the cwd', () => {
    const events = chain(
      prompt(1, 'fix the build'),
      reply(2, [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'running it' }, toolCall('c1', 'bash', { command: 'npm test' })], { usage: usageOf(100, 20, 400, 0, 8), stopReason: 'toolUse' }),
      outcome(3, 'c1', 'bash', 'ok'),
      reply(4, [toolCall('c2', 'edit', { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] }), toolCall('c3', 'write', { path: '/work/app/docs/b.md', content: 'x' }), toolCall('c4', 'read', { path: 'README.md' })], { usage: usageOf(40, 10), stopReason: 'toolUse' }),
      outcome(5, 'c2', 'edit', 'Edited src/a.ts'),
      outcome(5, 'c3', 'write', 'Wrote docs/b.md'),
      outcome(6, 'c4', 'read', '# readme'),
      say(8, 'done', { usage: usageOf(50, 5) }),
    );
    const out = extractOf(events);
    expect(out.session.userTurns).toBe(1);
    expect(out.session.assistantTurns).toBe(3);
    expect(out.session.models).toEqual({ 'claude-sonnet-4-5': 3 });
    // `reasoning` is already inside `output` (message-types.md:90), so thinking is 8 and output is 35, not 43.
    expect(out.session.usage).toMatchObject({ input: 190, cacheRead: 400, cacheWrite: 0, output: 35, thinking: 8 });
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'ok'], ['Edit', 'ok'], ['Edit', 'ok'], ['read', 'ok']]);
    // A relative `path` and an absolute one both come out in the absolute form Claude Code's `file_path` has.
    expect([...out.session.files].sort()).toEqual(['/work/app/docs/b.md', '/work/app/src/a.ts']);
    expect(out.errorLines).toEqual([]);
    expect(out.session.tsFirst).toBe(at(1));
    expect(out.session.tsLast).toBe(at(8));
  });

  it('keeps usage.input whole: Pi has already taken the cache reads and writes out of it, so nothing is subtracted a second time', () => {
    const out = extractOf(chain(prompt(1, 'x'), say(2, 'y', { usage: usageOf(100, 30, 400, 50, 7) })));
    expect(out.session.usage).toMatchObject({ input: 100, cacheRead: 400, cacheWrite: 50, output: 30, thinking: 7 });
  });

  it('records a shell call that exited non-zero as an error with the real exit code, from the suffix and not from a status field', () => {
    const out = extractOf(
      chain(
        prompt(1, 'run them'),
        callOf(2, 'c1', 'bash', { command: 'make' }),
        outcome(3, 'c1', 'bash', bashFailure(2, 'make: *** No rule to make target\nsecond'), true),
        callOf(4, 'c2', 'bash', { command: 'false' }),
        outcome(5, 'c2', 'bash', bashFailure(3, ''), true),
        callOf(6, 'c3', 'bash', { command: 'echo' }),
        // Output that merely mentions an exit code is not a failure when the result says it is not one.
        outcome(7, 'c3', 'bash', 'Command exited with code 1 was the old behavior', false),
      ),
    );
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'error'], ['Bash', 'error'], ['Bash', 'ok']]);
    expect(out.errorLines.map((error) => [error.tool, error.line])).toEqual([['Bash', 'make: *** No rule to make target'], ['Bash', 'Exit code 3']]);
  });

  it('records an aborted, timed-out, or exit-less shell call as an error, with the output it had, and an error with no recognizable suffix as itself', () => {
    const out = extractOf(
      chain(
        prompt(1, 'x'),
        callOf(2, 'a', 'bash', { command: 'sleep 9' }),
        outcome(3, 'a', 'bash', 'partial\n\nCommand timed out after 5 seconds', true),
        callOf(4, 'b', 'bash', { command: 'sleep 9' }),
        outcome(5, 'b', 'bash', 'Command aborted', true),
        callOf(6, 'c', 'powershell', { command: 'Get-Thing' }),
        outcome(7, 'c', 'powershell', 'spawn pwsh ENOENT', true),
      ),
    );
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'error'], ['Bash', 'error'], ['Bash', 'error']]);
    expect(out.errorLines.map((error) => error.line)).toEqual(['partial', 'Command aborted', 'spawn pwsh ENOENT']);
  });

  it('takes a failed tool’s text as its error line, with no wrapper, so it joins a Claude Code signature', () => {
    const out = extractOf(
      chain(
        prompt(1, 'read it'),
        callOf(2, 'r1', 'read', { path: 'nope' }),
        outcome(3, 'r1', 'read', "ENOENT: no such file or directory, access '/work/app/nope'", true),
        callOf(4, 'e1', 'edit', { path: 'a.ts', edits: [{ oldText: 'zz', newText: 'y' }] }),
        outcome(5, 'e1', 'edit', 'Could not find the exact text in a.ts.', true),
        callOf(6, 'g1', 'grep', { pattern: 'x' }),
        outcome(7, 'g1', 'grep', '', true),
      ),
    );
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['read', 'error'], ['Edit', 'error'], ['grep', 'error']]);
    expect(out.errorLines.map((error) => error.line)).toEqual(["ENOENT: no such file or directory, access '/work/app/nope'", 'Could not find the exact text in a.ts.', 'tool failed']);
  });

  it('redacts a secret and an email, and cuts a 1,500-character error at 1,000 characters', () => {
    const long = `fail: sk-abcdefghijklmnopqrstuvwxyz0123 for alice@example.com ${'x'.repeat(1500)}`;
    const out = extractOf(chain(prompt(1, 'x'), callOf(2, 'c1', 'bash', { command: 'make' }), outcome(3, 'c1', 'bash', bashFailure(1, long), true)));
    const [error] = out.errorLines;
    expect(error?.line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(error?.line).not.toContain('alice@example.com');
    expect(error?.line.length).toBe(1000);
  });

  it('writes no usage for a response that has none, and for one that errored before the provider counted anything, and gives every assistant line its own requestId', () => {
    const lines = linesOf(
      chain(prompt(1, 'hi'), say(2, 'hello', { usage: undefined }), prompt(3, 'again'), say(4, 'x', { stopReason: 'error', errorMessage: '401', usage: usageOf(0, 0) }), prompt(5, 'once more'), say(6, 'ok', { usage: usageOf(0, 12) })),
    );
    const assistant = lines.filter((entry) => entry.type === 'assistant');
    expect(assistant).toHaveLength(3);
    const usages = assistant.map((entry) => (typeof entry.message === 'object' && entry.message !== null && 'usage' in entry.message ? entry.message.usage : undefined));
    expect(usages[0]).toBeUndefined();
    expect(usages[1]).toBeUndefined();
    // A real zero beside a count is a figure the provider reported: it stays.
    expect(usages[2]).toMatchObject({ input_tokens: 0, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    expect(new Set(assistant.map((entry) => entry.requestId)).size).toBe(3);
    expect(assistant.every((entry) => typeof entry.requestId === 'string' && entry.requestId !== '')).toBe(true);
    expect(extractOf(chain(prompt(1, 'hi'), say(2, 'hello', { usage: undefined }))).session.usage).toMatchObject({ input: 0, output: 0 });
  });

  it('captures a session from a folder that is not a repository, and puts the header’s cwd on every line', () => {
    const header = piHeader({ cwd: '/tmp/notes' });
    const events = chain(prompt(1, 'hi'), callOf(2, 'c1', 'read', { path: 'a.txt' }), outcome(3, 'c1', 'read', 'hello'));
    const out = extractOf(events, header);
    expect(out.tools).toMatchObject([{ tool: 'read', status: 'ok' }]);
    expect(out.session.repo).toBeNull();
    expect(linesOf(events, header).every((entry) => entry.cwd === '/tmp/notes')).toBe(true);
  });

  it('keeps the active branch: the path from the last entry written to its root, not an abandoned branch’s prompts or calls', () => {
    // e3..e4 were the first try at the second prompt; e5..e6 are the branch /tree moved to, and e6 is the last entry in the file, so it is the leaf (session-manager.ts:1104-1112).
    const events = [
      ...chain(prompt(1, 'first'), say(2, 'one')),
      piEntry('message', 'e3', 'e2', at(3), { message: { role: 'user', content: 'second, abandoned', timestamp: BASE + 3000 } }),
      piEntry('message', 'e4', 'e3', at(4), { message: { role: 'assistant', content: [toolCall('x1', 'bash', { command: 'rm -rf build' })], model: 'claude-sonnet-4-5', usage: usageOf(900, 90), stopReason: 'toolUse', timestamp: BASE + 4000 } }),
      piEntry('message', 'e5', 'e2', at(5), { message: { role: 'user', content: 'second, kept', timestamp: BASE + 5000 } }),
      piEntry('message', 'e6', 'e5', at(6), { message: { role: 'assistant', content: [{ type: 'text', text: 'two' }], model: 'claude-sonnet-4-5', usage: usageOf(7, 3), stopReason: 'stop', timestamp: BASE + 6000 } }),
    ];
    const lines = linesOf(events);
    const prompts = lines.filter((entry) => entry.type === 'user').map((entry) => JSON.stringify(entry.message));
    expect(prompts).toHaveLength(2);
    expect(prompts.join('')).toContain('second, kept');
    expect(prompts.join('')).not.toContain('abandoned');
    const out = capture(lines.map((entry) => JSON.stringify(entry)).join('\n'));
    expect(out.tools).toEqual([]);
    expect(out.session.usage).toMatchObject({ input: 17, output: 8 });
  });

  it('reads a fork or clone as only its own entries: the path it copied from its parent keeps the old times, and the header’s time is the cut', () => {
    const header = piHeader({ timestamp: at(100), parentSession: '/home/u/.pi/agent/sessions/--work-app--/2026-06-01T10-00-00-000Z_parent.jsonl' });
    const events = [
      piEntry('message', 'p1', null, at(1), { message: { role: 'user', content: 'copied prompt', timestamp: BASE + 1000 } }),
      piEntry('message', 'p2', 'p1', at(2), { message: { role: 'assistant', content: [{ type: 'text', text: 'copied reply' }], model: 'claude-sonnet-4-5', usage: usageOf(500, 50), stopReason: 'stop', timestamp: BASE + 2000 } }),
      piEntry('message', 'n1', 'p2', at(101), { message: { role: 'user', content: 'own prompt', timestamp: BASE + 101000 } }),
      piEntry('message', 'n2', 'n1', at(102), { message: { role: 'assistant', content: [{ type: 'text', text: 'own reply' }], model: 'claude-sonnet-4-5', usage: usageOf(7, 3), stopReason: 'stop', timestamp: BASE + 102000 } }),
    ];
    const out = extractOf(events, header);
    expect(out.session.userTurns).toBe(1);
    expect(out.session.usage).toMatchObject({ input: 7, output: 3 });
    expect(out.session.tsFirst).toBe(at(101));
  });

  it('reads a version 1 file, which has no ids, as one chain in file order', () => {
    const header = { type: 'session', id: 'old', timestamp: at(0), cwd: '/work/app' };
    const events = [
      { type: 'message', timestamp: at(1), message: { role: 'user', content: 'hello', timestamp: BASE + 1000 } },
      { type: 'message', timestamp: at(2), message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], model: 'm', usage: usageOf(4, 2), stopReason: 'stop', timestamp: BASE + 2000 } },
      { type: 'message', timestamp: at(3), message: { role: 'user', content: 'again', timestamp: BASE + 3000 } },
    ];
    const out = extractOf(events, header);
    expect(out.session.userTurns).toBe(2);
    expect(out.session.usage).toMatchObject({ input: 4, output: 2 });
  });

  it('gives each prompt its own time: a missing or unreadable entry time falls back to the message’s own, then to the latest time so far, never to one time for all', () => {
    const events = [
      piEntry('message', 'e1', null, 'not a time', { message: { role: 'user', content: 'a', timestamp: BASE + 10000 } }),
      piEntry('message', 'e2', 'e1', at(11), { message: { role: 'assistant', content: [{ type: 'text', text: 'x' }], model: 'm', usage: usageOf(1, 1), stopReason: 'stop', timestamp: BASE + 11000 } }),
      { type: 'message', id: 'e3', parentId: 'e2', message: { role: 'user', content: 'b' } },
      piEntry('message', 'e4', 'e3', at(30), { message: { role: 'user', content: 'c', timestamp: BASE + 30000 } }),
    ];
    const times = linesOf(events)
      .filter((entry) => entry.type === 'user')
      .map((entry) => entry.timestamp);
    expect(times).toEqual([at(10), at(11), at(30)]);
  });

  it('ends the path at a parent that is gone, a cycle, or an entry with no id, rather than failing', () => {
    const entry = (id: string | undefined, parent: string | null, second: number, text: string): Obj => ({ type: 'message', ...(id === undefined ? {} : { id }), parentId: parent, timestamp: at(second), message: { role: 'user', content: text, timestamp: BASE + second * 1000 } });
    const texts = (events: readonly Obj[]): string[] =>
      linesOf(events)
        .filter((line) => line.type === 'user')
        .map((line) => JSON.stringify(line.message));
    // e2's parent was never written: the path starts at e2.
    expect(texts([entry('e1', null, 1, 'lost'), entry('e2', 'gone', 2, 'kept 1'), entry('e3', 'e2', 3, 'kept 2')]).join('')).not.toContain('lost');
    expect(texts([entry('e1', null, 1, 'lost'), entry('e2', 'gone', 2, 'kept 1'), entry('e3', 'e2', 3, 'kept 2')])).toHaveLength(2);
    // Two entries that name each other as parent: each is read once.
    expect(texts([entry('a', 'b', 1, 'one'), entry('b', 'a', 2, 'two')])).toHaveLength(2);
    // An entry with no id cannot be the leaf or a parent: the last entry that has one is the leaf.
    expect(texts([entry('e1', null, 1, 'one'), entry('e2', 'e1', 2, 'two'), entry(undefined, 'e2', 3, 'no id')])).toHaveLength(2);
  });

  it('puts no time on a line when the session has none anywhere, rather than the epoch', () => {
    const header = { type: 'session', version: 3, id: 'sess', cwd: '/work/app' };
    const events = [
      { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: 'hello' } },
      { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], model: 'm', stopReason: 'stop' } },
    ];
    const lines = linesOf(events, header);
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => 'timestamp' in line)).toBe(false);
    expect(capture(lines.map((line) => JSON.stringify(line)).join('\n')).session.tsFirst).toBeNull();
  });

  it('does not read an extension’s or a summary’s text as a prompt, and does not count a tool’s nested model work as the session’s responses', () => {
    const events = chain(
      (id, parent) => piEntry('model_change', id, parent, at(1), { provider: 'openai', modelId: 'gpt-4o' }),
      (id, parent) => piEntry('custom_message', id, parent, at(1), { customType: 'ext', content: 'injected context', display: true }),
      (id, parent) => piEntry('custom', id, parent, at(1), { customType: 'ext', data: { n: 1 } }),
      (id, parent) => piEntry('branch_summary', id, parent, at(1), { fromId: 'z', summary: 'branch summary text', usage: usageOf(900, 90) }),
      (id, parent) => piEntry('compaction', id, parent, at(1), { summary: 'compaction text', firstKeptEntryId: id, tokensBefore: 5, usage: usageOf(800, 80) }),
      (id, parent) => piEntry('usage', id, parent, at(1), { kind: 'cache_warm', provider: 'anthropic', model: 'm', usage: usageOf(0, 0, 50000) }),
      message(1, { role: 'custom', customType: 'ext', content: 'also injected', display: true }),
      message(1, { role: 'branchSummary', summary: 'x', fromId: null }),
      message(1, { role: 'compactionSummary', summary: 'y', tokensBefore: 1 }),
      prompt(2, 'the one real prompt'),
      callOf(3, 'c1', 'codemode', { code: 'run()' }, { usage: usageOf(10, 5) }),
      outcome(4, 'c1', 'codemode', 'done', false, { usage: usageOf(999, 99), nestedCalls: { complete: true, calls: [{ id: 'n1', name: 'bash', status: 'error', error: 'boom' }] } }),
      say(5, 'ok'),
    );
    const out = extractOf(events);
    expect(out.session.userTurns).toBe(1);
    expect(out.session.assistantTurns).toBe(2);
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['codemode', 'ok']]);
    expect(out.session.usage).toMatchObject({ input: 20, output: 10 });
  });

  it('counts an image-only prompt as a turn without keeping the image, and joins a prompt’s text blocks', () => {
    const lines = linesOf(chain(prompt(1, [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]), say(2, 'a picture'), prompt(3, [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }, { type: 'image', data: 'BBBB', mimeType: 'image/png' }]), say(4, 'ok')));
    const users = lines.filter((entry) => entry.type === 'user');
    expect(users).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain('AAAA');
    expect(JSON.stringify(lines)).not.toContain('BBBB');
    expect(JSON.stringify(users[1]?.message)).toContain('one\\ntwo');
  });

  it('reads the user’s own !cmd (a bashExecution message) as a shell call with its real exit code', () => {
    const run = (second: number, command: string, output: string, exitCode: number | undefined, cancelled = false): Make =>
      message(second, { role: 'bashExecution', command, output, exitCode, cancelled, truncated: false });
    const out = extractOf(chain(prompt(1, 'hello'), say(2, 'hi'), run(3, 'ls', 'a b', 0), run(4, 'false', 'it failed', 1), run(5, 'sleep 9', '', undefined, true), run(6, 'x', 'unknown', undefined)));
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'ok'], ['Bash', 'error'], ['Bash', 'error'], ['Bash', 'error']]);
    expect(out.errorLines.map((error) => error.line)).toEqual(['it failed', 'Command cancelled', 'unknown']);
    expect(out.session.userTurns).toBe(1);
  });

  it('names an MCP tool the way Pi registers it, mcp__<server>__<tool>, and keeps an unlisted tool under its own name', () => {
    const out = extractOf(chain(prompt(1, 'x'), callOf(2, 'm1', 'mcp__github__get_issue', { number: 1 }), outcome(3, 'm1', 'mcp__github__get_issue', '{}'), callOf(4, 't1', 'tool_search', { query: 'x' }), outcome(5, 't1', 'tool_search', 'none')));
    expect(out.tools.map((tool) => tool.tool)).toEqual(['mcp__github__get_issue', 'tool_search']);
  });

  it('names the shell and the file a call touched in the native field, so the table reads a write as a write and a PowerShell call as PowerShell', () => {
    const lines = linesOf(chain(prompt(1, 'x'), reply(2, [toolCall('a', 'write', { path: 'n.txt', content: 'c' }), toolCall('b', 'powershell', { command: 'dir' })], { stopReason: 'toolUse' })));
    const blocks = lines
      .filter((entry) => entry.type === 'assistant')
      .flatMap((entry): unknown[] => {
        const content: unknown = typeof entry.message === 'object' && entry.message !== null && 'content' in entry.message ? entry.message.content : [];
        return Array.isArray(content) ? content.map((block: unknown) => block) : [];
      });
    expect(blocks).toMatchObject([
      { type: 'tool_use', id: 'a', name: 'Edit', native: 'write', input: { file_path: '/work/app/n.txt' } },
      { type: 'tool_use', id: 'b', name: 'Bash', native: 'powershell', input: { command: 'dir' } },
    ]);
  });

  it('counts a line that is not JSON, and throws when no line is', () => {
    const text = `${asText([piHeader()])}\n{torn\n`;
    expect(piBadLines(text)).toEqual(['{torn']);
    expect(() => piLines('{torn\nnot json\n', 'sess')).toThrow('no parseable line');
  });
});

describe('the Pi store', () => {
  const header = (id: string, cwd: string): Obj => piHeader({ id, cwd });
  const session = (id: string, cwd: string): unknown[] => [header(id, cwd), ...chain(prompt(1, 'hi'), say(2, 'hello'))];

  it('names the Pi agent folder from PI_CODING_AGENT_DIR, a ~ in it, or ~/.pi/agent', () => {
    expect(piRoot({}, '/home/u')).toBe(join('/home/u', '.pi', 'agent'));
    expect(piRoot({ PI_CODING_AGENT_DIR: '' }, '/home/u')).toBe(join('/home/u', '.pi', 'agent'));
    expect(piRoot({ PI_CODING_AGENT_DIR: '/data/pi' }, '/home/u')).toBe('/data/pi');
    expect(piRoot({ PI_CODING_AGENT_DIR: '~/pi-agent' }, '/home/u')).toBe(join('/home/u', 'pi-agent'));
  });

  it('lists sessions by the id in the file name and the header’s cwd, reports what it cannot read, and lists nothing for a missing store', async () => {
    const s = stage();
    const home = stagePi(s.root, [
      { id: 'aaaa1111', cwd: '/work/app', lines: session('aaaa1111', '/work/app') },
      { id: 'bbbb2222', cwd: 'C:\\Users\\me\\proj', lines: session('bbbb2222', 'C:\\Users\\me\\proj') },
      { id: 'cccc3333', cwd: '/x', lines: '' },
      { id: 'dddd4444', cwd: '/x', lines: '{torn' },
      { id: '..', cwd: '/x', lines: session('..', '/x') },
    ]);
    expect(home.startsWith(s.root)).toBe(true);
    const store = await openPiStore(home);
    expect(store?.sessions.map((entry) => [entry.id, entry.folder])).toEqual([['aaaa1111', '/work/app'], ['bbbb2222', 'C:\\Users\\me\\proj']]);
    expect(store?.rejected).toBe(1);
    expect(store?.unreadable.map((entry) => entry.file).join('\n')).toContain('cccc3333');
    expect(store?.unreadable.map((entry) => entry.file).join('\n')).toContain('dddd4444');
    expect(await openPiStore(join(s.root, 'nowhere'))).toBeUndefined();
    mkdirSync(join(s.root, 'empty-home'), { recursive: true });
    writeFileSync(join(s.root, 'empty-home', 'sessions'), 'a file where the folder should be');
    expect((await openPiStore(join(s.root, 'empty-home')))?.unreadable).toHaveLength(1);
  });

  it('reads a session’s file as lines, with a torn line kept so the deposit counts it', async () => {
    const s = stage();
    const home = stagePi(s.root, [{ id: 'aaaa1111', cwd: '/work/app', lines: `${asText(session('aaaa1111', '/work/app'))}\n{torn\n` }]);
    const store = await openPiStore(home);
    const [found] = store?.sessions ?? [];
    if (found === undefined) throw new Error('no session');
    const text = (await store?.transcript(found)) ?? '';
    expect(text.split('\n').filter((raw) => raw !== '')).toHaveLength(3);
    expect(piBadLines(text)).toEqual(['{torn']);
  });
});
