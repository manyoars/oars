import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openOtelStore } from './otel.js';
import { deposit, loadStore, readSkeletons } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';
import { verifyAll, verifyCaptured } from './verify.js';

afterEach(cleanup);

// `fixtures/otel-pydantic-ai/trace.jsonl` is a real trace: Pydantic AI 2.66.0 (instrumentation scope `pydantic-ai`, GenAI spans on, content included) ran a support-policy agent
// over three local policy files and two questions, once with a lookup that succeeds and once with one that raises. The model was a scripted OpenAI-compatible stub (no model was
// installed), so the spans are the framework's. OpenTelemetry SDK 1.45.2 wrote them, as `ExportTraceServiceRequest` JSON lines, one per span. Host paths, the service instance id,
// and the stub's port were replaced with fixed tokens. Each run has its own `gen_ai.conversation.id`, so the trace is two sessions.
// What the real spans carry that the reader drops or misreads is listed in docs/sessions-store.md (the otel section); the cases marked KNOWN GAP below pin today's output so a fix shows as a change here.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'otel-pydantic-ai');
const OK = 'conv-7d196b3aceec8f37';
const FAILED = 'conv-2ba9d21155a5762d';
const POLICY = '# Refund policy\nRefunds are accepted within 30 days of delivery. The item must be unused and in its original packaging.\n';

const imported = async () => {
  const s = stage();
  const runtime = { ...s.runtime, sourceRoots: { otel: FIXTURE } };
  const result = await deposit(runtime, { allow: ['otel'], redactDomains: [], now: () => NOW });
  return { result, store: await loadStore(s.storeDir), skeletons: (await readSkeletons(s.storeDir)).skeletons };
};

describe('a real Pydantic AI trace deposited with --allow otel', () => {
  it('is two sessions, one per conversation id, framed as otel with the framework in the version slot', async () => {
    const { result, store } = await imported();
    expect(result).toMatchObject({ sessions: 2, badLines: 0, sources: { otel: { read: 2, unreadable: [], rejected: 0 } } });
    expect(store.sessions.map((entry) => entry.session).sort()).toEqual([`otel-${FAILED}`, `otel-${OK}`].sort());
    for (const entry of store.sessions) {
      expect(entry).toMatchObject({ harness: 'otel', project: 'otel', versions: ['pydantic-ai'], tools: { lookup_policy: 1 } });
      expect(Object.keys(entry.models)).toEqual(['stub-support-1']);
    }
  });

  it('holds every verify invariant, including --strict', async () => {
    const { store, skeletons } = await imported();
    expect(skeletons).toHaveLength(2);
    expect([...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((result) => result.violations > 0)).toEqual([]);
  });

  it('keeps the successful lookup as an ok call placed in the model call that named it, with the arguments read as a text key', async () => {
    const { store } = await imported();
    const calls = store.tools.filter((tool) => tool.session === `otel-${OK}`);
    expect(calls).toMatchObject([{ tool: 'lookup_policy', status: 'ok', toolUseId: 'call_refund', model: 'stub-support-1', keys: ['topic'], argClass: ['text'], harnessVersion: 'pydantic-ai' }]);
    expect(store.errors.filter((error) => error.session === `otel-${OK}`)).toEqual([]);
  });

  it('keeps the raising lookup as an error call whose error line is the exception type and message from the exception event', async () => {
    const { store } = await imported();
    expect(store.tools.filter((tool) => tool.session === `otel-${FAILED}`)).toMatchObject([{ tool: 'lookup_policy', status: 'error', toolUseId: 'call_warranty', errorCode: 'other' }]);
    // The tool span's status carries no message and no `error.type`; the type and the text come from the `exception` event (`exception.type`, `exception.message`). The type reaches the
    // signature and the example; `errorCode` is the closed class `errorCodeOf` gives the line, and `RuntimeError` is not one of them.
    expect(store.errors).toMatchObject([{ session: `otel-${FAILED}`, tool: 'lookup_policy', sig: 'lookup_policy | RuntimeError: policy index unavailable', example: 'RuntimeError: policy index unavailable', toolUseId: 'call_warranty' }]);
  });

  it('reads the model and the usage from the chat spans only: the uncached input, the cache read, and the output, not the agent span aggregate', async () => {
    const { store } = await imported();
    const byId = new Map(store.sessions.map((entry) => [entry.session, entry]));
    // The first chat reported 120 in and 14 out; the second 190 in (64 of them cached) and 11 out. The agent span's `gen_ai.aggregated_usage.*` (310 in) is not added again.
    expect(byId.get(`otel-${OK}`)).toMatchObject({ assistantTurns: 2, usageResponses: 2, usage: { input: 246, cacheRead: 64, cacheWrite: 0, output: 25, thinking: 0 }, usageObserved: ['input', 'cacheRead', 'output'] });
    expect(byId.get(`otel-${FAILED}`)).toMatchObject({ assistantTurns: 1, usageResponses: 1, usage: { input: 120, cacheRead: 0, output: 14 }, usageObserved: ['input', 'output'] });
  });

  it('takes the user prompt from the first chat span, because Pydantic AI puts the messages there and in `pydantic_ai.all_messages`, not on the agent span', async () => {
    const store = await openOtelStore(FIXTURE);
    if (store === undefined) throw new Error('no store');
    const first = store.sessions.find((entry) => entry.id === OK);
    if (first === undefined) throw new Error('no session');
    const lines = store
      .transcript(first)
      .split('\n')
      .filter((raw) => raw !== '')
      .map((raw): unknown => JSON.parse(raw));
    expect(lines[0]).toMatchObject({ type: 'user', message: { content: [{ type: 'text', text: 'How long do I have to ask for a refund?' }] } });
  });

  // KNOWN GAP (t947): a call's duration is still not kept. Capture reads it as the result line's time minus the time of the line that holds the `tool_use`, and the reader puts the
  // `tool_use` in the model call that named it, so the only line time is that chat span's start (about 87 ms before the first tool span ends), not the tool span's own start
  // (the ok call's span is 1 ms long, the failed one's 4 ms). Stamping the `tool_use` at the tool span's start moves every call into a line of its own, or capture takes a duration on the result line.
  it('keeps the tool result content, and still claims no duration for a call', async () => {
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
      { noDuration: true, message: { content: [{ type: 'tool_result', tool_use_id: 'call_refund', is_error: false, content: POLICY }] } },
      { noDuration: true, message: { content: [{ type: 'tool_result', tool_use_id: 'call_warranty', is_error: true, content: 'RuntimeError: policy index unavailable' }] } },
    ]);
    expect((await imported()).store.tools.map((tool) => tool.durationMs)).toEqual([null, null]);
  });
});
