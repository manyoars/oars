import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runHook } from './hooks.js';
import { books, formatMeasure, measure, recall } from './query.js';
import { harnessOf } from './schema.js';
import { deposit, loadStore, paths, readSkeletons } from './store.js';
import { verifyAll, verifyCaptured } from './verify.js';
import { cleanup, NOW, otlpRequest, otlpSpan, stage, stageOtel, type OtlpSpanInput } from './test-support.js';

afterEach(cleanup);

// Fixtures follow the GenAI semantic conventions (open-telemetry/semantic-conventions-genai @ e6658f1) and the OTLP JSON encoding (see otel.test.ts); no real trace was
// read. Every folder below is under the test's own temp folder (`stageOtel` puts it under `root`, and the runtime's `sourceRoots` names it), so the real config folder
// is never touched.

const T1 = 'a'.repeat(32);
const T2 = 'b'.repeat(32);
const T3 = 'c'.repeat(32);
const sp = (n: number): string => n.toString(16).padStart(16, '0');

const span = (input: OtlpSpanInput): object => otlpSpan(input);
const user = (text: string): object[] => [{ role: 'user', parts: [{ type: 'text', content: text }] }];
// One agent run: a model call, then a lookup that fails (status ERROR, `error.type`, and a status message).
const trace = (id: string, text: string): object[] => [
  span({ trace: id, id: sp(1), name: 'invoke_agent support', start: 0, end: 10, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'support', 'gen_ai.input.messages': user(text) } }),
  span({ trace: id, id: sp(2), parent: sp(1), name: 'chat gpt-5.1', start: 1, end: 3, attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-5.1', 'gen_ai.usage.input_tokens': 20, 'gen_ai.usage.output_tokens': 5 } }),
  span({
    trace: id,
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
const file = (name: string, spans: readonly object[]) => ({ name, lines: [otlpRequest(spans)] });

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

const staged = () => {
  const s = stage();
  const dir = stageOtel(s.root, [file('one.jsonl', trace(T1, 'where is my order?')), file('two.jsonl', trace(T2, 'cancel my order'))]);
  expect(dir.startsWith(s.root)).toBe(true);
  return { ...s, dir, runtime: { ...s.runtime, sourceRoots: { otel: dir } } };
};

const trackedKeys = (storeDir: string): string[] => {
  const state: unknown = JSON.parse(readFileSync(paths(storeDir).state, 'utf8'));
  const files = typeof state === 'object' && state !== null && 'files' in state ? state.files : {};
  return typeof files === 'object' && files !== null ? Object.keys(files).sort() : [];
};

describe('depositing the OpenTelemetry GenAI source', () => {
  it('captures each trace as an otel-harness session, with its own cursor, and a second deposit adds nothing', async () => {
    const s = staged();
    const first = await deposit(s.runtime, options(['otel']));
    expect(first).toMatchObject({ sessions: 2, unchanged: 0, missing: [] });
    expect(first.sources.otel?.read).toBe(2);
    const store = await loadStore(s.storeDir);
    expect(store.sessions.map((entry) => [entry.session, harnessOf(entry)]).sort()).toEqual([
      [`otel-${T1}`, 'otel'],
      [`otel-${T2}`, 'otel'],
    ]);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    const second = await deposit(s.runtime, options(['otel']));
    expect(second).toMatchObject({ sessions: 0, unchanged: 2 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    expect(trackedKeys(s.storeDir)).toEqual([`otel/${T1}`, `otel/${T2}`]);
  });

  it('reads the failed tool call as an error and frames the session as OpenTelemetry', async () => {
    const s = staged();
    await deposit(s.runtime, options(['otel']));
    const store = await loadStore(s.storeDir);
    const calls = store.tools.filter((tool) => tool.session === `otel-${T1}`);
    expect(calls.map((tool) => [tool.tool, tool.status])).toEqual([['lookup_order', 'error']]);
    const found = store.sessions.find((candidate) => candidate.session === `otel-${T1}`);
    expect(found).toMatchObject({ harness: 'otel' });
    expect(found?.frame).toMatchObject({ harness: 'otel' });
  });

  it('is read by default and not when denied, and an allowed name reports nothing missing while a typo does', async () => {
    const s = staged();
    expect((await deposit(s.runtime, options([]))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['!otel']))).sources['otel']).toBeUndefined();
    expect((await deposit(s.runtime, options(['otel']))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['otl']))).missing).toEqual(['otl']);
  });

  it('does not read a discovered trace folder that is not allowed: another allowed source reads, otel stays unread and untracked', async () => {
    const s = staged();
    const project = join(s.projectsRoot, 'mine');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: 'hello' } })}\n`);
    const result = await deposit(s.runtime, options(['mine']));
    expect(result.sources.otel).toBeUndefined();
    expect(trackedKeys(s.storeDir)).toEqual(['mine/one.jsonl']);
  });

  it('changes nothing in the trace folder: a deposit only reads', async () => {
    const s = staged();
    const before = readFileSync(join(s.dir, 'two.jsonl'), 'utf8');
    await deposit(s.runtime, options(['otel']));
    expect(readFileSync(join(s.dir, 'two.jsonl'), 'utf8')).toBe(before);
  });

  it('holds every verify invariant, including --strict, for a normal trace, one with no usage, and one with no tool call', async () => {
    const s = staged();
    stageOtel(s.root, [
      file('three.jsonl', [
        span({ trace: T3, id: sp(1), name: 'invoke_agent support', start: 0, end: 5, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.input.messages': user('hi') } }),
        span({ trace: T3, id: sp(2), parent: sp(1), name: 'chat m', start: 1, end: 2, attrs: { 'gen_ai.operation.name': 'chat' } }),
      ]),
    ]);
    await deposit(s.runtime, options(['otel']));
    const { skeletons } = await readSkeletons(s.storeDir);
    expect(skeletons).toHaveLength(3);
    const store = await loadStore(s.storeDir);
    expect([...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((result) => result.violations > 0)).toEqual([]);
  });

  it('skips silently when the runtime names no trace folder or the folder does not exist', async () => {
    const s = staged();
    expect(await deposit({ ...s.runtime, sourceRoots: {} }, options(['otel']))).toMatchObject({ sessions: 0 });
    expect(await deposit({ ...s.runtime, sourceRoots: { otel: join(s.root, 'nowhere') } }, options(['otel']))).toMatchObject({ sessions: 0 });
  });

  it('fails open on a corrupt file: it is named once, and the good files and the Claude Code folder still deposit', async () => {
    const s = staged();
    const project = join(s.projectsRoot, 'mine');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: 'hello' } })}\n`);
    stageOtel(s.root, [{ name: 'broken.jsonl', lines: '{torn\nnot json\n' }]);
    const result = await deposit(s.runtime, options(['mine', 'otel']));
    expect(trackedKeys(s.storeDir)).toEqual(expect.arrayContaining(['mine/one.jsonl', `otel/${T1}`, `otel/${T2}`]));
    expect((result.sources.otel?.unreadable ?? []).filter((entry) => entry.includes('broken.jsonl'))).toHaveLength(1);
    expect(result.sessions).toBe(3);
  });

  it('leaves a corrupt file out of the cursor, so a second deposit adds nothing and tracks only the good traces', async () => {
    const s = staged();
    stageOtel(s.root, [{ name: 'broken.jsonl', lines: '{torn\nnot json\n' }]);
    await deposit(s.runtime, options(['otel']));
    const again = await deposit(s.runtime, options(['otel']));
    expect(again).toMatchObject({ sessions: 0, unchanged: 2 });
    expect(trackedKeys(s.storeDir)).toEqual([`otel/${T1}`, `otel/${T2}`]);
  });

  it('lets the nightly run repeat a saved allow, so it reads the trace folder with no flag', async () => {
    const s = staged();
    await deposit(s.runtime, options(['otel']));
    stageOtel(s.root, [file('three.jsonl', trace(T3, 'refund please'))]);
    await runHook('nightly', '', s.runtime, () => NOW);
    expect(trackedKeys(s.storeDir)).toContain(`otel/${T3}`);
  });

  it('reads a trace again when spans are appended to its file, as a long run exports more', async () => {
    const s = staged();
    await deposit(s.runtime, options(['otel']));
    const more = otlpRequest([span({ trace: T2, id: sp(9), parent: sp(1), name: 'chat gpt-5.1', start: 5, end: 6, attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-5.1' } })]);
    writeFileSync(join(s.dir, 'two.jsonl'), `${readFileSync(join(s.dir, 'two.jsonl'), 'utf8')}${JSON.stringify(more)}\n`);
    expect(await deposit(s.runtime, options(['otel']))).toMatchObject({ sessions: 1, unchanged: 1 });
  });
});

describe('recall, books, and measure over OpenTelemetry skeletons', () => {
  it('measure counts OpenTelemetry sessions in its window as "of which OpenTelemetry GenAI"', async () => {
    const s = staged();
    await deposit(s.runtime, options(['otel']));
    const signal = measure(await loadStore(s.storeDir), [], [], 5);
    expect(signal.last.sessions).toBe(2);
    expect(signal.last.otherSessions).toMatchObject({ otel: 2 });
    expect(formatMeasure(signal)).toMatch(/of which OpenTelemetry GenAI\s+2\s/);
  });

  it('books --by harness separates otel from claude-code', async () => {
    const s = staged();
    await deposit(s.runtime, options(['otel']));
    const store = await loadStore(s.storeDir);
    const rows = books(store, 'harness', NOW);
    expect(rows.find((row) => row.key === 'otel')?.prompts).toBe(2);
    expect(rows.reduce((total, row) => total + row.prompts, 0)).toBe(store.prompts.length);
  });

  it('recall finds the session by the failed call error line', async () => {
    const s = staged();
    await deposit(s.runtime, options(['otel']));
    const found = recall(await loadStore(s.storeDir), { error: 'order service unavailable' }, NOW);
    expect(found.matches.map((match) => [match.tool, match.sessions])).toEqual([['lookup_order', 2]]);
  });
});
