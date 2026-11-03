import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractSession } from './derive.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { formatVerify, INVARIANTS, verifyAll, verifyCaptured, verifySkeleton, type InvariantResult } from './verify.js';
import { FIXTURES } from './test-support.js';

const skeletonOf = (lines: readonly string[], name = 's') =>
  extractSession({ text: lines.join('\n'), session: name, project: 'p', rev: 1, at: 'x', bytes: 0, redact: makeRedactor() }).skeleton;
const fixture = (name: string): string[] => readFileSync(join(FIXTURES, 'proj', `${name}.jsonl`), 'utf8').split('\n').filter((line) => line !== '' && line.startsWith('{"'));

const countsOf = (result: InvariantResult | undefined) =>
  Object.fromEntries((result?.observed ?? []).filter((entry) => entry.checks > 0).map((entry) => [entry.cls, entry.checks]));

const violationsOf = (lines: readonly string[]): number[] => verifySkeleton(skeletonOf(lines)).map((result) => result.violations);

describe('verify', () => {
  it('treats an empty request id as absent: each such line counts in the cost-state sum and fails the request-id invariant', () => {
    const assistant = (uuid: string, id: string): string =>
      JSON.stringify({ type: 'assistant', uuid, requestId: '', message: { role: 'assistant', id, content: [], usage: { input_tokens: 1, cache_creation_input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 5 } } });
    const cost = JSON.stringify({ type: 'cost-state', modelUsage: { m: { inputTokens: 2, cacheCreationInputTokens: 6, cacheReadInputTokens: 14, outputTokens: 10 } } });
    const results = verifySkeleton(skeletonOf([assistant('a1', 'm1'), assistant('a2', 'm2'), cost]));
    expect(results[3]).toMatchObject({ checked: 2, violations: 2 });
    expect(results[5]).toMatchObject({ checked: 4, violations: 0 });
  });

  it('passes every invariant on the clean fixtures', () => {
    const results = verifyAll(['errors-a', 'errors-b', 'tldr', 'sidechain'].map((name) => skeletonOf(fixture(name), name)));
    expect(results.map((result) => result.name)).toEqual([...INVARIANTS]);
    expect(results.map((result) => result.violations)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(results[0]?.checked).toBeGreaterThan(10);
    expect(results[4]?.checked).toBeGreaterThan(0);
    expect(formatVerify(results, 4)).toContain('PASS  tool_result names an earlier tool_use');
  });

  it('flags a deliberately corrupted file on each invariant', () => {
    const clean = fixture('errors-a');
    const parse = (line: string | undefined): { [key: string]: unknown } => {
      const value: unknown = JSON.parse(line ?? '{}');
      return typeof value === 'object' && value !== null ? { ...value } : {};
    };
    const edit = (index: number, change: (line: { [key: string]: unknown }) => void): string[] =>
      clean.map((line, position) => {
        if (position !== index) return line;
        const parsed = parse(line);
        change(parsed);
        return JSON.stringify(parsed);
      });
    const assistantIndex = clean.findIndex((line) => line.includes('"type": "assistant"') || line.includes('"type":"assistant"'));
    const resultIndex = clean.findIndex((line) => line.includes('tool_result'));
    expect(assistantIndex).toBeGreaterThan(0);

    // A tool_result naming an id no earlier tool_use has.
    expect(violationsOf(clean.map((line, position) => (position === resultIndex ? line.replace('"tool_use_id": "t1"', '"tool_use_id": "nope"') : line)))[0]).toBe(1);
    // A parentUuid that resolves nowhere.
    expect(violationsOf(edit(assistantIndex, (line) => (line.parentUuid = 'ghost')))[1]).toBe(1);
    // A timestamp stepping back by an hour.
    expect(violationsOf(edit(assistantIndex, (line) => (line.timestamp = '2020-01-01T00:00:00.000Z')))[2]).toBeGreaterThanOrEqual(1);
    // An assistant line without a request id.
    expect(violationsOf(edit(assistantIndex, (line) => delete line.requestId))[3]).toBe(1);
    // Thinking tokens above output tokens.
    const thinking = clean.findIndex((line) => line.includes('thinking_tokens'));
    expect(violationsOf(edit(thinking, (line) => {
      const message = parse(JSON.stringify(line.message));
      message.usage = { output_tokens: 1, output_tokens_details: { thinking_tokens: 99 } };
      line.message = message;
    }))[4]).toBe(1);
  });

  it('flags shared request ids whose apiBlockIndex does not advance by one', () => {
    const line = (index: number): string => JSON.stringify({ type: 'assistant', uuid: `u${String(index)}`, requestId: 'r1', apiBlockIndex: index, message: { role: 'assistant', content: [] } });
    expect(violationsOf([line(0), line(1), line(2)])[3]).toBe(0);
    expect(violationsOf([line(0), line(2)])[3]).toBe(1);
    const unindexed = JSON.stringify({ type: 'assistant', requestId: 'r1', message: { role: 'assistant', content: [] } });
    expect(violationsOf([line(0), unindexed])[3]).toBe(0);
  });

  it('checks that cost-state totals equal summed usage', () => {
    const usage = { input_tokens: 5, cache_creation_input_tokens: 6, cache_read_input_tokens: 7, output_tokens: 8 };
    const assistant = JSON.stringify({ type: 'assistant', requestId: 'r', message: { role: 'assistant', model: 'm', content: [], usage } });
    const state = (output: number): string =>
      JSON.stringify({ type: 'cost-state', totalCostUSD: 1.5, modelUsage: { m: { inputTokens: 5, cacheCreationInputTokens: 6, cacheReadInputTokens: 7, outputTokens: output } } });
    expect(verifySkeleton(skeletonOf([assistant, state(8)]))[5]).toMatchObject({ checked: 4, violations: 0 });
    // A total above the recorded sum is not a failure: it is observed, here with no side model to trace it to.
    expect(verifySkeleton(skeletonOf([assistant, state(9)]))[5]).toMatchObject({ checked: 4, violations: 0 });
    expect(countsOf(verifySkeleton(skeletonOf([assistant, state(9)]))[5])).toEqual({ other: 1 });
    expect(verifySkeleton(skeletonOf([assistant, state(7)]))[5]).toMatchObject({ checked: 4, violations: 1 });
    // Two content-block lines of one request repeat its usage; they count once. A line with no request id counts on its own.
    expect(verifySkeleton(skeletonOf([assistant, assistant, state(8)]))[5]).toMatchObject({ checked: 4, violations: 0 });
    const anonymous = JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'm', content: [], usage } });
    expect(verifySkeleton(skeletonOf([anonymous, anonymous, state(16)]))[5]).toMatchObject({ checked: 4, violations: 3 });
    expect(verifySkeleton(skeletonOf([assistant]))[5]).toMatchObject({ checked: 0, violations: 0 });
    expect(verifySkeleton(skeletonOf([assistant, JSON.stringify({ type: 'cost-state', modelUsage: 5 })]))[5]?.checked).toBe(0);
    expect(formatVerify(verifyAll([skeletonOf([assistant, state(7)])]), 1)).toContain(`FAIL  ${INVARIANTS[5]}: 3 of 4 hold, 1 exceptions`);
  });

  it('classes each check that holds only within its scope, and each total above the recorded sum (A2)', () => {
    const usage = { input_tokens: 5, cache_creation_input_tokens: 6, cache_read_input_tokens: 7, output_tokens: 8 };
    const at = (requestId: string, timestamp: string): string =>
      JSON.stringify({ type: 'assistant', requestId, timestamp, message: { role: 'assistant', model: 'm', content: [], usage } });
    const tokens = (factor: number, extra = 0) => ({ inputTokens: 5 * factor + extra, cacheCreationInputTokens: 6 * factor, cacheReadInputTokens: 7 * factor, outputTokens: 8 * factor });
    const start = Date.parse('2026-10-13T15:00:00.000Z');
    const state = (modelUsage: object): string => JSON.stringify({ type: 'cost-state', startTime: start, modelUsage });
    const before = at('r1', '2026-10-12T23:00:00.000Z');
    const after = at('r2', '2026-10-13T16:00:00.000Z');
    // Resume scope: the earlier process's request is outside the totals; with it the sum would be twice the total.
    const resumed = skeletonOf([before, after, state({ m: tokens(1) })], 'resumed');
    expect(countsOf(verifySkeleton(resumed)[5])).toEqual({ 'resume scope': 4 });
    // Subagent transcripts: the agent's two requests make the main line's one equal the total of three.
    const parent = skeletonOf([after, state({ m: tokens(3) })], 'p1');
    const agent = skeletonOf([at('s1', '2026-10-13T16:01:00.000Z'), at('s2', '2026-10-13T16:02:00.000Z')], 'p1~agent-a');
    expect(countsOf(verifyAll([parent, agent])[5])).toEqual({ 'subagent transcripts': 4 });
    // Harness side calls: a small model in modelUsage that no line names, as in 001cf645.
    const side = skeletonOf([after, state({ m: tokens(1), 'claude-haiku-4-5': { inputTokens: 300, outputTokens: 20 } })], '001cf645');
    expect(countsOf(verifySkeleton(side)[5])).toEqual({ 'harness side calls': 2 });
    // Other: the total is above the sum and every modelUsage model has a line.
    const other = skeletonOf([after, state({ m: tokens(1, 174) })], 'other');
    expect(countsOf(verifySkeleton(other)[5])).toEqual({ other: 1 });
    const results = verifyAll([resumed, parent, agent, side, other]);
    expect(results[5]).toMatchObject({ checked: 16, violations: 0 });
    const text = formatVerify(results, 5);
    expect(text).toContain(`PASS  ${INVARIANTS[5]}: 13 of 16 hold, 3 observed`);
    expect(text).toContain('      equal only within scope: 4 resume scope (e.g. resumed), 4 subagent transcripts (e.g. p1)');
    expect(text).toContain('      total above the recorded sum, as observed: 2 harness side calls (e.g. 001cf645), 1 other (e.g. other)');
    expect(formatVerify(verifyAll([skeletonOf([after, state({ m: tokens(1) })])]), 1).endsWith(`PASS  ${INVARIANTS[5]}: 4 of 4 hold`)).toBe(true);
  });

  it('classes a total above the sum as a side call only on a key a side model reported', () => {
    const usage = { input_tokens: 5, cache_creation_input_tokens: 6, cache_read_input_tokens: 7, output_tokens: 8 };
    const line = JSON.stringify({ type: 'assistant', requestId: 'r1', timestamp: '2026-10-13T16:00:00.000Z', message: { role: 'assistant', model: 'm', content: [], usage } });
    const state = (modelUsage: object): string => JSON.stringify({ type: 'cost-state', startTime: Date.parse('2026-10-13T15:00:00.000Z'), modelUsage });
    const main = { inputTokens: 5, cacheCreationInputTokens: 6, cacheReadInputTokens: 7, outputTokens: 8 };
    // The haiku entry carries zeros on the cache keys, as the transcript writes it; the cacheRead excess is not its, so that key is `other`.
    const partial = skeletonOf([line, state({ m: { ...main, cacheReadInputTokens: 107 }, 'claude-haiku-4-5': { inputTokens: 300, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } })], 'partial');
    expect(countsOf(verifySkeleton(partial)[5])).toEqual({ 'harness side calls': 2, other: 1 });
    // Once the side model reports cacheRead, the same excess is a side call.
    const full = skeletonOf([line, state({ m: { ...main, cacheReadInputTokens: 107 }, 'claude-haiku-4-5': { inputTokens: 300, cacheReadInputTokens: 100, outputTokens: 20 } })], 'full');
    expect(countsOf(verifySkeleton(full)[5])).toEqual({ 'harness side calls': 3 });
    // A skeleton written before the keys were recorded reads its side model with none, so every excess key is `other`.
    const older = skeletonOf([line, state({ m: main, 'claude-haiku-4-5': { inputTokens: 300, outputTokens: 20 } })], 'older');
    older.lines = older.lines.map((entry) => (entry.costState === null ? entry : { ...entry, costState: { ...entry.costState, models: entry.costState.models.map((model) => ({ ...model, keys: [] })) } }));
    expect(countsOf(verifySkeleton(older)[5])).toEqual({ other: 2 });
  });

  it('counts only usage since the process start, and the subagent transcripts the totals include (A2)', () => {
    const usage = { input_tokens: 5, cache_creation_input_tokens: 6, cache_read_input_tokens: 7, output_tokens: 8 };
    const at = (requestId: string, timestamp: string): string =>
      JSON.stringify({ type: 'assistant', requestId, timestamp, message: { role: 'assistant', content: [], usage } });
    const state = (startTime: unknown, factor: number): string =>
      JSON.stringify({ type: 'cost-state', startTime, modelUsage: { m: { inputTokens: 5 * factor, cacheCreationInputTokens: 6 * factor, cacheReadInputTokens: 7 * factor, outputTokens: 8 * factor } } });
    const start = Date.parse('2026-10-13T15:00:00.000Z');
    // A resumed session: the first request ran in an earlier process, before startTime, so the totals hold only the second.
    const resumed = [at('r1', '2026-10-12T23:00:00.000Z'), at('r2', '2026-10-13T16:00:00.000Z'), state(start, 1)];
    expect(verifySkeleton(skeletonOf(resumed))[5]).toMatchObject({ checked: 4, violations: 0 });
    expect(verifySkeleton(skeletonOf([...resumed.slice(0, 2), state('soon', 1)]))[5]).toMatchObject({ checked: 4, violations: 4 });
    expect(verifySkeleton(skeletonOf([...resumed.slice(0, 2), state(1e20, 1)]))[5]).toMatchObject({ checked: 4, violations: 4 });
    // The subagent's request is in the parent's totals; verifyAll joins it by the `<parent>~agent-<id>` name.
    const parent = skeletonOf([at('r2', '2026-10-13T16:00:00.000Z'), state(start, 3)], 'p1');
    const agent = skeletonOf([at('s1', '2026-10-13T16:01:00.000Z'), at('s2', '2026-10-13T16:02:00.000Z')], 'p1~agent-a');
    expect(verifyAll([parent, agent])[5]).toMatchObject({ checked: 4, violations: 0 });
    expect(verifyAll([parent, agent, skeletonOf([at('s3', '2026-10-13T16:03:00.000Z')], 'p1~agent-b')])[5]).toMatchObject({ checked: 4, violations: 4 });
  });
});

describe('verifyCaptured (the CAPTURE 4 fields)', () => {
  const capture = (cwd: string, filePath: string, sid: string | null) =>
    captureSession({
      text: [
        JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-06-01T00:00:01.000Z', cwd, message: { role: 'user', content: 'go' } }),
        JSON.stringify({ type: 'assistant', uuid: 'u2', cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: filePath } }, { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'git status' } }] } }),
      ].join('\n'),
      session: filePath,
      project: 'p',
      rev: 1,
      at: 'x',
      bytes: 0,
      redact: makeRedactor(),
      salt: 's',
      sid,
    });
  const violations = (sessions: ReturnType<typeof capture>[]) => verifyCaptured(sessions.map((one) => one.session), sessions.flatMap((one) => one.tools)).map((result) => result.violations);

  it('passes a clean version-4 capture', () => {
    expect(violations([capture('/w', '/w/a', 'aaaaaaaa'), capture('/w', '/w/b', 'aaaaaaaa')])).toEqual([0, 0, 0, 0]);
  });

  it('counts a cv-behind session, a minority sid, an unexplained fileHash, and a mislabeled target base', () => {
    const behind = capture('/w', '/w/a', 'aaaaaaaa');
    behind.session.cv = '3';
    expect(violations([behind, capture('/w', '/w/b', 'aaaaaaaa')])[0]).toBe(1);
    expect(violations([capture('/w', '/w/a', 'aaaaaaaa'), capture('/w', '/w/b', 'aaaaaaaa'), capture('/w', '/w/c', 'bbbbbbbb')])[1]).toBe(1);
    const stray = capture('/w', '/w/a', 'aaaaaaaa');
    stray.session.fileHashes.push('0123456789abcdef');
    expect(violations([stray])[2]).toBe(1);
    const mislabeled = capture('/w', '/w/a', 'aaaaaaaa');
    const [read, shell] = mislabeled.tools;
    if (read !== undefined) read.targetBase = null;
    if (shell !== undefined) shell.targetBase = 'cwd';
    expect(violations([mislabeled])[3]).toBe(2);
    // A version-2 session passes through, permanently: it is neither checked nor a violation.
    const old = capture('/w', '/w/a', 'aaaaaaaa');
    old.session.cv = '2';
    expect(verifyCaptured([old.session], old.tools)[0]).toMatchObject({ checked: 0, violations: 0 });
    const newer = capture('/w', '/w/a', 'aaaaaaaa');
    newer.session.cv = '6';
    expect(violations([newer])[0]).toBe(0);
  });
});
