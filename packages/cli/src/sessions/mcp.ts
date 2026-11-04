// `oars sessions recall --mcp`: a Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0) exposing the same
// query as one tool, so a running agent can look a failure up before re-solving it. Hand-rolled because the surface is three
// methods and the package takes no new dependency for it. Every answered call is appended to `mcp-calls.jsonl`, which is what
// `oars sessions measure` reads for recall calls per session.
import { appendFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { currentPool } from './pool.js';
import { appendRecall } from './recall-object.js';
import { formsRefusal, pull, pullRefusal, RECALL_FAMILIES, type PullInput } from './recall-reads.js';
import { MISS_TEXT } from './recall-render.js';
import type { RecallCall } from './schema.js';
import { tryLog } from './steps.js';
import { loadStore, paths, readRedactDomains, type SessionsRuntime } from './store.js';

const PROTOCOL = '2025-06-18';

export const TOOL_NAME = 'oars_recall';

const TOOL = {
  name: TOOL_NAME,
  description:
    "Look up a tool error, a file, or a prompt class in this operator's own past agent sessions before solving it again. Returns counts per read: sessions, days, harness versions, how far the evidence sits from you, and the actions that followed. Local; each call is recorded as a recall.",
  inputSchema: {
    type: 'object',
    properties: {
      error: { type: 'string', description: 'The error text, as printed.' },
      path: { type: 'string', description: 'A file path or file name an earlier session touched.' },
      class: { type: 'string', description: 'A prompt class: edit-verify, edit-only, shell-only, research, orchestration, explore-only, mixed, no-tools.' },
      sinceDays: { type: 'integer', minimum: 1, description: 'Only errors from the last N days.' },
      prefix: { type: 'array', items: { type: 'string' }, description: 'Read IDs for your steps so far: what happened from here?' },
      entity: { type: 'string', description: 'A public name: a package, a tool, an MCP server, an action, or a model.' },
      family: { type: 'string', description: `A read family to answer: ${RECALL_FAMILIES.join(', ')}. Only recovery and fit can be narrowed by class or sinceDays.` },
      text: { type: 'string', description: 'Text to look for in the local record.' },
    },
  },
} as const;

interface Obj {
  [key: string]: unknown;
}

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The forms an MCP call names, by the same tests `toQuery` reads them with. */
const namedForms = (args: unknown): Parameters<typeof formsRefusal>[0] => {
  const source = isObj(args) ? args : {};
  const prefix = Array.isArray(source.prefix) ? source.prefix.filter((id): id is string => typeof id === 'string') : [];
  return [
    ...(prefix.length > 0 ? ['prefix' as const] : []),
    ...(typeof source.entity === 'string' ? ['entity' as const] : []),
    ...(typeof source.family === 'string' ? ['family' as const] : []),
    ...(typeof source.text === 'string' ? ['text' as const] : []),
    ...(typeof source.error === 'string' || typeof source.path === 'string' ? ['error or path' as const] : []),
  ];
};

const toQuery = (args: unknown): PullInput => {
  const source = isObj(args) ? args : {};
  const narrowing: { cls?: string; sinceDays?: number } = {};
  if (typeof source.class === 'string') narrowing.cls = source.class;
  if (typeof source.sinceDays === 'number' && Number.isInteger(source.sinceDays) && source.sinceDays > 0) narrowing.sinceDays = source.sinceDays;
  const prefix = Array.isArray(source.prefix) ? source.prefix.filter((id): id is string => typeof id === 'string') : [];
  if (prefix.length > 0) return { form: 'pattern', prefix, slice: narrowing };
  if (typeof source.entity === 'string') return { form: 'entity', entity: source.entity, slice: narrowing };
  if (typeof source.family === 'string') return { form: 'question', family: source.family, slice: narrowing };
  if (typeof source.text === 'string') return { form: 'text', text: source.text, slice: narrowing };
  const query: { error?: string; path?: string } = {};
  if (typeof source.error === 'string') query.error = source.error;
  if (typeof source.path === 'string') query.path = source.path;
  return { ...query, ...narrowing };
};

const reply = (id: unknown, result: object): object => ({ jsonrpc: '2.0', id, result });
const failure = (id: unknown, code: number, message: string): object => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Answers one JSON-RPC message; a notification (no `id`) gets no answer. */
export const handleMessage = async (runtime: SessionsRuntime, now: () => number, message: unknown): Promise<object | undefined> => {
  if (!isObj(message) || typeof message.method !== 'string') return failure(isObj(message) ? message.id : null, -32600, 'Invalid request');
  const { id, method } = message;
  if (id === undefined) return undefined;
  if (method === 'initialize') {
    return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'oars-sessions', version: '1' } });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: [TOOL] });
  if (method === 'tools/call') {
    const params = isObj(message.params) ? message.params : {};
    if (params.name !== TOOL_NAME) return failure(id, -32602, `Unknown tool: ${typeof params.name === 'string' ? params.name : ''}`);
    const conflict = formsRefusal(namedForms(params.arguments));
    if (conflict !== undefined) return failure(id, -32602, conflict);
    const query = toQuery(params.arguments);
    const refusal = pullRefusal(query);
    if (refusal !== undefined) return failure(id, -32602, refusal);
    try {
      // The server is not told which session it serves, so `sid` is null: naming it is what a consequence for an MCP pull still needs.
      const store = await loadStore(runtime.storeDir);
      const result = pull(store, query, { sid: null, now: now(), frame: null, redactDomains: await readRedactDomains(runtime.storeDir), current: await currentPool(runtime.storeDir, store) });
      const call: RecallCall = { at: new Date(now()).toISOString(), query: JSON.stringify(query), matches: result.legacy?.matches.length ?? result.reads.length, cwd: process.cwd() };
      // A pull always answers: a log or recall row that cannot be written costs the record, never the agent's answer.
      await tryLog(async () => {
        await mkdir(runtime.storeDir, { recursive: true });
        await appendFile(paths(runtime.storeDir).calls, `${JSON.stringify(call)}\n`, { mode: 0o600 });
      });
      await tryLog(() => appendRecall(runtime.storeDir, result.recall));
      // An agent reads this, so it gets the rendered counts and the structured recall, and no signature text.
      const { answer, id: recallId, evidence } = result.recall;
      return reply(id, { content: [{ type: 'text', text: answer.rendered === '' ? MISS_TEXT : answer.rendered }], structuredContent: { recallId, kind: answer.kind, reads: answer.reads, evidence } });
    } catch (error) {
      // A store read failure must not end the server mid-session: the agent gets an error for this call and can carry on.
      return failure(id, -32603, `Internal error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failure(id, -32601, `Method not found: ${method}`);
};

/** Reads requests from `runtime.stdin` until it ends, writing one response line per request to `runtime.stdout`. */
export const serve = async (runtime: SessionsRuntime, now: () => number): Promise<void> => {
  const lines = createInterface({ input: runtime.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      runtime.stdout.write(`${JSON.stringify(failure(null, -32700, 'Parse error'))}\n`);
      continue;
    }
    const answer = await handleMessage(runtime, now, parsed);
    if (answer !== undefined) runtime.stdout.write(`${JSON.stringify(answer)}\n`);
  }
};
