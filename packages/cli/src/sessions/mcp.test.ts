import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleMessage, serve, TOOL_NAME } from './mcp.js';
import { deposit, paths, readCalls } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);
const now = () => NOW;

describe('MCP server', () => {
  it('answers initialize, ping, and tools/list, and ignores notifications', async () => {
    const { runtime } = stage();
    expect(field(field(await handleMessage(runtime, now, { jsonrpc: '2.0', id: 1, method: 'initialize' }), 'result'), 'capabilities')).toEqual({ tools: {} });
    expect(field(await handleMessage(runtime, now, { jsonrpc: '2.0', id: 2, method: 'ping' }), 'result')).toEqual({});
    const list = field(field(await handleMessage(runtime, now, { jsonrpc: '2.0', id: 3, method: 'tools/list' }), 'result'), 'tools');
    expect(Array.isArray(list) && list.map((tool: unknown) => field(tool, 'name'))).toEqual([TOOL_NAME]);
    expect(await handleMessage(runtime, now, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
  });

  it('rejects an unknown method, an unknown tool, and a malformed request', async () => {
    const { runtime } = stage();
    expect(field(field(await handleMessage(runtime, now, { jsonrpc: '2.0', id: 1, method: 'nope' }), 'error'), 'code')).toBe(-32601);
    expect(field(field(await handleMessage(runtime, now, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'other' } }), 'error'), 'code')).toBe(-32602);
    expect(field(field(await handleMessage(runtime, now, { jsonrpc: '2.0', id: 1, method: 'tools/call' }), 'error'), 'message')).toBe('Unknown tool: ');
    expect(field(field(await handleMessage(runtime, now, 5), 'error'), 'code')).toBe(-32600);
    expect(field(await handleMessage(runtime, now, { id: 9 }), 'id')).toBe(9);
  });

  it('answers a recall call from the store and logs it', async () => {
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now });
    const reply = await handleMessage(staged.runtime, now, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: TOOL_NAME, arguments: { error: 'unexpected EOF while looking for matching quote', sinceDays: 30, path: 7, class: 'edit-verify', extra: true } },
    });
    const result = field(reply, 'result');
    const content = field(result, 'content');
    expect(Array.isArray(content) && String(field(content[0], 'text'))).toContain('2 sessions');
    expect(await readCalls(staged.storeDir)).toEqual([{ at: new Date(NOW).toISOString(), query: '{"error":"unexpected EOF while looking for matching quote","cls":"edit-verify","sinceDays":30}', matches: 1 }]);
    await handleMessage(staged.runtime, now, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: TOOL_NAME, arguments: 'bad' } });
    expect(readFileSync(paths(staged.storeDir).calls, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('answers a store failure inside tools/call with -32603 instead of rejecting', async () => {
    const staged = stage();
    writeFileSync(join(staged.root, 'blocker'), 'a file where the store folder should be');
    const runtime = { ...staged.runtime, storeDir: join(staged.root, 'blocker') };
    const reply = await handleMessage(runtime, now, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: TOOL_NAME, arguments: { class: 'edit-verify' } } });
    expect(field(field(reply, 'error'), 'code')).toBe(-32603);
  });

  it('serves newline-delimited requests on stdio until stdin ends, answering garbage with a parse error', async () => {
    const staged = stage();
    staged.stdin.write('not json\n\n');
    staged.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    staged.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    staged.stdin.end();
    await serve(staged.runtime, now);
    expect(staged.written.map((line): unknown => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { jsonrpc: '2.0', id: 1, result: {} },
    ]);
  });
});
