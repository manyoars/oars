import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openOtelStore } from './otel.js';
import { deposit, loadStore } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

// `fixtures/otel-pydantic-ai/trace.jsonl` is a real trace: Pydantic AI 2.66.0 (instrumentation scope `pydantic-ai`, GenAI spans on, content included) ran a support-policy agent
// over three local policy files and two questions, once with a lookup that succeeds and once with one that raises. The model was a scripted OpenAI-compatible stub (no model was
// installed), so the spans are the framework's. OpenTelemetry SDK 1.45.2 wrote them, as `ExportTraceServiceRequest` JSON lines, one per span. Host paths, the service instance id,
// and the stub's port were replaced with fixed tokens. Each run has its own `gen_ai.conversation.id`, so the trace is two sessions.
// What the real spans carry that the reader drops or misreads is listed in docs/sessions-store.md (the otel section); the cases marked KNOWN GAP below pin today's output so a fix shows as a change here.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'otel-pydantic-ai');
const OK = 'conv-7d196b3aceec8f37';
const FAILED = 'conv-2ba9d21155a5762d';

const imported = async () => {
  const s = stage();
  const runtime = { ...s.runtime, sourceRoots: { otel: FIXTURE } };
  const result = await deposit(runtime, { allow: ['otel'], redactDomains: [], now: () => NOW });
  return { result, store: await loadStore(s.storeDir) };
};

describe('a real Pydantic AI trace deposited with --allow otel', () => {
  it('is two sessions, one per conversation id, framed as otel with the framework in the version slot', async () => {
    const { result, store } = await imported();
    expect(result).toMatchObject({ sessions: 2, badLines: 0, sources: { otel: { read: 2, unreadable: [], rejected: 0 } } });
    expect(store.sessions.map((entry) => entry.session).sort()).toEqual([`otel-${FAILED}`, `otel-${OK}`].sort());
    for (const entry of store.sessions) expect(entry).toMatchObject({ harness: 'otel', project: 'otel', versions: ['pydantic-ai'], models: { 'stub-support-1': expect.any(Number) }, tools: { lookup_policy: 1 } });
  });

  it('keeps the successful lookup as an ok call placed in the model call that named it, with the arguments read as a text key', async () => {
    const { store } = await imported();
    const calls = store.tools.filter((tool) => tool.session === `otel-${OK}`);
    expect(calls).toMatchObject([{ tool: 'lookup_policy', status: 'ok', toolUseId: 'call_refund', model: 'stub-support-1', keys: ['topic'], argClass: ['text'], harnessVersion: 'pydantic-ai' }]);
    expect(store.errors.filter((error) => error.session === `otel-${OK}`)).toEqual([]);
  });

  it('keeps the raising lookup as an error call whose error line is the exception event message', async () => {
    const { store } = await imported();
    expect(store.tools.filter((tool) => tool.session === `otel-${FAILED}`)).toMatchObject([{ tool: 'lookup_policy', status: 'error', toolUseId: 'call_warranty', errorCode: 'other' }]);
    // The tool span's status carries no message and no `error.type`; the text comes from the `exception` event.
    expect(store.errors).toMatchObject([{ session: `otel-${FAILED}`, tool: 'lookup_policy', sig: 'lookup_policy | policy index unavailable', example: 'policy index unavailable', toolUseId: 'call_warranty' }]);
  });

  it('reads the model and the usage from the chat spans only: the uncached input, the cache read, and the output, not the agent span aggregate', async () => {
    const { store } = await imported();
    const byId = new Map(store.sessions.map((entry) => [entry.session, entry]));
    // The first chat reported 120 in and 14 out; the second 190 in (64 of them cached) and 11 out. The agent span's `gen_ai.aggregated_usage.*` (310 in) is not added again.
    expect(byId.get(`otel-${OK}`)).toMatchObject({ assistantTurns: 2, usageResponses: 2, usage: { input: 246, cacheRead: 64, cacheWrite: 0, output: 25, thinking: 0 }, usageObserved: ['input', 'cacheRead', 'output'] });
    expect(byId.get(`otel-${FAILED}`)).toMatchObject({ assistantTurns: 1, usageResponses: 1, usage: { input: 120, cacheRead: 0, output: 14 }, usageObserved: ['input', 'output'] });
  });

  it('KNOWN GAP: the user prompt is written content-less, because Pydantic AI puts the messages on the chat spans and `pydantic_ai.all_messages`, not on the agent span', async () => {
    const store = await openOtelStore(FIXTURE);
    if (store === undefined) throw new Error('no store');
    const first = store.sessions.find((entry) => entry.id === OK);
    if (first === undefined) throw new Error('no session');
    const lines = store
      .transcript(first)
      .split('\n')
      .filter((raw) => raw !== '')
      .map((raw): unknown => JSON.parse(raw));
    expect(lines[0]).toMatchObject({ type: 'user', message: { content: [{ type: 'image' }] } });
    expect(JSON.stringify(lines)).not.toContain('refund?');
  });

  it('KNOWN GAP: no duration is kept for a call, the successful result carries no content, and the failed one carries only the message', async () => {
    const store = await openOtelStore(FIXTURE);
    if (store === undefined) throw new Error('no store');
    const results = store.sessions.flatMap((entry) =>
      store
        .transcript(entry)
        .split('\n')
        .filter((raw) => raw.includes('tool_result'))
        .map((raw): unknown => JSON.parse(raw)),
    );
    expect(results).toMatchObject([
      { noDuration: true, message: { content: [{ type: 'tool_result', tool_use_id: 'call_refund', is_error: false, content: '' }] } },
      { noDuration: true, message: { content: [{ type: 'tool_result', tool_use_id: 'call_warranty', is_error: true, content: 'policy index unavailable' }] } },
    ]);
    expect((await imported()).store.tools.map((tool) => tool.durationMs)).toEqual([null, null]);
  });
});
