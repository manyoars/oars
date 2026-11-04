// Layer 2's self-baseline (spec 2.2, t744): a session against the operator's own other weeks.
import { describe, expect, it } from 'vitest';
import { BASELINE_MIN_CALLS, BASELINE_MIN_WEEKS, fitOf, formatSelfBaseline, medianOf, selfBaseline, weekOf, type BaselinePrompt, type BaselineSession, type BaselineTool, type Fraction, type SelfBaselineResult } from './baseline.js';

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
  usage?: Partial<BaselinePrompt['usage']>;
  turns?: number;
}

const ratio = (n: number, d: number): Fraction => ({ n: BigInt(n), d: BigInt(d) });

/** One session per week with `calls` tool calls; a week holds one value per dimension unless it overrides one, so a distance is 0 or 1 only between weeks that each hold a single value and pool alone. */
const fixture = (weeks: readonly Week[]): { sessions: BaselineSession[]; tools: BaselineTool[]; prompts: BaselinePrompt[] } => {
  const sessions: BaselineSession[] = [];
  const tools: BaselineTool[] = [];
  const prompts: BaselinePrompt[] = [];
  weeks.forEach((week, index) => {
    const session = `s${String(index)}`;
    sessions.push({ session, tsFirst: `${week.start}T12:00:00.000Z`, tools: week.mix ?? { Read: week.calls }, ...(week.harness === undefined ? {} : { harness: week.harness }) });
    tools.push({ session, status: week.status ?? 'ok', durationMs: week.durationMs === undefined ? 50 : week.durationMs });
    prompts.push({ session, wallSec: week.wallSec ?? 10, cls: week.cls ?? 'mixed', turns: week.turns ?? 4, usage: { ...usage, ...week.usage } });
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

describe('formatSelfBaseline', () => {
  const result = (session: string, overrides: Partial<SelfBaselineResult>): SelfBaselineResult => ({ session, harness: 'claude-code', week: '2026-06-01', status: 'not run', reason: null, calls: 0, baselineWeeks: 0, distances: [], m: null, f: null, ...overrides });

  it('prints the count line, the scored count, and one line per reason sorted, with each reason counted', () => {
    const text = formatSelfBaseline([
      result('a', { status: 'scored' }),
      result('b', { reason: 'week under 1000 tool calls' }),
      result('c', { reason: 'week under 1000 tool calls' }),
      result('d', { reason: 'no first timestamp' }),
    ]);
    expect(text).toBe(
      [
        '4 sessions against their own other weeks (layer 2, local; a low F lowers W and rejects nothing)',
        '      scored: 1',
        '      not run, no first timestamp: 1',
        '      not run, week under 1000 tool calls: 2',
      ].join('\n'),
    );
  });
});

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
    expect(medianOf([ratio(5, 1), ratio(1, 1), ratio(3, 1)])).toEqual(ratio(3, 1));
    // 2 and 3 are the middle two of 1, 2, 3, 9 over mixed denominators: (2/1 + 6/2) / 2 = 10/4.
    expect(medianOf([ratio(9, 1), ratio(1, 1), ratio(2, 1), ratio(6, 2)])).toEqual(ratio(10, 4));
  });

  it('maps m to F: 1 at or under 1/10, 0 at or over 2/5, linear between', () => {
    expect([fitOf(ratio(0, 1)), fitOf(ratio(1, 10)), fitOf(ratio(2, 5)), fitOf(ratio(9, 10))]).toEqual([1, 1, 0, 0]);
    // Exact rational arithmetic: 1/4 is 0.5 with no float residue, and 1/3 rounds to 4 places.
    expect(fitOf(ratio(1, 4))).toBe(0.5);
    expect(fitOf(ratio(1, 3))).toBe(0.2222);
    // Half-even at the 5th place: a rest above half rounds up (truncation gives 0.6666), a tie on an even digit stays (half-up gives 0.0313), a tie on an odd digit rounds up (truncation gives 0.0937).
    expect(fitOf(ratio(1, 5))).toBe(0.6667);
    expect(fitOf(ratio(25, 64))).toBe(0.0312);
    expect(fitOf(ratio(119, 320))).toBe(0.0938);
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
    expect(mix?.distance).toBe(0.6);
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

  it('counts a week from its last UTC day: asOf on that day takes it, the second before leaves it out', () => {
    // The week of 06-01 ends on 06-07; it is the fourth baseline week of the week of 05-04.
    const data = fixture([...BASE.slice(1), { start: '2026-06-01', calls: 1000 }, { start: '2026-05-04', calls: 1000 }]);
    const target = (asOf: string) => selfBaseline(data.sessions, data.tools, data.prompts, Date.parse(asOf)).find((entry) => entry.session === 's4');
    expect(target('2026-06-07T00:00:00Z')).toMatchObject({ status: 'scored', baselineWeeks: 4 });
    expect(target('2026-06-07T23:59:59Z')).toMatchObject({ status: 'scored', baselineWeeks: 4 });
    expect(target('2026-06-06T23:59:59Z')).toMatchObject({ status: 'not run', baselineWeeks: 3 });
  });

  it('drops every dimension a side has no counts for, leaving the tool mix, which every qualifying week has', () => {
    const data = fixture([...BASE, { start: '2026-06-01', calls: 1000 }]);
    const target = selfBaseline(data.sessions, data.tools.filter((tool) => tool.session !== 's4'), data.prompts.filter((prompt) => prompt.session !== 's4'), ASOF).find((entry) => entry.session === 's4');
    expect(target?.distances.map((entry) => entry.dimension)).toEqual(['tool mix']);
    expect(target).toMatchObject({ status: 'scored', m: 0, f: 1 });
  });

  it('gives the same results whatever order the store lists its sessions in', () => {
    const weeks: Week[] = [
      { start: '2026-05-04', calls: 2000, mix: { Read: 1500, Grep: 500 }, durationMs: 300 },
      { start: '2026-05-11', calls: 1000, mix: { Grep: 700, Edit: 300 }, wallSec: 40 },
      { start: '2026-05-18', calls: 1300, mix: { Read: 1300 }, status: 'error' },
      { start: '2026-05-25', calls: 1100, mix: { Bash: 1100 }, cls: 'research' },
      { start: '2026-06-01', calls: 1000 },
    ];
    const data = fixture(weeks);
    const forward = selfBaseline(data.sessions, data.tools, data.prompts, ASOF);
    const reversed = selfBaseline([...data.sessions].reverse(), [...data.tools].reverse(), [...data.prompts].reverse(), ASOF);
    expect([...reversed].sort((a, b) => a.session.localeCompare(b.session))).toEqual(forward);
  });

  describe('a bin edge', () => {
    /** Two baseline weeks hold `low`, two hold `high`; the target holds `target`. The result is the distance of one dimension. */
    const across = (dimension: string, low: Partial<Week>, high: Partial<Week>, target: Partial<Week>): number | undefined => {
      const baseline = BASE.map((week, index): Week => ({ ...week, ...(index < 2 ? low : high) }));
      return last([...baseline, { start: '2026-06-01', calls: 1000, ...target }])?.distances.find((entry) => entry.dimension === dimension)?.distance;
    };

    it('splits durationMs at 100 ms: 99 is the lower bin, 100 the upper', () => {
      expect(across('durationMs', { durationMs: 99 }, { durationMs: 100 }, { durationMs: 99 })).toBe(0.5);
      expect(across('durationMs', { durationMs: 99 }, { durationMs: 100 }, { durationMs: 100 })).toBe(0.5);
      expect(across('durationMs', { durationMs: 99 }, { durationMs: 100 }, { durationMs: 5000 })).toBe(1);
      expect(across('durationMs', { durationMs: 100 }, { durationMs: 100 }, { durationMs: 100 })).toBe(0);
      expect(across('durationMs', { durationMs: 100 }, { durationMs: 100 }, { durationMs: 99 })).toBe(1);
    });

    it('splits wallSec at 5 s: 4 is the lower bin, 5 the upper', () => {
      expect(across('wallSec', { wallSec: 4 }, { wallSec: 5 }, { wallSec: 4 })).toBe(0.5);
      expect(across('wallSec', { wallSec: 5 }, { wallSec: 5 }, { wallSec: 5 })).toBe(0);
      expect(across('wallSec', { wallSec: 5 }, { wallSec: 5 }, { wallSec: 4 })).toBe(1);
    });

    it('splits the cache-read share at 7/10: 699 of 1000 is under it, 700 is the upper bin', () => {
      const at = (cacheRead: number): Partial<Week> => ({ usage: { input: 100, cacheWrite: 900 - cacheRead, cacheRead } });
      expect(across('cache-read share', at(699), at(700), at(699))).toBe(0.5);
      expect(across('cache-read share', at(700), at(700), at(700))).toBe(0);
      expect(across('cache-read share', at(700), at(700), at(699))).toBe(1);
      expect(across('cache-read share', at(700), at(700), at(800))).toBe(1);
    });

    it('splits output per turn at 1000: 3996 over 4 turns is under it, 4000 is the upper bin', () => {
      const at = (output: number): Partial<Week> => ({ usage: { output } });
      expect(across('output per turn', at(3996), at(4000), at(3996))).toBe(0.5);
      expect(across('output per turn', at(4000), at(4000), at(4000))).toBe(0);
      expect(across('output per turn', at(4000), at(4000), at(3996))).toBe(1);
      // The same output over more turns is a lower rate: 4000 over 8 turns is 500, also an edge, so the upper bin of [500, 1000).
      expect(across('output per turn', at(4000), at(4000), { ...at(4000), turns: 8 })).toBe(1);
      expect(across('output per turn', { ...at(4000), turns: 8 }, { ...at(4000), turns: 8 }, { ...at(4000), turns: 8 })).toBe(0);
    });

    it('adds no count for zero input or zero turns, so those dimensions are dropped for the week', () => {
      const none = { input: 0, cacheWrite: 0, cacheRead: 0 };
      expect(last([...BASE, { start: '2026-06-01', calls: 1000, usage: none }])?.distances.map((entry) => entry.dimension)).not.toContain('cache-read share');
      expect(last([...BASE, { start: '2026-06-01', calls: 1000, usage: none }])?.distances.map((entry) => entry.dimension)).toContain('output per turn');
      expect(last([...BASE, { start: '2026-06-01', calls: 1000, turns: 0 }])?.distances.map((entry) => entry.dimension)).not.toContain('output per turn');
      expect(last([...BASE, { start: '2026-06-01', calls: 1000, turns: 0 }])?.distances.map((entry) => entry.dimension)).toContain('cache-read share');
      expect(last([...BASE, { start: '2026-06-01', calls: 1000, usage: none, turns: 0 }])?.distances.map((entry) => entry.dimension)).toEqual(['tool mix', 'status', 'durationMs', 'wallSec', 'prompt class']);
    });
  });
});
