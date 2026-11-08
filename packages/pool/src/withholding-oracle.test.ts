// The withholding oracle (spec 2026-11-08-pool-withholding-relations, sections 2 and 5). The relations among a bundle's cells are a property of the emitter, so this test does not state them: it builds calls, runs
// them through the real route (the functions `extract.ts` calls on a tool's raw input, then `skeletonOf`, `parseSkeleton`, and `incrementsOf`), and asks, with exact rational arithmetic, whether the cells the real
// `bundleOf` serves determine a sub-floor cell for every store the held cells allow. A reader who holds every served cell and the action's calls (the `fit` read) learns a sub-floor cell when its row is in the
// span of the served rows. One row per (cell, stored column) and one column per atom (one session as the pool stores it); the atoms come only through the route, from a fixed seed, until the rank stops rising.
import { describe, expect, it } from 'vitest';
import { argClassOf, argFeaturesOf, argValuesOf, changeKindOf, targetClassOf, type ComparedCall } from '../../cli/src/sessions/call-shape.js';
import { incrementsOf, type CellRow } from '../../cli/src/sessions/cell-increments.js';
import { ERROR_CLASS, ERROR_VERSION_CLASS, RECOVERY_CLASS, SHAPE_CLASS, parseShapeClass, type Cell } from '../../cli/src/sessions/cells.js';
import { hashPath } from '../../cli/src/sessions/extract.js';
import type { Motif } from '../../cli/src/sessions/motif.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from '../../cli/src/sessions/pool-fixture.js';
import { parseSkeleton, skeletonOf } from '../../cli/src/sessions/pool-wire.js';
import { CLOSED_ARG_VALUES } from '../../cli/src/sessions/public-vocabulary.js';
import type { ToolObservation, ToolStatus } from '../../cli/src/sessions/schema.js';
import { bundleOf } from './derive.js';
import { DEFAULT_FLOORS } from './floors.js';
import type { StoredPool } from './stored.js';

const FLOOR = DEFAULT_FLOORS.public;
const CWD = '/work/app';
const SKELETON_ID = '0123456789abcdef';

/** The seven stored columns (spec section 2): `n` is not one, a read derives it as `ok + failed`. */
const COLUMNS = ['ok', 'failed', 'sessions', 'durationMs', 'tokens', 'tokenSessions', 'tokenPrompts'] as const;
type Column = (typeof COLUMNS)[number];

/** A tool the fixtures call: its public name, canonical action, and the input key its target is hashed on. */
const TOOLS: readonly { native: string; action: 'file.read' | 'file.search' | 'web.search'; pathKey?: string }[] = [
  { native: 'Read', action: 'file.read', pathKey: 'file_path' },
  { native: 'Grep', action: 'file.search', pathKey: 'path' },
  { native: 'WebSearch', action: 'web.search' },
];

/** One call as a transcript line would give it: the tool's raw input, how it ended, and what its step recorded. */
interface Call {
  tool: string;
  input: { readonly [key: string]: unknown };
  status: ToolStatus;
  errorCode?: string;
  tokens: number | null;
  durationMs: number | null;
}

/** One session as the pool stores it: the calls of one prompt, and what the prompt recorded. */
interface Atom {
  calls: Call[];
  promptTokens: number | null;
  wallSec: number | null;
}

const call = (name: string, input: { readonly [key: string]: unknown }, over: Partial<Call> = {}): Call => ({ tool: name, input, status: 'ok', tokens: 5000, durationMs: 500, ...over });
const atomOf = (...calls: Call[]): Atom => ({ calls, promptTokens: 5000, wallSec: 3 });

/** A tool observation as `extract.ts:1764-1790` builds it from the raw input. */
const observe = (id: string, n: number, spec: Call, before: ComparedCall | undefined): { observation: ToolObservation; compared: ComparedCall } => {
  const known = TOOLS.find(({ native }) => native === spec.tool);
  if (known === undefined) throw new Error(`no tool ${spec.tool}`);
  const given = known.pathKey === undefined ? undefined : spec.input[known.pathKey];
  const aimed = typeof given === 'string' ? hashPath(given, CWD, CWD, 'oracle') : undefined;
  const features = argFeaturesOf(spec.tool, spec.input, CWD, CWD);
  const values = argValuesOf(spec.tool, spec.input, CLOSED_ARG_VALUES);
  const compared: ComparedCall = { input: spec.input, target: aimed?.hash ?? null, features, values };
  const observation = tool(id, n, spec.tool, {
    status: spec.status,
    target: aimed?.hash ?? null,
    targetBase: aimed?.base ?? null,
    keys: Object.keys(spec.input).sort(),
    targetClass: targetClassOf(aimed?.key, aimed?.base ?? null),
    argClass: argClassOf(spec.input),
    argFeatures: features,
    ...(values.length === 0 ? {} : { argValues: values }),
    ...(before === undefined ? {} : { changeKind: changeKindOf(before, compared) }),
    ...(spec.errorCode === undefined ? {} : { errorCode: spec.errorCode }),
    durationMs: spec.durationMs,
    steps: [step(n, 0, known.action, { native: spec.tool, status: spec.status, cost: { tokens: spec.tokens, durationMs: spec.durationMs } })],
  });
  return { observation, compared };
};

/** What one atom emits, by the real route: the cells it adds, and the motifs they name. */
const emit = (atom: Atom): { rows: Map<string, CellRow>; motifs: Motif[] } => {
  const framed = frame();
  const lastOf = new Map<string, ComparedCall>();
  const tools = atom.calls.map((spec, n) => {
    const made = observe('s', n, spec, lastOf.get(spec.tool));
    lastOf.set(spec.tool, made.compared);
    return made.observation;
  });
  const errors = atom.calls.filter(({ status }) => status === 'error').length;
  const local = store({
    sessions: [session('s', { frame: framed })],
    prompts: [prompt('s', 0, { frame: framed, errors, wallSec: atom.wallSec, ...(atom.promptTokens === null ? { usageObserved: [] } : { usage: { input: atom.promptTokens, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0 } }) })],
    tools,
  });
  const [only] = sessionsFrom(local);
  const built = only === undefined ? null : skeletonOf(only, SKELETON_ID, storedNames, printOf);
  if (built === null) throw new Error('no skeleton');
  // The wire, as a deposit carries it: what the pool parses is the JSON, not the object.
  const parsed = parseSkeleton(JSON.parse(JSON.stringify(built)));
  if (!parsed.ok) throw new Error('the skeleton does not parse');
  const { cells, motifs } = incrementsOf(parsed.skeleton);
  return { rows: cells, motifs };
};

/** A fixture: each account's atoms. A cell's `clusters` is the accounts that emit it, and its stored columns the sum over every atom. */
type Accounts = Atom[][];

interface Held {
  pool: StoredPool;
  cells: Cell[];
}

const keyOf = (cell: Pick<Cell, 'motifId' | 'frameBucket' | 'grain' | 'day' | 'exposed'>): string => JSON.stringify([cell.motifId, cell.frameBucket, cell.grain, cell.day, cell.exposed]);

const heldOf = (accounts: Accounts): Held => {
  const sums = new Map<string, { cell: Cell; accounts: Set<number> }>();
  const motifs = new Map<string, Motif>();
  for (const [account, atoms] of accounts.entries()) {
    for (const atom of atoms) {
      const emitted = emit(atom);
      for (const motif of emitted.motifs) motifs.set(motif.motifId, motif);
      for (const row of emitted.rows.values()) {
        const key = keyOf({ ...row, exposed: row.exposed === 1 });
        const sum = sums.get(key) ?? { cell: { motifId: row.motifId, frameBucket: row.frameBucket, grain: row.grain, day: row.day, sessions: 0, clusters: 0, ok: 0, failed: 0, tokens: null, tokenSessions: 0, tokenPrompts: 0, durationMs: 0, exposed: row.exposed === 1 }, accounts: new Set<number>() };
        sums.set(key, sum);
        sum.accounts.add(account);
        sum.cell.sessions += row.sessions;
        sum.cell.ok += row.ok;
        sum.cell.failed += row.failed;
        sum.cell.durationMs += row.durationMs;
        sum.cell.tokens = (sum.cell.tokens ?? 0) + row.tokens;
        sum.cell.tokenSessions = (sum.cell.tokenSessions ?? 0) + row.tokenSessions;
        sum.cell.tokenPrompts = (sum.cell.tokenPrompts ?? 0) + row.tokenPrompts;
      }
    }
  }
  const cells = [...sums.values()].map(({ cell, accounts: who }) => ({ ...cell, clusters: who.size, tokens: (cell.tokenSessions ?? 0) === 0 ? null : cell.tokens }));
  const environment = cells.filter(({ frameBucket }) => frameBucket.startsWith('env:'));
  return { cells, pool: { cells: cells.filter((cell) => !environment.includes(cell)), environment, motifs: [...motifs.values()], strata: [] } };
};

/** Whether a cell's tally writes a column: the `recovery:`, `error:`, and `error-version:` cells add only to `failed`, and a call-shape facet cell (`shape:`) and a recovery cell carry no cost. */
const writes = (motif: Motif | undefined, column: Column): boolean => {
  const cls = motif?.cls ?? null;
  const startsWith = (prefix: string): boolean => cls !== null && cls.startsWith(prefix);
  if (column === 'failed' || column === 'sessions') return true;
  if (column === 'ok') return ![RECOVERY_CLASS, ERROR_CLASS, ERROR_VERSION_CLASS].some(startsWith);
  return ![SHAPE_CLASS, RECOVERY_CLASS].some(startsWith);
};

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));

/** Exact row echelon form over the rationals (BigInt, fraction-free), the way `determinedOf` does its rank. */
class Span {
  private readonly basis: { pivot: number; vector: bigint[] }[] = [];

  /** `vector` reduced by the basis: zero exactly when it is in the span. */
  reduce(vector: readonly bigint[]): bigint[] {
    let row = [...vector];
    for (const { pivot, vector: base } of this.basis) {
      const factor = row[pivot] ?? 0n;
      if (factor === 0n) continue;
      const scale = base[pivot] ?? 1n;
      row = row.map((value, index) => value * scale - (base[index] ?? 0n) * factor);
      const divisor = row.reduce(gcd, 0n);
      if (divisor > 1n) row = row.map((value) => value / divisor);
    }
    return row;
  }

  /** Adds a vector, and says whether the rank rose. */
  add(vector: readonly bigint[]): boolean {
    const row = this.reduce(vector);
    const pivot = row.findIndex((value) => value !== 0n);
    if (pivot < 0) return false;
    this.basis.push({ pivot, vector: row });
    return true;
  }

  covers(vector: readonly bigint[]): boolean {
    return this.reduce(vector).every((value) => value === 0n);
  }
}

/** A fixed-seed generator (mulberry32), so the same fixture samples the same atoms. */
const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

/** The values a key can take when a candidate call is built: enough of each closed list (path depth, extension, folder kind, size) for the held cells to pick from. */
const VALUE_POOL: ReadonlyMap<string, readonly unknown[]> = new Map<string, readonly unknown[]>([
  ['file_path', ['a.ts', 'src/a.ts', 'src/lib/a.ts', 'docs/lib/a.md', 'README.md', 'test/a.test.ts', 'a/b/c/d/e/f.json']],
  ['path', ['a.ts', 'src/a.ts', 'src/lib/a.ts', 'docs/lib/a.md', 'README.md']],
  ['pattern', ['foo', 'foo.*bar', '^a|b$']],
  ['query', ['q', 'a query of some length', 'a query that is considerably longer than thirty-two characters']],
  ['limit', [10, 2000]],
  ['offset', [0, 500]],
]);

/** The held cells' own vocabulary: for each action, the key sets its `keys` cells name, and whether a keyless call is held (`arg/none`). */
const vocabularyOf = (held: Held): { action: string; native: string; keySets: string[][]; codes: string[] }[] => {
  const motifOf = new Map(held.pool.motifs.map((motif) => [motif.motifId, motif]));
  const codes = [...new Set(held.cells.flatMap((cell) => ((motifOf.get(cell.motifId)?.cls ?? '').startsWith(ERROR_CLASS) ? [(motifOf.get(cell.motifId)?.cls ?? '').slice(ERROR_CLASS.length).split('/')[0] ?? ''] : [])))];
  return TOOLS.flatMap(({ native, action }) => {
    const keySets = new Map<string, string[]>();
    for (const cell of held.cells) {
      const parsed = parseShapeClass(motifOf.get(cell.motifId)?.cls ?? '');
      if (parsed === null || parsed.action !== action) continue;
      if (parsed.facet === 'keys') keySets.set(parsed.value, parsed.value.split(','));
      if (parsed.facet === 'arg' && parsed.value === 'none') keySets.set('', []);
    }
    return keySets.size === 0 ? [] : [{ action, native, keySets: [...keySets.values()], codes }];
  });
};

/** The atoms the held cells allow, drawn from a fixed seed: key sets from the `keys` cells, values from the pool, and every status and cost variant, then run through the route. */
const candidatesOf = (held: Held, count: number): Atom[] => {
  const random = seeded(7);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const vocabulary = vocabularyOf(held);
  const atoms: Atom[] = [];
  for (let drawn = 0; drawn < count && vocabulary.length > 0; drawn += 1) {
    const { native, keySets, codes } = pick(vocabulary);
    const callOf = (): Call => {
      const keys = pick(keySets);
      const input = Object.fromEntries([...keys, ...(random() < 0.15 ? ['not_a_public_key'] : [])].map((key) => [key, pick(VALUE_POOL.get(key) ?? ['x'])]));
      const status = pick<ToolStatus>(['ok', 'ok', 'error', 'none']);
      const errorCode = status === 'error' && codes.length > 0 && random() < 0.7 ? pick(codes) : undefined;
      return call(native, input, { status, ...(errorCode === undefined ? {} : { errorCode }), tokens: random() < 0.5 ? null : 5000, durationMs: random() < 0.5 ? null : 500 });
    };
    atoms.push({ calls: random() < 0.25 ? [callOf(), callOf()] : [callOf()], promptTokens: random() < 0.5 ? null : 5000, wallSec: random() < 0.5 ? null : 3 });
  }
  return atoms;
};

interface Leak {
  cell: string;
  column: Column;
}

/**
 * The sub-floor cells (and columns) that the cells the real `bundleOf` serves give back, for every store of the held cells' vocabulary: the cell's row is in the rational span of the served rows and the
 * rows of the action's calls. Throws on a (cell, column) pair that exists with a row of zeros, because a zero row is in every span: it would be counted as recovered when it is a gap in the generator.
 */
const leaksOf = (accounts: Accounts, extra = 400): Leak[] => {
  const held = heldOf(accounts);
  const motifOf = new Map(held.pool.motifs.map((motif) => [motif.motifId, motif]));
  const served = new Set(bundleOf('claude-code', '2.1.314', held.pool, DEFAULT_FLOORS).cells.map(keyOf));
  const keys = new Set(held.cells.map(keyOf));
  const pairs = held.cells.flatMap((cell) => COLUMNS.filter((column) => writes(motifOf.get(cell.motifId), column)).map((column) => ({ cell, column, key: keyOf(cell) })));
  const index = new Map(pairs.map(({ key, column }, position) => [`${key}|${column}`, position]));
  // A pair's coefficient in an atom, and the atom's calls of each action by status: the rows the `fit` read adds.
  const columnOf = (atom: Atom): { vector: bigint[]; calls: bigint[] } | null => {
    const emitted = emit(atom);
    const vector = pairs.map(() => 0n);
    for (const row of emitted.rows.values()) {
      const key = keyOf({ ...row, exposed: row.exposed === 1 });
      if (!keys.has(key)) return null;
      for (const column of COLUMNS) {
        const at = index.get(`${key}|${column}`);
        if (at !== undefined) vector[at] = BigInt(row[column]);
      }
    }
    const calls = TOOLS.flatMap(({ native }) => (['ok', 'error'] as const).map((status) => BigInt(atom.calls.filter((spec) => spec.tool === native && spec.status === status).length)));
    return { vector, calls };
  };
  const universe = [...accounts.flat(), ...candidatesOf(held, extra)];
  const kept: { vector: bigint[]; calls: bigint[] }[] = [];
  const rank = new Span();
  for (const atom of universe) {
    const made = columnOf(atom);
    if (made !== null && rank.add(made.vector)) kept.push(made);
  }
  const rowOf = (at: number): bigint[] => kept.map(({ vector }) => vector[at] ?? 0n);
  const callRows = TOOLS.flatMap((_, tool) => [0, 1].map((status) => kept.map(({ calls }) => calls[tool * 2 + status] ?? 0n)));
  const span = new Span();
  for (const row of callRows) span.add(row);
  for (const [at, { key }] of pairs.entries()) if (served.has(key)) span.add(rowOf(at));
  const leaks: Leak[] = [];
  for (const [at, { cell, column, key }] of pairs.entries()) {
    const row = rowOf(at);
    if (row.every((value) => value === 0n)) throw new Error(`no atom gives ${key} ${column}: a gap in the generator`);
    if (served.has(key) || cell.clusters >= FLOOR) continue;
    if (span.covers(row)) leaks.push({ cell: `${motifOf.get(cell.motifId)?.cls ?? cell.motifId} ${cell.frameBucket} ${cell.grain}`, column });
  }
  return leaks;
};

/** `count` accounts that each send the same call. */
const accountsOf = (count: number, make: (account: number) => Atom): Accounts => Array.from({ length: count }, (_, account) => [make(account)]);

describe('the withholding oracle', () => {
  it('serves nothing that gives back arg/none: 12 calls of a tool, 10 with query and 2 with no input, at floor 5', () => {
    const accounts = [...accountsOf(10, () => atomOf(call('WebSearch', { query: 'q' }))), ...accountsOf(2, () => atomOf(call('WebSearch', {})))];
    expect(leaksOf(accounts)).toEqual([]);
  });

  it('serves nothing that gives back arg/number: keys/file_path,limit 40 beside keys/file_path,offset 3, with arg/number 43 served', () => {
    const path = { file_path: 'src/a.ts' };
    const accounts = [...accountsOf(10, () => atomOf(call('Read', path))), ...accountsOf(40, () => atomOf(call('Read', { ...path, limit: 10 }))), ...accountsOf(3, () => atomOf(call('Read', { ...path, offset: 0 })))];
    expect(leaksOf(accounts)).toEqual([]);
  });

  it('serves nothing that gives back depth 1 through dir root: depth 0 and dir root count the same calls, beside the keys total and depth 2', () => {
    const at = (file: string) => atomOf(call('Read', { file_path: file }));
    const accounts = [...accountsOf(20, () => at('a.ts')), ...accountsOf(3, () => at('src/a.ts')), ...accountsOf(10, () => at('src/lib/a.ts')), ...accountsOf(20, () => at('docs/lib/a.md'))];
    expect(leaksOf(accounts)).toEqual([]);
  });
});
