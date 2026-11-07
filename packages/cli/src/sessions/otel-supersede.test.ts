import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { books, measure, recall } from './query.js';
import { printOf, storedNames } from './pool-fixture.js';
import { sessionsOf, skeletonOf } from './pool-wire.js';
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

/** The session records in the log, in order. */
const sessionRecords = (storeDir: string): { session: string; rev: number; userTurns: number; supersededBy?: string }[] =>
  readFileSync(paths(storeDir).observations, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line))
    .flatMap((record) =>
      typeof record === 'object' && record !== null && 'kind' in record && record.kind === 'session' && 'session' in record && typeof record.session === 'string' && 'rev' in record && typeof record.rev === 'number' && 'userTurns' in record && typeof record.userTurns === 'number'
        ? [{ session: record.session, rev: record.rev, userTurns: record.userTurns, ...('supersededBy' in record && typeof record.supersededBy === 'string' ? { supersededBy: record.supersededBy } : {}) }]
        : [],
    );

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

  it('never reaches the deposit wire: the batches built from the store hold the merged session alone, with each prompt and call once', async () => {
    const s = setup([early]);
    await deposit(s.runtime, options);
    writeFileSync(join(s.dir, late.name), `${late.lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    await deposit(s.runtime, options);
    const roots = new Map((await readSkeletons(s.storeDir, undefined, true)).skeletons.map(({ session, merkleRoot, leaves }) => [session, { merkleRoot, leaves }]));
    const batches = sessionsOf(await loadStore(s.storeDir), roots).map((records) => skeletonOf(records, '0123456789abcdef', storedNames, printOf));
    expect(batches).toHaveLength(1);
    const transcripts = batches.flatMap((batch) => batch?.transcripts ?? []);
    expect(transcripts.flatMap((transcript) => transcript.prompts)).toHaveLength(2);
    expect(transcripts.flatMap((transcript) => transcript.tools)).toHaveLength(2);
  });

  it('records the supersede as a later rev of the early session, with no turns, rather than editing the early one', async () => {
    const s = setup([early]);
    await deposit(s.runtime, options);
    const first = sessionRecords(s.storeDir).find((record) => record.session === `otel-${T}`);
    writeFileSync(join(s.dir, late.name), `${late.lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    await deposit(s.runtime, options);
    const marked = sessionRecords(s.storeDir).filter((record) => record.supersededBy !== undefined);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.session).toBe(`otel-${T}`);
    expect(marked[0]?.userTurns).toBe(0);
    expect(marked[0]?.supersededBy).toMatch(/^otel-conv-/u);
    expect(marked[0]?.rev).toBeGreaterThan(first?.rev ?? Infinity);
  });

  it('records nothing for a trace that was never deposited alone', async () => {
    const s = setup([early, late]);
    await deposit(s.runtime, options);
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).not.toContain('supersededBy');
  });
});

describe('order and repetition', () => {
  it('comes to the same counts when the id-bearing file is read first', async () => {
    const merged = await single();
    const s = setup([{ ...late, name: 'a-late.jsonl' }]);
    await deposit(s.runtime, options);
    writeFileSync(join(s.dir, 'b-early.jsonl'), `${early.lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    await deposit(s.runtime, options);
    const after = await counted(s.storeDir);
    expect(after).toEqual(merged);
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).not.toContain('supersededBy');
  });

  it('adds nothing when the folder is deposited twice after the id arrives', async () => {
    const s = setup([early]);
    await deposit(s.runtime, options);
    writeFileSync(join(s.dir, late.name), `${late.lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    await deposit(s.runtime, options);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    const again = await deposit(s.runtime, options);
    expect(again).toMatchObject({ sessions: 0 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    expect(await counted(s.storeDir)).toEqual(await single());
  });
});
