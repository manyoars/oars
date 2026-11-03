// Layer 2's self-baseline (spec 2.2, t744): a session against the operator's own other weeks.
import { describe, expect, it } from 'vitest';
import { BASELINE_MIN_CALLS, BASELINE_MIN_WEEKS, fitOf, medianOf, selfBaseline, weekOf, type BaselinePrompt, type BaselineSession, type BaselineTool } from './baseline.js';

const ASOF = Date.parse('2026-06-10T00:00:00Z');
const usage = { input: 100, cacheWrite: 100, cacheRead: 800, output: 400, thinking: 0 };

interface Week {
  start: string;
  calls: number;
  mix?: { [tool: string]: number };
  harness?: 'claude-code' | 'cursor';
  durationMs?: number | null;
  wallSec?: number;
  cls?: BaselinePrompt['cls'];
  status?: BaselineTool['status'];
}

/** One session per week with `calls` tool calls; every other dimension holds one value, so a distance is 0 or 1. */
const fixture = (weeks: readonly Week[]): { sessions: BaselineSession[]; tools: BaselineTool[]; prompts: BaselinePrompt[] } => {
  const sessions: BaselineSession[] = [];
  const tools: BaselineTool[] = [];
  const prompts: BaselinePrompt[] = [];
  weeks.forEach((week, index) => {
    const session = `s${String(index)}`;
    sessions.push({ session, tsFirst: `${week.start}T12:00:00.000Z`, tools: week.mix ?? { Read: week.calls }, ...(week.harness === undefined ? {} : { harness: week.harness }) });
    tools.push({ session, status: week.status ?? 'ok', durationMs: week.durationMs === undefined ? 50 : week.durationMs });
    prompts.push({ session, wallSec: week.wallSec ?? 10, cls: week.cls ?? 'mixed', turns: 4, usage });
  });
  return { sessions, tools, prompts };
};
const BASE: Week[] = ['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25'].map((start) => ({ start, calls: 1000 }));
const run = (weeks: readonly Week[]) => {
  const data = fixture(weeks);
  return selfBaseline(data.sessions, data.tools, data.prompts, ASOF);
};
const last = (weeks: readonly Week[]) => run(weeks).find((entry) => entry.session === `s${String(weeks.length - 1)}`);
const cursor = (start: string, overrides: Partial<Week> = {}): Week => ({ start, calls: 1000, harness: 'cursor', durationMs: null, ...overrides });
const CURSOR_BASE = BASE.map((week) => cursor(week.start));

describe('selfBaseline', () => {
  it('names the constants', () => {
    expect([BASELINE_MIN_CALLS, BASELINE_MIN_WEEKS]).toEqual([1000, 4]);
  });

  it('takes the week of tsFirst as a UTC Monday, and none for a null or unparsable one', () => {
    expect(weekOf('2026-06-07T23:59:59.000Z')).toBe(Date.parse('2026-06-01T00:00:00Z'));
    expect(weekOf('2026-06-08T00:00:00.000Z')).toBe(Date.parse('2026-06-08T00:00:00Z'));
    expect(weekOf(null)).toBeNull();
    expect(weekOf('not a date')).toBeNull();
  });

  it('takes the median of the rest, the mean of the middle two for an even count', () => {
    expect(medianOf([5, 1, 3])).toBe(3);
    expect(medianOf([4, 1, 2, 9])).toBe(3);
  });

  it('maps m to F: 1 at or under 1/10, 0 at or over 2/5, linear between', () => {
    expect([fitOf(0), fitOf(0.1), fitOf(0.4), fitOf(0.9)]).toEqual([1, 1, 0, 0]);
    expect(fitOf(0.25)).toBeCloseTo(0.5, 10);
  });

  it('scores a week identical to its baseline at distance 0 and F 1', () => {
    const target = last([...BASE, { start: '2026-06-01', calls: 1000 }]);
    expect(target).toMatchObject({ status: 'scored', week: '2026-06-01', calls: 1000, baselineWeeks: 4, m: 0, f: 1, reason: null });
    expect(target?.distances).toHaveLength(7);
    expect(target?.distances.every((entry) => entry.distance === 0)).toBe(true);
  });

  it('weighs each baseline week by its calls: pooled counts, not an average of weeks', () => {
    // Pooled baseline: 2000 Read and 3000 Grep. The week is all Read, so the distance is 1 - 2/5 = 3/5 (an average of weeks would give 3/4).
    const weeks: Week[] = [
      { start: '2026-05-04', calls: 2000, mix: { Read: 2000 } },
      { start: '2026-05-11', calls: 1000, mix: { Grep: 1000 } },
      { start: '2026-05-18', calls: 1000, mix: { Grep: 1000 } },
      { start: '2026-05-25', calls: 1000, mix: { Grep: 1000 } },
      { start: '2026-06-01', calls: 1000 },
    ];
    const mix = last(weeks)?.distances.find((entry) => entry.dimension === 'tool mix');
    expect(mix?.distance).toBeCloseTo(3 / 5, 10);
  });

  it('drops durationMs for a Cursor week and takes m as the mean of the middle two of the six that remain', () => {
    // Distances: tool mix 1, status 1, wallSec 1, cache share 0, output per turn 0, prompt class 1 -> sorted 0 0 1 1 1 1; middle two 1 and 1.
    const target = last([...CURSOR_BASE, cursor('2026-06-01', { mix: { Grep: 1000 }, status: 'error', wallSec: 1000, cls: 'research' })]);
    expect(target?.distances.map((entry) => entry.dimension)).toEqual(['tool mix', 'status', 'wallSec', 'cache-read share', 'output per turn', 'prompt class']);
    expect(target?.distances.map((entry) => entry.distance)).toEqual([1, 1, 1, 0, 0, 1]);
    expect(target).toMatchObject({ status: 'scored', m: 1, f: 0 });
  });

  it('takes the mean of the middle two when they differ', () => {
    // Three dimensions at 1 and three at 0 -> sorted 0 0 0 1 1 1; the middle two are 0 and 1, so m is 1/2 (the odd count of seven would have taken a single value).
    const target = last([...CURSOR_BASE, cursor('2026-06-01', { mix: { Grep: 1000 }, status: 'error', wallSec: 1000 })]);
    expect(target?.distances.map((entry) => entry.distance)).toEqual([1, 1, 1, 0, 0, 0]);
    expect(target).toMatchObject({ m: 0.5, f: 0 });
  });

  it('takes the single middle value of seven, so one odd dimension cannot set m', () => {
    const target = last([...BASE, { start: '2026-06-01', calls: 1000, mix: { Grep: 1000 } }]);
    expect(target?.distances.filter((entry) => entry.distance > 0).map((entry) => entry.dimension)).toEqual(['tool mix']);
    expect(target).toMatchObject({ m: 0, f: 1 });
  });

  it('scores nothing for a null tsFirst', () => {
    const data = fixture([...BASE, { start: '2026-06-01', calls: 1000 }]);
    data.sessions[4] = { session: 's4', tsFirst: null, tools: { Read: 1000 } };
    const target = selfBaseline(data.sessions, data.tools, data.prompts, ASOF).find((entry) => entry.session === 's4');
    expect(target).toMatchObject({ status: 'not run', week: null, f: null, m: null, reason: 'no first timestamp' });
  });

  it('scores nothing for a week under 1,000 calls, and a week under 1,000 does not count toward a baseline', () => {
    expect(last([...BASE, { start: '2026-06-01', calls: 999 }])).toMatchObject({ status: 'not run', f: null, m: null, calls: 999, reason: 'week under 1000 tool calls' });
    const thin = last([...BASE.slice(0, 3), { start: '2026-05-25', calls: 999 }, { start: '2026-06-01', calls: 1000 }]);
    expect(thin).toMatchObject({ status: 'not run', f: null, baselineWeeks: 3, reason: 'under 4 qualifying baseline weeks' });
  });

  it('adds the calls of every session in the week, so small sessions can reach the floor together', () => {
    const results = run([...BASE, { start: '2026-06-01', calls: 600 }, { start: '2026-06-02', calls: 600 }]);
    expect(results.filter((entry) => entry.week === '2026-06-01').map((entry) => [entry.status, entry.calls])).toEqual([['scored', 1200], ['scored', 1200]]);
  });

  it('keeps harnesses apart and leaves the target week out of its own baseline', () => {
    expect(last([...BASE, { start: '2026-06-01', calls: 1000, harness: 'cursor' }])).toMatchObject({ status: 'not run', harness: 'cursor', baselineWeeks: 0 });
    expect(last([...BASE.slice(1), { start: '2026-06-01', calls: 1000 }])).toMatchObject({ status: 'not run', baselineWeeks: 3 });
  });

  it('leaves a week that has not ended by asOf out of the baseline', () => {
    // 06-08 ends 06-14, after asOf 06-10: only 05-11, 05-18, and 05-25 qualify for 06-01.
    const weeks: Week[] = [...BASE.slice(1), { start: '2026-06-08', calls: 1000 }, { start: '2026-06-01', calls: 1000 }];
    expect(last(weeks)).toMatchObject({ status: 'not run', baselineWeeks: 3 });
  });

  it('drops every dimension a side has no counts for, leaving the tool mix, which every qualifying week has', () => {
    const data = fixture([...BASE, { start: '2026-06-01', calls: 1000 }]);
    const target = selfBaseline(data.sessions, data.tools.filter((tool) => tool.session !== 's4'), data.prompts.filter((prompt) => prompt.session !== 's4'), ASOF).find((entry) => entry.session === 's4');
    expect(target?.distances.map((entry) => entry.dimension)).toEqual(['tool mix']);
    expect(target).toMatchObject({ status: 'scored', m: 0, f: 1 });
  });
});
