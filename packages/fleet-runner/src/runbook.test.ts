import { describe, expect, it } from 'vitest';
import { makeFake } from './fake-harness.js';
import { objectAt } from './json.js';
import { parseOrder } from './order.js';
import { planOrder } from './plan.js';
import { runOrder, type RunnerOptions } from './runner.js';
import { serializeRunBook } from './runbook.js';
import { FLEET, retestText, taskSet } from './test-fixtures.js';

const fullRetest = (): RunnerOptions => {
  let ticks = 0;
  return {
    order: parseOrder(retestText(), FLEET),
    taskSet: taskSet(8),
    fleet: FLEET,
    // Every 7th run hits a rate limit, so the book holds void runs too.
    adapter: makeFake((request) => (request.sequence % 7 === 0 ? { exit: 'rate-limit' } : {})),
    clock: () => new Date(Date.UTC(2026, 10, 16, 12, 0, ticks++)),
    operator: 'Many Oars Co.',
  };
};

describe('a full fake retest', () => {
  it('writes a run book whose counts match the plan, void runs included', async () => {
    const options = fullRetest();
    const plan = planOrder(options.order, options.taskSet);
    const text = serializeRunBook(await runOrder(options));
    const lines = text.trimEnd().split('\n');
    const header = objectAt(JSON.parse(lines[0] ?? '{}'), 'header');
    const runs = lines.slice(1).map((line) => objectAt(JSON.parse(line), 'run'));
    expect(header).toMatchObject({ orderId: 'o-1', line: 'retest', status: 'complete', fixtureTag: 'taskset-v1', fixtureCommit: 'abc123', startDate: '2026-11-16', endDate: '2026-11-16' });
    expect(runs.filter((run) => run.void === null)).toHaveLength(plan.runs.length);
    expect(plan.runs).toHaveLength(48);
    expect(runs.filter((run) => run.void !== null).map((run) => run.void)).toEqual(Array.from({ length: runs.length - 48 }, () => 'harness-failed'));
    expect(runs.slice(0, 4).map((run) => run.side)).toEqual(['before', 'after', 'before', 'after']);
  });

  it('is byte-identical on a second run with the same script and clock', async () => {
    expect(serializeRunBook(await runOrder(fullRetest()))).toBe(serializeRunBook(await runOrder(fullRetest())));
  });

  it('writes keys in a fixed order', async () => {
    const text = serializeRunBook(await runOrder(fullRetest()));
    expect(text.split('\n')[0]?.startsWith('{"orderId":"o-1","line":"retest","taskSetVersion":"v1"')).toBe(true);
    expect(text.split('\n')[1]?.startsWith('{"runId":"o-1-0001","taskId":"t1","category":"browser","arm":"playwright","side":"before","repeat":1')).toBe(true);
  });
});
