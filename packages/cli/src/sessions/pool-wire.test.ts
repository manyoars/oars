import { describe, expect, it } from 'vitest';
import { frame, prompt, session, step, store, tool } from './pool-fixture.js';
import { parseSkeleton, sessionsOf, skeletonOf, stacksOf, type SessionSkeleton } from './pool-wire.js';
import { LITERAL } from './public-vocabulary.js';

// Real capture writes the shell as `shellOf` names it; the shared fixture's frame predates that spelling.
const framed = frame({ shell: 'bash' });
const framedPrompt = (id: string, index: number, over: Parameters<typeof prompt>[2] = {}): ReturnType<typeof prompt> => prompt(id, index, { frame: framed, ...over });

const shell = step(0, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: ['--force'] } });

const skeletonFrom = (from: ReturnType<typeof store>): SessionSkeleton | null => {
  const [only] = sessionsOf(from);
  if (only === undefined) throw new Error('the store has no session');
  return skeletonOf(only, '0123456789abcdef');
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
const withStep = (over: object): unknown => sent(firstStep, JSON.parse(JSON.stringify({ ...shell, n: undefined, frameId: undefined, ...over })));
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

  it('folds a subagent transcript under the session that spawned it', () => {
    const from = store({
      sessions: [session('s1', { frame: framed })],
      subagents: [session('s1~agent-x', { parent: 's1', frame: framed })],
      prompts: [framedPrompt('s1', 0)],
      tools: [tool('s1', 0, 'Bash', { steps: [shell] }), tool('s1~agent-x', 0, 'Bash', { parent: 's1', steps: [shell] })],
    });
    expect(sessionsOf(from)).toHaveLength(1);
    const skeleton = skeletonFrom(from);
    expect(skeleton?.transcripts).toHaveLength(2);
    expect(skeleton?.transcripts[1]?.tools).toHaveLength(1);
  });
});

describe('stacksOf', () => {
  it('reads every language and framework of the frames, sorted and single', () => {
    const skeleton = skeletonFrom(
      store({
        sessions: [session('s1', { frame: frame({ shell: 'bash', stack: { languages: ['typescript'], frameworks: ['vite'], size: 'm' } }) })],
        prompts: [framedPrompt('s1', 0, { frame: frame({ shell: 'bash', stack: { languages: ['go', 'typescript'], frameworks: [], size: null } }) })],
        tools: [tool('s1', 0, 'Bash', { steps: [shell] })],
      }),
    );
    expect(skeleton === null ? [] : stacksOf(skeleton)).toEqual(['go', 'typescript', 'vite']);
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
    { name: 'a prompt class outside the list', path: ['transcripts', 0, 'prompts', 0, 'cls'], value: 'acme', field: 'transcripts[0].prompts[0].cls' },
    { name: 'text in a count', path: ['transcripts', 0, 'prompts', 0, 'errors'], value: 'many', field: 'transcripts[0].prompts[0].errors' },
    { name: 'an id that is not a hash', path: ['id'], value: 'acme-session', field: 'id' },
    { name: 'a format this server does not know', path: ['format'], value: 99, field: 'format' },
    { name: 'a missing field', path: ['transcripts', 0, 'frame'], value: undefined, field: 'transcripts[0].frame' },
    { name: 'no transcript at all', path: ['transcripts'], value: [], field: 'transcripts' },
    { name: 'a harness outside the list', path: ['transcripts', 0, 'harness'], value: 'acme', field: 'transcripts[0].harness' },
  ];
  it.each(cases)('$name', ({ path, value, field }) => {
    expect(refusedField(sent(path, value))).toBe(field);
  });

  it('refuses what is not an object', () => {
    expect(refusedField('text')).toBe('skeleton');
    expect(refusedField(null)).toBe('skeleton');
    expect(refusedField([])).toBe('skeleton');
  });

  it('keeps the literal, which is the vocabulary saying it does not know a name', () => {
    expect(refusedField(withStep({ native: LITERAL, identity: { program: LITERAL, sub: null, flags: [] } }))).toBe('accepted');
  });

  it('holds MCP, skill, and web identities to their own lists', () => {
    expect(refusedField(withStep({ action: 'mcp.call', native: LITERAL, identity: { server: 'github', tool: 'get_issue' } }))).toBe('accepted');
    expect(refusedField(withStep({ action: 'mcp.call', native: 'mcp__github__get_issue', identity: { server: 'github', tool: 'get_issue' } }))).toBe('accepted');
    expect(refusedField(withStep({ action: 'mcp.call', native: 'mcp__acme__get_issue', identity: null }))).toBe(`${stepField}.native`);
    expect(refusedField(withStep({ action: 'mcp.call', native: LITERAL, identity: { server: 'acme', tool: 'x' } }))).toBe(`${stepField}.identity.server`);
    expect(refusedField(withStep({ action: 'skill.run', native: 'Skill', identity: { skill: 'acme-skill' } }))).toBe(`${stepField}.identity.skill`);
    expect(refusedField(withStep({ action: 'web.fetch', native: 'WebFetch', identity: { host: 'acme.internal' } }))).toBe(`${stepField}.identity.host`);
    expect(refusedField(withStep({ action: 'web.fetch', native: 'WebFetch', identity: { host: 'github.com' } }))).toBe('accepted');
    expect(refusedField(withStep({ action: 'file.read', native: 'Read', identity: { path: '/home/me' } }))).toBe(`${stepField}.identity`);
  });

  it('holds a pull to the registries, packages, and versions it may name', () => {
    const pull = (over: object): unknown => withStep({ identity: { program: 'npm', sub: null, flags: [], pulls: [{ registry: 'npm', name: 'zod', version: null, ...over }] } });
    expect(refusedField(pull({}))).toBe('accepted');
    expect(refusedField(pull({ version: '^4.0.0' }))).toBe('accepted');
    expect(refusedField(pull({ name: 'acme-private' }))).toBe(`${stepField}.identity.pulls[0].name`);
    expect(refusedField(pull({ registry: 'acme' }))).toBe(`${stepField}.identity.pulls[0].registry`);
    expect(refusedField(pull({ version: 'latest-acme' }))).toBe(`${stepField}.identity.pulls[0].version`);
  });

  it('holds an edge to its kinds', () => {
    expect(refusedField(withStep({ edges: [{ kind: 'acme', n: 0, seg: 0 }] }))).toBe(`${stepField}.edges[0].kind`);
    expect(refusedField(withStep({ edges: [{ kind: 'next', n: 0, seg: 0 }] }))).toBe('accepted');
  });
});
