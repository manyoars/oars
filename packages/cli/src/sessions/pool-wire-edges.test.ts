import { describe, expect, it } from 'vitest';
import { cellsOf, storeOf } from './cell-increments.js';
import { linkSteps } from './graph.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from './pool-fixture.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton } from './pool-wire.js';
import type { StepObservation, ToolObservation } from './schema.js';
import type { Store } from './store.js';

const framed = frame({ shell: 'bash' });
const shell = (n: number, over: Partial<StepObservation> = {}): StepObservation => step(n, 0, 'shell.exec', { native: 'Bash', identity: { program: 'git', sub: 'push', flags: [] }, ...over });

/** One call of a transcript, linked the way capture links it: the failed call, its clean retry, a later call, with call numbers that skip. */
const linked = (id: string, numbers: readonly number[], spawnedAt: number | null, prompts: readonly (number | null)[] = numbers.map(() => 0)): ToolObservation[] => {
  const statuses = ['error', 'ok', 'ok'] as const;
  const steps = numbers.map((n, at) => shell(n, { status: statuses[at] ?? 'ok' }));
  linkSteps(
    numbers.map((_, at) => ({ steps: [steps[at] ?? shell(0)], rawKeys: [at < 2 ? 'git push' : 'git status'], line: `${String(prompts[at] ?? null)} false`, status: statuses[at] ?? 'ok' })),
    spawnedAt,
  );
  return numbers.map((n, at) => tool(id, n, 'Bash', { status: statuses[at] ?? 'ok', prompt: prompts[at] ?? null, steps: [steps[at] ?? shell(n)] }));
};

const withSubagents = (): Store =>
  store({
    sessions: [session('s1', { frame: framed })],
    subagents: [
      session('s1~a', { parent: 's1', spawnedIn: 's1', agentType: 'Explore', frame: framed }),
      session('s1~b', { parent: 's1', spawnedIn: 's1~a', agentType: 'Plan', frame: framed }),
    ],
    prompts: [prompt('s1', 0, { frame: framed })],
    // Main calls 3, 5, and 8 are positions 0, 1, and 2. Agent a's call 20 (position 0) is the one that spawned agent b, and call 5 of the main run spawned a.
    tools: [
      ...linked('s1', [3, 5, 8], null),
      ...linked('s1~a', [20, 21, 22], 5).map((call) => ({ ...call, steps: (call.steps ?? []).map((held) => ({ ...held, parent: 5 })) })),
      ...linked('s1~b', [40, 41, 42], 21, [null, null, null]).map((call) => ({ ...call, steps: (call.steps ?? []).map((held) => ({ ...held, parent: 21 })) })),
    ],
  });

const skeletonOfStore = (from: Store): SessionSkeleton => {
  const [only] = sessionsFrom(from);
  if (only === undefined) throw new Error('the store has no session');
  const skeleton = skeletonOf(only, '0123456789abcdef', storedNames, printOf);
  if (skeleton === null) throw new Error('no skeleton');
  return skeleton;
};

const roundTrip = (skeleton: SessionSkeleton): SessionSkeleton => {
  const parsed = parseSkeleton(JSON.parse(JSON.stringify(skeleton)));
  if (!parsed.ok) throw new Error(`refused ${parsed.field}: ${parsed.reason}`);
  return parsed.skeleton;
};

type Path = readonly (string | number)[];

const isHolder = (value: unknown): value is object => typeof value === 'object' && value !== null;

/** The two-deep batch as plain JSON with one value set, the way a hostile client would send it. */
const sent = (path: Path, value: unknown): unknown => {
  const raw: unknown = JSON.parse(JSON.stringify(skeletonOfStore(withSubagents())));
  let holder: unknown = raw;
  for (const key of path.slice(0, -1)) {
    if (!isHolder(holder)) throw new Error(`no ${String(key)} in the batch`);
    holder = Reflect.get(holder, key);
  }
  const last = path.at(-1);
  if (!isHolder(holder) || last === undefined) throw new Error('nothing to set');
  Reflect.set(holder, last, value);
  return raw;
};

const refusedField = (value: unknown): string => {
  const parsed = parseSkeleton(value);
  return parsed.ok ? 'accepted' : parsed.field;
};

describe('edges on the wire (t869)', () => {
  it('keeps all four kinds, each at the position of the step it names, through the parse', () => {
    const skeleton = roundTrip(skeletonOfStore(withSubagents()));
    const main = skeleton.transcripts[0]?.tools.flatMap(({ steps }) => steps) ?? [];
    // Flat step positions 0, 1, 2 are calls 3, 5, and 8: the failed call, its retry, and a later one.
    expect(main[0]?.edges).toBeUndefined();
    expect(main[1]?.edges).toEqual([
      { kind: 'next', target: 0 },
      { kind: 'after-error', target: 0 },
      { kind: 'retried', target: 0 },
    ]);
    expect(main[2]?.edges).toEqual([{ kind: 'next', target: 1 }]);
    // The subagent's first step was spawned by main call 5 (position 1), an edge into the spawning transcript.
    const sub = skeleton.transcripts[1]?.tools.flatMap(({ steps }) => steps) ?? [];
    expect(sub[0]?.edges).toEqual([{ kind: 'spawned', target: 1 }]);
    const kinds = new Set(skeleton.transcripts.flatMap(({ tools }) => tools.flatMap(({ steps }) => steps.flatMap(({ edges }) => (edges ?? []).map(({ kind }) => kind)))));
    expect([...kinds].sort()).toEqual(['after-error', 'next', 'retried', 'spawned']);
  });

  it('sends no exact number: the wire holds no raw key, call number, or segment', () => {
    const text = JSON.stringify(skeletonOfStore(withSubagents()));
    for (const field of ['"n"', '"seg"', '"rawKeys"', '"from"']) expect(text).not.toContain(field);
  });

  const refusing = (name: string, path: Path, value: unknown, field: string): void => {
    it(`refuses ${name}`, () => {
      expect(refusedField(sent(path, value))).toBe(field);
    });
  };
  // Main call 5 (position 1) is the retry with three edges; the failed call before it is position 0, and call 8 is position 2.
  const retry = ['transcripts', 0, 'tools', 1, 'steps', 0];
  const field = 'transcripts[0].tools[1].steps[0].edges[0]';
  refusing('a kind outside the closed list', [...retry, 'edges'], [{ kind: 'bridged', target: 0 }], `${field}.kind`);
  refusing('a target past the transcript', [...retry, 'edges'], [{ kind: 'next', target: 3 }], `${field}.target`);
  refusing('a fractional target', [...retry, 'edges'], [{ kind: 'next', target: 0.5 }], `${field}.target`);
  refusing('a field beside the kind and target', [...retry, 'edges'], [{ kind: 'next', target: 0, n: 3 }], `${field}.n`);
  refusing('an edge that points forward', ['transcripts', 0, 'tools', 0, 'steps', 0, 'edges'], [{ kind: 'next', target: 1 }], 'transcripts[0].tools[0].steps[0].edges[0].target');
  refusing('a next whose target ran in another prompt', ['transcripts', 0, 'tools', 1, 'prompt'], 1, 'transcripts[0].tools[1].steps[0].edges[0].target');
  refusing('a spawned edge on a transcript with no spawner', [...retry, 'edges'], [{ kind: 'spawned', target: 0 }], `${field}.kind`);
  refusing('a spawned edge past the spawning transcript', ['transcripts', 1, 'tools', 0, 'steps', 0, 'edges'], [{ kind: 'spawned', target: 3 }], 'transcripts[1].tools[0].steps[0].edges[0].target');
});

describe('the parent link (t869)', () => {
  it('rebuilds a tree two subagents deep from the wire alone', () => {
    const skeleton = roundTrip(skeletonOfStore(withSubagents()));
    // Main spawns a (from its call at position 1), and a spawns b (from a's call at position 1, call 21).
    expect(skeleton.transcripts.map(({ spawnedIn }) => spawnedIn)).toEqual([null, 0, 1]);
    expect(skeleton.transcripts.map(({ tools }) => tools[0]?.steps[0]?.parent)).toEqual([null, 1, 1]);
  });

  it('sends null for a subagent whose spawner the batch does not hold', () => {
    const from = store({
      sessions: [session('s1', { frame: framed })],
      subagents: [session('s1~a', { parent: 's1', spawnedIn: null, agentType: 'Explore', frame: framed })],
      prompts: [prompt('s1', 0, { frame: framed })],
      tools: [tool('s1', 0, 'Bash', { steps: [shell(0)] }), tool('s1~a', 0, 'Bash', { steps: [shell(0)] })],
    });
    const skeleton = skeletonOfStore(from);
    expect(skeleton.transcripts.map(({ spawnedIn }) => spawnedIn)).toEqual([null, null]);
    expect(roundTrip(skeleton)).toEqual(skeleton);
  });

  it('refuses a spawner outside the batch, the transcript itself, a cycle, and a main run with a spawner', () => {
    expect(refusedField(sent(['transcripts', 1, 'spawnedIn'], 3))).toBe('transcripts[1].spawnedIn');
    expect(refusedField(sent(['transcripts', 1, 'spawnedIn'], 1))).toBe('transcripts[1].spawnedIn');
    expect(refusedField(sent(['transcripts', 1, 'spawnedIn'], 2))).toBe('transcripts[1].spawnedIn');
    expect(refusedField(sent(['transcripts', 0, 'spawnedIn'], 1))).toBe('transcripts[0].spawnedIn');
    expect(refusedField(sent(['transcripts', 1, 'spawnedIn'], 'main'))).toBe('transcripts[1].spawnedIn');
  });

  it('refuses a parent that names a call the spawning transcript does not hold, or a parent with no spawner', () => {
    expect(refusedField(sent(['transcripts', 1, 'tools', 0, 'steps', 0, 'parent'], 3))).toBe('transcripts[1].tools[0].steps[0].parent');
    expect(refusedField(sent(['transcripts', 1, 'spawnedIn'], null))).toBe('transcripts[1].tools[0].steps[0].parent');
  });
});

describe('a derive from skeletons sees the local graph (t869)', () => {
  it('rebuilds every edge kind, by position, on the fields both stores hold', () => {
    const local = withSubagents();
    const skeleton = roundTrip(skeletonOfStore(local));
    const rebuilt = storeOf([skeleton]);
    const edgesOf = (from: Store, session: string): { kind: string; at: string }[][] =>
      from.tools
        .filter((call) => call.session === session)
        .sort((a, b) => a.n - b.n)
        .flatMap((call) => call.steps ?? [])
        .map(({ edges }) => edges.map(({ kind }) => ({ kind, at: '' })));
    for (const [index, name] of ['s1', 's1~a', 's1~b'].entries()) expect(edgesOf(rebuilt, `0123456789abcdef#${String(index)}`)).toEqual(edgesOf(local, name));
    // Targets: positions in the local store are call numbers, so compare as the flat position of the step each names.
    const flat = (from: Store, session: string): StepObservation[] => from.tools.filter((call) => call.session === session).sort((a, b) => a.n - b.n).flatMap((call) => call.steps ?? []);
    const positionOf = (steps: StepObservation[]) => (n: number, seg: number): number => steps.findIndex((held) => held.n === n && held.seg === seg);
    for (const [index, name] of ['s1', 's1~a', 's1~b'].entries()) {
      const mine = flat(local, name);
      const theirs = flat(rebuilt, `0123456789abcdef#${String(index)}`);
      const spawner = skeleton.transcripts[index]?.spawnedIn ?? null;
      const mineIn = positionOf(mine);
      const theirsIn = positionOf(theirs);
      const spawnerLocal = spawner === null ? [] : flat(local, ['s1', 's1~a', 's1~b'][spawner] ?? '');
      for (const [at, held] of mine.entries()) {
        const expected = held.edges.map(({ kind, n, seg }) => ({ kind, target: kind === 'spawned' ? positionOf(spawnerLocal)(n, seg) : mineIn(n, seg) }));
        const got = (theirs[at]?.edges ?? []).map(({ kind, n, seg }) => ({ kind, target: kind === 'spawned' ? spawner === null ? -1 : positionOf(flat(rebuilt, `0123456789abcdef#${String(spawner)}`))(n, seg) : theirsIn(n, seg) }));
        expect(got).toEqual(expected);
      }
    }
    expect(rebuilt.subagents.map(({ spawnedIn }) => spawnedIn)).toEqual(['0123456789abcdef#0', '0123456789abcdef#1']);
  });

  it('leaves the cells where they were: edges add none', () => {
    const skeleton = roundTrip(skeletonOfStore(withSubagents()));
    const bare: SessionSkeleton = {
      ...skeleton,
      transcripts: skeleton.transcripts.map((transcript) => ({ ...transcript, spawnedIn: null, tools: transcript.tools.map((call) => ({ ...call, steps: call.steps.map((held) => ({ ...held, edges: [] })) })) })),
    };
    expect(JSON.stringify(cellsOf(storeOf([skeleton])))).toBe(JSON.stringify(cellsOf(storeOf([bare]))));
  });
});
