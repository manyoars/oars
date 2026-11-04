import { describe, expect, it } from 'vitest';
import { frame, prompt, session, step, store, tool } from './pool-fixture.js';
import { parseSkeleton, sessionsOf, skeletonOf, stacksOf, type SessionSkeleton } from './pool-wire.js';
import type { Harness } from './schema.js';
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

describe('a nested spawn', () => {
  it('names the transcript that spawned each subagent by its position, since a skeleton holds no session id', () => {
    const skeleton = skeletonFrom(
      store({
        sessions: [session('s1', { frame: framed })],
        subagents: [
          session('s1~agent-x', { parent: 's1', spawnedIn: 's1', frame: framed }),
          session('s1~agent-y', { parent: 's1', spawnedIn: 's1~agent-x', frame: framed }),
          session('s1~agent-z', { parent: 's1', spawnedIn: 's1~not-held', frame: framed }),
        ],
        prompts: [framedPrompt('s1', 0)],
      }),
    );
    expect(skeleton?.transcripts.map((transcript) => transcript.spawnedIn)).toEqual([null, 0, 1, null]);
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton)))).toEqual({ ok: true, skeleton });
    expect(JSON.stringify(skeleton)).not.toContain('agent-x');
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
    { name: 'a fraction in a step number', path: [...firstStep, 'seg'], value: 1.5, field: `${stepField}.seg` },
    { name: 'a wall time past any real prompt', path: ['transcripts', 0, 'prompts', 0, 'wallSec'], value: 1e308, field: 'transcripts[0].prompts[0].wallSec' },
    { name: 'a spawner no transcript holds', path: ['transcripts', 0, 'spawnedIn'], value: 5, field: 'transcripts[0].spawnedIn' },
    { name: 'a fraction for a spawner', path: ['transcripts', 0, 'spawnedIn'], value: 0.5, field: 'transcripts[0].spawnedIn' },
  ];
  it.each(cases)('$name', ({ path, value, field }) => {
    expect(refusedField(sent(path, value))).toBe(field);
  });

  it('takes a fraction of a second as wall time', () => {
    expect(refusedField(sent(['transcripts', 0, 'prompts', 0, 'wallSec'], 1.5))).toBe('accepted');
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
    const tool = (server: string, name: string): unknown => withStep({ action: 'mcp.call', native: LITERAL, identity: { server, tool: name } });
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
    expect(refusedField(fromCursor({ native: LITERAL, identity: { server: 'github', tool: LITERAL } }))).toBe('accepted');
    expect(refusedField(fromCursor({ native: LITERAL, identity: { server: 'github', tool: 'get_issue' } }))).toBe(`${stepField}.identity.tool`);
    expect(refusedField(fromCursor({ native: 'mcp_github_get_issue', identity: { server: 'github', tool: LITERAL } }))).toBe(`${stepField}.native`);
  });

  // The harness list is the schema's `Harness` union: a skeleton from a harness missing from it is refused whole, so each name needs a pass here.
  it('accepts a skeleton from every harness the schema names', () => {
    const natives: [Harness, string][] = [['claude-code', 'Bash'], ['cursor', 'run_terminal_cmd'], ['codex', 'exec_command'], ['copilot', 'bash'], ['grok', 'run_terminal_cmd']];
    for (const [harness, native] of natives) {
      const raw = withStep({ native });
      if (!isHolder(raw)) throw new Error('the sample is not an object');
      const transcripts: unknown = Reflect.get(raw, 'transcripts');
      if (!Array.isArray(transcripts) || !isHolder(transcripts[0])) throw new Error('the sample has no transcript');
      Reflect.set(transcripts[0], 'harness', harness);
      expect(refusedField(raw), harness).toBe('accepted');
    }
  });

  it('holds an edge to its kinds', () => {
    expect(refusedField(withStep({ edges: [{ kind: 'acme', n: 0, seg: 0 }] }))).toBe(`${stepField}.edges[0].kind`);
    expect(refusedField(withStep({ edges: [{ kind: 'next', n: 0, seg: 0 }] }))).toBe('accepted');
  });
});
