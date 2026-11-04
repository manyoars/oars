// What a step carries on the wire (t867): the frame it ran in, by position, the skill whose run it sits in, and the reach its frame holds. Every name here is invented or public.
import { describe, expect, it } from 'vitest';
import { incrementsOf } from './cell-increments.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import { PRIVATE } from './public-vocabulary.js';

const framed = frame({ shell: 'bash', model: 'claude-opus-5-5' });
const read = step(0, 0, 'file.read', { native: 'Read' });

/** The wire form of a store's one session. */
const skeletonOfStore = (from: ReturnType<typeof store>): SessionSkeleton => {
  const [only] = sessionsFrom(from);
  const skeleton = only === undefined ? null : skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (skeleton === null) throw new Error('no skeleton');
  return skeleton;
};

/** One prompt whose majority model is opus and whose second call ran on sonnet. */
const midPrompt = (extra: Partial<ReturnType<typeof session>> = {}): SessionSkeleton =>
  skeletonOfStore(
    store({
      sessions: [session('s1', { frame: framed, ...extra })],
      prompts: [prompt('s1', 0, { frame: framed })],
      tools: [
        tool('s1', 0, 'Read', { steps: [read], model: 'claude-opus-5-5', harnessVersion: '2.1.314' }),
        tool('s1', 1, 'Read', { steps: [{ ...read, n: 1 }], model: 'claude-sonnet-5-5', harnessVersion: '2.1.315' }),
        tool('s1', 2, 'Read', { steps: [{ ...read, n: 2 }] }),
      ],
    }),
  );

const resolved = (skeleton: SessionSkeleton): { model: string | null; harnessVersion: string | null }[] => {
  const transcript = skeleton.transcripts[0];
  return (transcript?.tools ?? []).flatMap(({ steps }) => steps.map(({ frame: at }) => ({ model: transcript?.frames[at]?.model ?? null, harnessVersion: transcript?.frames[at]?.harnessVersion ?? null })));
};

describe('a step names its frame', () => {
  it('attributes each step to the model of its own call, which the prompt join cannot', () => {
    expect(resolved(midPrompt())).toEqual([
      { model: 'claude-opus-5-5', harnessVersion: '2.1.314' },
      { model: 'claude-sonnet-5-5', harnessVersion: '2.1.315' },
      // A call that recorded nothing of its own takes its prompt's frame.
      { model: 'claude-opus-5-5', harnessVersion: '2.1.314' },
    ]);
  });

  it('lists each distinct frame once, and the prompt join still holds the prompt its majority model', () => {
    const skeleton = midPrompt();
    expect(skeleton.transcripts[0]?.frames).toHaveLength(2);
    expect(skeleton.transcripts[0]?.prompts[0]?.frame.model).toBe('claude-opus-5-5');
  });

  it('survives the parser, and the parser refuses a position outside the list', () => {
    const skeleton = midPrompt();
    const parsed = parseSkeleton(JSON.parse(JSON.stringify(skeleton)));
    expect(parsed.ok).toBe(true);
    const bad: SessionSkeleton = JSON.parse(JSON.stringify(skeleton));
    const first = bad.transcripts[0]?.tools[0]?.steps[0];
    if (first === undefined) throw new Error('no step');
    first.frame = bad.transcripts[0]?.frames.length ?? 99;
    expect(parseSkeleton(bad)).toEqual({ ok: false, field: 'transcripts[0].tools[0].steps[0].frame', reason: 'no such frame position' });
    first.frame = -1;
    expect(parseSkeleton(bad)).toMatchObject({ ok: false, field: 'transcripts[0].tools[0].steps[0].frame' });
  });

  it('refuses a step with no frame, and a format-2 batch', () => {
    const raw: SessionSkeleton = JSON.parse(JSON.stringify(midPrompt()));
    const first = raw.transcripts[0]?.tools[0]?.steps[0];
    if (first === undefined) throw new Error('no step');
    Reflect.deleteProperty(first, 'frame');
    expect(parseSkeleton(raw)).toEqual({ ok: false, field: 'transcripts[0].tools[0].steps[0].frame', reason: 'missing' });
    expect(parseSkeleton({ ...JSON.parse(JSON.stringify(midPrompt())), format: 2 })).toEqual({ ok: false, field: 'format', reason: 'not a format this version reads' });
  });
});

describe('the skill behind a call', () => {
  const inRun = (): SessionSkeleton =>
    skeletonOfStore(
      store({
        sessions: [session('s1', { frame: framed })],
        prompts: [prompt('s1', 0, { frame: framed })],
        tools: [
          tool('s1', 0, 'Skill', { steps: [step(0, 0, 'skill.run', { native: 'Skill', identity: { skill: 'commit' } })] }),
          tool('s1', 1, 'Read', { steps: [{ ...read, n: 1 }], skill: 'commit' }),
          tool('s1', 2, 'Read', { steps: [{ ...read, n: 2 }], skill: 'acme-private-skill' }),
          tool('s1', 3, 'Read', { steps: [{ ...read, n: 3 }] }),
        ],
      }),
    );

  it('goes on the steps of the calls in the run, a listed skill by name and any other as private, and not on the call after it', () => {
    const steps = inRun().transcripts[0]?.tools.flatMap((call) => call.steps) ?? [];
    expect(steps.map((held) => held.skill)).toEqual([undefined, 'commit', PRIVATE, undefined]);
    expect(JSON.stringify(inRun())).not.toContain('acme-private-skill');
  });

  it('survives the parser, which holds the skill to the list', () => {
    expect(parseSkeleton(JSON.parse(JSON.stringify(inRun()))).ok).toBe(true);
    const bad: SessionSkeleton = JSON.parse(JSON.stringify(inRun()));
    const held = bad.transcripts[0]?.tools[1]?.steps[0];
    if (held === undefined) throw new Error('no step');
    held.skill = 'acme-private-skill';
    expect(parseSkeleton(bad)).toEqual({ ok: false, field: 'transcripts[0].tools[1].steps[0].skill', reason: 'outside the vocabulary' });
  });
});

describe('the reach on the frame', () => {
  it('lists the servers, skills, and plugins the session shows, each listed or private', () => {
    const skeleton = midPrompt({
      setup: { plugins: ['acme-plugin'] },
      funnel: { offered: ['mcp__playwright__browser_click', 'mcp__acme-internal__run', 'Read'], loaded: ['mcp__github__create_issue'] },
    });
    expect(skeleton.transcripts[0]?.frame.reach).toEqual({ filled: true, mcp: ['github', 'playwright', PRIVATE], skills: [], plugins: [PRIVATE] });
    expect(skeleton.transcripts[0]?.frames.every(({ reach }) => reach?.filled === true)).toBe(true);
    expect(JSON.stringify(skeleton)).not.toContain('acme');
    expect(parseSkeleton(JSON.parse(JSON.stringify(skeleton))).ok).toBe(true);
  });

  it('says it is unfilled when the harness filled no setup, so absence is not read as no tools', () => {
    const skeleton = midPrompt();
    expect(skeleton.transcripts[0]?.frame.reach).toEqual({ filled: false, mcp: [], skills: [], plugins: [] });
  });

  it('refuses a name outside the lists, and a filled reach that is empty only by being unfilled', () => {
    const bad: SessionSkeleton = JSON.parse(JSON.stringify(midPrompt({ setup: { plugins: ['x'] } })));
    const reach = bad.transcripts[0]?.frame.reach;
    if (reach === undefined) throw new Error('no reach');
    reach.mcp = ['acme-internal'];
    expect(parseSkeleton(bad)).toEqual({ ok: false, field: 'transcripts[0].frame.reach.mcp[0]', reason: 'outside the vocabulary' });
  });
});

describe('the lists the parser holds', () => {
  const raw = (): SessionSkeleton => JSON.parse(JSON.stringify(midPrompt()));

  it('refuses an unfilled reach that lists a name, and a transcript with no frames', () => {
    const unfilled = raw();
    const reach = unfilled.transcripts[0]?.frame.reach;
    if (reach === undefined) throw new Error('no reach');
    reach.mcp = ['github'];
    expect(parseSkeleton(unfilled)).toEqual({ ok: false, field: 'transcripts[0].frame.reach', reason: 'an unfilled reach lists nothing' });
    const none = raw();
    const transcript = none.transcripts[0];
    if (transcript === undefined) throw new Error('no transcript');
    transcript.frames = [];
    expect(parseSkeleton(none)).toEqual({ ok: false, field: 'transcripts[0].frames', reason: 'empty' });
  });

  it('refuses a plugin that is not the word private', () => {
    const bad = raw();
    const reach = bad.transcripts[0]?.frame.reach;
    if (reach === undefined) throw new Error('no reach');
    reach.filled = true;
    reach.plugins = ['acme-plugin'];
    expect(parseSkeleton(bad)).toEqual({ ok: false, field: 'transcripts[0].frame.reach.plugins[0]', reason: 'outside the vocabulary' });
  });
});

describe('the cells do not move', () => {
  it('keeps the cell keys and counts on the prompt join when a call names its own model', () => {
    const base = (model: string | undefined): SessionSkeleton =>
      skeletonOfStore(
        store({
          sessions: [session('s1', { frame: framed })],
          prompts: [prompt('s1', 0, { frame: framed })],
          tools: [tool('s1', 0, 'Read', { steps: [read], ...(model === undefined ? {} : { model }) }), tool('s1', 1, 'Read', { steps: [{ ...read, n: 1 }] })],
        }),
      );
    const cells = (skeleton: SessionSkeleton): string => JSON.stringify(incrementsOf(skeleton));
    expect(cells(base('claude-sonnet-5-5'))).toBe(cells(base(undefined)));
  });
});
