import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { openOtelStore, otelRoot } from './otel.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, otlpRequest, otlpSpan, stage, stageOtel, type OtlpSpanInput } from './test-support.js';

afterEach(cleanup);

// Every fixture is written from the GenAI semantic conventions (open-telemetry/semantic-conventions-genai @ e6658f1, docs/registry/attributes/gen-ai.md) and the OTLP
// JSON encoding (opentelemetry-proto v1.11.1, docs/specification.md:453-484, trace.proto:96-327); no real trace was read. The attributes a fixture sets:
//   gen_ai.operation.name   `chat`, `execute_tool`, `invoke_agent` (registry: well-known values; client-inference.md:65, execute-tool.md:58, gen-ai-agent-spans.md:168)
//   gen_ai.input.messages / gen_ai.output.messages   Opt-In; `[{role, parts: [{type: "text", content}, {type: "tool_call", id, name, arguments}]}]`
//   gen_ai.request.model, gen_ai.response.model, gen_ai.conversation.id, gen_ai.agent.name
//   gen_ai.usage.input_tokens (includes cached tokens), .output_tokens, .cache_read.input_tokens, .cache_write.input_tokens, .reasoning.output_tokens
//   gen_ai.tool.name, gen_ai.tool.call.id, gen_ai.tool.call.arguments (Opt-In)   execute-tool.md:75-83
//   error.type (stable), status.code 2 = ERROR (trace.proto:327), process.exit.code (the command refinement), gen_ai.skill.name, gen_ai.transfer.target.name, mcp.method.name
// Pinned lines (semantic-conventions-genai @ e6658f14, paths under docs/ unless the path starts with model/; every GenAI attribute is Development):
//   gen_ai.conversation.id registry/attributes/gen-ai.md:15 (merging traces on it is the reader's rule, from the SHOULD at :112)   gen_ai.agent.name registry/attributes/gen-ai.md:12
//   gen_ai.transfer.mode / .target.name gen-ai/execute-tool.md:225-226 (registry/attributes/gen-ai.md:80)   gen_ai.skill.name / .resource.name registry/attributes/gen-ai.md:65-66, gen-ai/execute-tool.md:386
//   mcp.method.name registry/attributes/mcp.md:10 (Development); the span name and attribute table gen-ai/mcp.md:143, 160; the conventions carry no MCP server name
//   process.executable.name / process.exit.code gen-ai/execute-tool.md:725-726 (Release Candidate, from semantic-conventions v1.45.0 registry/attributes/process.md:28, 30)
//   message parts: the schema model/gen-ai/gen-ai-input-messages.json:74 (`parts`), :414-434 (`TextPart`: `type` "text", `content`); the worked example registry/attributes/gen-ai.md:22, 33
//   failure text: the span status message (semantic-conventions v1.45.0 docs/general/recording-errors.md:57-58), else the `exception` span event (docs/exceptions/exceptions-spans.md:47, a Deprecated
//   document at :7 that moved exceptions to log records, which an OTLP trace file does not hold); `exception.message` is Stable (registry/attributes/exception.md:17). The GenAI-specific
//   `gen_ai.execute_tool.exception` (gen-ai/execute-tool.md:857-866) is a log event, so it is not read.

type Obj = { [key: string]: unknown };
const T = 'a'.repeat(32);
const T2 = 'b'.repeat(32);
const sp = (n: number): string => n.toString(16).padStart(16, '0');

const span = (input: OtlpSpanInput): object => otlpSpan(input);
const user = (text: string): Obj[] => [{ role: 'user', parts: [{ type: 'text', content: text }] }];
const reply = (text: string, ...calls: string[]): Obj[] => [{ role: 'assistant', parts: [{ type: 'text', content: text }, ...calls.map((id) => ({ type: 'tool_call', id, name: 'x', arguments: {} }))] }];
const agent = (trace: string, id: number, parent: number | undefined, start: number, end: number, text?: string, extra: Obj = {}): object =>
  span({ trace, id: sp(id), ...(parent === undefined ? {} : { parent: sp(parent) }), name: 'invoke_agent support', start, end, attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'support', ...(text === undefined ? {} : { 'gen_ai.input.messages': user(text) }), ...extra } });
const chat = (trace: string, id: number, parent: number, start: number, end: number, extra: Obj = {}): object =>
  span({ trace, id: sp(id), parent: sp(parent), name: 'chat gpt-5.1', start, end, attrs: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'gpt-5.1', ...extra } });
const tool = (trace: string, id: number, parent: number, start: number, end: number, name: string, extra: Obj = {}, more: Partial<OtlpSpanInput> = {}): object =>
  span({ trace, id: sp(id), parent: sp(parent), name: `execute_tool ${name}`, start, end, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': name, ...extra }, ...more });

const open = async (files: { name: string; spans: readonly object[] }[]) => {
  const s = stage();
  const dir = stageOtel(
    s.root,
    files.map((file) => ({ name: file.name, lines: [otlpRequest(file.spans)] })),
  );
  expect(dir.startsWith(s.root)).toBe(true);
  const store = await openOtelStore(dir);
  if (store === undefined) throw new Error('no store');
  return store;
};
const capture = (text: string) =>
  captureSession({
    text,
    harness: 'otel',
    session: 'otel-x',
    project: 'otel',
    rev: 1,
    at: '2026-06-01T00:00:00Z',
    bytes: text.length,
    redact: makeRedactor(),
    salt: 'salt',
    sid: 'abcd1234',
    repoRoot: makeRepoRoot(),
    repoIdentity: makeRepoIdentity(),
  });
const textOf = (store: Awaited<ReturnType<typeof open>>, id: string): string => {
  const found = store.sessions.find((session) => session.id === id);
  if (found === undefined) throw new Error(`no session ${id}`);
  return store.transcript(found);
};
const obj = (value: unknown): Obj => (typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {});
const linesOf = (text: string): Obj[] => text.split('\n').filter((raw) => raw !== '').map((raw) => obj(JSON.parse(raw)));
const present = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('expected a value');
  return value;
};

const single = (): object[] => [
  agent(T, 1, undefined, 0, 12, 'where is my order?'),
  chat(T, 2, 1, 1, 3, { 'gen_ai.response.model': 'gpt-5.1-2026-01', 'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.cache_read.input_tokens': 40, 'gen_ai.usage.cache_write.input_tokens': 10, 'gen_ai.usage.output_tokens': 20, 'gen_ai.usage.reasoning.output_tokens': 5, 'gen_ai.output.messages': reply('looking', 'c1') }),
  tool(T, 3, 1, 3, 4, 'lookup_order', { 'gen_ai.tool.call.id': 'c1', 'gen_ai.tool.call.arguments': { order: '17' } }),
  chat(T, 4, 1, 5, 7, { 'gen_ai.usage.input_tokens': 30, 'gen_ai.usage.output_tokens': 8 }),
  tool(T, 5, 1, 7, 8, 'exec_command', { 'gen_ai.tool.call.id': 'c2', 'gen_ai.tool.call.arguments': { command: 'ls -a' } }),
];

describe('a single-agent trace with two tool calls', () => {
  it('is one session named for the trace, with a prompt, two model calls, and two calls the table reads', async () => {
    const store = await open([{ name: 'a.jsonl', spans: single() }]);
    expect(store.sessions).toMatchObject([{ id: T, folder: null }]);
    const lines = linesOf(textOf(store, T));
    expect(lines.filter((line) => line.type === 'assistant')).toHaveLength(2);
    const out = capture(textOf(store, T));
    expect(out.prompts).toHaveLength(1);
    expect(out.prompts[0]?.head).toBe('where is my order?');
    expect(out.tools).toMatchObject([
      { tool: 'lookup_order', status: 'ok' },
      { tool: 'exec_command', status: 'ok' },
    ]);
    expect(out.tools[0]?.steps?.[0]).toMatchObject({ action: 'other' });
    expect(out.tools[1]?.steps?.[0]).toMatchObject({ action: 'shell.exec', identity: { program: 'ls' } });
    expect(out.errorLines).toEqual([]);
  });

  it('writes the uncached part as input (the figure includes cache reads and writes) and keeps the cache and reasoning figures', async () => {
    const out = capture(textOf(await open([{ name: 'a.jsonl', spans: single() }]), T));
    expect(out.session.usage).toMatchObject({ input: 50 + 30, cacheRead: 40, cacheWrite: 10, output: 28, thinking: 5 });
  });

  it('names the model the response reported, else the one requested', async () => {
    const lines = linesOf(textOf(await open([{ name: 'a.jsonl', spans: single() }]), T));
    expect(lines.filter((line) => line.type === 'assistant').map((line) => line.requestedModel)).toEqual(['gpt-5.1-2026-01', 'gpt-5.1']);
  });

  it('gives each line its own time, converted once from Unix nanoseconds', async () => {
    const lines = linesOf(textOf(await open([{ name: 'a.jsonl', spans: single() }]), T));
    const times = lines.map((line) => line.timestamp);
    expect(times[0]).toBe('2026-06-01T10:00:00.000Z');
    expect(times).toContain('2026-06-01T10:00:01.000Z');
    expect(times).toContain('2026-06-01T10:00:04.000Z');
    expect(new Set(times).size).toBeGreaterThan(4);
  });

  it('takes the emitting framework from the instrumentation scope, with other for one the list does not name', async () => {
    const store = await open([{ name: 'a.jsonl', spans: single() }]);
    expect(linesOf(textOf(store, T)).every((line) => line.version === 'langchain')).toBe(true);
    const s = stage();
    const dir = stageOtel(s.root, [{ name: 'x.jsonl', lines: [otlpRequest(single(), 'acme.private.tracer')] }]);
    const other = present(await openOtelStore(dir));
    expect(linesOf(other.transcript(present(other.sessions[0]))).every((line) => line.version === 'other')).toBe(true);
  });

  it('names google-adk for a scope that has adk as a word, and not for one that merely contains it', async () => {
    const versionOf = async (scope: string): Promise<unknown> => {
      const dir = stageOtel(stage().root, [{ name: 'x.jsonl', lines: [otlpRequest(single(), scope)] }]);
      const store = present(await openOtelStore(dir));
      return linesOf(store.transcript(present(store.sessions[0])))[0]?.version;
    };
    expect(await versionOf('opentelemetry.instrumentation.adk')).toBe('google-adk');
    expect(await versionOf('google.adk')).toBe('google-adk');
    expect(await versionOf('acme.shadkow.tracer')).toBe('other');
  });

  it('records no working folder or repository', async () => {
    const out = capture(textOf(await open([{ name: 'a.jsonl', spans: single() }]), T));
    expect(linesOf(textOf(await open([{ name: 'a.jsonl', spans: single() }]), T)).some((line) => 'cwd' in line)).toBe(false);
    expect(out.session.lines).toBe(linesOf(textOf(await open([{ name: 'a.jsonl', spans: single() }]), T)).length);
  });
});

describe('a failed tool call', () => {
  const failing = (): object[] => [
    agent(T, 1, undefined, 0, 9, 'refund it'),
    chat(T, 2, 1, 1, 2),
    tool(T, 3, 1, 2, 3, 'refund', { 'error.type': 'TimeoutError' }, { code: 2, message: 'upstream took too long' }),
    tool(T, 4, 1, 3, 4, 'notify', { 'error.type': 'ValueError' }),
    tool(T, 5, 1, 4, 5, 'check', {}, { code: 2 }),
    tool(T, 6, 1, 5, 6, 'run', { 'process.exit.code': 3, 'process.executable.name': 'make', 'gen_ai.tool.call.arguments': { command: 'make' } }),
    tool(T, 7, 1, 6, 7, 'fine', {}, { code: 1 }),
  ];

  it('reads the span status and error.type, not a name: each failure is an error with its own line', async () => {
    const out = capture(textOf(await open([{ name: 'a.jsonl', spans: failing() }]), T));
    expect(out.tools.map((entry) => entry.status)).toEqual(['error', 'error', 'error', 'error', 'ok']);
    expect(out.errorLines.map((error) => error.line)).toEqual(['TimeoutError: upstream took too long', 'ValueError', 'tool failed', 'Exit code 3']);
  });

  it('reads the exception event when the status carries no message', async () => {
    const spans = [agent(T, 1, undefined, 0, 4, 'x'), tool(T, 2, 1, 1, 2, 'a', {}, { code: 2, events: [{ name: 'exception', attrs: { 'exception.message': 'boom' } }] })];
    expect(capture(textOf(await open([{ name: 'a.jsonl', spans }]), T)).errorLines.map((error) => error.line)).toEqual(['boom']);
  });

  it('redacts a secret and an email, and cuts a 1,500-character error at 1,000 characters', async () => {
    const long = `fail: sk-abcdefghijklmnopqrstuvwxyz0123 for alice@example.com ${'x'.repeat(1500)}`;
    const spans = [agent(T, 1, undefined, 0, 4, 'x'), tool(T, 2, 1, 1, 2, 'a', { 'error.type': 'Boom' }, { code: 2, message: long })];
    const error = capture(textOf(await open([{ name: 'a.jsonl', spans }]), T)).errorLines[0];
    expect(error?.line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(error?.line).not.toContain('alice@example.com');
    expect(error?.line.length).toBeLessThanOrEqual(1000);
  });

  it('redacts a secret in the prompt text and the command the span carries', async () => {
    const spans = [
      agent(T, 1, undefined, 0, 4, 'use key sk-abcdefghijklmnopqrstuvwxyz0123 please'),
      tool(T, 2, 1, 1, 2, 'exec_command', { 'gen_ai.tool.call.arguments': { command: 'curl -H "x: sk-abcdefghijklmnopqrstuvwxyz0123" https://example.com' } }),
    ];
    const out = capture(textOf(await open([{ name: 'a.jsonl', spans }]), T));
    expect(JSON.stringify(out)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
  });
});

describe('a nested agent', () => {
  const nested = (): object[] => [
    agent(T, 1, undefined, 0, 20, 'plan the trip'),
    chat(T, 2, 1, 1, 2),
    agent(T, 3, 1, 2, 10, 'find flights', { 'gen_ai.agent.name': 'flights' }),
    chat(T, 4, 3, 3, 4),
    tool(T, 5, 3, 4, 5, 'search_flights', { 'gen_ai.tool.call.id': 'f1' }),
    tool(T, 6, 1, 10, 18, 'ask_hotels', { 'gen_ai.tool.call.id': 'h1', 'gen_ai.transfer.target.name': 'hotels' }),
    agent(T, 7, 6, 11, 17, 'find hotels', { 'gen_ai.agent.name': 'hotels' }),
    tool(T, 8, 7, 12, 13, 'search_hotels'),
  ];

  it('is its own session whose turns never land in the parent, linked to the call that spawned it', async () => {
    const store = await open([{ name: 'a.jsonl', spans: nested() }]);
    expect(store.sessions.map((entry) => entry.id).sort()).toEqual([T, `${T}-${sp(3)}`, `${T}-${sp(7)}`].sort());
    const flights = store.sessions.find((entry) => entry.id === `${T}-${sp(3)}`);
    expect(flights?.subagent).toEqual({ parent: `otel-${T}`, agentType: 'flights', spawnedBy: sp(3) });
    const hotels = store.sessions.find((entry) => entry.id === `${T}-${sp(7)}`);
    expect(hotels?.subagent).toEqual({ parent: `otel-${T}`, agentType: 'hotels', spawnedBy: 'h1' });
    const parent = capture(textOf(store, T));
    expect(parent.tools.map((entry) => entry.tool)).toEqual(['invoke_agent', 'ask_hotels']);
    expect(parent.tools.map((entry) => entry.steps?.[0]?.action)).toEqual(['agent.spawn', 'agent.spawn']);
    expect(parent.prompts).toHaveLength(1);
    expect(capture(textOf(store, `${T}-${sp(3)}`)).tools.map((entry) => entry.tool)).toEqual(['search_flights']);
    expect(capture(textOf(store, `${T}-${sp(7)}`)).tools.map((entry) => entry.tool)).toEqual(['search_hotels']);
  });
});

describe('a trace with no usage', () => {
  it('writes no usage object and observes none, rather than writing zero', async () => {
    const store = await open([{ name: 'a.jsonl', spans: [agent(T, 1, undefined, 0, 5, 'hi'), chat(T, 2, 1, 1, 2, { 'gen_ai.output.messages': reply('hello') })] }]);
    const assistant = linesOf(textOf(store, T)).filter((line) => line.type === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(obj(assistant[0]?.message).usage).toBeUndefined();
    expect(capture(textOf(store, T)).session.usageObserved).toEqual([]);
  });

  it('writes only the figure a span reported', async () => {
    const store = await open([{ name: 'a.jsonl', spans: [agent(T, 1, undefined, 0, 5, 'hi'), chat(T, 2, 1, 1, 2, { 'gen_ai.usage.output_tokens': 9 })] }]);
    const usage = obj(linesOf(textOf(store, T)).find((line) => line.type === 'assistant')?.message).usage;
    expect(usage).toEqual({ output_tokens: 9 });
    expect(capture(textOf(store, T)).session.usageObserved).toEqual(['output']);
  });
});

describe('spans split across files', () => {
  it('joins the spans of one trace from two files, in either order', async () => {
    const all = single();
    const store = await open([
      { name: 'b.jsonl', spans: all.slice(2) },
      { name: 'a.jsonl', spans: all.slice(0, 2) },
    ]);
    expect(store.sessions).toHaveLength(1);
    const out = capture(textOf(store, T));
    expect(out.tools.map((entry) => entry.tool)).toEqual(['lookup_order', 'exec_command']);
    expect(out.prompts).toHaveLength(1);
  });
});

describe('two traces of one conversation', () => {
  it('is one session with each trace a prompt in start-time order, while a trace with no conversation id stays its own', async () => {
    const conversation = { 'gen_ai.conversation.id': 'conv-42' };
    const store = await open([
      {
        name: 'a.jsonl',
        spans: [
          agent(T2, 11, undefined, 100, 110, 'second question', conversation),
          chat(T2, 12, 11, 101, 102),
          agent(T, 1, undefined, 0, 10, 'first question', conversation),
          chat(T, 2, 1, 1, 2),
          agent('c'.repeat(32), 21, undefined, 50, 60, 'unrelated'),
        ],
      },
    ]);
    expect(store.sessions).toHaveLength(2);
    const merged = store.sessions.find((entry) => entry.id.startsWith('conv-'));
    expect(merged).toBeDefined();
    const out = capture(store.transcript(present(merged)));
    expect(out.prompts.map((prompt) => prompt.head)).toEqual(['first question', 'second question']);
  });
});

describe('what the conventions leave out or mark unstable', () => {
  it('writes a prompt with no content (the default: content capture is off) as a turn, not as nothing', async () => {
    const out = capture(textOf(await open([{ name: 'a.jsonl', spans: [agent(T, 1, undefined, 0, 5), chat(T, 2, 1, 1, 2)] }]), T));
    expect(out.session.userTurns).toBe(0);
    expect(out.session.assistantTurns).toBe(1);
    expect(out.session.lines).toBe(2);
  });

  it('falls back to the span name when the operation attribute is missing, and skips an operation it does not know', async () => {
    const spans = [
      span({ trace: T, id: sp(1), name: 'invoke_agent support', start: 0, end: 9 }),
      span({ trace: T, id: sp(2), parent: sp(1), name: 'execute_tool lookup', start: 1, end: 2, attrs: { 'gen_ai.tool.name': 'lookup' } }),
      span({ trace: T, id: sp(3), parent: sp(1), name: 'embeddings text-embedding-3', start: 2, end: 3, attrs: { 'gen_ai.operation.name': 'embeddings' } }),
    ];
    expect(capture(textOf(await open([{ name: 'a.jsonl', spans }]), T)).tools.map((entry) => entry.tool)).toEqual(['lookup']);
  });

  it('reads messages written as JSON text as well as structured values', async () => {
    const spans = [agent(T, 1, undefined, 0, 5, undefined, { 'gen_ai.input.messages': JSON.stringify(user('as text')) })];
    expect(capture(textOf(await open([{ name: 'a.jsonl', spans }]), T)).prompts[0]?.head).toBe('as text');
  });

  it('dates a first unit with no time of its own by the earliest timed span it holds, not 1970', async () => {
    const spans = [
      span({ trace: T, id: sp(1), name: 'invoke_agent support', attrs: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.input.messages': user('go') } }),
      span({ trace: T, id: sp(2), parent: sp(1), name: 'chat m', start: 5, end: 6, attrs: { 'gen_ai.operation.name': 'chat' } }),
      span({ trace: T, id: sp(3), parent: sp(1), name: 'execute_tool t', start: 7, end: 8, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 't' } }),
    ];
    const lines = linesOf(textOf(await open([{ name: 'a.jsonl', spans }]), T));
    const first = lines.find((line) => line.type === 'user');
    expect(first?.timestamp).toBe('2026-06-01T10:00:05.000Z');
    expect(lines.every((line) => typeof line.timestamp === 'string' && !line.timestamp.startsWith('1970'))).toBe(true);
  });

  it('gives a missing time the latest one so far, and reads a trace with no agent span from its root', async () => {
    const spans = [
      span({ trace: T, id: sp(1), name: 'workflow', start: 10, end: 20, attrs: { 'gen_ai.input.messages': user('go') } }),
      span({ trace: T, id: sp(2), parent: sp(1), name: 'chat m', attrs: { 'gen_ai.operation.name': 'chat' } }),
      span({ trace: T, id: sp(3), parent: sp(1), name: 'execute_tool t', start: 12, end: 13, attrs: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 't' } }),
    ];
    const lines = linesOf(textOf(await open([{ name: 'a.jsonl', spans }]), T));
    expect(lines.map((line) => line.type)).toEqual(['user', 'assistant', 'user']);
    expect(lines.every((line) => typeof line.timestamp === 'string' && line.timestamp >= '2026-06-01T10:00:10')).toBe(true);
  });

  it('writes an MCP call under a server that names none, since the conventions carry no server name', async () => {
    const spans = [agent(T, 1, undefined, 0, 5, 'x'), tool(T, 2, 1, 1, 2, 'get_issue', { 'mcp.method.name': 'tools/call' })];
    const out = capture(textOf(await open([{ name: 'a.jsonl', spans }]), T));
    expect(out.tools[0]?.steps?.[0]).toMatchObject({ action: 'mcp.call' });
  });

  it('reads a skill load as skill.run and a skill resource as file.read', async () => {
    const spans = [
      agent(T, 1, undefined, 0, 5, 'x'),
      tool(T, 2, 1, 1, 2, 'load', { 'gen_ai.skill.name': 'pdf' }),
      tool(T, 3, 1, 2, 3, 'load_resource', { 'gen_ai.skill.name': 'pdf', 'gen_ai.skill.resource.name': 'forms.md' }),
    ];
    const out = capture(textOf(await open([{ name: 'a.jsonl', spans }]), T));
    expect(out.tools.map((entry) => entry.steps?.[0]?.action)).toEqual(['skill.run', 'file.read']);
  });
});

describe('where it reads from', () => {
  it('names a configured folder, else the config folder, and never a real one in a test', () => {
    expect(otelRoot({ OARS_OTEL_TRACES: '/x/traces' }, '/home/u')).toBe('/x/traces');
    expect(otelRoot({ XDG_CONFIG_HOME: '/cfg' }, '/home/u', 'linux')).toBe(join('/cfg', 'oars', 'otel-traces'));
    expect(otelRoot({}, '/home/u', 'linux')).toBe(join('/home/u', '.config', 'oars', 'otel-traces'));
    expect(otelRoot({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u', 'win32')).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'oars', 'otel-traces'));
    expect(otelRoot({}, 'C:\\Users\\u', 'win32')).toBe(join('C:\\Users\\u', 'AppData', 'Roaming', 'oars', 'otel-traces'));
  });

  it('returns nothing for a folder that does not exist', async () => {
    expect(await openOtelStore(join(stage().root, 'nowhere'))).toBeUndefined();
  });
});

describe('a file with torn lines', () => {
  const folder = (files: { name: string; lines: readonly unknown[] | string }[]) => openOtelStore(stageOtel(stage().root, files));
  const request = (spans: readonly object[]): string => JSON.stringify(otlpRequest(spans));
  // Capture counts a transcript line that is not a JSON object as a bad line, so the count is those lines of the session's transcript.
  const badLines = (store: NonNullable<Awaited<ReturnType<typeof folder>>>, id: string): number => textOf(store, id).split('\n').filter((raw) => raw !== '' && !raw.startsWith('{"')).length;

  it('counts them on a session that came from that file, not on the oldest session of another file', async () => {
    const store = await folder([
      { name: 'a.jsonl', lines: `${request(single())}\n` },
      { name: 'b.jsonl', lines: `${request([agent(T2, 1, undefined, 100, 112, 'later')])}\n{torn\n` },
    ]);
    if (store === undefined) throw new Error('no store');
    expect(store.sessions.map((found) => found.id)).toEqual([T, T2]);
    expect(badLines(store, T)).toBe(0);
    expect(badLines(store, T2)).toBe(1);
    expect(store.unreadable).toEqual([]);
  });

  it('names the file in unreadable, with its line count, when no session came from it', async () => {
    const store = await folder([
      { name: 'a.jsonl', lines: `${request(single())}\n` },
      { name: 'b.jsonl', lines: `${request([])}\n{torn\nalso torn\n` },
    ]);
    if (store === undefined) throw new Error('no store');
    expect(badLines(store, T)).toBe(0);
    expect(store.unreadable).toHaveLength(1);
    expect(store.unreadable[0]?.file.endsWith('b.jsonl')).toBe(true);
    expect(store.unreadable[0]?.reason).toBe('2 lines are not JSON');
  });
});

describe('a folder that grows', () => {
  it('reads 2,000 traces of 10 spans each, with a nested agent each, into 4,000 sessions in under two seconds', async () => {
    const spans: object[] = [];
    for (let n = 0; n < 2000; n += 1) {
      const trace = n.toString(16).padStart(32, '0');
      const at = n * 100;
      spans.push(agent(trace, 1, undefined, at, at + 50, `question ${String(n)}`));
      for (let k = 0; k < 4; k += 1) {
        spans.push(chat(trace, 2 + k * 2, 1, at + k * 10, at + k * 10 + 4, { 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 2 }));
        spans.push(tool(trace, 3 + k * 2, 1, at + k * 10 + 4, at + k * 10 + 8, 'lookup', { 'gen_ai.tool.call.id': `c${String(k)}` }));
      }
      spans.push(agent(trace, 20, 1, at + 41, at + 49, undefined, { 'gen_ai.agent.name': 'helper' }));
    }
    const started = Date.now();
    const store = await open([{ name: 'big.jsonl', spans }]);
    expect(store.sessions).toHaveLength(4000);
    expect(Date.now() - started).toBeLessThan(2000);
  }, 30000);
});
