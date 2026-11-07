import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { books, measure, recall } from './query.js';
import { deposit, loadStore, paths, readSkeletons } from './store.js';
import { verifyAll, verifyCaptured } from './verify.js';
import { cleanup, NOW, otlpRequest, otlpSpan, stage, stageOtel } from './test-support.js';

afterEach(cleanup);

// A trace deposited before its conversation id arrives (the id sits on the root agent span, which a batch exporter writes last) is a session of its own until the id
// shows up. These tests hold the rule that, once it does, the early session is superseded by the merged one and every read counts each prompt and call once.

const T = 'a'.repeat(32);
const U = 'b'.repeat(32);
const CONVERSATION = 'support-thread-1';
const sp = (n: number): string => n.toString(16).padStart(16, '0');
const user = (text: string): object[] => [{ role: 'user', parts: [{ type: 'text', content: text }] }];

/** T's model call and failing tool call as an exporter writes them before the root span ends: the parent (`sp(1)`) is not in the file yet, and no span names a conversation. */
const earlyPart = (): object[] => [
  otlpSpan({ trace: T, id: sp(2), parent: sp(1), name: 'chat gpt-5.1', start: 1, end: 3, attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-5.1', 'gen_ai.input.messages': user('where is my order?') } }),
  otlpSpan({
    trace: T,
    id: sp(3),
    parent: sp(1),
    name: 'execute_tool lookup_order',
    start: 3,
    end: 4,
    attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup_order', 'gen_ai.tool.call.id': 'c1', 'error.type': 'timeout' },
    code: 2,
    message: 'order service unavailable',
  }),
];

const agent = (trace: string, text: string, start: number): object =>
  otlpSpan({ trace, id: sp(1), name: 'invoke_agent support', start, end: start + 10, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.conversation.id': CONVERSATION, 'gen_ai.input.messages': user(text) } });

/** The file that brings the id: T's root agent span, and a whole second trace U of the same conversation. */
const latePart = (): object[] => [
  agent(T, 'where is my order?', 0),
  agent(U, 'cancel my order', 20),
  otlpSpan({ trace: U, id: sp(2), parent: sp(1), name: 'chat gpt-5.1', start: 21, end: 23, attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-5.1' } }),
  otlpSpan({
    trace: U,
    id: sp(3),
    parent: sp(1),
    name: 'execute_tool lookup_order',
    start: 23,
    end: 24,
    attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'lookup_order', 'gen_ai.tool.call.id': 'c2', 'error.type': 'timeout' },
    code: 2,
    message: 'order service unavailable',
  }),
];

const early = { name: 'early.jsonl', lines: [otlpRequest(earlyPart())] };
const late = { name: 'late.jsonl', lines: [otlpRequest(latePart())] };
const options = { allow: ['otel'], redactDomains: [], now: () => NOW };

const setup = (files: readonly { name: string; lines: readonly object[] }[]) => {
  const s = stage();
  const dir = stageOtel(s.root, files);
  return { ...s, dir, runtime: { ...s.runtime, sourceRoots: { otel: dir } } };
};

/** What each reader counts: the store, `books`, `measure`, `recall`, and `verify`. */
const counted = async (storeDir: string) => {
  const store = await loadStore(storeDir);
  const { skeletons } = await readSkeletons(storeDir);
  return {
    sessions: store.sessions.map((session) => session.session).sort(),
    prompts: store.prompts.length,
    tools: store.tools.length,
    booksPrompts: books(store, 'harness', NOW).reduce((total, row) => total + row.prompts, 0),
    measureSessions: measure(store, [], [], 5).last.sessions,
    recallSessions: recall(store, { error: 'order service unavailable' }, NOW).matches.map((match) => match.sessions),
    skeletons: skeletons.length,
    violations: [...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((result) => result.violations > 0),
  };
};

/** The merge of both files read at once: nothing was ever deposited early, so this is the count the early deposit must come to. */
const single = async () => {
  const s = setup([early, late]);
  await deposit(s.runtime, options);
  return counted(s.storeDir);
};

describe('a trace deposited before its conversation id arrives', () => {
  it('is superseded by the merged session once the id arrives: each prompt and call is counted once by every read', async () => {
    const s = setup([early]);
    await deposit(s.runtime, options);
    expect((await counted(s.storeDir)).prompts).toBe(1);
    writeFileSync(join(s.dir, late.name), `${late.lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    await deposit(s.runtime, options);

    const merged = await single();
    expect(merged.prompts).toBe(2);
    expect(merged.tools).toBe(2);
    const after = await counted(s.storeDir);
    expect(after.sessions).toHaveLength(1);
    expect(after.sessions).toEqual(merged.sessions);
    expect(after.prompts).toBe(merged.prompts);
    expect(after.tools).toBe(merged.tools);
    expect(after.booksPrompts).toBe(merged.booksPrompts);
    expect(after.measureSessions).toBe(merged.measureSessions);
    expect(after.recallSessions).toEqual(merged.recallSessions);
    expect(after.skeletons).toBe(merged.skeletons);
    expect(after.violations).toEqual([]);
  });
});
