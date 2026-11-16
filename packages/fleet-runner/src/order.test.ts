import { describe, expect, it } from 'vitest';
import { parseOrder } from './order.js';
import { comparisonShape, comparisonText, FLEET, retestShape, retestText } from './test-fixtures.js';

const reject = (text: string): string => {
  try {
    parseOrder(text, FLEET);
  } catch (error) {
    return error instanceof Error ? error.message : 'not an error';
  }
  return 'accepted';
};

describe('parseOrder', () => {
  it('reads a retest with two pinned sides', () => {
    const order = parseOrder(retestText(), FLEET);
    expect(order.line).toBe('retest');
    expect(order.sides.map((side) => side.pin)).toEqual(['npm:1.0.0', 'npm:1.1.0']);
    expect(order.repeats).toBe(3);
  });

  it('reads a comparison with pinned tools and no sides', () => {
    const order = parseOrder(comparisonText(), FLEET);
    expect(order.line).toBe('comparison');
    expect(order.sides).toEqual([]);
    expect(order.arms).toEqual(['no-tool', 'playwright', 'sqlite']);
  });

  it('defaults repeats to 3', () => {
    const { repeats: _dropped, ...rest } = retestShape();
    expect(parseOrder(JSON.stringify(rest), FLEET).repeats).toBe(3);
  });

  it('rejects a comparison that mixes task-set versions', () => {
    expect(reject(comparisonText({ sides: [{ name: 'main', pin: 'x', taskSetVersion: 'v2' }] }))).toMatch(/mixes task-set versions/);
  });

  it('rejects a retest whose sides name different task-set versions', () => {
    const sides = [
      { name: 'before', pin: '1', taskSetVersion: 'v1' },
      { name: 'after', pin: '2', taskSetVersion: 'v2' },
    ];
    expect(reject(retestText({ sides }))).toMatch(/mixes task-set versions/);
  });

  it('rejects a retest without exactly two sides', () => {
    expect(reject(retestText({ sides: [{ name: 'before', pin: 'npm:1.0.0' }] }))).toMatch(/exactly two sides/);
  });

  it('rejects a retest side without a pin', () => {
    expect(reject(retestText({ sides: [{ name: 'before', pin: 'npm:1' }, { name: 'after' }] }))).toMatch(/pin/);
  });

  it('rejects a retest whose two sides share a name', () => {
    expect(reject(retestText({ sides: [{ name: 'a', pin: '1' }, { name: 'a', pin: '2' }] }))).toMatch(/distinct/);
  });

  it('rejects a harness the fleet manifest does not name', () => {
    expect(reject(retestText({ harness: 'mystery' }))).toMatch(/harness "mystery"/);
  });

  it('rejects a model ID the harness does not list', () => {
    expect(reject(retestText({ modelId: 'other-model' }))).toMatch(/model/);
  });

  it('rejects a different manifest version', () => {
    expect(reject(retestText({ manifestVersion: 'fleet-2' }))).toMatch(/manifest/);
  });

  it('rejects repeats under 1 and non-integers', () => {
    expect(reject(retestText({ repeats: 0 }))).toMatch(/repeats/);
    expect(reject(retestText({ repeats: 1.5 }))).toMatch(/repeats/);
  });

  it('rejects a run cap under 1', () => {
    expect(reject(retestText({ runCap: 0 }))).toMatch(/runCap/);
  });

  it('rejects a comparison tool without a pin', () => {
    const tools = [
      { name: 'playwright', kind: 'server', pin: 'x' },
      { name: 'sqlite', kind: 'server' },
    ];
    expect(reject(comparisonText({ tools }))).toMatch(/pin/);
  });

  it('rejects an arm that names no tool', () => {
    expect(reject(comparisonText({ arms: ['ghost'] }))).toMatch(/arm "ghost"/);
    expect(comparisonShape().arms).toContain('no-tool');
  });

  it('rejects a comparison with a side, a bad line, and bad JSON', () => {
    expect(reject(comparisonText({ sides: [{ name: 'main', pin: 'x' }] }))).toMatch(/no sides/);
    expect(reject(retestText({ line: 'audit' }))).toMatch(/line/);
    expect(reject('{')).toMatch(/valid JSON/);
  });

  it('rejects a retest with other than one tool and one tool arm', () => {
    expect(reject(retestText({ tools: [{ name: 'playwright', kind: 'server' }, { name: 'b', kind: 'server' }] }))).toMatch(/one tool/);
    expect(reject(retestText({ arms: ['no-tool'] }))).toMatch(/arms/);
  });

  it('rejects a tool kind that is not server or skill', () => {
    expect(reject(retestText({ tools: [{ name: 'playwright', kind: 'package' }] }))).toMatch(/kind/);
  });
});
