import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, storedNames, store, tool } from './pool-fixture.js';
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

describe('a session has ended (Item 1)', () => {
  const from = (main: number, sub: number): Store =>
    store({ sessions: [session('m', { frame: framed, rev: NOW - main * HOUR })], subagents: [session('m~a', { parent: 'm', spawnedIn: 'm', agentType: 'Explore', frame: framed, rev: NOW - sub * HOUR })] });

  it('waits while any transcript, main or subagent, is quieter than the idle bound', () => {
    expect(SESSION_IDLE_HOURS).toBe(6);
    const [one] = sessionsFrom(from(5, 7));
    const [other] = sessionsFrom(from(7, 5));
    const [both] = sessionsFrom(from(7, 7));
    expect(one === undefined || hasEnded(one, NOW)).toBe(false);
    expect(other === undefined || hasEnded(other, NOW)).toBe(false);
    expect(both !== undefined && hasEnded(both, NOW)).toBe(true);
  });

  it('holds a dead subagent back no longer than the bound', () => {
    const [dead] = sessionsFrom(from(30, 6));
    expect(dead !== undefined && hasEnded(dead, NOW)).toBe(true);
    expect(dead !== undefined && hasEnded(dead, NOW - 1)).toBe(false);
  });
});

describe('the fold and the envelope (Items 2 and 3)', () => {
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

  it('is one batch of the main run then each subagent run, each step tagged, a nested run linked to nothing, an orphan folded into nothing', () => {
    const skeleton = built(withSubagent(9));
    expect(skeleton.transcripts).toHaveLength(3);
    expect(skeleton.transcripts[2]?.tools.every(({ steps }) => steps.every(({ agentType, parent }) => agentType === 'Plan' && parent === null))).toBe(true);
    expect(skeleton.transcripts[0]?.tools.every(({ steps }) => steps.every(({ agentType }) => agentType === null))).toBe(true);
    expect(skeleton.transcripts[1]?.tools.every(({ steps }) => steps.every(({ agentType, parent }) => agentType === 'Explore' && parent === MIN_TIMED_CALLS))).toBe(true);
    expect(new Set(skeleton.transcripts.map(({ merkleRoot }) => merkleRoot)).size).toBe(3);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toMatchObject({ ok: true });
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

describe('remainingTokens (Item 4)', () => {
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

  it('is the same on the steps a resume batch holds as on the whole batch, and corrects nothing earlier', () => {
    const calls = [0, 1, 2, 3].map((n) => tool('m', n, 'Read', { steps: [step(n, 0, 'file.read', { native: 'Read', cost: cost(700) })] }));
    const base = { sessions: [session('m', { frame: framed })], prompts: [prompt('m', 0, { frame: framed })] };
    const whole = built(store({ ...base, tools: calls })).transcripts[0]?.tools.map(({ steps }) => steps[0]?.remainingTokens);
    const resumed = built(store({ ...base, tools: calls.slice(2) })).transcripts[0]?.tools.map(({ steps }) => steps[0]?.remainingTokens);
    expect(resumed).toEqual(whole?.slice(2));
  });
});
