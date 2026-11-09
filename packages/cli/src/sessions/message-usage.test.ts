// Token usage as an attribute of a message group (CAPTURE 28): one entry per distinct model message, never per content-block line or per tool call.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import type { MessageUsage } from './schema.js';
import { deposit, loadStore } from './store.js';
import { addProject, cleanup, NOW, stage } from './test-support.js';

const redact = makeRedactor();
const line = (value: object): string => JSON.stringify(value);
const capture = (lines: readonly string[]) => {
  const text = lines.join('\n');
  return captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: text.length, redact });
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
