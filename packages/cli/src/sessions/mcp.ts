// `oars sessions recall --mcp`: a Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0) exposing the same
// query as one tool, so a running agent can look a failure up before re-solving it. Hand-rolled because the surface is three
// methods and the package takes no new dependency for it. Every answered call is appended to `mcp-calls.jsonl`, which is what
// `oars sessions measure` reads for recall calls per session.
import { appendFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { formatRecall, recall, type RecallQuery } from './query.js';
import type { RecallCall } from './schema.js';
import { loadStore, paths, readRedactDomains, type SessionsRuntime } from './store.js';

const PROTOCOL = '2025-06-18';

export const TOOL_NAME = 'oars_recall';

const TOOL = {
  name: TOOL_NAME,
  description:
    "Look up a tool error, a file, or a prompt class in this operator's own past agent sessions before solving it again. Returns matching error signatures with session counts, first and last seen, harness versions, and the tools that followed. Local, read-only.",
  inputSchema: {
    type: 'object',
    properties: {
      error: { type: 'string', description: 'The error text, as printed.' },
      path: { type: 'string', description: 'A file path or file name an earlier session touched.' },
      class: { type: 'string', description: 'A prompt class: edit-verify, edit-only, shell-only, research, orchestration, explore-only, mixed, no-tools.' },
      sinceDays: { type: 'integer', minimum: 1, description: 'Only errors from the last N days.' },
    },
  },
} as const;

interface Obj {
  [key: string]: unknown;
}

const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

const toQuery = (args: unknown): RecallQuery => {
  const source = isObj(args) ? args : {};
  const query: RecallQuery = {};
  if (typeof source.error === 'string') query.error = source.error;
  if (typeof source.path === 'string') query.path = source.path;
  if (typeof source.class === 'string') query.cls = source.class;
  if (typeof source.sinceDays === 'number' && Number.isInteger(source.sinceDays) && source.sinceDays > 0) query.sinceDays = source.sinceDays;
  return query;
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
    const query = toQuery(params.arguments);
    try {
      const result = recall(await loadStore(runtime.storeDir), query, now(), undefined, await readRedactDomains(runtime.storeDir));
      const call: RecallCall = { at: new Date(now()).toISOString(), query: JSON.stringify(query), matches: result.matches.length, cwd: process.cwd() };
      await mkdir(runtime.storeDir, { recursive: true });
      await appendFile(paths(runtime.storeDir).calls, `${JSON.stringify(call)}\n`, { mode: 0o600 });
      return reply(id, { content: [{ type: 'text', text: formatRecall(result) }], structuredContent: result });
    } catch (error) {
      // A store or log failure must not end the server mid-session: the agent gets an error for this call and can carry on.
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
