import { describe, expect, it } from 'vitest';
import { planOrder } from './plan.js';
import { parseOrder } from './order.js';
import { comparisonText, FLEET, retestText, taskSet } from './test-fixtures.js';

describe('planOrder', () => {
  it('plans the retest default as 8 tasks x 1 arm x 3 repeats x 2 sides = 48 runs', () => {
    const plan = planOrder(parseOrder(retestText(), FLEET), taskSet(8));
    expect(plan.runs).toHaveLength(48);
    expect(plan.cells).toHaveLength(16);
    expect(plan.runs.map((run) => run.side)).toEqual(Array.from({ length: 24 }, () => ['before', 'after']).flat());
  });

  it('alternates sides task by task: before then after, repeat by repeat', () => {
    const plan = planOrder(parseOrder(retestText({ repeats: 2 }), FLEET), taskSet(2));
    expect(plan.runs.map((run) => `${run.taskId}:${run.side ?? '-'}:${String(run.repeat)}`)).toEqual([
      't1:before:1', 't1:after:1', 't1:before:2', 't1:after:2',
      't2:before:1', 't2:after:1', 't2:before:2', 't2:after:2',
    ]);
  });

  it('plans a comparison over every arm with no side', () => {
    const plan = planOrder(parseOrder(comparisonText({ repeats: 2 }), FLEET), taskSet(2));
    expect(plan.runs).toHaveLength(2 * 3 * 2);
    expect(plan.runs.every((run) => run.side === null)).toBe(true);
    expect(plan.runs[0]).toEqual({ taskId: 't1', category: 'control', arm: 'no-tool', side: null, repeat: 1 });
  });

  it('refuses an order whose task-set version is not the manifest\'s', () => {
    expect(() => planOrder(parseOrder(retestText({ taskSetVersion: 'v2' }), FLEET), taskSet(2))).toThrow(/v2/);
  });
});
