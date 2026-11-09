// Gemini and OTel readers drop a file before it is a session: Gemini a chat that "holds nothing", OTel a file with no span the reader finds. A file dropped while holding records
// in a shape the reader does not know (a renamed message type, a renamed key) is counted by `sessions verify` as seen and unreadable; a file that is routinely
// dropped (a launch and quit, the CLI's own context turn, an `info` message, an export with an empty span list) stays out. Selection is untouched: nothing deposited moves.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsVerify } from './command.js';
import { deposit } from './store.js';
import { cleanup, geminiHead, NOW, otlpRequest, otlpSpan, stage, stageGemini, stageOtel } from './test-support.js';

afterEach(cleanup);

const A = 'aaaa1111-1111-4111-8111-111111111111';
const B = 'bbbb2222-2222-4222-8222-222222222222';
const C = 'cccc3333-3333-4333-8333-333333333333';
const D = 'dddd4444-4444-4444-8444-444444444444';
const E = 'eeee5555-5555-4555-8555-555555555555';
const F = 'ffff6666-6666-4666-8666-666666666666';
const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const WORK = '/work/app';

const geminiFiles = (withDropped: boolean) => [
  {
    id: A,
    projectRoot: WORK,
    lines: [geminiHead(A), { id: 'u1', timestamp: T(1), type: 'user', content: [{ text: 'fix the build' }] }, { id: 'g2', timestamp: T(2), type: 'gemini', content: 'done', model: 'gemini-2.5-pro' }],
  },
  ...(withDropped
    ? [
        // The message type was renamed.
        { id: B, slug: 'renamed-type', projectRoot: WORK, lines: [geminiHead(B), { id: 'u1', timestamp: T(1), type: 'human', content: [{ text: 'fix the build' }] }] },
        // `content` was renamed to `parts`.
        { id: C, slug: 'renamed-key', projectRoot: WORK, lines: [geminiHead(C), { id: 'u1', timestamp: T(1), type: 'user', parts: [{ text: 'fix the build' }] }] },
        // Routine: a launch and quit, the CLI's own context turn, and an `info` message.
        { id: D, slug: 'quit', projectRoot: WORK, lines: [geminiHead(D)] },
        { id: E, slug: 'context', projectRoot: WORK, lines: [geminiHead(E), { id: 'u1', timestamp: T(1), type: 'user', content: [{ text: '<session_context>cwd</session_context>' }] }] },
        { id: F, slug: 'info', projectRoot: WORK, lines: [geminiHead(F), { id: 'i1', timestamp: T(1), type: 'info', content: 'Switched model' }] },
      ]
    : []),
];

const span = (trace: string, attrs: { [key: string]: unknown }): object => otlpSpan({ trace, id: '0000000000000001', name: 'invoke_agent support', start: 0, end: 10, attrs });
const otelFiles = (withDropped: boolean) => [
  {
    name: 'good.jsonl',
    lines: [otlpRequest([span('a'.repeat(32), { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'support', 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'fix the build' }] }] })])],
  },
  ...(withDropped
    ? [
        // The export's top key was renamed, so no span is found: dropped before it is a session.
        { name: 'renamed-top.jsonl', lines: [{ resource_spans: [{ scope_spans: [{ spans: [{ traceId: 'b'.repeat(32), spanId: '0000000000000001', name: 'invoke_agent support' }] }] }] }] },
        // A span whose ids were renamed (`trace_id`, `span_id`): no span is found either.
        { name: 'renamed-ids.jsonl', lines: [{ resourceSpans: [{ scopeSpans: [{ spans: [{ trace_id: 'c'.repeat(32), span_id: '0000000000000001', name: 'invoke_agent support' }] }] }] }] },
        // Routine: an export with nothing traced, and an empty file.
        { name: 'empty-list.jsonl', lines: [{ resourceSpans: [] }] },
        { name: 'blank.jsonl', lines: '' },
      ]
    : []),
];

const filesOf = (dir: string, base = dir): { [path: string]: string } => {
  const found: { [path: string]: string } = {};
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) Object.assign(found, filesOf(path, base));
    else found[relative(base, path).replaceAll('\\', '/')] = readFileSync(path, 'utf8');
  }
  return found;
};

const verifyCounts = async (staged: ReturnType<typeof stage>, roots: { [name: string]: string }) => {
  const verified = await sessionsVerify({ sessions: { ...staged.runtime, sourceRoots: roots }, install: undefined, now: () => NOW }, { session: undefined });
  return verified.report.harnessFiles;
};

describe('sessionsVerify, a file the Gemini or OTel reader drops while it holds records in a shape it does not know', () => {
  it('Gemini: a renamed message type and a renamed content key are seen and unreadable; a launch and quit, a context turn, and an info message stay out', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const gemini = stageGemini(staged.root, geminiFiles(true));
    expect((await verifyCounts(staged, { gemini })).gemini).toEqual({ seen: 3, yielded: 1, unreadable: 2 });
  });

  it('Gemini: a record with no id, a legacy file whose messages key was renamed, and a prompt whose text part was renamed are seen and unreadable; a legacy quit stays out', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const whole = (id: string, over: object): string => JSON.stringify({ ...geminiHead(id), ...over });
    const gemini = stageGemini(staged.root, [
      { id: A, projectRoot: WORK, lines: [geminiHead(A), { id: 'u1', timestamp: T(1), type: 'user', content: [{ text: 'fix the build' }] }, { id: 'g2', timestamp: T(2), type: 'gemini', content: 'done', model: 'gemini-2.5-pro' }] },
      // A message record whose `id` was renamed.
      { id: B, slug: 'no-id', projectRoot: WORK, lines: [geminiHead(B), { key: 'u1', timestamp: T(1), type: 'user', content: [{ text: 'fix the build' }] }] },
      // A legacy whole-file chat whose `messages` list was renamed.
      { id: C, slug: 'legacy-renamed', projectRoot: WORK, legacy: true, lines: whole(C, { turns: [{ id: 'u1', type: 'user', content: [{ text: 'fix the build' }] }] }) },
      // A prompt whose parts no longer carry `text`.
      { id: D, slug: 'no-text', projectRoot: WORK, lines: [geminiHead(D), { id: 'u1', timestamp: T(1), type: 'user', content: [{ body: 'fix the build' }] }] },
      // Routine: a prompt of an image alone (`inlineData`, `fileData`) is a known part kind.
      { id: F, slug: 'image-only', projectRoot: WORK, lines: [geminiHead(F), { id: 'u1', timestamp: T(1), type: 'user', content: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }, { fileData: { fileUri: 'gs://x/y.png' } }] }] },
      // Routine: a legacy chat with an empty messages list.
      { id: E, slug: 'legacy-quit', projectRoot: WORK, legacy: true, lines: whole(E, { messages: [] }) },
    ]);
    expect((await verifyCounts(staged, { gemini })).gemini).toEqual({ seen: 4, yielded: 1, unreadable: 3 });
  });

  it('OTel: a file whose top key or span ids were renamed is seen and unreadable; an empty span list and a blank file stay out', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const otel = stageOtel(staged.root, otelFiles(true));
    expect((await verifyCounts(staged, { otel })).otel).toEqual({ seen: 3, yielded: 1, unreadable: 2 });
  });

  it('OTel: ordinary HTTP spans and a metrics or logs export stay out; a renamed gen_ai attribute is seen and unreadable', async () => {
    const staged = stage();
    rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
    mkdirSync(staged.projectsRoot, { recursive: true });
    const http = (trace: string, attrs: { [key: string]: unknown }): object => otlpSpan({ trace, id: '0000000000000001', name: 'GET /health', start: 0, end: 10, attrs });
    const otel = stageOtel(staged.root, [
      ...otelFiles(false),
      // Routine: a trace of HTTP spans from the same exporter, with no GenAI attribute and no operation in a name.
      { name: 'http.jsonl', lines: [otlpRequest([http('d'.repeat(32), { 'http.request.method': 'GET', 'http.response.status_code': 200 })])] },
      // The attribute was renamed (`gen_ai.op`) and the name leads with no operation: a moved form.
      { name: 'renamed.jsonl', lines: [otlpRequest([http('e'.repeat(32), { 'gen_ai.op': 'chat' })])] },
      // The renamed attribute sits on a child span under an ordinary HTTP root: still a moved form, not an empty session.
      { name: 'renamed-child.jsonl', lines: [otlpRequest([http('f'.repeat(32), {}), otlpSpan({ trace: 'f'.repeat(32), id: '0000000000000002', parent: '0000000000000001', name: 'GET /health', start: 1, end: 9, attrs: { 'gen_ai.op': 'chat' } })])] },
      // Other signals in the same folder.
      { name: 'metrics.jsonl', lines: [{ resourceMetrics: [{ scopeMetrics: [{ metrics: [] }] }] }] },
      { name: 'logs.jsonl', lines: [{ resourceLogs: [{ scopeLogs: [{ logRecords: [] }] }] }] },
    ]);
    expect((await verifyCounts(staged, { otel })).otel).toEqual({ seen: 3, yielded: 1, unreadable: 2 });
  });

  it('deposits the same bytes with the dropped files present as without them', async () => {
    const deposited = async (withDropped: boolean): Promise<{ [path: string]: string }> => {
      const staged = stage();
      rmSync(join(staged.projectsRoot, 'proj'), { recursive: true });
      mkdirSync(staged.projectsRoot, { recursive: true });
      const roots = { gemini: stageGemini(staged.root, geminiFiles(withDropped)), otel: stageOtel(staged.root, otelFiles(withDropped)) };
      // The salt is random per store and every record carries its `sid`; the same one in both runs lets the bytes be compared.
      mkdirSync(staged.runtime.storeDir, { recursive: true });
      writeFileSync(join(staged.runtime.storeDir, 'salt'), 'fixed-salt-for-the-comparison');
      await deposit({ ...staged.runtime, sourceRoots: roots }, { allow: ['gemini', 'otel'], redactDomains: [], now: () => NOW });
      const stored = filesOf(staged.runtime.storeDir);
      // The temp folder differs between the two stagings; nothing else may.
      return Object.fromEntries(Object.entries(stored).map(([path, text]) => [path, text.split(staged.root).join('<root>').replaceAll('\\\\', '/').replace(/"mtimeMs":\d+/g, '"mtimeMs":0')]));
    };
    const without = await deposited(false);
    const withDropped = await deposited(true);
    expect(Object.keys(without).length).toBeGreaterThan(0);
    expect(withDropped).toEqual(without);
  });
});
