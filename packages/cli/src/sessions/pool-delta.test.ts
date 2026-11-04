import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { carriedDeltas, DELTA_DAYS, DELTA_MIN_SESSIONS, deltaMark, deltasOf, markDeltasSent, placedOf, sentDeltas, windowsOf, type Gated } from './pool-delta.js';
import { prompt, session, sessionsFrom, store, tool } from './pool-fixture.js';
import type { DeltaEntry, SessionRecords } from './pool-wire.js';
import type { Harness, ToolManifest, ToolStatus } from './schema.js';

const DAY = 24 * 60 * 60 * 1000;
// Windows sit on a fixed grid counted from the epoch, so the first test window starts on a grid line.
const START = Math.ceil(Date.parse('2026-10-01T00:00:00Z') / (7 * DAY)) * 7 * DAY;

/** `count` sessions spread over the `index`th window (a window is `DELTA_DAYS` long, on the grid from the epoch), named `<prefix><n>`. */
const run = (prefix: string, index: number, count: number): { id: string; at: number }[] =>
  Array.from({ length: count }, (_, n) => ({ id: `${prefix}${String(n)}`, at: START + index * DELTA_DAYS * DAY + n * 60 * 60 * 1000 }));

describe('the windows of a delta', () => {
  it('hold the values the spec names', () => {
    expect(DELTA_DAYS).toBe(7);
    expect(DELTA_MIN_SESSIONS).toBe(5);
  });

  it('build no delta while the after window holds 4 sessions, and one at 5', () => {
    expect(windowsOf([...run('b', 0, 5), ...run('a', 1, 4)])).toEqual([]);
    const [only, ...rest] = windowsOf([...run('b', 0, 5), ...run('a', 1, 5)]);
    expect(rest).toEqual([]);
    expect(only?.before.map(({ id }) => id)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4']);
    expect(only?.after.map(({ id }) => id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']);
  });

  it('build no delta while the before window holds 4 sessions, and one at 5', () => {
    expect(windowsOf([...run('b', 0, 4), ...run('a', 1, 5)])).toEqual([]);
    expect(windowsOf([...run('b', 0, 5), ...run('a', 1, 5)])).toHaveLength(1);
  });

  it('name the session that fills the after window: the fifth in time order, whatever the order given', () => {
    const [only] = windowsOf([...run('a', 1, 8), ...run('b', 0, 5)].reverse());
    expect(only?.filler.id).toBe('a4');
    expect(only?.after).toHaveLength(8);
  });

  it('number windows on a grid counted from the epoch, so the earliest session does not move them', () => {
    const [only] = windowsOf([...run('b', 0, 6), ...run('a', 1, 5)]);
    const [without] = windowsOf([...run('b', 0, 6).slice(1), ...run('a', 1, 5)]);
    expect(only?.index).toBe(Math.floor((START + DELTA_DAYS * DAY) / (DELTA_DAYS * DAY)));
    expect(without?.index).toBe(only?.index);
    expect(without?.after.map(({ id }) => id)).toEqual(only?.after.map(({ id }) => id));
  });

  it('compare only windows next to each other, so a gap of a window builds nothing', () => {
    expect(windowsOf([...run('b', 0, 5), ...run('a', 2, 5)])).toEqual([]);
  });

  it('chain windows: each full window is the after of one pair and the before of the next', () => {
    const pairs = windowsOf([...run('w0', 0, 5), ...run('w1', 1, 5), ...run('w2', 2, 6)]);
    expect(pairs.map(({ filler }) => filler.id)).toEqual(['w14', 'w24']);
    expect(pairs[1]?.before.map(({ id }) => id)).toEqual(['w10', 'w11', 'w12', 'w13', 'w14']);
  });

  it('take the minimum and the span as arguments', () => {
    expect(windowsOf([...run('b', 0, 2), ...run('a', 1, 2)], DELTA_DAYS, 2)).toHaveLength(1);
    expect(windowsOf([{ id: 'x', at: START }, { id: 'y', at: START + DAY }], 1, 1)).toHaveLength(1);
    expect(windowsOf([{ id: 'x', at: START }, { id: 'y', at: START + 2 * DAY }], 1, 1)).toEqual([]);
  });

  it('order sessions of one instant by id, so two runs agree', () => {
    const same = ['d', 'c', 'b', 'a', 'e'].map((id) => ({ id, at: START }));
    const [only] = windowsOf([...same, ...run('z', 1, 5)]);
    expect(only?.before.map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

const HOUR = 60 * 60 * 1000;

interface Shape {
  /** Index of the window the session sits in, 0 for before and 1 for after. */
  window: number;
  plugins?: string[];
  mode?: string;
  efforts?: string[];
  /** Tool calls of the session, and how many of them name `packages`. */
  calls?: number;
  packages?: string[];
  thinking?: number;
  manifest?: ToolManifest;
  /** The status of the call that holds the manifest; `ok` unless given. */
  manifestStatus?: ToolStatus;
  target?: string | null;
  /** Hours into its window the session began; 1 unless given. */
  hour?: number;
  /** The harness the session came from; Claude Code unless given. */
  harness?: Harness;
  /** The tool of the call that holds the manifest; `Bash` unless given. */
  manifestTool?: string;
}

const sessionOf = (id: string, shape: Shape): SessionRecords => {
  const calls = shape.calls ?? 2;
  const tools = Array.from({ length: calls }, (_, n) =>
    tool(id, n, n === calls - 1 && shape.manifest !== undefined ? (shape.manifestTool ?? 'Bash') : 'Bash', {
      target: shape.target ?? null,
      ...(shape.packages === undefined || n >= shape.packages.length ? {} : { packages: [{ package: shape.packages[n] ?? '', packageVersion: null, first: true }] }),
      ...(shape.manifest === undefined || n !== calls - 1 ? {} : { manifest: shape.manifest, status: shape.manifestStatus ?? 'ok' }),
    }),
  );
  const [only] = sessionsFrom(
    store({
      sessions: [
        session(id, {
          tsFirst: new Date(START + shape.window * DELTA_DAYS * DAY + (shape.hour ?? 1) * HOUR).toISOString(),
          ...(shape.harness === undefined ? {} : { harness: shape.harness }),
          setup: { ...(shape.mode === undefined ? {} : { permissionMode: shape.mode }), ...(shape.plugins === undefined ? {} : { plugins: shape.plugins }) },
        }),
      ],
      prompts: [prompt(id, 0, { efforts: shape.efforts ?? ['high'], usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: shape.thinking ?? 0 } })],
      tools,
    }),
  );
  if (only === undefined) throw new Error('no session');
  return only;
};

const windowOf = (prefix: string, shape: Shape, count = 5): SessionRecords[] => Array.from({ length: count }, (_, n) => sessionOf(`${prefix}${String(n)}`, shape));

describe('the entries of a delta', () => {
  it('name a plugin added, and one removed, as private: no plugin registry is pinned', () => {
    const entries = deltasOf(windowOf('b', { window: 0, plugins: ['old-plugin'] }), windowOf('a', { window: 1, plugins: ['new-plugin'] }));
    expect(entries).toEqual([
      { deltaKind: 'added', field: 'plugin', name: 'private', registry: null, metric: 'callsPerSession', change: 0 },
      { deltaKind: 'removed', field: 'plugin', name: 'private', registry: null, metric: 'callsPerSession', change: 0 },
    ]);
  });

  it('build none when the plugins are the same, and one entry however many plugins went', () => {
    expect(deltasOf(windowOf('b', { window: 0, plugins: ['p'] }), windowOf('a', { window: 1, plugins: ['p'] }))).toEqual([]);
    expect(deltasOf(windowOf('b', { window: 0, plugins: ['p', 'q', 'r'] }), windowOf('a', { window: 1 }))).toHaveLength(1);
  });

  it('compares plugins only over sessions whose harness records them, so another harness is no false removal or addition', () => {
    const codex = (prefix: string, window: number): SessionRecords[] => windowOf(prefix, { window, harness: 'codex' });
    expect(deltasOf(windowOf('b', { window: 0, plugins: ['p'] }), codex('a', 1))).toEqual([]);
    expect(deltasOf(codex('b', 0), windowOf('a', { window: 1, plugins: ['p'] }))).toEqual([]);
    expect(deltasOf(codex('b', 0), codex('a', 1))).toEqual([]);
    // A Claude Code session among them still counts, and its plugin is compared against the sessions that record.
    const mixed = [...codex('x', 1), ...windowOf('a', { window: 1, plugins: ['q'] }, 2)];
    expect(deltasOf(windowOf('b', { window: 0, plugins: ['p'] }), mixed).map(({ deltaKind }) => deltaKind)).toEqual(['added', 'removed']);
  });

  it('name a permission mode change by field alone, never by the modes', () => {
    const entries = deltasOf(windowOf('b', { window: 0, mode: 'default' }), windowOf('a', { window: 1, mode: 'acceptEdits' }));
    expect(entries).toEqual([{ deltaKind: 'changed', field: 'permissionMode', name: null, registry: null, metric: 'callsPerSession', change: 0 }]);
    expect(JSON.stringify(entries)).not.toMatch(/default|acceptEdits/);
  });

  it('build none for a mode that held, or for a window that shows none', () => {
    expect(deltasOf(windowOf('b', { window: 0, mode: 'plan' }), windowOf('a', { window: 1, mode: 'plan' }))).toEqual([]);
    expect(deltasOf(windowOf('b', { window: 0 }), windowOf('a', { window: 1, mode: 'plan' }))).toEqual([]);
  });

  it('use the most common mode of a window, so one odd session is not a change', () => {
    const before = [...windowOf('b', { window: 0, mode: 'default' }, 4), sessionOf('bx', { window: 0, mode: 'plan' })];
    const after = [...windowOf('a', { window: 1, mode: 'default' }, 3), sessionOf('ax', { window: 1, mode: 'plan' }), sessionOf('ay', { window: 1, mode: 'plan' })];
    expect(deltasOf(before, after)).toEqual([]);
  });

  it('name an effort change by field alone, and bucket the move in thinking per prompt', () => {
    const entries = deltasOf(windowOf('b', { window: 0, efforts: ['low'], thinking: 1000 }), windowOf('a', { window: 1, efforts: ['high'], thinking: 9000 }));
    expect(entries).toEqual([{ deltaKind: 'changed', field: 'effort', name: null, registry: null, metric: 'thinking', change: 4 }]);
    const fewer = deltasOf(windowOf('b', { window: 0, efforts: ['high'], thinking: 9000 }), windowOf('a', { window: 1, efforts: ['low'], thinking: 1000 }));
    expect(fewer[0]?.change).toBe(-4);
  });

  it('read an effort outside the list as one word, so two private values are no change', () => {
    expect(deltasOf(windowOf('b', { window: 0, efforts: ['secret-a'] }), windowOf('a', { window: 1, efforts: ['secret-b'] }))).toEqual([]);
    const entries = deltasOf(windowOf('b', { window: 0, efforts: ['secret-a'] }), windowOf('a', { window: 1, efforts: ['high'] }));
    expect(JSON.stringify(entries)).not.toContain('secret');
    expect(entries).toHaveLength(1);
  });

  it('bucket the move in calls per session, signed', () => {
    const entries = deltasOf(windowOf('b', { window: 0, calls: 2, plugins: ['p'] }), windowOf('a', { window: 1, calls: 10, plugins: [] }));
    expect(entries).toEqual([{ deltaKind: 'removed', field: 'plugin', name: 'private', registry: null, metric: 'callsPerSession', change: 4 }]);
    const fewer = deltasOf(windowOf('b', { window: 0, calls: 10, plugins: ['p'] }), windowOf('a', { window: 1, calls: 2, plugins: [] }));
    expect(fewer[0]?.change).toBe(-4);
  });
});

const manifest = (over: Partial<ToolManifest>): ToolManifest => ({ file: 'package.json', seen: [], added: [], removed: [], ...over });

describe('the removal of a package', () => {
  const before = (packages: string[] = ['npm:typescript', 'npm:typescript'], over: Partial<Shape> = {}): SessionRecords[] => windowOf('b', { window: 0, calls: 4, packages, ...over });

  it('names a package called before and removed from its manifest after, with the move in its calls per session', () => {
    const entries = deltasOf(before(), windowOf('a', { window: 1, calls: 4, manifest: manifest({ removed: ['npm:typescript'] }) }));
    expect(entries).toEqual([{ deltaKind: 'removed', field: 'package', name: 'typescript', registry: 'npm', metric: 'callsPerSession', change: -2 }]);
  });

  it('reads a listing of the same file that no longer holds it as gone', () => {
    const listed = before(undefined, { target: 'file-one', manifest: manifest({ seen: ['npm:typescript', 'npm:vitest'] }) });
    const gone = deltasOf(listed, windowOf('a', { window: 1, calls: 4, target: 'file-one', manifestTool: 'Write', manifest: manifest({ seen: ['npm:vitest'] }) }));
    expect(gone.map(({ name }) => name)).toEqual(['typescript']);
    // A listing of another file says nothing of this one, and a listing that still holds it says it stayed.
    expect(deltasOf(listed, windowOf('a', { window: 1, calls: 4, target: 'file-two', manifest: manifest({ seen: ['npm:vitest'] }) }))).toEqual([]);
    expect(deltasOf(listed, windowOf('a', { window: 1, calls: 4, target: 'file-one', manifest: manifest({ seen: ['npm:typescript'] }) }))).toEqual([]);
  });

  it('reads a Read of part of the file as no removal: it can say the package stayed, never that it went', () => {
    const listed = before(undefined, { target: 'file-one', manifest: manifest({ seen: ['npm:typescript', 'npm:vitest'] }) });
    expect(deltasOf(listed, windowOf('a', { window: 1, calls: 4, target: 'file-one', manifestTool: 'Read', manifest: manifest({ seen: ['npm:vitest'] }) }))).toEqual([]);
    expect(deltasOf(listed, windowOf('a', { window: 1, calls: 4, target: 'file-one', manifestTool: 'Read', manifest: manifest({ seen: ['npm:typescript'] }) }))).toEqual([]);
  });

  it('is not a removal when the package was added back later in the window, or never called before', () => {
    const after = [...windowOf('a', { window: 1, calls: 4, manifest: manifest({ removed: ['npm:typescript'] }) }, 2), ...windowOf('c', { window: 1, calls: 4, manifest: manifest({ added: ['npm:typescript'] }) }, 3)];
    expect(deltasOf(before(), after)).toEqual([]);
    expect(deltasOf(windowOf('b', { window: 0, calls: 4 }), windowOf('a', { window: 1, calls: 4, manifest: manifest({ removed: ['npm:typescript'] }) }))).toEqual([]);
  });

  it('reads no manifest of a call that did not come back clean', () => {
    expect(deltasOf(before(), windowOf('a', { window: 1, calls: 4, manifestStatus: 'error', manifest: manifest({ removed: ['npm:typescript'] }) }))).toEqual([]);
  });

  it('sends a package outside the public list as private, with no registry, and one entry for all of them', () => {
    const entries = deltasOf(before(['npm:acme-internal', 'pypi:acme-secret']), windowOf('a', { window: 1, calls: 4, manifest: manifest({ removed: ['npm:acme-internal', 'pypi:acme-secret'] }) }));
    expect(entries).toEqual([{ deltaKind: 'removed', field: 'package', name: 'private', registry: null, metric: 'callsPerSession', change: -2 }]);
    expect(JSON.stringify(entries)).not.toContain('acme');
  });
});

describe('what an entry holds', () => {
  it('has no session id, root, date, or exact value anywhere in it', () => {
    const ids = ['b0', 'b1', 'a0', 'a1'];
    const entries = deltasOf(
      windowOf('b', { window: 0, calls: 6, plugins: ['p'], mode: 'default', efforts: ['low'], thinking: 1500, packages: ['npm:typescript', 'npm:typescript'], target: 'file-one', manifest: manifest({ seen: ['npm:typescript'] }) }),
      windowOf('a', { window: 1, calls: 7, plugins: [], mode: 'plan', efforts: ['high'], thinking: 4800, target: 'file-one', manifest: manifest({ removed: ['npm:typescript'] }) }),
    );
    expect(entries.map(({ field }) => field).sort()).toEqual(['effort', 'package', 'permissionMode', 'plugin']);
    const leaves: unknown[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null) for (const [key, held] of Object.entries(value)) {
        leaves.push(key);
        walk(held);
      }
      else leaves.push(value);
    };
    walk(entries);
    const text = JSON.stringify(entries);
    for (const id of ids) expect(text).not.toContain(id);
    expect(text).not.toMatch(/sid|merkle|root|2026|\d{4}-\d{2}|[0-9a-f]{16}|file-one|default|plan|low|high/);
    for (const leaf of leaves) {
      if (typeof leaf === 'number') expect(Number.isInteger(leaf) && Math.abs(leaf) <= 11).toBe(true);
      else expect(leaf === null || typeof leaf === 'string').toBe(true);
    }
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(['change', 'deltaKind', 'field', 'metric', 'name', 'registry']);
  });
});

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const outbox = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-delta-mark-'));
  folders.push(folder);
  return join(folder, 'outbox');
};

const ENTRY: DeltaEntry = { deltaKind: 'removed', field: 'package', name: 'typescript', registry: 'npm', metric: 'callsPerSession', change: -3 };

describe('the once-only mark of a delta', () => {
  it('names a delta by its account, kind, field, name, registry, metric, and the index of its after window', () => {
    const mark = deltaMark('acct', ENTRY, 4);
    expect(mark).toMatch(/^[0-9a-f]{16}$/);
    expect(deltaMark('acct', { ...ENTRY }, 4)).toBe(mark);
    for (const other of [deltaMark('acct2', ENTRY, 4), deltaMark('acct', ENTRY, 5), deltaMark('acct', { ...ENTRY, name: 'react' }, 4), deltaMark('acct', { ...ENTRY, registry: 'pypi' }, 4), deltaMark('acct', { ...ENTRY, field: 'plugin' }, 4), deltaMark('acct', { ...ENTRY, deltaKind: 'added' }, 4), deltaMark('acct', { ...ENTRY, metric: 'thinking' }, 4)]) expect(other).not.toBe(mark);
  });

  it('ignores the size of the move, so a recount of the same windows never builds the delta again', () => {
    expect(deltaMark('acct', { ...ENTRY, change: 4 }, 4)).toBe(deltaMark('acct', ENTRY, 4));
  });

  it('holds no mark before one is written, and an outbox folder that does not exist yet holds none', async () => {
    expect([...(await sentDeltas(outbox()))]).toEqual([]);
  });

  it('writes each mark on a line of deltas-sent.log in the outbox folder, and reads them back', async () => {
    const folder = outbox();
    await markDeltasSent(folder, ['1111111111111111', '2222222222222222']);
    await markDeltasSent(folder, ['3333333333333333']);
    expect(readFileSync(join(folder, 'deltas-sent.log'), 'utf8')).toBe('1111111111111111\n2222222222222222\n3333333333333333\n');
    expect([...(await sentDeltas(folder))].sort()).toEqual(['1111111111111111', '2222222222222222', '3333333333333333']);
  });

  it('writes nothing for no marks, so a deposit with no delta leaves no file', async () => {
    const folder = outbox();
    await markDeltasSent(folder, []);
    expect(() => readFileSync(join(folder, 'deltas-sent.log'), 'utf8')).toThrow();
  });

  it('reads past a blank line without an empty mark', async () => {
    const folder = outbox();
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'deltas-sent.log'), '1111111111111111\n\n2222222222222222\n', 'utf8');
    expect([...(await sentDeltas(folder))].sort()).toEqual(['1111111111111111', '2222222222222222']);
  });

  it('fails on a log it cannot read rather than read it as empty', async () => {
    const folder = outbox();
    mkdirSync(join(folder, 'deltas-sent.log'), { recursive: true });
    await expect(sentDeltas(folder)).rejects.toThrow();
  });
});

const gated = (prefix: string, count: number, shape: Shape): Gated[] =>
  Array.from({ length: count }, (_, n) => {
    const records = sessionOf(`${prefix}${String(n)}`, shape);
    const placed = placedOf(records);
    if (placed === undefined) throw new Error('no start');
    return placed;
  });

describe('the deltas a deposit carries', () => {
  const before = (count = 5): Gated[] => gated('b', count, { window: 0, mode: 'default' });
  const after = (count = 5, mode = 'plan'): Gated[] => gated('a', count, { window: 1, mode });

  it('places a session by when it began and its own id, and none that has no start', () => {
    const [first] = before(1);
    expect(first?.id).toBe('b0');
    expect(first?.at).toBe(START + HOUR);
    const bare = sessionOf('x', { window: 0 });
    bare.main.tsFirst = null;
    expect(placedOf(bare)).toBeUndefined();
    bare.main.tsFirst = 'not a time';
    expect(placedOf(bare)).toBeUndefined();
  });

  it('builds nothing while the after window holds 4 sessions, and carries the entry on the fifth', () => {
    expect([...carriedDeltas('acct', [...before(), ...after(4)], new Set()).keys()]).toEqual([]);
    const carried = carriedDeltas('acct', [...before(), ...after(5)], new Set());
    expect([...carried.keys()]).toEqual(['a4']);
    expect(carried.get('a4')?.entries).toEqual([{ deltaKind: 'changed', field: 'permissionMode', name: null, registry: null, metric: 'callsPerSession', change: 0 }]);
    const [entry] = carried.get('a4')?.entries ?? [];
    if (entry === undefined) throw new Error('no entry');
    expect(carried.get('a4')?.marks).toEqual([deltaMark('acct', entry, Math.floor((START + DELTA_DAYS * DAY) / (DELTA_DAYS * DAY)))]);
  });

  it('builds nothing while the before window holds 4 sessions', () => {
    expect(carriedDeltas('acct', [...before(4), ...after(5)], new Set()).size).toBe(0);
  });

  it('builds nothing for windows that show no change', () => {
    expect(carriedDeltas('acct', [...before(), ...after(5, 'default')], new Set()).size).toBe(0);
  });

  it('builds a delta once: one whose mark is held is not built again, whoever asks', () => {
    const sessions = [...before(), ...after()];
    const first = carriedDeltas('acct', sessions, new Set());
    const marks = new Set(first.get('a4')?.marks);
    expect(marks.size).toBe(1);
    expect(carriedDeltas('acct', sessions, marks).size).toBe(0);
    expect(carriedDeltas('other', sessions, marks).get('a4')?.entries).toHaveLength(1);
  });

  it('builds the same delta whatever the order the sessions come in, so a rebuilt session carries the same one', () => {
    const sessions = [...before(), ...after()];
    expect(carriedDeltas('acct', [...sessions].reverse(), new Set())).toEqual(carriedDeltas('acct', sessions, new Set()));
  });

  it('keeps the mark when a session is added before the filler, so the delta is not built again', () => {
    const marks = new Set(carriedDeltas('acct', [...before(), ...after(5)], new Set()).get('a4')?.marks);
    expect(marks.size).toBe(1);
    const extra = gated('A', 1, { window: 1, mode: 'plan' });
    const again = carriedDeltas('acct', [...before(), ...extra, ...after(5)], marks);
    expect(again.size).toBe(0);
  });

  it('keeps the mark when a session drops out as not ended and ends later, whichever filler results', () => {
    const late = (count: number): Gated[] => [...after(count)].filter(({ id }) => id !== 'a1');
    const first = carriedDeltas('acct', [...before(), ...late(6)], new Set());
    const marks = new Set([...first.values()].flatMap(({ marks: held }) => held));
    expect([...first.keys()]).toEqual(['a5']);
    expect(marks.size).toBe(1);
    expect(carriedDeltas('acct', [...before(), ...after(6)], marks).size).toBe(0);
  });

  it('keeps the mark when the earliest session is lost to a gate, so no past pair is rebuilt', () => {
    const earliest = gated('E', 1, { window: 0, mode: 'default' });
    const rest = gated('b', 5, { window: 0, mode: 'default', hour: 5 });
    const marks = new Set(carriedDeltas('acct', [...earliest, ...rest, ...after(5)], new Set()).get('a4')?.marks);
    expect(marks.size).toBe(1);
    expect(carriedDeltas('acct', [...rest, ...after(5)], marks).size).toBe(0);
    // The pair itself stays: with no mark held, the same delta is built again, on the same filler.
    expect([...carriedDeltas('acct', [...rest, ...after(5)], new Set()).keys()]).toEqual(['a4']);
  });

  it('fixes the outcome at the fill: a change that shows only in the sessions after the fifth builds nothing', () => {
    const many = [...gated('a', 5, { window: 1, mode: 'default' }), ...gated('s', 6, { window: 1, mode: 'plan' })];
    expect(carriedDeltas('acct', [...before(), ...many], new Set()).size).toBe(0);
  });

  it('chains: the windows of three weeks carry one delta each, on their own fillers', () => {
    const third = gated('c', 5, { window: 2, mode: 'default' });
    const carried = carriedDeltas('acct', [...before(), ...after(), ...third], new Set());
    expect([...carried.keys()].sort()).toEqual(['a4', 'c4']);
  });
});
