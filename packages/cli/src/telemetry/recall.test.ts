// A recall leaves one `recall` event of counts and closed words: how it was asked, the families it served, how many reads and evidence rows, the size of the answer, and its
// arm. The query's text, a name, and the rendered answer never reach the spool, and the recall's own output is the same with telemetry on and off.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfigDir } from '../credentials.js';
import { sessionsDeposit, sessionsRecall, type SessionsDeps } from '../sessions/command.js';
import { handleMessage, TOOL_NAME } from '../sessions/mcp.js';
import { makeRecall } from '../sessions/recall-object.js';
import { cleanup, NOW, stage, type Staged } from '../sessions/test-support.js';
import { emitFor } from './emit.js';
import { recallFields } from './fields.js';
import { readSpool } from './spool.js';

const roots: string[] = [];
afterEach(() => {
  cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const spoolFolder = (): string => {
  const appData = mkdtempSync(join(tmpdir(), 'oars-recall-telemetry-'));
  roots.push(appData);
  const configDir = defaultConfigDir({ APPDATA: appData }, 'win32', 'C:\\unused-home');
  expect(configDir).toBe(appData);
  return join(configDir, 'oars', 'telemetry');
};

const depsOf = (staged: Staged, dir?: string): SessionsDeps => ({
  sessions: staged.runtime,
  install: undefined,
  now: () => NOW,
  ...(dir === undefined ? {} : { telemetry: emitFor({ env: {}, telemetry: { dir, platform: 'linux' }, version: () => '1.2.3', now: () => NOW }) }),
});

const recalls = (dir: string): { [field: string]: unknown }[] =>
  readSpool(dir).flatMap((line) => {
    const parsed: unknown = JSON.parse(line);
    const data: unknown = typeof parsed === 'object' && parsed !== null && Reflect.get(parsed, 'type') === 'recall' ? Reflect.get(parsed, 'data') : undefined;
    return typeof data === 'object' && data !== null ? [Object.fromEntries(Object.entries(data))] : [];
  });

/** Walks `keys` down an untyped value; an array at the end, else empty. */
const field = (value: unknown, ...keys: string[]): unknown[] => {
  const found = keys.reduce((at: unknown, key): unknown => (typeof at === 'object' && at !== null ? Reflect.get(at, key) : undefined), value);
  return Array.isArray(found) ? found : [];
};

const PRIVATE = 'the acme-billing refactor that Sam asked for';

describe('a recall records its counts', () => {
  it.each([
    ['an error text', { error: 'bash: -c: line 7: unexpected EOF while looking for matching quote' }, 'legacy'],
    ['a free-text question', { form: 'text', text: PRIVATE }, 'text'],
    ['an entity', { form: 'entity', entity: 'left-pad' }, 'entity'],
    ['a pattern', { form: 'pattern', prefix: ['ab12cd34ef56ab78'] }, 'pattern'],
    ['a family', { form: 'question', family: 'fit' }, 'question'],
  ] as const)('%s: one event, the form, counts, and nothing typed', async (_label, query, form) => {
    const dir = spoolFolder();
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    const outcome = await sessionsRecall(depsOf(staged, dir), query);
    const [event, ...rest] = recalls(dir);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({ form, mode: 'pull', arm: 'shown' });
    expect(event?.reads).toBe(field(outcome.document, 'recall', 'answer', 'reads').length);
    expect(['hit', 'miss']).toContain(event?.kind);
    const spool = readSpool(dir).join('\n');
    for (const typed of [PRIVATE, 'acme', 'left-pad', 'unexpected EOF', 'ab12cd34ef56ab78']) expect(spool).not.toContain(typed);
  });

  it('prints and returns the same with telemetry on as without, and with a spool that cannot be written', async () => {
    const dir = spoolFolder();
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    const without = await sessionsRecall(depsOf(staged), { form: 'text', text: PRIVATE });
    const withIt = await sessionsRecall(depsOf(staged, dir), { form: 'text', text: PRIVATE });
    expect(withIt).toEqual(without);
    expect(recalls(dir)).toHaveLength(1);
  });

  it("an agent's recall through the MCP tool records the same event, and its answer is the same with telemetry on and off", async () => {
    const dir = spoolFolder();
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: TOOL_NAME, arguments: { text: PRIVATE } } };
    const without = await handleMessage(staged.runtime, () => NOW, message);
    const withIt = await handleMessage(staged.runtime, () => NOW, message, emitFor({ env: {}, telemetry: { dir, platform: 'linux' }, version: () => '1.2.3', now: () => NOW }));
    expect(withIt).toEqual(without);
    expect(recalls(dir)).toHaveLength(1);
    expect(recalls(dir)[0]).toMatchObject({ form: 'text', mode: 'pull' });
    expect(readSpool(dir).join('\n')).not.toContain('acme');
  });

  it('counts the reads, evidence rows, and tokens of a recall, and each family once', () => {
    const recall = makeRecall({
      sid: 's',
      at: '2026-11-01T00:00:00.000Z',
      frame: null,
      mode: 'push',
      query: { form: 'pattern', prefix: ['p'] },
      poolVersion: 'v1',
      arm: 'held',
      reads: ['read:a', 'read:b'],
      rendered: 'failed 3 of 30 calls',
      names: [],
      evidence: [],
    });
    expect(recallFields(recall, ['fit', 'recovery', 'fit'])).toEqual({ form: 'pattern', mode: 'push', families: ['fit', 'recovery'], kind: 'hit', reads: 2, evidence: 0, tokens: recall.answer.tokens, arm: 'held' });
  });
});
