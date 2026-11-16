// The MCP recall tool serves a bundle's same-target read only when `error`, `path`, and `failed` are all given; with `failed` absent its answer is unchanged.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { handleMessage, TOOL_NAME } from './mcp.js';
import { session, tool } from './pool-fixture.js';
import { bundleOf, keep, pair } from './pool-books-fixture.js';
import { readOf } from './next-fixtures.js';
import { recallsPath } from './recall-object.js';
import type { Read } from './read.js';
import { paths } from './store.js';
import { cleanup, NOW, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const now = () => NOW;
const field = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

const same = (step: string): Read =>
  readOf({ readId: 'read:same', family: 'recovery', slice: { failed: 'file.edit', errorCode: '1', target: 'source', step, week: '2026-11-02' }, value: { recovered: 6, followed: 8, of: 12, share: 0.5 }, n: 6, asOf: { pool: 'p1', day: '2026-11-02' } });

/** A store whose newest call states a version, and a kept bundle for that version holding `reads`. */
const staged = async (reads: Read[]): Promise<Staged> => {
  const made = stage();
  mkdirSync(made.storeDir, { recursive: true });
  writeFileSync(paths(made.storeDir).observations, [session('a'), tool('a', 0, 'Edit', { ts: '2026-06-01T00:00:00.000Z', harnessVersion: '2.1.314' })].map((row) => `${JSON.stringify(row)}\n`).join(''));
  await keep(made.storeDir, { ...bundleOf(undefined, '2.1.314'), reads }, await pair());
  return made;
};

const textOf = async (made: Staged, args: object): Promise<string> => {
  const result = field(await handleMessage(made.runtime, now, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_NAME, arguments: args } }), 'result');
  const content = field(result, 'content');
  return Array.isArray(content) ? String(field(content[0], 'text')) : '';
};

/** Every recall row the store holds, parsed. */
const rowsOf = (made: Staged): unknown[] =>
  readFileSync(recallsPath(made.storeDir), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));

/** The object without the named keys. */
const without = (value: unknown, keys: string[]): object => Object.fromEntries(Reflect.ownKeys(typeof value === 'object' && value !== null ? value : {}).map((key): [string | symbol, unknown] => [key, field(value, String(key))]).filter(([key]) => typeof key === 'string' && !keys.includes(key)));

/** The structured reply without its per-call id, and the rows the call appended without their id and time. */
const shapeOf = async (made: Staged, args: object): Promise<{ structured: object; rows: object[] }> => {
  const result = field(await handleMessage(made.runtime, now, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_NAME, arguments: args } }), 'result');
  return { structured: without(field(result, 'structuredContent'), ['recallId']), rows: rowsOf(made).map((row) => without(row, ['id', 'at'])) };
};

const ASK = { error: 'Exit code 1\nnothing seen before', path: 'src/a.ts' };

describe('oars_recall same-target read', () => {
  it('serves the read when error, path, and failed are all given', async () => {
    const made = await staged([same('file.search')]);
    expect(await textOf(made, { ...ASK, failed: 'file.edit' })).toBe('oars recall, counts from earlier sessions: after a failed file.edit (1) on a source target, file.search came back ok 6 of 8 times it followed\n  read read:same (recovery)');
  });

  it('records the served read id and its evidence in the answer and the recall row', async () => {
    const made = await staged([same('file.search')]);
    const result = field(await handleMessage(made.runtime, now, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_NAME, arguments: { ...ASK, failed: 'file.edit' } } }), 'result');
    const structured = field(result, 'structuredContent');
    expect(field(structured, 'reads')).toContain('read:same');
    expect(field(structured, 'evidence')).toEqual([expect.objectContaining({ n: 6, clusters: 1 })]);
    const row = readFileSync(recallsPath(made.storeDir), 'utf8');
    expect(row).toContain('"read:same"');
    expect(row).toContain('"n":6');
  });

  it('records what was rendered: a miss pull plus a served read is a hit whose row holds the reply text', async () => {
    const made = await staged([same('file.search')]);
    const args = { ...ASK, failed: 'file.edit' };
    const reply = await textOf(made, args);
    const rows = rowsOf(made);
    const answer = field(rows.at(-1), 'answer');
    expect(field(answer, 'rendered')).toBe(reply);
    expect(field(answer, 'kind')).toBe('hit');
    expect(field(answer, 'reads')).toEqual(['read:same']);
    expect(field(answer, 'names')).toEqual(['file.search']);
    expect(field(answer, 'bytes')).toBe(Buffer.byteLength(reply));
    expect(field(answer, 'tokens')).toBe(Math.ceil(reply.length / 4));
  });

  it('emits the recall event with the recovery family when a missed pull serves a same-target read', async () => {
    const made = await staged([same('file.search')]);
    const events: { type: string; fields: unknown }[] = [];
    await handleMessage(made.runtime, now, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_NAME, arguments: { ...ASK, failed: 'file.edit' } } }, (type, fields) => {
      events.push({ type, fields });
    });
    expect(events.map((event) => event.type)).toEqual(['recall']);
    expect(field(events[0]?.fields, 'kind')).toBe('hit');
    expect(field(events[0]?.fields, 'reads')).toBe(1);
    expect(field(events[0]?.fields, 'families')).toEqual(['recovery']);
  });

  it('words a step equal to the failed action as the same action on another kind of target', async () => {
    const made = await staged([same('file.edit')]);
    expect(await textOf(made, { ...ASK, failed: 'file.edit' })).toContain('the same action on another kind of target came back ok 6 of 8 times it followed');
  });

  it('answers byte-identically to today when failed is absent, when the bundle holds no read, or when the path names no class', async () => {
    const withRead = await staged([same('file.search')]);
    const without = await staged([]);
    const plain = await textOf(without, ASK);
    const plainShape = await shapeOf(await staged([]), ASK);
    expect(await shapeOf(await staged([same('file.search')]), ASK)).toEqual(plainShape);
    expect(await shapeOf(await staged([same('file.search')]), { ...ASK, failed: 'file.write' })).toEqual(plainShape);
    expect(await textOf(withRead, ASK)).toBe(plain);
    expect(await textOf(without, { ...ASK, failed: 'file.edit' })).toBe(plain);
    expect(await textOf(withRead, { ...ASK, failed: 'file.write' })).toBe(plain);
    expect(await textOf(withRead, { error: ASK.error, failed: 'file.edit' })).toBe(await textOf(without, { error: ASK.error }));
    expect(await textOf(withRead, { path: 'src/a.ts', failed: 'file.edit' })).toBe(await textOf(without, { path: 'src/a.ts' }));
    expect(await textOf(withRead, { ...ASK, path: '', failed: 'file.edit' })).toBe(await textOf(without, { ...ASK, path: '' }));
  });
});
