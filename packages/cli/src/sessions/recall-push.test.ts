import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readHookCalls } from './hook-calls.js';
import { indexPath, type HookIndex } from './hook-index.js';
import { runHook } from './hooks.js';
import { armOf, HOLDBACK_RATE, readRecalls, recallsPath } from './recall-object.js';
import { frameOfTail, tailOf } from './recall-push.js';
import { toolShapeId, type RecallRead } from './recall-reads.js';
import { readSteps } from './steps.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const AT = '2026-11-01T00:00:00.000Z';
const SHAPE = toolShapeId('Monitor', ['query', 'max_results']);

const read: RecallRead = {
  readId: SHAPE,
  family: 'fit',
  tool: 'Monitor',
  keys: ['max_results', 'query'],
  n: 40,
  count: 175,
  calls: 175,
  clusters: 1,
  firstDay: '2026-10-01',
  lastDay: '2026-10-30',
  harnesses: ['claude-code'],
  harnessVersions: ['2.1.300'],
  models: ['claude-opus-4-5'],
  followed: [['Bash', 12]],
};

const stagedIndex = (over: Partial<HookIndex> = {}) => {
  const staged = stage();
  mkdirSync(staged.storeDir, { recursive: true });
  const index: HookIndex = { at: AT, redactDomains: [], projects: {}, signatures: {}, fit: { [SHAPE]: read }, ...over };
  writeFileSync(indexPath(staged.storeDir), JSON.stringify(index));
  return staged;
};

/** A session the arm hash puts on the arm asked for: the arm is a pure function of the session, so a test picks a session, never a mock. */
const sessionOn = (arm: 'shown' | 'held', skip = 0): string => {
  let left = skip;
  for (let index = 0; index < 10_000; index += 1) {
    const sid = `session-${String(index)}`;
    if (armOf(sid, [SHAPE], AT) === arm && left-- === 0) return sid;
  }
  throw new Error('no session on that arm');
};

const call = (sid: string, over: { [key: string]: unknown } = {}): string => JSON.stringify({ session_id: sid, tool_name: 'Monitor', tool_input: { query: 'a typed value', max_results: 3 }, hook_event_name: 'PreToolUse', ...over });

const specific = (output: string | undefined): { [key: string]: unknown } => {
  const parsed: unknown = JSON.parse(output ?? '{}');
  const inner: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'hookSpecificOutput') : undefined;
  return typeof inner === 'object' && inner !== null ? Object.fromEntries(Object.entries(inner)) : {};
};

describe('the arm', () => {
  it('is stable for one session, prefix, and pool, and moves when the pool does', () => {
    expect(armOf('s', ['p'], 'v1')).toBe(armOf('s', ['p'], 'v1'));
    const pools = Array.from({ length: 200 }, (_, index) => armOf('s', ['p'], `v${String(index)}`));
    expect(new Set(pools).size).toBe(2);
  });

  it('holds back about the rate over many hashes', () => {
    const total = 20_000;
    let held = 0;
    for (let index = 0; index < total; index += 1) if (armOf(`session-${String(index)}`, [SHAPE], AT) === 'held') held += 1;
    expect(held / total).toBeGreaterThan(HOLDBACK_RATE - 0.01);
    expect(held / total).toBeLessThan(HOLDBACK_RATE + 0.01);
  });
});

describe('the pre-tool push', () => {
  it('injects counts for a shown arm, records the push, and writes nothing but additionalContext', async () => {
    const staged = stagedIndex();
    const sid = sessionOn('shown');
    const output = await runHook('pre-tool', call(sid), staged.runtime, () => NOW);
    const inner = specific(output);
    expect(Object.keys(inner).sort()).toEqual(['additionalContext', 'hookEventName']);
    expect(inner.hookEventName).toBe('PreToolUse');
    expect(inner.additionalContext).toContain('failed 175 of 175 calls');
    expect(output).not.toContain('a typed value');
    const [recall] = await readRecalls(staged.storeDir);
    expect(recall).toMatchObject({ sid, mode: 'push', arm: 'shown', poolVersion: AT, query: { form: 'pattern', prefix: [SHAPE] }, answer: { kind: 'hit', reads: [SHAPE] } });
    expect(recall?.answer.rendered).toBe(inner.additionalContext);
    expect(recall?.evidence[0]?.ref).toBe(SHAPE);
    expect((await readHookCalls(staged.storeDir))[0]).toMatchObject({ event: 'pre-tool', session: sid, hit: true });
    expect((await readSteps(staged.storeDir))[0]).toMatchObject({ step: 'recall', trigger: 'pre-tool', status: 'ok', out: { matches: 1 } });
  });

  it('injects nothing for a held arm and stores what it would have shown', async () => {
    const staged = stagedIndex();
    const sid = sessionOn('held');
    expect(await runHook('pre-tool', call(sid), staged.runtime, () => NOW)).toBeUndefined();
    const [recall] = await readRecalls(staged.storeDir);
    expect(recall).toMatchObject({ sid, arm: 'held', answer: { kind: 'hit', reads: [SHAPE] } });
    expect(recall?.answer.rendered).toContain('failed 175 of 175 calls');
    expect(recall?.answer.tokens).toBeGreaterThan(0);
  });

  it('pushes a shape once per session, and again for another session', async () => {
    const staged = stagedIndex();
    const sid = sessionOn('shown');
    const other = sessionOn('shown', 1);
    expect(await runHook('pre-tool', call(sid), staged.runtime, () => NOW)).toBeDefined();
    expect(await runHook('pre-tool', call(sid), staged.runtime, () => NOW + 1)).toBeUndefined();
    expect(await runHook('pre-tool', call(other), staged.runtime, () => NOW + 2)).toBeDefined();
    expect((await readRecalls(staged.storeDir)).map((recall) => recall.sid)).toEqual([sid, other]);
  });

  it('says nothing and keeps no row for a call no read covers, with no session, with no tool, or on garbage', async () => {
    const staged = stagedIndex();
    expect(await runHook('pre-tool', call('s', { tool_input: { command: 'ls' } }), staged.runtime, () => NOW)).toBeUndefined();
    expect(await runHook('pre-tool', call('s', { tool_input: 'not an object' }), staged.runtime, () => NOW)).toBeUndefined();
    expect(await runHook('pre-tool', call('s', { tool_name: undefined }), staged.runtime, () => NOW)).toBeUndefined();
    expect(await runHook('pre-tool', JSON.stringify({ tool_name: 'Monitor' }), staged.runtime, () => NOW)).toBeUndefined();
    expect(await runHook('pre-tool', 'not json', staged.runtime, () => NOW)).toBeUndefined();
    expect(await readRecalls(staged.storeDir)).toEqual([]);
    expect(await readSteps(staged.storeDir)).toEqual([]);
  });

  it('says nothing with no index, or an index written before fit reads existed', async () => {
    const bare = stage();
    expect(await runHook('pre-tool', call('s'), bare.runtime, () => NOW)).toBeUndefined();
    const older = stagedIndex();
    writeFileSync(indexPath(older.storeDir), JSON.stringify({ at: AT, redactDomains: [], projects: {}, signatures: {} }));
    expect(await runHook('pre-tool', call('s'), older.runtime, () => NOW)).toBeUndefined();
  });

  it('leaves the tool call untouched when the recall cannot be written, and injects nothing unrecorded', async () => {
    const staged = stagedIndex();
    // A directory where the file goes: the read and the append both fail.
    mkdirSync(recallsPath(staged.storeDir));
    expect(await runHook('pre-tool', call(sessionOn('shown')), staged.runtime, () => NOW)).toBeUndefined();
    const [row] = await readHookCalls(staged.storeDir);
    expect(row).toMatchObject({ event: 'pre-tool', hit: false });
    expect(row?.error).not.toBeNull();
    expect((await readSteps(staged.storeDir))[0]).toMatchObject({ step: 'recall', trigger: 'pre-tool', status: 'error' });
  });

  it('reads the frame from the transcript tail and states the distance', async () => {
    const staged = stagedIndex();
    const transcript = join(staged.root, 'transcript.jsonl');
    writeFileSync(transcript, ['{"version":"2.1.310","message":{"model":"claude-opus-4-5"}}', 'torn {'].join('\n'));
    const output = await runHook('pre-tool', call(sessionOn('shown'), { transcript_path: transcript }), staged.runtime, () => NOW);
    expect(specific(output).additionalContext).toContain('from you: harness +10, model same');
    const [recall] = await readRecalls(staged.storeDir);
    expect(recall?.frame).toMatchObject({ harness: 'claude-code', harnessVersion: '2.1.310', model: 'claude-opus-4-5' });
  });
});

describe('the tail helpers', () => {
  it('reads a file short of the tail whole, and a missing one as empty', async () => {
    const staged = stage();
    const file = join(staged.root, 'short.txt');
    writeFileSync(file, 'abc');
    expect(await tailOf(file)).toBe('abc');
    expect(await tailOf(join(staged.root, 'missing.txt'))).toBe('');
  });

  it('reads only the end of a long file', async () => {
    const staged = stage();
    const file = join(staged.root, 'long.txt');
    writeFileSync(file, `${'x'.repeat(100_000)}END`);
    const tail = await tailOf(file);
    expect(tail.endsWith('END')).toBe(true);
    expect(tail.length).toBe(64 * 1024);
  });

  it('takes the newest line that states each field, and leaves what no line states unknown', () => {
    const lines = ['{"version":"1.0.0","effort":"low","message":{"model":"claude-opus-4-5"}}', '{"version":"2.0.0","effort":"high","message":{"model":"claude-sonnet-4-5"}}', '"a string"'].join('\n');
    expect(frameOfTail(lines, 'linux', AT)).toMatchObject({ harnessVersion: '2.0.0', model: 'claude-sonnet-4-5', effort: 'high', platform: 'linux', day: '2026-11-01', shell: null });
    expect(frameOfTail('', 'linux', AT)).toMatchObject({ harnessVersion: null, model: null, effort: null });
  });
});
