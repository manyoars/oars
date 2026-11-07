// The OpenTelemetry GenAI source: an agent trace in OTLP JSON becomes the same capture records a Claude Code transcript does.
//
// CONVENTION-DERIVED: written from the public GenAI semantic conventions (github.com/open-telemetry/semantic-conventions-genai @ e6658f1, Apache-2.0; the
// conventions moved there from open-telemetry/semantic-conventions, which has a release but only "Moved" stubs for GenAI, and the new repository has no release)
// and the OTLP JSON encoding (opentelemetry-proto v1.11.1, docs/specification.md:453-484, trace.proto:96-327; the file exporter,
// opentelemetry-specification specification/protocol/file-exporter.md:64-75, writes one `ExportTraceServiceRequest` a line with no order guarantee). Nothing was
// copied and no real trace was read: `docs/sessions-store.md` names the one hand run that would prove the reader. Every GenAI attribute below is marked Development
// in the registry, so each one is optional here: a missing or renamed attribute means less is read, never a throw.
//
// Where it reads from (`otelRoot`): `$OARS_OTEL_TRACES`, else `<config>/oars/otel-traces` (a configured folder, so the nightly run is deterministic). Every `*.jsonl` and
// `*.json` file in it is read; the traces of all files are joined by `traceId` first, because a collector may split one trace across files.
//
// How a trace becomes a session:
//   session      one `traceId`; traces that share `gen_ai.conversation.id` are one session, each trace a turn in start-time order. An agent span nested inside another
//                agent's (directly or through an agent-as-tool `execute_tool` span) is its own session `<traceId>-<spanId>`, a subagent of the span's session.
//   prompt       one per root agent span (`invoke_agent`, `invoke_workflow`, any `invoke_*` operation), else per trace root; its text is the last user message of
//                `gen_ai.input.messages` (Opt-In: absent by default, and then the turn is written content-less, as an image-only prompt is).
//   model call   a span whose `gen_ai.operation.name` is `chat`, `generate_content`, or `text_completion`: one assistant line, its `requestId` the span id.
//   tool call    an `execute_tool` span: a block in the model call that ended before it began (or whose output messages name its `gen_ai.tool.call.id`). It failed iff the
//                span's status code is ERROR (2) or `error.type` is set (stable, recording-errors.md): the error line is `error.type: status.message`, never the result.
//   usage        `gen_ai.usage.*`; `input_tokens` includes the cache reads and writes (the registry says it SHOULD), and capture's fields are disjoint, so the uncached
//                part is input - read - write. A figure the span did not report is not written as zero.
//   harness      `otel`; the version slot holds the emitting framework from the instrumentation scope name (a closed list plus `other`). Nothing names a working folder.

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';

/** The folder of OTLP JSON trace files for an environment; a test passes its own so it never reads a real one. */
export const otelRoot = (env: { [name: string]: string | undefined }, home: string = homedir(), platform: NodeJS.Platform = process.platform): string => {
  const set = env.OARS_OTEL_TRACES;
  if (set !== undefined && set !== '') return set;
  const config = platform === 'win32' ? (env.APPDATA ?? join(home, 'AppData', 'Roaming')) : (env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return join(config, 'oars', 'otel-traces');
};

type Obj = { [key: string]: unknown };
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const reasonOf = (error: unknown, file: string): string => (error instanceof Error ? error.message : String(error)).split(file).join(basename(file));
const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** An OTLP `AnyValue` as plain data (the proto3 JSON mapping: `intValue` is a decimal string for int64). */
const anyOf = (value: unknown): unknown => {
  if (!isObj(value)) return undefined;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (typeof value.doubleValue === 'number') return value.doubleValue;
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  if (isObj(value.arrayValue)) return (Array.isArray(value.arrayValue.values) ? value.arrayValue.values : []).map(anyOf);
  if (isObj(value.kvlistValue)) return attributesOf(value.kvlistValue.values);
  return undefined;
};

const attributesOf = (list: unknown): Obj => {
  const out: Obj = {};
  for (const entry of Array.isArray(list) ? list : []) {
    const key = isObj(entry) ? str(entry.key) : undefined;
    if (key !== undefined && isObj(entry)) out[key] = anyOf(entry.value);
  }
  return out;
};

/** A structured attribute (messages, arguments) is an AnyValue; an exporter that flattens it writes its JSON text instead, and both are read. */
const structured = (value: unknown): unknown => (typeof value === 'string' ? (parse(value) ?? value) : value);

/** Unix nanoseconds (a decimal string, or a number) as whole milliseconds; undefined when absent, zero, or not an integer. */
const msOf = (value: unknown): number | undefined => {
  try {
    const nanos = BigInt(typeof value === 'number' ? Math.trunc(value) : String(value));
    return nanos > 0n ? Number(nanos / 1_000_000n) : undefined;
  } catch {
    return undefined;
  }
};

interface Span {
  trace: string;
  id: string;
  parent: string | undefined;
  name: string;
  start: number | undefined;
  end: number | undefined;
  failed: boolean;
  statusMessage: string | undefined;
  attrs: Obj;
  events: Obj[];
  framework: string;
  /** Position in the input, so spans with the same start keep the order they were written in. */
  order: number;
  /** The file the span was read from, blamed when its session cannot be read. */
  file: string;
}

/** The frameworks the conventions name (gen-ai-agent-spans.md:180-195, execute-tool.md:675-690) by a word of their instrumentation scope name; anything else is `other`. */
const FRAMEWORKS: readonly [string, RegExp][] = [
  ['langchain', /langchain|langgraph/i],
  ['openai-agents', /openai[-_.]agents/i],
  ['crewai', /crewai/i],
  ['google-adk', /google[-_.]adk|\badk\b/i],
  ['pydantic-ai', /pydantic[-_.]ai/i],
  ['strands', /strands/i],
  ['microsoft-agent-framework', /agent[-_.]framework/i],
  ['semantic-kernel', /semantic[-_.]kernel/i],
  ['llamaindex', /llama[-_.]?index/i],
  ['agno', /agno/i],
];
const frameworkOf = (scope: string): string => FRAMEWORKS.find(([, pattern]) => pattern.test(scope))?.[0] ?? 'other';

/** `ExportTraceServiceRequest` objects (proto JSON, camelCase) as spans. */
const spansOf = (request: unknown, order: { next: number }, file: string): Span[] => {
  if (!isObj(request)) return [];
  const spans: Span[] = [];
  for (const resource of Array.isArray(request.resourceSpans) ? request.resourceSpans : []) {
    for (const scoped of isObj(resource) && Array.isArray(resource.scopeSpans) ? resource.scopeSpans : []) {
      const scope = isObj(scoped) && isObj(scoped.scope) ? (str(scoped.scope.name) ?? '') : '';
      for (const raw of isObj(scoped) && Array.isArray(scoped.spans) ? scoped.spans : []) {
        if (!isObj(raw)) continue;
        const trace = str(raw.traceId);
        const id = str(raw.spanId);
        if (trace === undefined || id === undefined) continue;
        const status = isObj(raw.status) ? raw.status : {};
        const attrs = attributesOf(raw.attributes);
        order.next += 1;
        spans.push({
          trace,
          id,
          parent: str(raw.parentSpanId),
          name: str(raw.name) ?? '',
          start: msOf(raw.startTimeUnixNano),
          end: msOf(raw.endTimeUnixNano),
          // The status code is an integer enum in proto JSON (trace.proto:327: 2 is ERROR); a string-named enum is read too. `error.type` is stable and means failure whatever the status says.
          failed: status.code === 2 || status.code === 'STATUS_CODE_ERROR' || str(attrs['error.type']) !== undefined,
          statusMessage: str(status.message),
          attrs,
          events: (Array.isArray(raw.events) ? raw.events : []).filter(isObj).map((event) => ({ name: event.name, ...attributesOf(event.attributes) })),
          framework: frameworkOf(scope),
          order: order.next,
          file,
        });
      }
    }
  }
  return spans;
};

/** The requests of one file: the whole text as one JSON value (a `.json` file), else one request a line (the file exporter's JSON Lines). Throws when nothing parses. */
const requestsOf = (text: string): { requests: unknown[]; bad: string[] } => {
  const whole = parse(text);
  if (isObj(whole)) return { requests: [whole], bad: [] };
  const lines = text.split('\n').filter((raw) => raw.trim() !== '');
  const requests = lines.map(parse).filter(isObj);
  if (lines.length > 0 && requests.length === 0) throw new Error('no parseable line');
  return { requests, bad: lines.filter((raw) => !isObj(parse(raw))) };
};

const ops = (span: Span): string => {
  const set = str(span.attrs['gen_ai.operation.name']);
  if (set !== undefined) return set;
  // Development attributes may be missing or renamed: the span name leads with the operation (client-inference.md:65, execute-tool.md:58).
  const lead = /^(chat|generate_content|text_completion|execute_tool|invoke_agent|invoke_workflow)\b/.exec(span.name)?.[1];
  return lead ?? '';
};
const MODEL_OPS: ReadonlySet<string> = new Set(['chat', 'generate_content', 'text_completion']);
const isModel = (span: Span): boolean => MODEL_OPS.has(ops(span));
const isTool = (span: Span): boolean => ops(span) === 'execute_tool';
const isAgent = (span: Span): boolean => ops(span).startsWith('invoke_');

const textParts = (message: unknown): string => {
  const parts = isObj(message) && Array.isArray(message.parts) ? message.parts : [];
  return parts.flatMap((part) => (isObj(part) && part.type === 'text' && str(part.content) !== undefined ? [String(part.content)] : [])).join('\n');
};
const messagesOf = (value: unknown): Obj[] => {
  const list = structured(value);
  return Array.isArray(list) ? list.filter(isObj) : [];
};
const promptText = (span: Span): string => {
  const users = messagesOf(span.attrs['gen_ai.input.messages']).filter((message) => message.role === 'user');
  return textParts(users[users.length - 1]);
};
/** The tool call ids a model call's output messages name. */
const namedCalls = (span: Span): string[] =>
  messagesOf(span.attrs['gen_ai.output.messages']).flatMap((message) =>
    (Array.isArray(message.parts) ? message.parts : []).flatMap((part) => (isObj(part) && part.type === 'tool_call' && str(part.id) !== undefined ? [String(part.id)] : [])),
  );

const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

/** A tool span's error line: `error.type: status.message`, either alone when the other is missing, else the exception event's message. */
const failureText = (span: Span): string => {
  const type = str(span.attrs['error.type']);
  const message = span.statusMessage ?? str(span.events.find((event) => event.name === 'exception')?.['exception.message']);
  if (type !== undefined && message !== undefined) return `${type}: ${message}`;
  return type ?? message ?? 'tool failed';
};

interface Unit {
  span: Span;
  /** The session the unit's lines belong to. */
  session: string;
  /** For a subagent unit: who spawned it. */
  spawn: { parent: string; callId: string; tool: Span | undefined } | undefined;
}

/** One session as the lines `captureSession` reads. */
export interface OtelSession {
  id: string;
  size: number;
  mtimeMs: number;
  lines: Obj[];
  subagent: { parent: string; agentType: string | null; spawnedBy: string | null } | undefined;
  file: string;
}

/** The sessions of a set of spans (every trace of every file). */
export const otelSessions = (spans: readonly Span[]): OtelSession[] => {
  const byId = new Map(spans.map((span) => [`${span.trace}/${span.id}`, span]));
  const parentOf = (span: Span): Span | undefined => (span.parent === undefined ? undefined : byId.get(`${span.trace}/${span.parent}`));
  // Each lookup below is built once: a file-exporter folder grows without bound and every deposit reads all of it, so nothing here may scan every span per span.
  const chainOf = new Map<Span, Span[]>();
  const ancestors = (span: Span): Span[] => {
    const held = chainOf.get(span);
    if (held !== undefined) return held;
    const chain: Span[] = [];
    for (let at = parentOf(span); at !== undefined && chain.length < 256; at = parentOf(at)) chain.push(at);
    chainOf.set(span, chain);
    return chain;
  };
  const childrenOf = new Map<string, Span[]>();
  const agentTraces = new Set<string>();
  for (const span of spans) {
    if (isAgent(span)) agentTraces.add(span.trace);
    if (span.parent === undefined) continue;
    const key = `${span.trace}/${span.parent}`;
    const siblings = childrenOf.get(key);
    if (siblings === undefined) childrenOf.set(key, [span]);
    else siblings.push(span);
  }
  const roots = spans.filter((span) => parentOf(span) === undefined);
  const startOf = (span: Span): number => span.start ?? span.end ?? 0;
  const conversationOf = new Map<string, string>();
  for (const span of [...spans].sort((a, b) => startOf(a) - startOf(b))) {
    const conversation = str(span.attrs['gen_ai.conversation.id']);
    if (conversation !== undefined && !conversationOf.has(span.trace)) conversationOf.set(span.trace, conversation);
  }
  const tracePart = (trace: string): string => (/^[A-Za-z0-9]{1,64}$/.test(trace) ? trace : digest(trace));
  const sessionOfTrace = (trace: string): string => {
    const conversation = conversationOf.get(trace);
    return conversation === undefined ? tracePart(trace) : `conv-${digest(conversation)}`;
  };

  // A unit is an agent span, or a trace root that is not one: whatever owns the model calls and tools beneath it.
  const unitOf = new Map<Span, Unit>();
  const agentsAbove = (span: Span): Span | undefined => ancestors(span).find(isAgent);
  const rootUnits = new Set<Span>();
  for (const span of spans) {
    if (isAgent(span)) {
      const above = agentsAbove(span);
      if (above === undefined) {
        unitOf.set(span, { span, session: sessionOfTrace(span.trace), spawn: undefined });
        rootUnits.add(span);
      }
    }
  }
  // The agents nested in another: found after the roots, outermost first, so a parent's session is known.
  const nested = spans.filter((span) => isAgent(span) && !unitOf.has(span)).sort((a, b) => ancestors(a).length - ancestors(b).length);
  for (const span of nested) {
    const above = agentsAbove(span);
    const parentUnit = above === undefined ? undefined : unitOf.get(above);
    if (parentUnit === undefined) continue;
    const between = ancestors(span).slice(0, ancestors(span).indexOf(above ?? span)).find(isTool);
    unitOf.set(span, { span, session: `${tracePart(span.trace)}-${span.id}`, spawn: { parent: parentUnit.session, callId: between === undefined ? span.id : (str(between.attrs['gen_ai.tool.call.id']) ?? between.id), tool: between } });
  }
  // A trace with no agent span: its earliest root is the one unit. The other roots are spans whose parent never reached the data (the root span ends last, so a batch exporter writes it last),
  // and they fall through to that unit like any call outside an agent, instead of each opening a prompt of its own.
  const earliestRoot = new Map<string, Span>();
  for (const root of roots) {
    if (isAgent(root) || agentTraces.has(root.trace)) continue;
    const held = earliestRoot.get(root.trace);
    if (held === undefined || startOf(root) < startOf(held) || (startOf(root) === startOf(held) && root.order < held.order)) earliestRoot.set(root.trace, root);
  }
  for (const root of earliestRoot.values()) {
    unitOf.set(root, { span: root, session: sessionOfTrace(root.trace), spawn: undefined });
    rootUnits.add(root);
  }
  // A call outside every agent span (a sibling of it under a custom root) belongs to the trace's first root unit instead of being dropped.
  const firstRootUnit = new Map<string, Unit>();
  for (const root of rootUnits) {
    const unit = unitOf.get(root);
    if (unit !== undefined && !firstRootUnit.has(root.trace)) firstRootUnit.set(root.trace, unit);
  }
  const ownerOf = (span: Span): Unit | undefined => [span, ...ancestors(span)].map((candidate) => unitOf.get(candidate)).find((unit) => unit !== undefined) ?? firstRootUnit.get(span.trace);

  const members = new Map<Unit, Span[]>();
  for (const span of spans) {
    if (!isModel(span) && !isTool(span)) continue;
    const owner = ownerOf(span);
    if (owner === undefined) continue;
    const held = members.get(owner);
    if (held === undefined) members.set(owner, [span]);
    else held.push(span);
  }

  const out = new Map<string, { lines: Obj[]; mtime: number; spans: number; subagent: OtelSession['subagent']; file: string }>();
  const framework = (unit: Unit): string => unit.span.framework;
  const orderedUnits = [...unitOf.values()].sort((a, b) => startOf(a.span) - startOf(b.span) || a.span.order - b.span.order);
  // A directly nested agent is a call of the parent, though no tool span says so; grouped by the unit that owns its parent span, in one pass.
  const directOf = new Map<Unit, Span[]>();
  for (const child of orderedUnits) {
    if (child.spawn === undefined || child.spawn.tool !== undefined) continue;
    const owner = ownerOf(parentOf(child.span) ?? child.span);
    if (owner === undefined || owner.session !== child.spawn.parent || !ancestors(child.span).includes(owner.span)) continue;
    const held = directOf.get(owner);
    if (held === undefined) directOf.set(owner, [child.span]);
    else held.push(child.span);
  }
  for (const unit of orderedUnits) {
    const entry = out.get(unit.session) ?? { lines: [], mtime: 0, spans: 0, subagent: undefined, file: unit.span.file };
    out.set(unit.session, entry);
    if (unit.spawn !== undefined) {
      const agentName = str(unit.span.attrs['gen_ai.agent.name']);
      entry.subagent = { parent: `otel-${unit.spawn.parent}`, agentType: agentName ?? null, spawnedBy: unit.spawn.callId };
    }
    const base = { sessionId: unit.session, version: framework(unit) };
    const stamp = (ms: number | undefined): number => {
      // A missing or zero time says nothing about when: the latest time so far in this session stands.
      if (ms === undefined) return entry.mtime;
      entry.mtime = Math.max(entry.mtime, ms);
      return ms;
    };
    const iso = (ms: number): string => new Date(ms).toISOString();
    // A directly nested agent is a call of the parent; it is placed among the unit's own spans by start time.
    const direct = new Set(directOf.get(unit) ?? []);
    const mine = [...(members.get(unit) ?? []), ...direct].sort((a, b) => startOf(a) - startOf(b) || a.order - b.order);
    // A first unit with no time of its own is dated by the earliest timed span it holds before it falls back to 0.
    const earliest = mine.reduce<number | undefined>((least, span) => {
      const at = span.start ?? span.end;
      return at !== undefined && (least === undefined || at < least) ? at : least;
    }, undefined);
    const begin = stamp(unit.span.start ?? unit.span.end ?? (entry.mtime === 0 ? earliest : undefined));
    const text = promptText(unit.span);
    const pieces: { t: number; rank: number; line: Obj }[] = [];
    pieces.push({ t: begin, rank: -1, line: { ...base, type: 'user', uuid: `${unit.session}-${unit.span.id}-u`, timestamp: iso(begin), message: { role: 'user', content: [text === '' ? { type: 'image' } : { type: 'text', text }] } } });

    const calls: { span: Span; content: Obj[]; line: Obj; end: number; names: string[] }[] = [];
    const assistant = (span: Span, requestId: string): { content: Obj[]; line: Obj; message: Obj } => {
      const content: Obj[] = [];
      const t = Math.max(stamp(span.start ?? span.end), begin);
      const model = str(span.attrs['gen_ai.response.model']) ?? str(span.attrs['gen_ai.request.model']);
      const message: Obj = { role: 'assistant', content };
      const line: Obj = { ...base, type: 'assistant', uuid: `${unit.session}-${span.id}-a`, requestId, timestamp: iso(t), ...(model === undefined ? {} : { requestedModel: model }), message };
      pieces.push({ t, rank: 0, line });
      return { content, line, message };
    };
    const attach = (callId: string, tool: Span): { content: Obj[] } => {
      const named = calls.find((call) => call.names.includes(callId));
      const before = calls.findLast((call) => call.end <= startOf(tool));
      const chosen = named ?? before;
      if (chosen !== undefined) return chosen;
      return assistant(tool, `${tool.id}-call`);
    };
    const result = (id: string, tool: Span, failure: string | undefined): void => {
      const t = Math.max(stamp(tool.end ?? tool.start), begin);
      pieces.push({
        t,
        rank: 1,
        line: { ...base, type: 'user', uuid: `${unit.session}-${tool.id}-r-${id}`, timestamp: iso(t), noDuration: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failure !== undefined, content: failure ?? '' }] } },
      });
    };

    for (const span of mine) {
      if (direct.has(span)) {
        attach(span.id, span).content.push({ type: 'tool_use', id: span.id, name: 'invoke_agent', native: 'invoke_agent', input: {} });
        result(span.id, span, span.failed ? failureText(span) : undefined);
      } else if (isModel(span)) {
        const { content, line, message } = assistant(span, span.id);
        const reply = messagesOf(span.attrs['gen_ai.output.messages']).map(textParts).filter((part) => part !== '').join('\n');
        if (reply !== '') content.push({ type: 'text', text: reply });
        const input = count(span.attrs['gen_ai.usage.input_tokens']);
        const output = count(span.attrs['gen_ai.usage.output_tokens']);
        const read = count(span.attrs['gen_ai.usage.cache_read.input_tokens']);
        const write = count(span.attrs['gen_ai.usage.cache_write.input_tokens']);
        const thinking = count(span.attrs['gen_ai.usage.reasoning.output_tokens']);
        const reported = [input, output, read, write, thinking].some((figure) => figure !== undefined);
        if (reported) {
          // `input_tokens` includes the cache reads and writes (registry: it SHOULD), and capture's fields are disjoint; a figure not reported is not written, so it is not read as zero.
          const usage: Obj = {
            ...(input === undefined ? {} : { input_tokens: Math.max(input - (read ?? 0) - (write ?? 0), 0) }),
            ...(read === undefined ? {} : { cache_read_input_tokens: read }),
            ...(write === undefined ? {} : { cache_creation_input_tokens: write }),
            ...(output === undefined ? {} : { output_tokens: output }),
            ...(thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
          };
          message.usage = usage;
        }
        calls.push({ span, content, line, end: span.end ?? startOf(span), names: namedCalls(span) });
      } else {
        const id = str(span.attrs['gen_ai.tool.call.id']) ?? span.id;
        const toolName = str(span.attrs['gen_ai.tool.name']) ?? span.name.replace(/^execute_tool\s*/, '');
        const argsValue = structured(span.attrs['gen_ai.tool.call.arguments']);
        const args: Obj = isObj(argsValue) ? argsValue : {};
        const exit = typeof span.attrs['process.exit.code'] === 'number' ? span.attrs['process.exit.code'] : undefined;
        const command = exit !== undefined || str(span.attrs['process.executable.name']) !== undefined;
        const skill = str(span.attrs['gen_ai.skill.name']);
        const resource = str(span.attrs['gen_ai.skill.resource.name']);
        const spawned = str(span.attrs['gen_ai.transfer.mode']) !== undefined || str(span.attrs['gen_ai.transfer.target.name']) !== undefined || (childrenOf.get(`${span.trace}/${span.id}`) ?? []).some(isAgent);
        const mcp = str(span.attrs['mcp.method.name']) === 'tools/call';
        const block: Obj = { type: 'tool_use', id, name: toolName, native: toolName, input: args };
        let failed = span.failed;
        if (command) {
          const cmd = str(args.command);
          block.name = 'Bash';
          block.native = 'bash';
          block.input = cmd === undefined ? {} : { command: cmd };
          if (exit !== undefined && exit !== 0) failed = true;
        } else if (skill !== undefined) {
          block.native = resource === undefined ? 'load_skill' : 'load_skill_resource';
          block.input = resource === undefined ? { skill } : { file_path: resource };
        } else if (spawned) {
          block.native = 'invoke_agent';
        } else if (mcp) {
          // The conventions carry no MCP server name (mcp.md:143-213), so the call is written under a server that names none.
          block.name = `mcp__unnamed__${toolName}`;
          block.native = block.name;
        }
        attach(id, span).content.push(block);
        result(id, span, failed ? (exit !== undefined && exit !== 0 && !span.failed ? `Exit code ${String(exit)}` : failureText(span)) : undefined);
      }
    }
    pieces.sort((a, b) => a.t - b.t || a.rank - b.rank);
    entry.lines.push(...pieces.map((piece) => piece.line));
    entry.spans += 1 + mine.length;
  }
  return [...out.entries()].map(([id, held]) => ({ id, size: held.spans, mtimeMs: held.mtime, lines: held.lines, subagent: held.subagent, file: held.file }));
};

/** A trace session found in the folder, before its lines are read. */
export interface OtelFound {
  id: string;
  /** Always null: a trace names no working folder. */
  folder: null;
  size: number;
  mtimeMs: number;
  subagent: OtelSession['subagent'];
  file: string;
}

export interface OtelStore {
  sessions: OtelFound[];
  transcript: (session: OtelFound) => string;
  rejected: number;
  unreadable: { file: string; reason: string }[];
}

const SAFE = /^(?!\.+$)[A-Za-z0-9._-]+$/;

export const openOtelStore = async (root: string): Promise<OtelStore | undefined> => {
  let names: string[];
  try {
    names = (await readdir(root)).filter((name) => /\.jsonl?$/i.test(name)).sort();
  } catch (error) {
    if (missing(error)) return undefined;
    return { sessions: [], transcript: () => '', rejected: 0, unreadable: [{ file: root, reason: reasonOf(error, root) }] };
  }
  const unreadable: { file: string; reason: string }[] = [];
  const spans: Span[] = [];
  const order = { next: 0 };
  // The torn lines of each file stay with that file: a session that came from it counts them, else the file is named.
  const torn = new Map<string, string[]>();
  for (const name of names) {
    const file = join(root, name);
    try {
      if (!(await stat(file)).isFile()) continue;
      const { requests, bad } = requestsOf(await readFile(file, 'utf8'));
      if (bad.length > 0) torn.set(file, bad);
      for (const request of requests) {
        spans.push(...spansOf(request, order, file));
      }
    } catch (error) {
      unreadable.push({ file, reason: reasonOf(error, file) });
    }
  }
  const built = otelSessions(spans);
  let rejected = 0;
  const sessions: OtelFound[] = [];
  const lines = new Map<string, Obj[]>();
  for (const session of built) {
    if (!SAFE.test(session.id)) {
      rejected += 1;
      continue;
    }
    lines.set(session.id, session.lines);
    sessions.push({ id: session.id, folder: null, size: session.size, mtimeMs: session.mtimeMs, subagent: session.subagent, file: session.file });
  }
  sessions.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  const tornOf = new Map<string, string[]>();
  for (const [file, bad] of torn) {
    const owner = sessions.find((session) => session.file === file);
    if (owner === undefined) unreadable.push({ file, reason: `${String(bad.length)} ${bad.length === 1 ? 'line is' : 'lines are'} not JSON` });
    else tornOf.set(owner.id, bad);
  }
  return {
    sessions,
    rejected,
    unreadable,
    transcript: (session) => {
      const held = lines.get(session.id) ?? [];
      const text = [...held.map((line) => JSON.stringify(line)), ...(tornOf.get(session.id) ?? [])].join('\n');
      return text === '' ? '' : `${text}\n`;
    },
  };
};
