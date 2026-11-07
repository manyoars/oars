import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, rootsOf, session, sessionsFrom, step, storedNames, store, tool } from './pool-fixture.js';
import { bucketOf, hasEnded, MIN_TIMED_CALLS, parseSkeleton, SESSION_IDLE_HOURS, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import type { Store } from './store.js';

const framed = frame({ shell: 'bash' });
const HOUR = 60 * 60 * 1000;
const NOW = 100 * HOUR;

const built = (from: Store): SessionSkeleton => {
  const [only] = sessionsFrom(from);
  const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (skeleton === null) throw new Error('no skeleton');
  return skeleton;
};

const cost = (tokens: number): { tokens: number; durationMs: null } => ({ tokens, durationMs: null });

describe('a session has ended', () => {
  const from = (main: number, sub: number): Store =>
    store({ sessions: [session('m', { frame: framed, rev: NOW - main * HOUR })], subagents: [session('m~a', { parent: 'm', spawnedIn: 'm', agentType: 'Explore', frame: framed, rev: NOW - sub * HOUR })] });

  it('waits while any transcript, main or subagent, is quieter than the idle bound', () => {
    expect(SESSION_IDLE_HOURS).toBe(6);
    const [one] = sessionsFrom(from(5, 7));
    const [other] = sessionsFrom(from(7, 5));
    const [both] = sessionsFrom(from(7, 7));
    expect(one === undefined || hasEnded(one, NOW, 0)).toBe(false);
    expect(other === undefined || hasEnded(other, NOW, 0)).toBe(false);
    expect(both !== undefined && hasEnded(both, NOW, 0)).toBe(true);
  });

  it('counts a write to a raw file after the last capture as activity', () => {
    const [both] = sessionsFrom(from(7, 7));
    expect(both !== undefined && hasEnded(both, NOW, NOW - 5 * HOUR)).toBe(false);
    expect(both !== undefined && hasEnded(both, NOW, NOW - 6 * HOUR)).toBe(true);
    expect(both !== undefined && hasEnded(both, NOW, NOW - 8 * HOUR)).toBe(true);
  });

  it('holds a dead subagent back no longer than the bound', () => {
    const [dead] = sessionsFrom(from(30, 6));
    expect(dead !== undefined && hasEnded(dead, NOW, 0)).toBe(true);
    expect(dead !== undefined && hasEnded(dead, NOW - 1, 0)).toBe(false);
  });
});

describe('the fold and the envelope', () => {
  const calls = (id: string, count: number, durationMs: number | null): ReturnType<typeof tool>[] =>
    Array.from({ length: count }, (_, n) => tool(id, n, 'Read', { durationMs, steps: [step(n, 0, 'file.read', { native: 'Read', cost: cost(10) })] }));
  const withSubagent = (subDurations: number | null): Store => {
    const main = [...calls('m', MIN_TIMED_CALLS, 5), tool('m', MIN_TIMED_CALLS, 'Agent', { durationMs: 7, steps: [step(MIN_TIMED_CALLS, 0, 'agent.spawn', { native: 'Agent' })] })];
    const sub = calls('m~a', 3, subDurations).map((call) => ({ ...call, steps: (call.steps ?? []).map((held) => ({ ...held, parent: MIN_TIMED_CALLS })) }));
    return store({
      sessions: [session('m', { frame: framed })],
      subagents: [
        session('m~a', { parent: 'm', spawnedIn: 'm', agentType: 'Explore', frame: framed }),
        // A nested one: its file belongs to the main session, but the call that spawned it is in the first subagent's transcript.
        session('m~b', { parent: 'm', spawnedIn: 'm~a', agentType: 'Plan', frame: framed }),
        session('orphan~a', { parent: 'orphan', spawnedIn: 'orphan', agentType: 'Plan', frame: framed }),
      ],
      prompts: [prompt('m', 0, { frame: framed }), prompt('m~a', 0, { frame: framed }), prompt('m~b', 0, { frame: framed }), prompt('orphan~a', 0, { frame: framed })],
      tools: [...main, ...sub, ...calls('m~b', 2, 3).map((call) => ({ ...call, steps: (call.steps ?? []).map((held) => ({ ...held, parent: 0 })) })), ...calls('orphan~a', 2, 1)],
    });
  };

  it('is one batch of the main run then each subagent run, each step tagged, a nested run linked to the subagent that spawned it, an orphan folded into nothing', () => {
    const skeleton = built(withSubagent(9));
    expect(skeleton.transcripts).toHaveLength(3);
    expect(skeleton.transcripts[2]?.tools.every(({ steps }) => steps.every(({ agentType, parent }) => agentType === 'Plan' && parent === 0))).toBe(true);
    // The nested run names the first subagent's call 0, not the main run's.
    expect(skeleton.transcripts.map(({ spawnedIn }) => spawnedIn)).toEqual([null, 0, 1]);
    expect(skeleton.transcripts[0]?.tools.every(({ steps }) => steps.every(({ agentType }) => agentType === null))).toBe(true);
    expect(skeleton.transcripts[1]?.tools.every(({ steps }) => steps.every(({ agentType, parent }) => agentType === 'Explore' && parent === MIN_TIMED_CALLS))).toBe(true);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toMatchObject({ ok: true });
  });

  it('never makes a batch of a subagent whose main transcript is missing', () => {
    const found = sessionsFrom(withSubagent(9));
    expect(found).toHaveLength(1);
    expect(found.map(({ main }) => main.session)).toEqual(['m']);
    expect(found.flatMap(({ transcripts }) => transcripts.map(({ session: held }) => held.session))).toEqual(['m', 'm~a', 'm~b']);
  });

  it('holds one root and leaf count for each transcript, the first being the main transcript', () => {
    const from = withSubagent(9);
    const roots = rootsOf(from);
    const pairs = built(from).transcripts.map(({ merkleRoot, leaves }) => ({ merkleRoot, leaves }));
    expect(pairs).toEqual(['m', 'm~a', 'm~b'].map((id) => roots.get(id)));
    expect(new Set(pairs.map(({ merkleRoot }) => merkleRoot)).size).toBe(3);
  });

  describe('the timing print', () => {
    const timed = (count: number, durationAt: (n: number) => number | null, order: (calls: ReturnType<typeof tool>[]) => ReturnType<typeof tool>[] = (held) => held): string | null =>
      built(store({ sessions: [session('m', { frame: framed })], prompts: [prompt('m', 0, { frame: framed })], tools: order(Array.from({ length: count }, (_, n) => tool('m', n, 'Read', { durationMs: durationAt(n), steps: [step(n, 0, 'file.read', { native: 'Read' })] }))) })).timingPrint;

    it('needs 50 timed calls: 49 give none and 50 give a print', () => {
      expect(timed(MIN_TIMED_CALLS - 1, (n) => n + 1)).toBeNull();
      expect(timed(MIN_TIMED_CALLS, (n) => n + 1)).toMatch(/^[0-9a-f]{16}$/);
    });

    it('skips a call with no duration, so it neither counts toward 50 nor changes the print', () => {
      const base = timed(MIN_TIMED_CALLS, (n) => n + 1);
      expect(timed(MIN_TIMED_CALLS + 1, (n) => (n === 10 ? null : n < 10 ? n + 1 : n))).toBe(base);
      expect(timed(MIN_TIMED_CALLS, (n) => (n === 10 ? null : n + 1))).toBeNull();
    });

    it('is over the durations in call order, whatever order the tools are stored in', () => {
      const base = timed(MIN_TIMED_CALLS, (n) => n + 1);
      expect(timed(MIN_TIMED_CALLS, (n) => n + 1, (held) => [...held].reverse())).toBe(base);
      expect(timed(MIN_TIMED_CALLS, (n) => (n === 3 ? 5 : n === 4 ? 4 : n + 1))).not.toBe(base);
    });
  });

  it('keeps one print over the main transcript, which a subagent duration does not change', () => {
    const one = built(withSubagent(9));
    const other = built(withSubagent(123456));
    expect(one.timingPrint).toMatch(/^[0-9a-f]{16}$/);
    expect(other.timingPrint).toBe(one.timingPrint);
  });

  it('has no print under 50 timed calls in the main run, whatever the subagents hold', () => {
    const few = withSubagent(9);
    const skeleton = built({ ...few, tools: few.tools.filter((call) => call.session !== 'm' || call.n > 10) });
    expect(skeleton.timingPrint).toBeNull();
    expect(skeleton.transcripts[1]?.tools.length).toBe(3);
  });

  it('refuses a print the main run cannot have, and a missing one', () => {
    const skeleton = built(withSubagent(9));
    expect(parseSkeleton({ ...skeleton, timingPrint: null })).toMatchObject({ ok: false, field: 'timingPrint' });
    const few = built(store({ sessions: [session('m', { frame: framed })], prompts: [prompt('m', 0, { frame: framed })], tools: calls('m', 2, 5) }));
    expect(parseSkeleton({ ...few, timingPrint: '0123456789abcdef' })).toMatchObject({ ok: false, field: 'timingPrint' });
  });
});

describe('remainingTokens', () => {
  it('is the bucket of the sum, not a sum of buckets', () => {
    const from = store({
      sessions: [session('m', { frame: framed })],
      prompts: [prompt('m', 0, { frame: framed })],
      tools: [0, 1, 2].map((n) => tool('m', n, 'Read', { steps: [step(n, 0, 'file.read', { native: 'Read', cost: cost(n === 0 ? 5 : 600) })] })),
    });
    const remaining = built(from).transcripts[0]?.tools.map(({ steps }) => steps[0]?.remainingTokens);
    // 600 + 600 is 1,200, bucket 1; two buckets of 600 would sum to 0.
    expect(remaining).toEqual([bucketOf('tokens', 1200), bucketOf('tokens', 600), 0]);
    expect(bucketOf('tokens', 600) + bucketOf('tokens', 600)).toBe(0);
  });

  it('counts the subagent runs a main-run step spawned later, and a subagent step only its own run', () => {
    const from = store({
      sessions: [session('m', { frame: framed })],
      subagents: [session('m~a', { parent: 'm', spawnedIn: 'm', agentType: 'Explore', frame: framed })],
      prompts: [prompt('m', 0, { frame: framed }), prompt('m~a', 0, { frame: framed })],
      tools: [
        tool('m', 0, 'Read', { steps: [step(0, 0, 'file.read', { native: 'Read', cost: cost(10) })] }),
        tool('m', 1, 'Agent', { steps: [step(1, 0, 'agent.spawn', { native: 'Agent', cost: cost(10) })] }),
        tool('m~a', 0, 'Read', { steps: [step(0, 0, 'file.read', { native: 'Read', parent: 1, cost: cost(800) })] }),
        tool('m~a', 1, 'Read', { steps: [step(1, 0, 'file.read', { native: 'Read', parent: 1, cost: cost(800) })] }),
      ],
    });
    const [main, sub] = built(from).transcripts;
    // The first main step sees the spawn step (10) and the run it spawned (1,600); the spawn step sees nothing after it.
    expect(main?.tools.map(({ steps }) => steps[0]?.remainingTokens)).toEqual([bucketOf('tokens', 1610), 0]);
    expect(sub?.tools.map(({ steps }) => steps[0]?.remainingTokens)).toEqual([bucketOf('tokens', 800), 0]);
  });

  it('attaches a spawned run to the spawn step of the spawning call, wherever that step sits', () => {
    const from = store({
      sessions: [session('m', { frame: framed })],
      subagents: [session('m~a', { parent: 'm', spawnedIn: 'm', agentType: 'Explore', frame: framed })],
      prompts: [prompt('m', 0, { frame: framed }), prompt('m~a', 0, { frame: framed })],
      tools: [
        tool('m', 0, 'Read', { steps: [step(0, 0, 'file.read', { native: 'Read', cost: cost(10) })] }),
        tool('m', 1, 'Agent', { steps: [step(1, 0, 'file.read', { native: 'Read', cost: cost(10) }), step(1, 1, 'agent.spawn', { native: 'Agent', cost: cost(10) }), step(1, 2, 'file.read', { native: 'Read', cost: cost(10) })] }),
        tool('m~a', 0, 'Read', { steps: [step(0, 0, 'file.read', { native: 'Read', parent: 1, cost: cost(1600) })] }),
      ],
    });
    const [main] = built(from).transcripts;
    // Reading from the end: the step after the spawn sees 0; the spawn step sees that step (10); the step before it sees both and the run (10 + 10 + 1,600); the first call sees all of it.
    expect(main?.tools[1]?.steps.map(({ remainingTokens }) => remainingTokens)).toEqual([bucketOf('tokens', 1620), bucketOf('tokens', 10), 0]);
    expect(main?.tools[0]?.steps[0]?.remainingTokens).toBe(bucketOf('tokens', 1640));
    expect(bucketOf('tokens', 1620)).not.toBe(bucketOf('tokens', 20));
  });

  it('leaves every main-run step unchanged for a nested run, whatever it spent', () => {
    const main = (nested: number): (number | undefined)[] | undefined =>
      built(
        store({
          sessions: [session('m', { frame: framed })],
          subagents: [session('m~a', { parent: 'm', spawnedIn: 'm', agentType: 'Explore', frame: framed }), session('m~b', { parent: 'm', spawnedIn: 'm~a', agentType: 'Plan', frame: framed })],
          prompts: [prompt('m', 0, { frame: framed }), prompt('m~a', 0, { frame: framed }), prompt('m~b', 0, { frame: framed })],
          tools: [
            tool('m', 0, 'Read', { steps: [step(0, 0, 'file.read', { native: 'Read', cost: cost(10) })] }),
            tool('m', 1, 'Agent', { steps: [step(1, 0, 'agent.spawn', { native: 'Agent', cost: cost(10) })] }),
            tool('m~a', 0, 'Read', { steps: [step(0, 0, 'file.read', { native: 'Read', parent: 1, cost: cost(800) })] }),
            tool('m~b', 0, 'Read', { steps: [step(0, 0, 'file.read', { native: 'Read', parent: 0, cost: cost(nested) })] }),
          ],
        }),
      ).transcripts[0]?.tools.flatMap(({ steps }) => steps.map(({ remainingTokens }) => remainingTokens));
    expect(main(5_000_000)).toEqual(main(5));
    expect(main(5)).toEqual([bucketOf('tokens', 810), 0]);
  });

  it('is the same on the steps a resume batch holds as on the whole batch, and corrects nothing earlier', () => {
    const calls = [0, 1, 2, 3].map((n) => tool('m', n, 'Read', { steps: [step(n, 0, 'file.read', { native: 'Read', cost: cost(700) })] }));
    const base = { sessions: [session('m', { frame: framed })], prompts: [prompt('m', 0, { frame: framed })] };
    const whole = built(store({ ...base, tools: calls })).transcripts[0]?.tools.map(({ steps }) => steps[0]?.remainingTokens);
    const resumed = built(store({ ...base, tools: calls.slice(2) })).transcripts[0]?.tools.map(({ steps }) => steps[0]?.remainingTokens);
    expect(resumed).toEqual(whole?.slice(2));
  });
});
