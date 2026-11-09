import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CANDIDATES_FILE, type CandidateSnapshot, type InstructionCounts } from './candidates.js';
import { LOAD_STATUS_VERSION, loadStatusLines, loadStatusOf, loadedInstructionsOf, type LoadLabel, type LoadStatus } from './load-status.js';
import type { LoadedInstructions, SessionObservation } from './schema.js';
import { createShape } from './session-shape.js';

const counts = (over: Partial<InstructionCounts>): InstructionCounts => ({ working: 0, parent: 0, above: 0, mainCheckout: 0, user: 0, ...over });

const snapshot = (instructions: Partial<InstructionCounts>, repoLevels: number | null, mainLevels: number | null = null, more: Partial<CandidateSnapshot> = {}): CandidateSnapshot => ({
  v: 1,
  session: 's',
  at: 'a',
  harness: 'claude-code',
  instructions: counts(instructions),
  skills: { project: 0, user: 0 },
  hooks: {},
  repoLevels,
  mainLevels,
  ...more,
});

const none = { working: 'absent', parent: 'absent', above: 'absent', mainCheckout: 'absent', user: 'absent' } as const;
const labels = (over: Partial<LoadStatus['instructions']>): LoadStatus['instructions'] => ({ ...none, ...over });
const status = (harness: string, shot: CandidateSnapshot | undefined, loaded: LoadedInstructions | undefined): LoadStatus['instructions'] => loadStatusOf({ session: 's', harness, snapshot: shot, loaded }).instructions;

/** Item-for-item what the fixture measured: the snapshot each case produces, the loaded set its log held, and the label that follows. Every Claude Code case has the machine's user-level file. */
describe('the measured Claude Code rule', () => {
  const claude = (shot: CandidateSnapshot, levels: number[]): LoadStatus['instructions'] => status('claude-code', shot, { user: 1, levels });
  const cases: [string, CandidateSnapshot, number[], Partial<LoadStatus['instructions']>][] = [
    ['working folder', snapshot({ working: 1, user: 1 }, 1), [0], { working: 'loaded' }],
    ['parent inside the repo', snapshot({ parent: 1, user: 1 }, 2), [2], { parent: 'loaded' }],
    ['above the git root', snapshot({ above: 1, user: 1 }, 0), [1], { above: 'loaded' }],
    ['repo root, session in a nested linked worktree: by design, not a miss', snapshot({ mainCheckout: 1, user: 1 }, 0, 3), [], { mainCheckout: 'excluded' }],
    ['the census pattern: the worktree copy loads, the main root copy is by design', snapshot({ working: 1, mainCheckout: 1, user: 1 }, 0, 3), [0], { working: 'loaded', mainCheckout: 'excluded' }],
    ['above the main checkout of a nested worktree', snapshot({ above: 1, user: 1 }, 0, 3), [4], { above: 'loaded' }],
    ['between a nested worktree and its main root', snapshot({ mainCheckout: 1, user: 1 }, 0, 3), [], { mainCheckout: 'excluded' }],
    ['above a linked worktree outside its main checkout', snapshot({ above: 1, user: 1 }, 0), [1], { above: 'loaded' }],
    ['user level only', snapshot({ user: 1 }, 0), [], {}],
    ['a parent with no repository at all', snapshot({ above: 1, user: 1 }, null), [1], { above: 'loaded' }],
  ];
  it.each(cases)('%s', (_name, shot, levels, expected) => {
    expect(claude(shot, levels)).toEqual(labels({ user: 'loaded', ...expected }));
  });

  it.each([
    ['working', snapshot({ working: 1 }, 1)],
    ['parent', snapshot({ parent: 1 }, 2)],
    ['above', snapshot({ above: 1 }, 0)],
  ] as const)('labels a %s file the rule loads and the log does not show as a miss', (position, shot) => {
    expect(status('claude-code', shot, { user: 0, levels: [] })[position]).toBe('miss');
  });

  it('labels a user-level file the log does not show as a miss', () => {
    expect(status('claude-code', snapshot({ user: 1 }, 0), { user: 0, levels: [] }).user).toBe('miss');
  });

  it('lets the log win when a file loaded from a position the snapshot counted nothing at', () => {
    expect(status('claude-code', snapshot({}, 0), { user: 0, levels: [0] }).working).toBe('loaded');
  });

  it('lets the log win when the harness loaded a file the rule says it would skip', () => {
    expect(status('claude-code', snapshot({ mainCheckout: 1 }, 0, 3), { user: 0, levels: [2] }).mainCheckout).toBe('loaded');
  });
});

describe('the measured Codex rule', () => {
  const codex = (shot: CandidateSnapshot, any: boolean): LoadStatus['instructions'] => status('codex', shot, { user: 0, any });
  const cases: [string, CandidateSnapshot, boolean, Partial<LoadStatus['instructions']>][] = [
    ['working folder', snapshot({ working: 1 }, 1), true, { working: 'loaded' }],
    ['parent inside the repo', snapshot({ parent: 1 }, 2), true, { parent: 'loaded' }],
    ['above the git root: not read, by design', snapshot({ above: 1 }, 0), false, { above: 'excluded' }],
    ['repo root, session in a nested linked worktree: by design', snapshot({ mainCheckout: 1 }, 0, 3), false, { mainCheckout: 'excluded' }],
    ['the census pattern', snapshot({ working: 1, mainCheckout: 1 }, 0, 3), true, { working: 'loaded', mainCheckout: 'excluded' }],
    ['above a nested worktree', snapshot({ above: 1 }, 0, 3), false, { above: 'excluded' }],
    ['between a nested worktree and its main root', snapshot({ mainCheckout: 1 }, 0, 3), false, { mainCheckout: 'excluded' }],
    ['above an outside worktree', snapshot({ above: 1 }, 0), false, { above: 'excluded' }],
    ['a parent with no repository at all', snapshot({ above: 1 }, null), false, { above: 'excluded' }],
    ['no file anywhere', snapshot({}, 0), false, {}],
  ];
  it.each(cases)('%s', (_name, shot, any, expected) => {
    expect(codex(shot, any)).toEqual(labels(expected));
  });

  it('labels a file the rule loads as a miss when the record is empty', () => {
    expect(codex(snapshot({ working: 1 }, 1), false).working).toBe('miss');
  });

  it('labels a user-level file unknown: it was not measured (this machine has none, and measuring needs a copied login)', () => {
    expect(codex(snapshot({ user: 1 }, 0), false).user).toBe('unknown');
  });

  it('labels the candidates unknown when one record covers two positions and cannot be split', () => {
    const got = codex(snapshot({ working: 1, parent: 1 }, 1), true);
    expect(got.working).toBe('unknown');
    expect(got.parent).toBe('unknown');
  });
});

describe('what cannot be decided', () => {
  const allUnknown: LoadLabel = 'unknown';

  it('labels every kind unknown, never absent, when the session has no snapshot', () => {
    const got = loadStatusOf({ session: 's', harness: 'claude-code', snapshot: undefined, loaded: { user: 1, levels: [0] } });
    expect(new Set([...Object.values(got.instructions), ...Object.values(got.skills), got.hooks])).toEqual(new Set([allUnknown]));
    expect(got.v).toBe(LOAD_STATUS_VERSION);
  });

  it('labels a harness with no measured rule unknown', () => {
    expect(new Set(Object.values(status('gemini', snapshot({ working: 1 }, 0), { user: 0, levels: [0] })))).toEqual(new Set([allUnknown]));
  });

  it('keeps absent but cannot say missed when the log holds no loaded set', () => {
    const got = status('claude-code', snapshot({ working: 1 }, 0), undefined);
    expect(got.working).toBe('unknown');
    expect(got.parent).toBe('absent');
  });

  it('labels skills and hooks absent at zero and unknown otherwise, since no rule was measured for them', () => {
    const empty = loadStatusOf({ session: 's', harness: 'claude-code', snapshot: snapshot({}, 0), loaded: { user: 0, levels: [] } });
    expect(empty.skills).toEqual({ project: 'absent', user: 'absent' });
    expect(empty.hooks).toBe('absent');
    const some = loadStatusOf({ session: 's', harness: 'claude-code', snapshot: snapshot({}, 0, null, { skills: { project: 1, user: 2 }, hooks: { Stop: 1 } }), loaded: { user: 0, levels: [] } });
    expect(some.skills).toEqual({ project: 'unknown', user: 'unknown' });
    expect(some.hooks).toBe('unknown');
  });
});

describe('loadedInstructionsOf', () => {
  it('places each project file by how many folders above the working folder it sits', () => {
    const files = [
      { path: 'C:\\Work\\Repo\\Sub\\CLAUDE.md', type: 'Project' },
      { path: 'c:/work/repo/CLAUDE.md', type: 'Project' },
      { path: 'C:\\Users\\me\\.claude\\CLAUDE.md', type: 'User' },
    ];
    expect(loadedInstructionsOf(files, 'C:\\work\\repo\\sub')).toEqual({ user: 1, levels: [0, 1] });
  });

  it('skips files that are not instruction candidates: memory files, other names, and folders off the working path', () => {
    const files = [
      { path: '/home/me/.claude/machine-memory/MEMORY.md', type: 'User' },
      { path: '/work/repo/CLAUDE.local.md', type: 'Project' },
      { path: '/elsewhere/CLAUDE.md', type: 'Project' },
      { path: '/work/repo/deeper/still/CLAUDE.md', type: 'Project' },
      { path: '/work/repo/CLAUDE.md', type: 'AutoMem' },
    ];
    expect(loadedInstructionsOf(files, '/work/repo')).toEqual({ user: 0, levels: [] });
  });

  it('keeps case on a path with no drive letter, where case can matter', () => {
    expect(loadedInstructionsOf([{ path: '/Work/CLAUDE.md', type: 'Project' }], '/work')).toEqual({ user: 0, levels: [] });
  });
});

describe('the capture of the loaded set', () => {
  type Line = { [key: string]: unknown };
  const read = (lines: Line[]): LoadedInstructions | undefined => {
    const shape = createShape('claude-code', (tool) => tool, { timing: false });
    for (const line of lines) shape.read(line, { side: false, prompt: null });
    return shape.finish().loadedInstructions;
  };
  const line = (files: unknown): Line => ({ type: 'attachment', cwd: '/work/repo', attachment: { type: 'instructions', files } });

  it('keeps the first record of a session, as levels, with no path', () => {
    const got = read([line([{ path: '/work/repo/CLAUDE.md', type: 'Project', content: 'private text' }]), line([{ path: '/work/CLAUDE.md', type: 'Project' }])]);
    expect(got).toEqual({ user: 0, levels: [0] });
    expect(JSON.stringify(got)).not.toContain('work');
  });

  it('holds nothing when the transcript has no record, or no folder to place it against', () => {
    expect(read([{ type: 'user', cwd: '/work' }])).toBeUndefined();
    expect(read([{ type: 'attachment', attachment: { type: 'instructions', files: [] } }])).toBeUndefined();
  });

  it('reads an empty list as a loaded set of nothing', () => {
    expect(read([line([])])).toEqual({ user: 0, levels: [] });
  });

  it('skips a malformed file entry and a record with no list', () => {
    expect(read([line(['nope', { type: 'Project' }, { path: '/work/repo/CLAUDE.md', type: 'Project' }])])).toEqual({ user: 0, levels: [0] });
    expect(read([{ type: 'attachment', cwd: '/work', attachment: { type: 'instructions' } }])).toBeUndefined();
  });

  it('ignores a subagent sidechain', () => {
    const shape = createShape('claude-code', (tool) => tool, { timing: false });
    shape.read(line([{ path: '/work/repo/CLAUDE.md', type: 'Project' }]), { side: true, prompt: null });
    expect(shape.finish().loadedInstructions).toBeUndefined();
  });
});

describe('loadStatusLines', () => {
  let store: string;
  beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), 'oars-load-status-'));
  });
  afterEach(() => {
    rmSync(store, { recursive: true, force: true });
  });
  type Row = Pick<SessionObservation, 'session' | 'harness' | 'loadedInstructions'>;
  const session = (id: string, over: Partial<Row> = {}): Row => ({ session: id, ...over });
  const rowsOf = (text: string): unknown[] => text.trim().split('\n').map((row): unknown => JSON.parse(row));

  it('writes one row per session, with the snapshot joined by session id', async () => {
    writeFileSync(join(store, CANDIDATES_FILE), `${JSON.stringify(snapshot({ working: 1 }, 0, null, { session: 'with' }))}\n`);
    const rows = rowsOf(await loadStatusLines(store, [session('with', { loadedInstructions: { user: 0, levels: [0] } }), session('without', { harness: 'codex' })]));
    expect(rows).toMatchObject([
      { session: 'with', harness: 'claude-code', instructions: { working: 'loaded' } },
      { session: 'without', harness: 'codex', instructions: { working: 'unknown' } },
    ]);
  });

  it('reads every session as unknown when the snapshots cannot be read', async () => {
    mkdirSync(join(store, CANDIDATES_FILE));
    expect(rowsOf(await loadStatusLines(store, [session('s')]))).toMatchObject([{ instructions: { working: 'unknown' } }]);
  });
});
