import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { formatVerify, INVARIANTS, verifyAll, verifySkeleton } from './verify.js';
import { FIXTURES } from './test-support.js';

const skeletonOf = (lines: readonly string[], name = 's') =>
  extractSession({ text: lines.join('\n'), session: name, project: 'p', rev: 1, at: 'x', bytes: 0, redact: makeRedactor() }).skeleton;
const fixture = (name: string): string[] => readFileSync(join(FIXTURES, 'proj', `${name}.jsonl`), 'utf8').split('\n').filter((line) => line !== '' && line.startsWith('{"'));

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

  it('compares cost-state totals with summed usage', () => {
    const usage = { input_tokens: 5, cache_creation_input_tokens: 6, cache_read_input_tokens: 7, output_tokens: 8 };
    const assistant = JSON.stringify({ type: 'assistant', requestId: 'r', message: { role: 'assistant', content: [], usage } });
    const state = (output: number): string =>
      JSON.stringify({ type: 'cost-state', totalCostUSD: 1.5, modelUsage: { m: { inputTokens: 5, cacheCreationInputTokens: 6, cacheReadInputTokens: 7, outputTokens: output } } });
    expect(verifySkeleton(skeletonOf([assistant, state(8)]))[5]).toMatchObject({ checked: 4, violations: 0 });
    expect(verifySkeleton(skeletonOf([assistant, state(9)]))[5]).toMatchObject({ checked: 4, violations: 1 });
    // Two content-block lines of one request repeat its usage; they count once. A line with no request id counts on its own.
    expect(verifySkeleton(skeletonOf([assistant, assistant, state(8)]))[5]).toMatchObject({ checked: 4, violations: 0 });
    const anonymous = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [], usage } });
    expect(verifySkeleton(skeletonOf([anonymous, anonymous, state(16)]))[5]).toMatchObject({ checked: 4, violations: 3 });
    expect(verifySkeleton(skeletonOf([assistant]))[5]).toMatchObject({ checked: 0, violations: 0 });
    expect(verifySkeleton(skeletonOf([assistant, JSON.stringify({ type: 'cost-state', modelUsage: 5 })]))[5]?.checked).toBe(0);
    expect(formatVerify(verifyAll([skeletonOf([assistant, state(9)])]), 1)).toContain('FAIL  cost-state totals match summed usage: 3 of 4 hold, 1 exceptions');
  });
});
