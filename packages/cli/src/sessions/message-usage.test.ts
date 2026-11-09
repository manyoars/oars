// Token usage as an attribute of a message group (CAPTURE 28): one entry per distinct model message, never per content-block line or per tool call.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rolloutLines } from './codex.js';
import { captureSession, isObj, type Obj } from './extract.js';
import { makeRedactor } from './redact.js';
import { CAPTURE_VERSION, type MessageUsage } from './schema.js';
import { deposit, loadStore, paths } from './store.js';
import { addProject, cleanup, NOW, stage } from './test-support.js';

const redact = makeRedactor();
const line = (value: object): string => JSON.stringify(value);
const capture = (lines: readonly string[]) => {
  const text = lines.join('\n');
  return captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: text.length, redact });
};

const parseObject = (text: string): Obj => {
  const value: unknown = JSON.parse(text);
  return isObj(value) ? value : {};
};

const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40, output_tokens_details: { thinking_tokens: 5 } };
/** One assistant line of a message: the harness writes a message as one line per content block and repeats `usage` on each. */
const block = (n: number, messageId: string, content: object, usage: object = USAGE): string =>
  line({ type: 'assistant', uuid: `a${String(n)}`, requestId: `req-${messageId}`, timestamp: `2026-06-01T00:00:0${String(n)}.000Z`, message: { id: messageId, role: 'assistant', model: 'm', content: [content], usage } });
const call = (id: string): object => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `/w/${id}.ts` } });
const user = line({ type: 'user', uuid: 'u0', timestamp: '2026-06-01T00:00:00.000Z', message: { role: 'user', content: 'go' } });

/** The sum of every counted category over a session's message entries. */
const sum = (entries: readonly MessageUsage[] | undefined): { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number } => {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0 };
  for (const entry of entries ?? []) {
    total.input += entry.input ?? 0;
    total.output += entry.output ?? 0;
    total.cacheRead += entry.cacheRead ?? 0;
    total.cacheWrite += entry.cacheWrite ?? 0;
    total.thinking += entry.thinking ?? 0;
  }
  return total;
};

describe('messageUsage on a Claude Code session', () => {
  it('records one entry for a message spread over three content-block lines, tied to its two tool calls', () => {
    const { session } = capture([
      user,
      block(1, 'msg_1', { type: 'thinking', thinking: 'hmm' }),
      block(2, 'msg_1', call('t1')),
      block(3, 'msg_1', call('t2')),
    ]);
    expect(session.messageUsage).toEqual([{ id: 'msg_1', calls: ['t1', 't2'], input: 10, cacheWrite: 40, cacheRead: 30, output: 20, thinking: 5 }]);
    // The line total would count the message three times; the existing session total already counts it once, and the entries agree with it.
    expect(sum(session.messageUsage)).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, thinking: 5 });
    expect(session.usage).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, thinking: 5 });
  });

  it('sums distinct messages, not lines, and does not split a message across its calls', () => {
    const second = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
    const { session } = capture([
      user,
      block(1, 'msg_1', call('t1')),
      block(2, 'msg_1', call('t2')),
      block(3, 'msg_1', call('t3')),
      block(4, 'msg_2', { type: 'text', text: 'done' }, second),
    ]);
    expect(session.messageUsage).toHaveLength(2);
    expect(session.messageUsage?.[0]?.calls).toEqual(['t1', 't2', 't3']);
    expect(session.messageUsage?.[0]).toMatchObject({ output: 20 });
    // msg_2 made no call and did not report thinking: the category is absent, not a zero.
    expect(session.messageUsage?.[1]).toEqual({ id: 'msg_2', calls: [], input: 1, cacheWrite: 4, cacheRead: 3, output: 2 });
    expect(sum(session.messageUsage).output).toBe(22);
    const lineSum = 3 * 20 + 2;
    expect(sum(session.messageUsage).output).not.toBe(lineSum);
  });

  it('counts a replayed message once and ties a call to the message that first made it', () => {
    const { session } = capture([user, block(1, 'msg_1', call('t1')), block(2, 'msg_1', call('t1'))]);
    expect(session.messageUsage).toEqual([{ id: 'msg_1', calls: ['t1'], input: 10, cacheWrite: 40, cacheRead: 30, output: 20, thinking: 5 }]);
  });

  it('keys a line with no message id by its request id, and a line with neither as its own message with a null id', () => {
    const bare = (n: number, requestId?: string): string =>
      line({ type: 'assistant', uuid: `b${String(n)}`, ...(requestId === undefined ? {} : { requestId }), timestamp: '2026-06-01T00:00:01.000Z', message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } } });
    const { session } = capture([user, bare(1, 'r1'), bare(2, 'r1'), bare(3), bare(4)]);
    expect(session.messageUsage?.map((entry) => entry.id)).toEqual(['r1', null, null]);
  });

  it('records nothing for a session without usage data, and no zero for a category the source left out', () => {
    const plain = line({ type: 'assistant', uuid: 'p', timestamp: '2026-06-01T00:00:01.000Z', message: { id: 'msg_p', role: 'assistant', content: [{ type: 'text', text: 'x' }] } });
    expect('messageUsage' in capture([user, plain]).session).toBe(false);
    const partial = block(1, 'msg_q', { type: 'text', text: 'x' }, { output_tokens: 7 });
    expect(capture([user, partial]).session.messageUsage).toEqual([{ id: 'msg_q', calls: [], output: 7 }]);
  });

  it('marks a sidechain message of a main transcript, which the session total leaves out', () => {
    const side = line({ type: 'assistant', isSidechain: true, uuid: 's1', timestamp: '2026-06-01T00:00:02.000Z', message: { id: 'msg_s', role: 'assistant', model: 'm', content: [call('ts')], usage: { input_tokens: 2, output_tokens: 3 } } });
    const { session } = capture([user, block(1, 'msg_1', { type: 'text', text: 'x' }), side]);
    expect(session.messageUsage?.[1]).toEqual({ id: 'msg_s', calls: ['ts'], side: true, input: 2, output: 3 });
    expect(session.usage.output).toBe(20);
  });
});

describe('messageUsage is built for Claude Code and Codex only', () => {
  const asHarness = (harness: 'cursor' | 'copilot') => {
    const text = [user, block(1, 'msg_1', call('t1'))].join('\n');
    return captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: text.length, redact, harness });
  };

  it('records nothing for a Cursor-shaped capture', () => {
    expect(asHarness('cursor').session).not.toHaveProperty('messageUsage');
  });

  it('records nothing for a Copilot-shaped capture, whose totals are not per message', () => {
    expect(asHarness('copilot').session).not.toHaveProperty('messageUsage');
  });

  it('records nothing for a synthetic line: the harness speaking is not a model message', () => {
    const synthetic = line({ type: 'assistant', uuid: 'a1', timestamp: '2026-06-01T00:00:01.000Z', message: { id: 'msg_x', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 0, output_tokens: 0 } } });
    expect(capture([user, synthetic]).session).not.toHaveProperty('messageUsage');
  });
});

describe('messageUsage across a deposit, subagent transcripts included', () => {
  let appData: string;
  beforeEach(() => {
    // The store follows APPDATA; point it at a temp folder so nothing here can reach the operator's own store.
    appData = mkdtempSync(join(tmpdir(), 'oars-message-usage-appdata-'));
    vi.stubEnv('APPDATA', appData);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(appData, { recursive: true, force: true });
    cleanup();
  });

  it('reads the subagent file too, and the recorded total is the distinct-message sum, not the line sum', async () => {
    const staged = stage('proj');
    // Confirm the store path before anything runs: it is in the temp folder the harness made, not under APPDATA or the home folder.
    expect(staged.storeDir.startsWith(staged.root)).toBe(true);
    expect(process.env.APPDATA).toBe(appData);
    expect(staged.storeDir.startsWith(appData)).toBe(false);

    addProject(staged, 'proj', 'usage-main', [user, block(1, 'msg_1', { type: 'thinking', thinking: 'hmm' }), block(2, 'msg_1', call('t1')), block(3, 'msg_1', call('t2'))]);
    const subagents = join(staged.projectsRoot, 'proj', 'usage-main', 'subagents');
    mkdirSync(subagents, { recursive: true });
    const second = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
    writeFileSync(join(subagents, 'agent-x.jsonl'), `${[user, block(1, 'msg_a', call('ta1'), second), block(2, 'msg_a', call('ta2'), second)].join('\n')}\n`);
    writeFileSync(join(subagents, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 't1' }));

    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const store = await loadStore(staged.storeDir);
    const main = store.sessions.find((entry) => entry.session === 'usage-main');
    const sub = store.subagents.find((entry) => entry.session === 'usage-main~agent-x');
    expect(main?.messageUsage).toHaveLength(1);
    expect(sub?.messageUsage).toEqual([{ id: 'msg_a', calls: ['ta1', 'ta2'], input: 1, cacheWrite: 4, cacheRead: 3, output: 2 }]);
    const total = sum([...(main?.messageUsage ?? []), ...(sub?.messageUsage ?? [])]);
    expect(total.output).toBe(22);
    expect(total.output).not.toBe(3 * 20 + 2 * 2);
  });
});

// Codex: the same entries, read from the lines `rolloutLines` writes. The source is `token_count`, the event already read for usage, which also holds `rate_limits`.
describe('messageUsage on a Codex session', () => {
  const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
  const entry = (second: number, type: string, payload: object): object => ({ timestamp: T(second), type, payload });
  const limits = { primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1790000000 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1790500000 }, plan_type: 'plus' };
  const count = (second: number, input: number, cached: number, output: number, reasoning: number, total: number, rateLimits?: object): object =>
    entry(second, 'event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total },
        last_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 10, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total },
      },
      ...(rateLimits === undefined ? {} : { rate_limits: rateLimits }),
    });
  const codexCapture = (entries: readonly object[]) => {
    const text = rolloutLines(entries.map((value) => JSON.stringify(value)).join('\n'), 'sess').map((value) => JSON.stringify(value)).join('\n');
    return captureSession({ text, harness: 'codex', session: 'codex-x', project: 'p', rev: 1, at: 'x', bytes: text.length, redact });
  };
  const head = [
    entry(0, 'session_meta', { id: 'sess-1', session_id: 'sess-1', timestamp: T(0), cwd: '/work/app', originator: 'codex_cli_rs', cli_version: '0.50.0' }),
    entry(1, 'turn_context', { model: 'gpt-5-codex', cwd: '/work/app' }),
    entry(2, 'event_msg', { type: 'user_message', message: 'go' }),
  ];
  const say = (second: number, message: string): object => entry(second, 'event_msg', { type: 'agent_message', message });

  it('records a response with rate limits, one without, and a repeated event once', () => {
    const { session } = codexCapture([
      ...head,
      say(3, 'one'),
      count(4, 1000, 400, 200, 50, 1200, limits),
      count(5, 1000, 400, 200, 50, 1200, { ...limits, primary: { used_percent: 99 } }),
      say(6, 'two'),
      count(7, 500, 100, 80, 0, 600),
    ]);
    expect(session.messageUsage).toEqual([
      { id: 'sess-1-resp1', calls: [], input: 590, cacheWrite: 10, cacheRead: 400, output: 200, thinking: 50, plan: { primary: { usedPercent: 12.5, windowMinutes: 300 }, secondary: { usedPercent: 40, windowMinutes: 10080 } } },
      { id: 'sess-1-resp2', calls: [], input: 390, cacheWrite: 10, cacheRead: 100, output: 80, thinking: 0 },
    ]);
    // The second response had no rate-limit block: the field is absent, not zero.
    expect(session.messageUsage?.[1]).not.toHaveProperty('plan');
    expect(session.usage.output).toBe(280);
  });

  it('writes no cache category the event did not report, and its absence stays out of usageObserved', () => {
    const older = entry(4, 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, total_token_usage: { total_tokens: 120 } } });
    const { session } = codexCapture([...head, say(3, 'one'), older]);
    expect(session.messageUsage).toEqual([{ id: 'sess-1-resp1', calls: [], input: 100, output: 20 }]);
    expect(session.messageUsage?.[0]).not.toHaveProperty('cacheRead');
    expect(session.messageUsage?.[0]).not.toHaveProperty('cacheWrite');
  });

  it('records one entry for a response with two tool calls, with the response whole counts and both call ids in order', () => {
    const fn = (second: number, id: string): object => entry(second, 'response_item', { type: 'function_call', call_id: id, name: 'shell', arguments: JSON.stringify({ command: ['ls'] }) });
    const { session } = codexCapture([...head, say(3, 'one'), fn(4, 'call_a'), fn(5, 'call_b'), count(6, 1000, 400, 200, 50, 1200, limits)]);
    expect(session.messageUsage).toHaveLength(1);
    expect(session.messageUsage?.[0]).toMatchObject({ id: 'sess-1-resp1', calls: ['call_a', 'call_b'], input: 590, cacheRead: 400, cacheWrite: 10, output: 200, thinking: 50 });
  });

  it('keeps a window that reports only a percent, and one window alone', () => {
    const { session } = codexCapture([...head, say(3, 'one'), count(4, 10, 0, 5, 0, 15, { secondary: { used_percent: 3 }, primary: { window_minutes: 300 } })]);
    expect(session.messageUsage?.[0]?.plan).toEqual({ secondary: { usedPercent: 3 } });
  });

  it('writes no plan for an empty or non-numeric rate-limit block', () => {
    const { session } = codexCapture([...head, say(3, 'one'), count(4, 10, 0, 5, 0, 15, { primary: { used_percent: 'high' }, secondary: null })]);
    expect(session.messageUsage?.[0]).not.toHaveProperty('plan');
  });

  it('records nothing for a session whose events hold no usage', () => {
    const { session } = codexCapture([...head, say(3, 'one'), entry(4, 'event_msg', { type: 'token_count', info: null, rate_limits: limits })]);
    expect(session).not.toHaveProperty('messageUsage');
  });
});

describe('messageUsage on the version path', () => {
  let appData: string;
  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'oars-message-usage-appdata-'));
    vi.stubEnv('APPDATA', appData);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(appData, { recursive: true, force: true });
    cleanup();
  });

  it('is a capture-version bump: a version-27 store gains the field only when the next deposit captures its transcripts again', async () => {
    expect(Number(CAPTURE_VERSION)).toBeGreaterThanOrEqual(28);
    const staged = stage('proj');
    expect(staged.storeDir.startsWith(staged.root)).toBe(true);
    expect(staged.storeDir.startsWith(appData)).toBe(false);
    addProject(staged, 'proj', 'usage-main', [user, block(1, 'msg_1', call('t1'))]);
    const options = { allow: ['proj'], redactDomains: [], now: () => NOW };
    await deposit(staged.runtime, options);
    expect((await loadStore(staged.storeDir)).sessions.find((entry) => entry.session === 'usage-main')?.messageUsage).toHaveLength(1);

    // Make the store what version 27 wrote: no field on the record, the old stamp on the record and in the state.
    const file = paths(staged.storeDir).observations;
    const old = readFileSync(file, 'utf8').split('\n').filter((entry) => entry !== '').map((entry) => {
      const record = parseObject(entry);
      Reflect.deleteProperty(record, 'messageUsage');
      record.cv = '27';
      return `${JSON.stringify(record)}\n`;
    });
    writeFileSync(file, old.join(''));
    const state = parseObject(readFileSync(paths(staged.storeDir).state, 'utf8'));
    const files: unknown = state.files;
    if (typeof files !== 'object' || files === null) throw new Error('the state holds no files');
    for (const held of Object.values(files)) Reflect.set(Object(held), 'v', '27');
    writeFileSync(paths(staged.storeDir).state, JSON.stringify(state));
    const before = (await loadStore(staged.storeDir)).sessions.find((entry) => entry.session === 'usage-main');
    expect(before).toMatchObject({ cv: '27' });
    expect(before).not.toHaveProperty('messageUsage');

    const again = await deposit(staged.runtime, options);
    expect(again.sessions).toBeGreaterThan(0);
    const after = (await loadStore(staged.storeDir)).sessions.find((entry) => entry.session === 'usage-main');
    expect(after).toMatchObject({ cv: CAPTURE_VERSION, messageUsage: [{ id: 'msg_1', calls: ['t1'], input: 10, output: 20 }] });
  });

  it('re-extraction of a session with no usage data still records nothing', async () => {
    const staged = stage('proj');
    expect(staged.storeDir.startsWith(staged.root)).toBe(true);
    expect(staged.storeDir.startsWith(appData)).toBe(false);
    const plain = line({ type: 'assistant', uuid: 'p', timestamp: '2026-06-01T00:00:01.000Z', message: { id: 'msg_p', role: 'assistant', content: [{ type: 'text', text: 'x' }] } });
    addProject(staged, 'proj', 'usage-none', [user, plain]);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    expect((await loadStore(staged.storeDir)).sessions.find((entry) => entry.session === 'usage-none')).not.toHaveProperty('messageUsage');
  });
});
