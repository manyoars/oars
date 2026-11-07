import { describe, expect, it } from 'vitest';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { strataOf } from './strata.js';
import { parseSkeleton, projectExplore, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import type { Harness, Strata } from './schema.js';
import { LITERAL, PRIVATE } from './public-vocabulary.js';

// Real capture writes the shell as `shellOf` names it; the shared fixture's frame predates that spelling.
const framed = frame({ shell: 'bash' });
const framedPrompt = (id: string, index: number, over: Parameters<typeof prompt>[2] = {}): ReturnType<typeof prompt> => prompt(id, index, { frame: framed, ...over });

const shell = step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: ['--force'] } });

const skeletonFrom = (from: ReturnType<typeof store>): SessionSkeleton | null => {
  const [only] = sessionsFrom(from);
  if (only === undefined) throw new Error('the store has no session');
  return skeletonOf(only, '0123456789abcdef', storedNames, printOf);
};

const sample = (): SessionSkeleton => {
  const skeleton = skeletonFrom(
    store({
      sessions: [session('s1', { frame: framed })],
      prompts: [framedPrompt('s1', 0, { head: 'a private prompt' })],
      tools: [tool('s1', 0, 'Bash', { steps: [shell], target: 'git push', keys: ['command'] })],
    }),
  );
  if (skeleton === null) throw new Error('the sample has no skeleton');
  return skeleton;
};

type Path = readonly (string | number)[];

const isHolder = (value: unknown): value is object => typeof value === 'object' && value !== null;

/** The sample as plain JSON with one value set, or removed when `value` is undefined, the way a hostile client would send it. */
const sent = (path: Path, value: unknown): unknown => {
  const raw: unknown = JSON.parse(JSON.stringify(sample()));
  let holder: unknown = raw;
  for (const key of path.slice(0, -1)) {
    if (!isHolder(holder)) throw new Error(`no ${String(key)} in the sample`);
    holder = Reflect.get(holder, key);
  }
  const last = path.at(-1);
  if (!isHolder(holder) || last === undefined) throw new Error('nothing to set');
  if (value === undefined) Reflect.deleteProperty(holder, last);
  else Reflect.set(holder, last, value);
  return raw;
};

const refusedField = (value: unknown): string => {
  const parsed = parseSkeleton(value);
  return parsed.ok ? 'accepted' : parsed.field;
};

const firstStep = ['transcripts', 0, 'tools', 0, 'steps', 0];
const withStep = (over: object): unknown => sent(firstStep, JSON.parse(JSON.stringify({ ...shell, n: undefined, seg: undefined, frameId: undefined, edges: undefined, cost: undefined, tokens: null, ms: null, remainingTokens: 0, agentType: null, frame: 0, ...over })));
const stepField = 'transcripts[0].tools[0].steps[0]';

describe('skeletonOf', () => {
  it('builds a skeleton the parser accepts unchanged, holding nothing of class A', () => {
    const skeleton = sample();
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton });
    const text = JSON.stringify(skeleton);
    expect(text).not.toContain('a private prompt');
    expect(text).not.toContain('git push');
    expect(text).not.toContain('s1');
    expect(text).not.toContain('proj');
  });

  it('has no skeleton for a session captured before steps or frames', () => {
    const noFrame = store({ sessions: [session('s1')], prompts: [framedPrompt('s1', 0)], tools: [tool('s1', 0, 'Bash', { steps: [shell] })] });
    const noSteps = store({ sessions: [session('s1', { frame: framed })], prompts: [framedPrompt('s1', 0)], tools: [tool('s1', 0, 'Bash')] });
    const noPromptFrame = store({ sessions: [session('s1', { frame: framed })], prompts: [framedPrompt('s1', 0, { frame: undefined })], tools: [tool('s1', 0, 'Bash', { steps: [shell] })] });
    for (const from of [noFrame, noSteps, noPromptFrame]) expect(skeletonFrom(from)).toBeNull();
  });

  it('sends the literal for a stored tool its server no longer lists, so the parser takes the whole session', () => {
    const dropped = step(0, 0, 'mcp.call', { native: 'mcp__github__acme_secret_deploy', identity: { server: 'github', tool: 'acme_secret_deploy' } });
    const kept = step(1, 0, 'mcp.call', { native: 'mcp__github__get_issue', identity: { server: 'github', tool: 'get_issue' } });
    const skeleton = skeletonFrom(
      store({
        sessions: [session('s1', { frame: framed })],
        prompts: [framedPrompt('s1', 0)],
        tools: [tool('s1', 0, 'mcp__github__acme_secret_deploy', { steps: [dropped] }), tool('s1', 1, 'mcp__github__get_issue', { steps: [kept] })],
      }),
    );
    expect(skeleton?.transcripts[0]?.tools.map((entry) => entry.steps[0]?.identity)).toEqual([
      { server: 'github', tool: LITERAL },
      { server: 'github', tool: 'get_issue' },
    ]);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton });
  });

  it('folds a subagent transcript under the session that spawned it', () => {
    const from = store({
      sessions: [session('s1', { frame: framed })],
      subagents: [session('s1~agent-x', { parent: 's1', frame: framed })],
      prompts: [framedPrompt('s1', 0)],
      tools: [tool('s1', 0, 'Bash', { steps: [shell] }), tool('s1~agent-x', 0, 'Bash', { parent: 's1', steps: [shell] })],
    });
    expect(sessionsFrom(from)).toHaveLength(1);
    const skeleton = skeletonFrom(from);
    expect(skeleton?.transcripts).toHaveLength(2);
    expect(skeleton?.transcripts[1]?.tools).toHaveLength(1);
  });
});

describe('ordinals', () => {
  it('sends a call and a prompt as positions, never the numbers the session gave them, and no spawner or edge', () => {
    const from = store({
      sessions: [session('s1', { frame: framed })],
      subagents: [session('s1~agent-x', { parent: 's1', spawnedIn: 's1', frame: framed })],
      prompts: [framedPrompt('s1', 4), framedPrompt('s1', 2)],
      tools: [
        tool('s1', 9, 'Bash', { prompt: 2, steps: [shell] }),
        tool('s1', 3, 'Bash', { prompt: 4, steps: [shell] }),
        tool('s1', 7, 'Bash', { prompt: 2, steps: [shell] }),
        tool('s1~agent-x', 21, 'Bash', { parent: 's1', prompt: null, steps: [{ ...shell, parent: 7, edges: [{ kind: 'spawned', n: 7, seg: 0 }] }] }),
      ],
    });
    const skeleton = skeletonFrom(from);
    // Calls 3, 7, and 9 are positions 0, 1, and 2; prompts 2 and 4 are positions 0 and 1.
    expect(skeleton?.transcripts[0]?.tools.map((held) => held.prompt)).toEqual([1, 0, 0]);
    expect(skeleton?.transcripts[1]?.tools[0]?.steps[0]?.parent).toBe(1);
    const text = JSON.stringify(skeleton);
    for (const field of ['"spawnedIn"', '"edges"', '"index"', '"n"', '"seg"']) expect(text).not.toContain(field);
    expect(parseSkeleton(JSON.parse(text))).toEqual({ ok: true, skeleton });
  });

  it('sends no link for a subagent a subagent spawned, whose parent number is not a call of the main run', () => {
    const from = store({
      sessions: [session('s1', { frame: framed })],
      subagents: [session('s1~agent-x', { parent: 's1', spawnedIn: 's1', frame: framed }), session('s1~agent-y', { parent: 's1', spawnedIn: 's1~agent-x', frame: framed })],
      prompts: [framedPrompt('s1', 0)],
      tools: [
        tool('s1', 1, 'Bash', { steps: [shell] }),
        tool('s1', 2, 'Bash', { steps: [shell] }),
        tool('s1~agent-x', 2, 'Bash', { parent: 's1', steps: [shell] }),
        tool('s1~agent-y', 0, 'Bash', { parent: 's1', steps: [{ ...shell, parent: 2 }] }),
      ],
    });
    const parents = skeletonFrom(from)?.transcripts.map((held) => held.tools[0]?.steps[0]?.parent);
    // Call 2 of agent-x spawned agent-y, which the main run's own call 2 (position 1) did not.
    expect(parents?.[2]).toBeNull();
  });

  it('numbers the prompts a subagent names but does not hold after the ones it holds, one position per number', () => {
    const from = store({
      sessions: [session('s1', { frame: framed })],
      subagents: [session('s1~agent-x', { parent: 's1', frame: framed })],
      prompts: [framedPrompt('s1', 0)],
      tools: [tool('s1', 0, 'Bash', { prompt: 0, steps: [shell] }), tool('s1~agent-x', 0, 'Bash', { parent: 's1', prompt: 5, steps: [shell] }), tool('s1~agent-x', 1, 'Bash', { parent: 's1', prompt: 8, steps: [shell] }), tool('s1~agent-x', 2, 'Bash', { parent: 's1', prompt: 5, steps: [shell] })],
    });
    const skeleton = skeletonFrom(from);
    expect(skeleton?.transcripts[1]?.tools.map((held) => held.prompt)).toEqual([0, 1, 0]);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton });
  });
});

describe('parseSkeleton refuses, and names the field', () => {
  const cases: { name: string; path: Path; value: unknown; field: string }[] = [
    { name: 'a smuggled class A field on a prompt', path: ['transcripts', 0, 'prompts', 0, 'head'], value: 'text', field: 'transcripts[0].prompts[0].head' },
    { name: 'a smuggled class A field on a call', path: ['transcripts', 0, 'tools', 0, 'tool'], value: 'mcp__acme__secret', field: 'transcripts[0].tools[0].tool' },
    { name: 'a smuggled top-level field', path: ['project'], value: 'acme', field: 'project' },
    { name: 'a private program', path: [...firstStep, 'identity', 'program'], value: 'acme-deploy', field: `${stepField}.identity.program` },
    { name: 'a subcommand outside the table', path: [...firstStep, 'identity', 'sub'], value: 'acme-release', field: `${stepField}.identity.sub` },
    { name: 'a flag with a value', path: [...firstStep, 'identity', 'flags'], value: ['--token=abc'], field: `${stepField}.identity.flags[0]` },
    { name: 'an action outside the list', path: [...firstStep, 'action'], value: 'acme.action', field: `${stepField}.action` },
    { name: 'a native name no table lists', path: [...firstStep, 'native'], value: 'AcmeTool', field: `${stepField}.native` },
    { name: 'a model outside the vocabulary', path: ['transcripts', 0, 'frame', 'model'], value: 'acme-llm', field: 'transcripts[0].frame.model' },
    { name: 'a language outside the vocabulary', path: ['transcripts', 0, 'prompts', 0, 'frame', 'stack', 'languages'], value: ['acme-lang'], field: 'transcripts[0].prompts[0].frame.stack.languages[0]' },
    { name: 'a platform outside the list', path: ['transcripts', 0, 'frame', 'platform'], value: 'acme-os', field: 'transcripts[0].frame.platform' },
    { name: 'a shell outside the list', path: ['transcripts', 0, 'frame', 'shell'], value: 'acme-sh', field: 'transcripts[0].frame.shell' },
    { name: 'a day that is not a day', path: ['transcripts', 0, 'frame', 'day'], value: '2026-11-01T10:00:00Z', field: 'transcripts[0].frame.day' },
    { name: 'a day no calendar holds: 2026-99-99', path: ['transcripts', 0, 'frame', 'day'], value: '2026-99-99', field: 'transcripts[0].frame.day' },
    { name: 'a day no calendar holds: 0000-00-00', path: ['transcripts', 0, 'frame', 'day'], value: '0000-00-00', field: 'transcripts[0].frame.day' },
    { name: 'a day no calendar holds: 2026-13-01', path: ['transcripts', 0, 'frame', 'day'], value: '2026-13-01', field: 'transcripts[0].frame.day' },
    { name: 'a day no calendar holds: 2026-02-31', path: ['transcripts', 0, 'frame', 'day'], value: '2026-02-31', field: 'transcripts[0].frame.day' },
    { name: 'a prompt class outside the list', path: ['transcripts', 0, 'prompts', 0, 'cls'], value: 'acme', field: 'transcripts[0].prompts[0].cls' },
    { name: 'text in a count', path: ['transcripts', 0, 'prompts', 0, 'errors'], value: 'many', field: 'transcripts[0].prompts[0].errors' },
    { name: 'an id that is not a hash', path: ['id'], value: 'acme-session', field: 'id' },
    { name: 'a format this server does not know', path: ['format'], value: 99, field: 'format' },
    { name: 'a missing field', path: ['transcripts', 0, 'frame'], value: undefined, field: 'transcripts[0].frame' },
    { name: 'no transcript at all', path: ['transcripts'], value: [], field: 'transcripts' },
    { name: 'a harness outside the list', path: ['transcripts', 0, 'harness'], value: 'acme', field: 'transcripts[0].harness' },
    { name: 'a fraction in a count', path: ['transcripts', 0, 'prompts', 0, 'errors'], value: 1.5, field: 'transcripts[0].prompts[0].errors' },
    { name: 'a count no whole number holds', path: ['transcripts', 0, 'prompts', 0, 'usage', 'input'], value: 1e308, field: 'transcripts[0].prompts[0].usage.input' },
    { name: 'the number of a step in its call', path: [...firstStep, 'seg'], value: 0, field: `${stepField}.seg` },
    { name: 'a wall time past any real prompt', path: ['transcripts', 0, 'prompts', 0, 'wallSec'], value: 1e308, field: 'transcripts[0].prompts[0].wallSec' },
    { name: 'a prompt position past anything the transcript could number', path: ['transcripts', 0, 'tools', 0, 'prompt'], value: 99, field: 'transcripts[0].tools[0].prompt' },
    { name: 'a spawning call the main run does not hold', path: [...firstStep, 'parent'], value: 99, field: `${stepField}.parent` },
    { name: 'a fraction for a parent', path: [...firstStep, 'parent'], value: 0.5, field: `${stepField}.parent` },
    { name: 'the exact number of a call', path: ['transcripts', 0, 'tools', 0, 'n'], value: 3, field: 'transcripts[0].tools[0].n' },
    { name: 'the exact index of a prompt', path: ['transcripts', 0, 'prompts', 0, 'index'], value: 3, field: 'transcripts[0].prompts[0].index' },
    { name: 'a spawner address', path: ['transcripts', 0, 'spawnedIn'], value: 0, field: 'transcripts[0].spawnedIn' },
    { name: 'a step edge', path: [...firstStep, 'edges'], value: [], field: `${stepField}.edges` },
    { name: 'a private agent name as a subagent type', path: [...firstStep, 'agentType'], value: 'acme-private-agent', field: `${stepField}.agentType` },
    { name: 'a subagent type on a main-run step', path: [...firstStep, 'agentType'], value: 'Explore', field: `${stepField}.agentType` },
    { name: 'a root that is not a SHA-256', path: ['transcripts', 0, 'merkleRoot'], value: 'acme-root', field: 'transcripts[0].merkleRoot' },
    { name: 'a timing print that is not a hash', path: ['timingPrint'], value: 'acme', field: 'timingPrint' },
    { name: 'a timing print over too few timed calls', path: ['timingPrint'], value: '0123456789abcdef', field: 'timingPrint' },
    { name: 'a remaining-token count that is no bucket', path: [...firstStep, 'remainingTokens'], value: 12, field: `${stepField}.remainingTokens` },
  ];
  it.each(cases)('$name', ({ path, value, field }) => {
    expect(refusedField(sent(path, value))).toBe(field);
  });

  it('refuses a subagent step that carries no type', () => {
    const [main, other] = [session('s1', { frame: framed }), session('s1~a', { parent: 's1', spawnedIn: 's1', agentType: 'Explore', frame: framed })];
    const skeleton = skeletonFrom(
      store({
        sessions: [main],
        subagents: [other],
        prompts: [framedPrompt('s1', 0), framedPrompt('s1~a', 0)],
        tools: [tool('s1', 0, 'Bash', { steps: [shell] }), tool('s1~a', 0, 'Bash', { steps: [shell] })],
      }),
    );
    const raw: unknown = JSON.parse(JSON.stringify(skeleton));
    expect(refusedField(raw)).toBe('accepted');
    const subStep = ['transcripts', 1, 'tools', 0, 'steps', 0].reduce<unknown>((at, key) => (isHolder(at) ? Reflect.get(at, key) : undefined), raw);
    if (!isHolder(subStep)) throw new Error('the subagent has no step');
    Reflect.set(subStep, 'agentType', null);
    expect(refusedField(raw)).toBe('transcripts[1].tools[0].steps[0].agentType');
  });

  it('takes a bucket of wall time, and refuses an exact one: a fraction is no bucket', () => {
    expect(refusedField(sent(['transcripts', 0, 'prompts', 0, 'wallSec'], 6))).toBe('accepted');
    expect(refusedField(sent(['transcripts', 0, 'prompts', 0, 'wallSec'], null))).toBe('accepted');
    expect(refusedField(sent(['transcripts', 0, 'prompts', 0, 'wallSec'], 1.5))).toBe('transcripts[0].prompts[0].wallSec');
  });

  it('holds every bucketed field to its own edges', () => {
    const prompt = ['transcripts', 0, 'prompts', 0];
    expect(refusedField(sent([...prompt, 'usage', 'input'], 11))).toBe('accepted');
    expect(refusedField(sent([...prompt, 'usage', 'input'], 12))).toBe('transcripts[0].prompts[0].usage.input');
    expect(refusedField(sent([...prompt, 'usage', 'thinking'], 12))).toBe('transcripts[0].prompts[0].usage.thinking');
    expect(refusedField(sent([...prompt, 'errors'], -1))).toBe('transcripts[0].prompts[0].errors');
    expect(refusedField(sent([...prompt, 'wallSec'], 18))).toBe('transcripts[0].prompts[0].wallSec');
    expect(refusedField(sent([...firstStep, 'tokens'], 12))).toBe(`${stepField}.tokens`);
    expect(refusedField(sent([...firstStep, 'ms'], 18))).toBe(`${stepField}.ms`);
    expect(refusedField(sent([...firstStep, 'ms'], 17))).toBe('accepted');
  });

  it('refuses an exact count where the form holds a bucket: the old step cost and a stray exact field', () => {
    expect(refusedField(withStep({ cost: { tokens: 1500, durationMs: 40 } }))).toBe(`${stepField}.cost`);
    expect(refusedField(sent(['transcripts', 0, 'prompts', 0, 'usage', 'total'], 1500))).toBe('transcripts[0].prompts[0].usage.total');
  });

  it('refuses the exact-count form (format 1) by name, and a deposit that carries deltas', () => {
    const old = parseSkeleton({ ...sample(), format: 1 });
    expect(old).toMatchObject({ ok: false, field: 'format', reason: 'the exact-count form (format 1) is no longer read; send format 3' });
    expect(refusedField(sent(['deltas'], [{}]))).toBe('deltas[0].deltaKind');
    expect(refusedField(sent(['deltas'], undefined))).toBe('deltas');
    expect(refusedField(sent(['deltas'], 'none'))).toBe('deltas');
  });

  it('refuses a skeleton holding no prompt and no tool, which would otherwise count as a deposit', () => {
    const [transcript] = sample().transcripts;
    if (transcript === undefined) throw new Error('the sample has no transcript');
    expect(refusedField(sent(['transcripts', 0], { ...transcript, prompts: [], tools: [] }))).toBe('transcripts');
    expect(refusedField(sent(['transcripts', 0], { ...transcript, prompts: [] }))).toBe('accepted');
    expect(refusedField(sent(['transcripts', 0], { ...transcript, tools: [] }))).toBe('accepted');
  });

  it('refuses what is not an object', () => {
    expect(refusedField('text')).toBe('skeleton');
    expect(refusedField(null)).toBe('skeleton');
    expect(refusedField([])).toBe('skeleton');
  });

  it('spells a native name the vocabulary does not know as private, never the literal', () => {
    expect(refusedField(withStep({ native: PRIVATE }))).toBe('accepted');
    expect(refusedField(withStep({ native: LITERAL }))).toBe(`${stepField}.native`);
  });

  it('reads a shell program as a list member or private, never the literal, and a private program holds no subcommand', () => {
    expect(refusedField(withStep({ identity: { program: PRIVATE, sub: null, flags: [] } }))).toBe('accepted');
    expect(refusedField(withStep({ identity: { program: LITERAL, sub: null, flags: [] } }))).toBe(`${stepField}.identity.program`);
    expect(refusedField(withStep({ identity: { program: PRIVATE, sub: 'push', flags: [] } }))).toBe(`${stepField}.identity.sub`);
    expect(refusedField(withStep({ identity: { program: PRIVATE, sub: null, flags: ['--force'] } }))).toBe(`${stepField}.identity.flags`);
    expect(refusedField(withStep({ identity: { program: PRIVATE, sub: null, flags: [], pulls: [] } }))).toBe(`${stepField}.identity.pulls`);
    expect(refusedField(withStep({ identity: { program: 'git', sub: 'push', flags: ['-f', '--force'] } }))).toBe('accepted');
    expect(refusedField(withStep({ identity: { program: 'git', sub: 'push', flags: ['-force'] } }))).toBe(`${stepField}.identity.flags[0]`);
  });

  it('holds MCP, skill, and web identities to their own lists', () => {
    expect(refusedField(withStep({ action: 'mcp.call', native: PRIVATE, identity: { server: 'github', tool: 'get_issue' } }))).toBe('accepted');
    expect(refusedField(withStep({ action: 'mcp.call', native: 'mcp__github__get_issue', identity: { server: 'github', tool: 'get_issue' } }))).toBe('accepted');
    expect(refusedField(withStep({ action: 'mcp.call', native: 'mcp__acme__get_issue', identity: null }))).toBe(`${stepField}.native`);
    expect(refusedField(withStep({ action: 'mcp.call', native: PRIVATE, identity: { server: 'acme', tool: 'x' } }))).toBe(`${stepField}.identity.server`);
    expect(refusedField(withStep({ action: 'skill.run', native: 'Skill', identity: { skill: 'acme-skill' } }))).toBe(`${stepField}.identity.skill`);
    expect(refusedField(withStep({ action: 'mcp.call', native: PRIVATE, identity: { server: PRIVATE, tool: LITERAL } }))).toBe('accepted');
    expect(refusedField(withStep({ action: 'mcp.call', native: PRIVATE, identity: { server: LITERAL, tool: LITERAL } }))).toBe(`${stepField}.identity.server`);
    expect(refusedField(withStep({ action: 'skill.run', native: 'Skill', identity: { skill: PRIVATE } }))).toBe('accepted');
    expect(refusedField(withStep({ action: 'skill.run', native: 'Skill', identity: { skill: LITERAL } }))).toBe(`${stepField}.identity.skill`);
    expect(refusedField(withStep({ action: 'web.fetch', native: 'WebFetch', identity: { host: PRIVATE } }))).toBe('accepted');
    expect(refusedField(withStep({ action: 'web.fetch', native: 'WebFetch', identity: { host: LITERAL } }))).toBe(`${stepField}.identity.host`);
    expect(refusedField(withStep({ action: 'web.fetch', native: 'WebFetch', identity: { host: 'acme.internal' } }))).toBe(`${stepField}.identity.host`);
    expect(refusedField(withStep({ action: 'web.fetch', native: 'WebFetch', identity: { host: 'github.com' } }))).toBe('accepted');
    expect(refusedField(withStep({ action: 'file.read', native: 'Read', identity: { path: '/home/me' } }))).toBe(`${stepField}.identity`);
  });

  it('holds a pull to the registries, packages, and versions it may name', () => {
    const pull = (over: object): unknown => withStep({ identity: { program: 'npm', sub: null, flags: [], pulls: [{ registry: 'npm', name: 'zod', version: null, ...over }] } });
    expect(refusedField(pull({}))).toBe('accepted');
    expect(refusedField(pull({ version: '^4.0.0' }))).toBe('accepted');
    expect(refusedField(pull({ name: 'acme-private' }))).toBe(`${stepField}.identity.pulls[0].name`);
    expect(refusedField(pull({ name: PRIVATE }))).toBe('accepted');
    expect(refusedField(pull({ name: LITERAL }))).toBe(`${stepField}.identity.pulls[0].name`);
    expect(refusedField(pull({ registry: 'acme' }))).toBe(`${stepField}.identity.pulls[0].registry`);
    expect(refusedField(pull({ version: 'latest-acme' }))).toBe(`${stepField}.identity.pulls[0].version`);
    // A version beside a masked name identifies the name, so only a null version or the literal travels with `private`.
    expect(refusedField(pull({ name: PRIVATE, version: null }))).toBe('accepted');
    expect(refusedField(pull({ name: PRIVATE, version: LITERAL }))).toBe('accepted');
    expect(refusedField(pull({ name: PRIVATE, version: '7.3.1' }))).toBe(`${stepField}.identity.pulls[0].version`);
  });

  it('holds a version suffix to digits and release words', () => {
    const pull = (version: string): unknown => withStep({ identity: { program: 'npm', sub: null, flags: [], pulls: [{ registry: 'npm', name: 'zod', version }] } });
    for (const version of ['1.2.3', '^4.0.0', 'v2.x', '1.2.3-rc.1', '1.0.0-beta.2', '1.0.0-next.20250101', '1.0.0+5']) expect(refusedField(pull(version))).toBe('accepted');
    for (const version of ['1.0.0-acme-secret', '1.0.0+sha.5114f85', '1.0.0-rc.acme', '1.0.0-', '1.0.0-SNAPSHOT']) expect(refusedField(pull(version))).toBe(`${stepField}.identity.pulls[0].version`);
    const harness = (version: string): string => refusedField(sent(['transcripts', 0, 'frame', 'harnessVersion'], version));
    for (const version of ['2.1.314', '2.0.0-beta.1', '1.7.0-nightly', '2.0.0-dev.20250101']) expect(harness(version)).toBe('accepted');
    for (const version of ['1.0.0-acme-secret', '1.0.0.acme', '1.0.0+abc123']) expect(harness(version)).toBe('transcripts[0].frame.harnessVersion');
  });

  // The server's own list, as capture applies it, so a name only a forged client could write is refused rather than stored.
  it('takes an MCP tool only when that server lists it', () => {
    const tool = (server: string, name: string): unknown => withStep({ action: 'mcp.call', native: PRIVATE, identity: { server, tool: name } });
    const native = (name: string): unknown => withStep({ action: 'mcp.call', native: name, identity: { server: 'github', tool: LITERAL } });
    expect(refusedField(tool('github', 'acme_secret_deploy'))).toBe(`${stepField}.identity.tool`);
    expect(refusedField(tool('postgres', 'get_issue'))).toBe(`${stepField}.identity.tool`);
    expect(refusedField(tool('github', LITERAL))).toBe('accepted');
    expect(refusedField(native('mcp__github__acme_secret_deploy'))).toBe(`${stepField}.native`);
  });

  // Cursor's spelling cannot show where a server name ends, so capture keeps the tool and the native name out; a deposit naming either did not come from capture.
  it('takes no MCP tool name from a harness whose spelling cannot delimit the server', () => {
    const fromCursor = (over: object): unknown => {
      const raw = withStep({ action: 'mcp.call', ...over });
      if (!isHolder(raw)) throw new Error('the sample is not an object');
      const transcripts: unknown = Reflect.get(raw, 'transcripts');
      if (!Array.isArray(transcripts) || !isHolder(transcripts[0])) throw new Error('the sample has no transcript');
      Reflect.set(transcripts[0], 'harness', 'cursor');
      return raw;
    };
    expect(refusedField(fromCursor({ native: PRIVATE, identity: { server: 'github', tool: LITERAL } }))).toBe('accepted');
    expect(refusedField(fromCursor({ native: PRIVATE, identity: { server: 'github', tool: 'get_issue' } }))).toBe(`${stepField}.identity.tool`);
    expect(refusedField(fromCursor({ native: 'mcp_github_get_issue', identity: { server: 'github', tool: LITERAL } }))).toBe(`${stepField}.native`);
  });

  // The harness list is the schema's `Harness` union: a skeleton from a harness missing from it is refused whole, so each name needs a pass here.
  it('accepts a skeleton from every harness the schema names', () => {
    const natives: [Harness, string][] = [['claude-code', 'Bash'], ['cursor', 'run_terminal_cmd'], ['codex', 'exec_command'], ['copilot', 'bash'], ['gemini', 'run_shell_command'], ['grok', 'run_terminal_cmd'], ['vscode-copilot', 'run_in_terminal']];
    for (const [harness, native] of natives) {
      const raw = withStep({ native });
      if (!isHolder(raw)) throw new Error('the sample is not an object');
      const transcripts: unknown = Reflect.get(raw, 'transcripts');
      if (!Array.isArray(transcripts) || !isHolder(transcripts[0])) throw new Error('the sample has no transcript');
      Reflect.set(transcripts[0], 'harness', harness);
      expect(refusedField(raw), harness).toBe('accepted');
    }
  });
});

describe('the language shares on the wire', () => {
  const stackFrame = frame({ shell: 'bash', stack: { languages: ['python', 'typescript'], frameworks: [], size: null } });
  const withStrata = (languages: { language: string; share: string }[]): SessionSkeleton => {
    // The stored share is text on a record, so a test can hold one the list does not: Object.assign types the result as the record while the input stays loose.
    const stored: Strata = Object.assign({ languages: [], repoFiles: null, frameworks: [], explore: 0 }, { languages });
    const skeleton = skeletonFrom(store({ sessions: [session('s1', { frame: stackFrame, strata: stored })], prompts: [prompt('s1', 0, { frame: stackFrame, strata: stored })] }));
    if (skeleton === null) throw new Error('no skeleton');
    return skeleton;
  };

  it('each language carries its share bucket, in the session frame and in each prompt frame', () => {
    const skeleton = withStrata([
      { language: 'python', share: 'under-10' },
      { language: 'typescript', share: 'over-50' },
    ]);
    const shares = [
      { language: 'python', languageShare: 'under-10' },
      { language: 'typescript', languageShare: 'over-50' },
    ];
    expect(skeleton.transcripts[0]?.frame.stack.languageShares).toEqual(shares);
    expect(skeleton.transcripts[0]?.prompts[0]?.frame.stack.languageShares).toEqual(shares);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton });
  });

  it('drops a share outside its list and still sends the language', () => {
    const skeleton = withStrata([
      { language: 'python', share: '37' },
      { language: 'typescript', share: 'over-50' },
    ]);
    expect(skeleton.transcripts[0]?.frame.stack.languages).toEqual(['python', 'typescript']);
    expect(skeleton.transcripts[0]?.frame.stack.languageShares).toEqual([{ language: 'typescript', languageShare: 'over-50' }]);
  });

  it('sends a language outside the pinned list as other, and one share for it', () => {
    const skeleton = withStrata([
      { language: 'klingon', share: '10-50' },
      { language: 'other', share: 'under-10' },
    ]);
    expect(skeleton.transcripts[0]?.frame.stack.languageShares).toEqual([{ language: 'other', languageShare: '10-50' }]);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton });
  });

  it('parses the batch of a session that touched a .ts, a .ts, and a README.md', () => {
    // The strata come from the real strataOf, so the language other that it stores for an off-list extension must pass the parse.
    const strata: Strata = { ...strataOf({ paths: ['/r/a.ts', '/r/b.ts', '/r/README.md'], packages: [], size: null }), explore: 0 };
    expect(strata.languages).toEqual([{ language: 'other', share: '10-50' }, { language: 'typescript', share: 'over-50' }]);
    const skeleton = skeletonFrom(store({ sessions: [session('s1', { frame: stackFrame, strata })], prompts: [prompt('s1', 0, { frame: stackFrame, strata })] }));
    if (skeleton === null) throw new Error('no skeleton');
    expect(skeleton.transcripts[0]?.frame.stack.languageShares).toEqual([{ language: 'other', languageShare: '10-50' }, { language: 'typescript', languageShare: 'over-50' }]);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton });
  });

  it('keeps other out of the frame languages, which stay closed', () => {
    const raw: unknown = JSON.parse(JSON.stringify(withStrata([])));
    let holder: unknown = raw;
    for (const key of ['transcripts', 0, 'frame', 'stack']) holder = isHolder(holder) ? Reflect.get(holder, key) : undefined;
    if (!isHolder(holder)) throw new Error('no stack');
    Reflect.set(holder, 'languages', ['other']);
    expect(refusedField(raw)).toBe('transcripts[0].frame.stack.languages[0]');
  });

  it('sends none for a record captured before the strata', () => {
    const skeleton = skeletonFrom(store({ sessions: [session('s1', { frame: stackFrame })], prompts: [prompt('s1', 0, { frame: stackFrame })] }));
    expect(skeleton?.transcripts[0]?.frame.stack.languageShares).toEqual([]);
  });

  const at = ['transcripts', 0, 'frame', 'stack', 'languageShares'] as const;
  const field = 'transcripts[0].frame.stack.languageShares';
  it.each([
    { name: 'a share outside the list', value: [{ language: 'python', languageShare: '37' }], field: `${field}[0].languageShare` },
    { name: 'a language outside the vocabulary', value: [{ language: 'acme-lang', languageShare: '0' }], field: `${field}[0].language` },
    { name: 'a smuggled key beside a share', value: [{ language: 'python', languageShare: '0', files: 12 }], field: `${field}[0].files` },
    { name: 'text for the list', value: 'python', field },
    { name: 'a missing share', value: [{ language: 'python' }], field: `${field}[0].languageShare` },
  ])('parseSkeleton refuses $name', ({ value, field: refused }) => {
    const raw: unknown = JSON.parse(JSON.stringify(withStrata([])));
    let holder: unknown = raw;
    for (const key of at.slice(0, -1)) holder = isHolder(holder) ? Reflect.get(holder, key) : undefined;
    if (!isHolder(holder)) throw new Error('no stack');
    Reflect.set(holder, 'languageShares', value);
    expect(refusedField(raw)).toBe(refused);
  });

  it('parseSkeleton refuses a stack with no list of shares', () => {
    const raw: unknown = JSON.parse(JSON.stringify(withStrata([])));
    let holder: unknown = raw;
    for (const key of at.slice(0, -1)) holder = isHolder(holder) ? Reflect.get(holder, key) : undefined;
    if (!isHolder(holder)) throw new Error('no stack');
    Reflect.deleteProperty(holder, 'languageShares');
    expect(refusedField(raw)).toBe(field);
  });
});

describe('explore on the wire', () => {
  const exploring = (explore: number | undefined): SessionSkeleton => {
    const strata = explore === undefined ? undefined : { languages: [], repoFiles: null, frameworks: [], explore };
    const skeleton = skeletonFrom(store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed, strata }), prompt('s1', 1, { frame: framed, strata })] }));
    if (skeleton === null) throw new Error('no skeleton');
    return skeleton;
  };

  it('is the count bucket of the exact count, and the exact count is nowhere in the batch', () => {
    const skeleton = exploring(37);
    // 37 is past the edges 1, 2, 3, 5, 9, 17, and 33: bucket 7.
    expect(skeleton.transcripts[0]?.prompts.map(({ explore }) => explore)).toEqual([7, 7]);
    expect(JSON.stringify(skeleton)).not.toContain('"explore":37');
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton });
  });

  it('has buckets of doubling width past 32, so a long session still tells 100 from 3,000', () => {
    expect([0, 1, 4, 32, 33, 64, 65, 3000, 4096, 4097, 1e9].map((count) => projectExplore(count))).toEqual([0, 1, 3, 6, 7, 7, 8, 13, 13, 14, 14]);
  });

  it('is null for a record captured before the strata, and for a count no bucket holds', () => {
    expect(exploring(undefined).transcripts[0]?.prompts.map(({ explore }) => explore)).toEqual([null, null]);
    for (const stored of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) expect(projectExplore(stored)).toBeNull();
  });

  const field = 'transcripts[0].prompts[0].explore';
  it.each([
    { name: 'text for a bucket', value: 'many' },
    { name: 'a bucket past the last', value: 15 },
    { name: 'a fraction', value: 2.5 },
    { name: 'a negative bucket', value: -1 },
  ])('parseSkeleton refuses $name', ({ value }) => {
    expect(refusedField(sent(['transcripts', 0, 'prompts', 0, 'explore'], value))).toBe(field);
  });

  it('parseSkeleton refuses a prompt with no explore field', () => {
    expect(refusedField(sent(['transcripts', 0, 'prompts', 0, 'explore'], undefined))).toBe(field);
  });
});
