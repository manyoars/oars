// The withholding oracle (spec 2026-11-08-pool-withholding-relations, sections 2 and 5). The relations among a bundle's cells are a property of the emitter, so this test does not state them: it builds calls, runs
// them through the real route (the functions `extract.ts` calls on a tool's raw input, then `skeletonOf`, `parseSkeleton`, and `incrementsOf`), and asks, with exact rational arithmetic, whether the cells the real
// `bundleOf` serves determine a sub-floor cell for every store the held cells allow. A reader who holds every served cell and the action's calls (the `fit` read) learns a sub-floor cell when its row is in the
// span of the served rows. One row per (cell, stored column) and one column per atom (one session as the pool stores it); the atoms come only through the route, from a fixed seed, until the rank stops rising.
import { describe, expect, it } from 'vitest';
import { ARG_CLASSES, CHANGE_KINDS, DIRECTORY_KINDS, EXTENSION_CLASSES, PATH_DEPTHS, PATTERN_FEATURES, TARGET_CLASSES, VALUE_SIZES, argClassOf, argFeaturesOf, argValuesOf, changeKindOf, targetClassOf, type ComparedCall } from '../../cli/src/sessions/call-shape.js';
import { incrementsOf, type CellRow } from '../../cli/src/sessions/cell-increments.js';
import { ERROR_CLASS, ERROR_VERSION_CLASS, RECOVERY_CLASS, SHAPE_CLASS, SHAPE_FACETS, parseShapeClass, type Cell } from '../../cli/src/sessions/cells.js';
import { targetOf } from '../../cli/src/sessions/extract.js';
import type { Motif } from '../../cli/src/sessions/motif.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from '../../cli/src/sessions/pool-fixture.js';
import { parseSkeleton, skeletonOf } from '../../cli/src/sessions/pool-wire.js';
import { CLOSED_ARG_VALUES } from '../../cli/src/sessions/public-vocabulary.js';
import { makeRedactor } from '../../cli/src/sessions/redact.js';
import { ERROR_CODES, type ToolObservation, type ToolStatus } from '../../cli/src/sessions/schema.js';
import { bundleOf } from './derive.js';
import { DEFAULT_FLOORS } from './floors.js';
import type { StoredPool } from './stored.js';

const FLOOR = DEFAULT_FLOORS.public;
const CWD = '/work/app';
const SKELETON_ID = '0123456789abcdef';

/** The seven stored columns (spec section 2): `n` is not one, a read derives it as `ok + failed`. */
const COLUMNS = ['ok', 'failed', 'sessions', 'durationMs', 'tokens', 'tokenSessions', 'tokenPrompts'] as const;
type Column = (typeof COLUMNS)[number];

/** A tool the fixtures call: its public name and canonical action. */
const TOOLS: readonly { native: string; action: 'agent.spawn' | 'file.edit' | 'file.read' | 'file.search' | 'shell.exec' | 'web.search' }[] = [
  { native: 'Read', action: 'file.read' },
  { native: 'Grep', action: 'file.search' },
  { native: 'WebSearch', action: 'web.search' },
  { native: 'Bash', action: 'shell.exec' },
  { native: 'Agent', action: 'agent.spawn' },
  { native: 'Task', action: 'agent.spawn' },
  { native: 'NotebookEdit', action: 'file.edit' },
];
/** The actions those tools map to: the `fit` read gives an action's calls, whatever native tool made them. */
const ACTIONS = [...new Set(TOOLS.map(({ action }) => action))];

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
  // The route's own `targetOf` (`extract.ts:1749`), so a shell call gets the target it gets there and a `target-changed` between two of them can fire.
  const aimed = targetOf(spec.tool, spec.input, CWD, 'oracle', makeRedactor(), CWD);
  const features = argFeaturesOf(spec.tool, spec.input, CWD, CWD);
  const values = argValuesOf(spec.tool, spec.input, CLOSED_ARG_VALUES);
  const compared: ComparedCall = { input: spec.input, target: aimed.target, features, values };
  const observation = tool(id, n, spec.tool, {
    status: spec.status,
    target: aimed.target,
    targetBase: aimed.base,
    keys: Object.keys(spec.input).sort(),
    targetClass: targetClassOf(aimed.key, aimed.base),
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
  ['head_limit', [10, 2000]],
  ['output_mode', ['count']],
  ['-i', [true, false]],
  ['model', [true, 'sonnet']],
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

/**
 * The atoms the held cells allow, one a call, from one stream of a fixed seed: key sets from the `keys` cells, values from the pool, and every status and cost variant, then run through the route. The stream has no end
 * (the caller stops it when the rank stops rising) and gives `null` when the held cells name no key set to call with.
 */
const candidatesOf = (held: Held): (() => Atom | null) => {
  const random = seeded(7);
  const pick = <T>(items: readonly T[]): T => {
    const chosen = items[Math.floor(random() * items.length)];
    if (chosen === undefined) throw new Error('nothing to pick from');
    return chosen;
  };
  const vocabulary = vocabularyOf(held);
  return () => {
    if (vocabulary.length === 0) return null;
    const { native, keySets, codes } = pick(vocabulary);
    const callOf = (): Call => {
      const keys = pick(keySets);
      const input = Object.fromEntries([...keys, ...(random() < 0.15 ? ['not_a_public_key'] : [])].map((key) => [key, pick(VALUE_POOL.get(key) ?? ['x'])]));
      const status = pick<ToolStatus>(['ok', 'ok', 'error', 'none']);
      const errorCode = status === 'error' && codes.length > 0 && random() < 0.7 ? pick(codes) : undefined;
      return call(native, input, { status, ...(errorCode === undefined ? {} : { errorCode }), tokens: random() < 0.5 ? null : 5000, durationMs: random() < 0.5 ? null : 500 });
    };
    return { calls: random() < 0.25 ? [callOf(), callOf()] : [callOf()], promptTokens: random() < 0.5 ? null : 5000, wallSec: random() < 0.5 ? null : 3 };
  };
};

interface Leak {
  cell: string;
  column: Column;
}

/** An atom as the matrix holds it: the stored value it adds to each (cell, column) pair, and its calls of each action by status. */
interface MatrixColumn {
  vector: bigint[];
  calls: bigint[];
}

/** Where the matrix stops sampling: this many atoms in a row that add no rank. The unit is an atom drawn from the held cells' own vocabulary, so a larger fixture draws more before it stops. */
const PATIENCE = 400;

/**
 * The matrix of section 2: one column per atom that adds rank, and the (cell, column) pairs that are its rows. The universe is every account's own atoms, then the closed-list coverage (`coverageOf`), then draws from one
 * seeded stream (`candidatesOf`), and it stops only after `patience` draws in a row add no rank; `columnOf` discards an atom that emits a cell the fixture does not hold.
 */
const matrixOf = (accounts: Accounts, patience: number): { held: Held; motifOf: ReadonlyMap<string, Motif>; pairs: { cell: Cell; column: Column; key: string }[]; kept: MatrixColumn[]; drawn: number } => {
  const held = heldOf(accounts);
  const motifOf = new Map(held.pool.motifs.map((motif) => [motif.motifId, motif]));
  const keys = new Set(held.cells.map(keyOf));
  const pairs = held.cells.flatMap((cell) => COLUMNS.filter((column) => writes(motifOf.get(cell.motifId), column)).map((column) => ({ cell, column, key: keyOf(cell) })));
  const index = new Map(pairs.map(({ key, column }, position) => [`${key}|${column}`, position]));
  // A pair's coefficient in an atom, and the atom's calls of each action by status: the rows the `fit` read adds.
  const columnOf = (atom: Atom): MatrixColumn | null => {
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
    const calls = ACTIONS.flatMap((action) => (['ok', 'error'] as const).map((status) => BigInt(atom.calls.filter((spec) => TOOLS.find(({ native }) => native === spec.tool)?.action === action && spec.status === status).length)));
    return { vector, calls };
  };
  const kept: MatrixColumn[] = [];
  const rank = new Span();
  const keep = (atom: Atom): boolean => {
    const made = columnOf(atom);
    if (made === null || !rank.add(made.vector)) return false;
    kept.push(made);
    return true;
  };
  for (const atom of [...accounts.flat(), ...coverageOf()]) keep(atom);
  const draw = candidatesOf(held);
  let drawn = 0;
  for (let idle = 0; idle < patience; drawn += 1) {
    const atom = draw();
    if (atom === null) break;
    idle = keep(atom) ? 0 : idle + 1;
  }
  return { held, motifOf, pairs, kept, drawn };
};

/**
 * The sub-floor cells (and columns) that the cells the real `bundleOf` serves give back, for every store of the held cells' vocabulary: the cell's row is in the rational span of the served rows and the
 * rows of the action's calls. Throws on a (cell, column) pair that exists with a row of zeros, because a zero row is in every span: it would be counted as recovered when it is a gap in the generator.
 */
const leaksOf = (accounts: Accounts, patience = PATIENCE): Leak[] => {
  const { held, motifOf, pairs, kept } = matrixOf(accounts, patience);
  const served = new Set(bundleOf('claude-code', '2.1.314', held.pool, DEFAULT_FLOORS).cells.map(keyOf));
  const rowOf = (at: number): bigint[] => kept.map(({ vector }) => vector[at] ?? 0n);
  const callRows = ACTIONS.flatMap((_, action) => [0, 1].map((status) => kept.map(({ calls }) => calls[action * 2 + status] ?? 0n)));
  const span = new Span();
  for (const row of callRows) span.add(row);
  for (const [at, { key }] of pairs.entries()) if (served.has(key)) span.add(rowOf(at));
  const leaks: Leak[] = [];
  for (const [at, { cell, column, key }] of pairs.entries()) {
    const row = rowOf(at);
    if (row.every((value) => value === 0n)) throw new Error(`no atom gives ${motifOf.get(cell.motifId)?.cls ?? key} ${column}: a gap in the generator`);
    if (served.has(key) || cell.clusters >= FLOOR) continue;
    if (span.covers(row)) leaks.push({ cell: `${motifOf.get(cell.motifId)?.cls ?? cell.motifId} ${cell.frameBucket} ${cell.grain}`, column });
  }
  return leaks;
};

/** `count` accounts that each send the same call. */
const accountsOf = (count: number, make: (account: number) => Atom): Accounts => Array.from({ length: count }, (_, account) => [make(account)]);

/** A path for each target class, path depth, extension class, and folder kind the emitter reads (`call-shape.ts`), under the working folder `/work/app`; `/etc/hosts` is outside it. */
const COVERAGE_PATHS = [
  'a.ts', 'src/a.ts', 'src/lib/a.ts', 'a/b/c/d.ts', 'a/b/c/d/e/f.ts', 'a/b/c/d/e/f/g/h/i/j.ts', '/etc/hosts',
  'test/a.test.ts', 'tsconfig.json', 'README.md', 'package-lock.json', 'dist/a.js', 'data.csv', 'a.xyz', 'logo.png', 'Makefile',
  'docs/a.md', '.github/a.yml', 'foo/a.ts', 'test/a.ts',
];
/** One regular expression for each pattern feature a regex can hold (`recursive` comes from a glob), and the lengths that open each value size (`call-shape.ts:91`). */
const COVERAGE_PATTERNS = ['a|b', '^a$', '[a-z]', 'a\\.b', '(a)', 'foo', 'a+', 'a.b'];
const COVERAGE_SIZES = [0, 1, 9, 33, 129, 513, 2049, 8193];

/**
 * The calls that, between them, emit every member of every closed list the cells are keyed on. They are in the matrix's universe (`matrixOf`), so a member a fixture holds is a column the sweep has whether or not `VALUE_POOL`
 * can draw it, and a list member nothing here emits goes red in the meta-test below, so a new facet or member is not silently outside the universe. A call whose input holds a closed value is built from
 * `CLOSED_ARG_VALUES` itself, and a failed call from `ERROR_CODES`, so neither list can grow unseen.
 */
const coverageOf = (): Atom[] => {
  const calls: Call[][] = [
    ...COVERAGE_PATHS.flatMap((file) => [[call('Read', { file_path: file })], [call('Grep', { path: file })], [call('NotebookEdit', { notebook_path: file })]]),
    ...COVERAGE_PATTERNS.map((pattern) => [call('Grep', { pattern })]),
    [call('Grep', { pattern: 'x', glob: '**/*.ts' })],
    ...COVERAGE_SIZES.map((length) => [call('WebSearch', { query: 'x'.repeat(length) })]),
    [call('WebSearch', { query: 'https://example.test/x' })],
    [call('Bash', { command: 'ls' })],
    [call('Read', { file_path: 'src/a.ts', limit: 10 })],
    [call('Grep', { pattern: 'x', '-i': true }), call('Grep', { pattern: 'x', '-i': false })],
    [call('WebSearch', {})],
    // A key off the tool's list is dropped, and counted.
    [call('WebSearch', { query: 'q', not_a_public_key: 'x' })],
    // Each change kind is a second call of one tool in one prompt.
    [call('Read', { file_path: 'src/a.ts' }), call('Read', { file_path: 'src/a.ts' })],
    [call('Read', { file_path: 'src/a.ts' }), call('Read', { file_path: 'src/a.ts', limit: 10 })],
    [call('Read', { file_path: 'src/a.ts', limit: 10 }), call('Read', { file_path: 'src/a.ts' })],
    [call('WebSearch', { query: 'q' }), call('WebSearch', { query: 'a longer query' })],
    [call('WebSearch', { query: 'aa' }), call('WebSearch', { query: 'bb' })],
    [call('Read', { file_path: 'src/a.ts' }), call('Read', { file_path: 'src/b.ts' })],
    // Each closed value of each tool's argument.
    ...[...CLOSED_ARG_VALUES].flatMap(([native, keys]) => [...keys].flatMap(([key, values]) => [...values].map((value) => [call(native, { [key]: value })]))),
    // Each error code, on a failed call that something follows (the `recovery:` cells) and on one that nothing follows.
    ...[...ERROR_CODES].flatMap((code) => [[call('WebSearch', { query: 'q' }, { status: 'error', errorCode: code })], [call('Read', { file_path: 'src/a.ts' }, { status: 'error', errorCode: code }), call('Bash', { command: 'ls' })]]),
  ];
  return calls.map((made) => atomOf(...made));
};

/** The members of each closed list, by the name the meta-test reports, and the cell classes that carry them. */
interface Emitted {
  facets: Set<string>;
  byFacet: Map<string, Set<string>>;
  errors: Set<string>;
  recoveries: Set<string>;
  enums: Set<string>;
}

/** What the atoms emit, read from the class names of the motifs they name. */
const emittedBy = (atoms: readonly Atom[]): Emitted => {
  const found: Emitted = { facets: new Set(), byFacet: new Map(), errors: new Set(), recoveries: new Set(), enums: new Set() };
  for (const atom of atoms) {
    for (const { cls } of emit(atom).motifs) {
      if (cls === null) continue;
      const shape = parseShapeClass(cls);
      if (shape !== null) {
        found.facets.add(shape.facet);
        const member = shape.facet === 'size' || shape.facet === 'depth' || shape.facet === 'extension' || shape.facet === 'dir' || shape.facet === 'pattern' || shape.facet === 'enum' ? shape.value.slice(shape.value.indexOf('=') + 1) : shape.value;
        found.byFacet.set(shape.facet, (found.byFacet.get(shape.facet) ?? new Set()).add(member));
        if (shape.facet === 'enum') found.enums.add(`${shape.action}|${shape.value}`);
      } else if (cls.startsWith(ERROR_CLASS)) found.errors.add(cls.slice(ERROR_CLASS.length).split('/')[0] ?? '');
      else if (cls.startsWith(RECOVERY_CLASS)) found.recoveries.add(cls.slice(RECOVERY_CLASS.length).split('/')[0] ?? '');
    }
  }
  return found;
};

/**
 * The two list members no cell can name. The wire spells "a value this reader does not know" `other`, so `knownFeatures` (`cell-increments.ts:157-158`) reads an `other` extension or folder kind as a field the call did not
 * send: the call still counts in `size`, and in `depth` and `target`, but adds no `extension` or `dir` cell. The first meta-test asserts these are exactly the members left over, so the exclusion goes red if the route starts to emit one.
 */
const UNREACHABLE = ['EXTENSION_CLASSES/other', 'DIRECTORY_KINDS/other'];

/** Every member of a closed list that the atoms do not emit, named `list/member`. */
const unemittedBy = (atoms: readonly Atom[]): string[] => {
  const found = emittedBy(atoms);
  const missing = (list: string, members: readonly string[], seen: ReadonlySet<string> | undefined): string[] => members.filter((member) => seen?.has(member) !== true).map((member) => `${list}/${member}`);
  const actionOf = (native: string): string => TOOLS.find((known) => known.native === native)?.action ?? native;
  return [
    ...missing('SHAPE_FACETS', SHAPE_FACETS, found.facets),
    ...missing('TARGET_CLASSES', TARGET_CLASSES, found.byFacet.get('target')),
    ...missing('ARG_CLASSES', ARG_CLASSES, found.byFacet.get('arg')),
    ...missing('VALUE_SIZES', VALUE_SIZES, found.byFacet.get('size')),
    ...missing('PATH_DEPTHS', PATH_DEPTHS, found.byFacet.get('depth')),
    ...missing('EXTENSION_CLASSES', EXTENSION_CLASSES, found.byFacet.get('extension')),
    ...missing('DIRECTORY_KINDS', DIRECTORY_KINDS, found.byFacet.get('dir')),
    ...missing('PATTERN_FEATURES', PATTERN_FEATURES, found.byFacet.get('pattern')),
    ...missing('CHANGE_KINDS', CHANGE_KINDS, found.byFacet.get('change')),
    ...missing('ERROR_CODES (error:)', [...ERROR_CODES], found.errors),
    ...missing('ERROR_CODES (recovery:)', [...ERROR_CODES], found.recoveries),
    ...missing('CLOSED_ARG_VALUES', [...CLOSED_ARG_VALUES].flatMap(([native, keys]) => [...keys].flatMap(([key, values]) => [...values].map((value) => `${actionOf(native)}|${key}=${value}`))), found.enums),
  ];
};

describe('the withholding oracle', () => {
  it('emits every member of every closed list a cell is keyed on, so a new facet or member goes red until the universe covers it', () => {
    expect(unemittedBy(coverageOf())).toEqual(UNREACHABLE);
  });

  it('names a list member that no call emits', () => {
    const withoutLimit = coverageOf().filter(({ calls }) => !calls.some(({ input }) => 'limit' in input));
    expect(unemittedBy(withoutLimit).filter((member) => !UNREACHABLE.includes(member))).toEqual(['ARG_CLASSES/number', 'CHANGE_KINDS/key-added', 'CHANGE_KINDS/key-removed']);
  });

  // Two cases `determinedCells` (`shape-cells.test.ts`) stated from cells, moved here and built from calls through the route. `determinedCells` stays for its seeded census until t996's sweep replaces it.
  const grep = (input: { readonly [key: string]: unknown }): Atom => atomOf(call('Grep', input));
  const servedOf = (accounts: Accounts): number => bundleOf('claude-code', '2.1.314', heldOf(accounts).pool, DEFAULT_FLOORS).cells.length;

  it('serves nothing that gives back a keys cell through a combination of served totals: path,pattern is the path total plus the pattern total less the calls', () => {
    const accounts = [...accountsOf(FLOOR + 5, () => grep({ path: 'src/a.ts' })), ...accountsOf(FLOOR - 1, () => grep({ path: 'src/a.ts', pattern: 'foo' })), ...accountsOf(FLOOR + 5, () => grep({ pattern: 'foo' }))];
    expect(servedOf(accounts)).toBeGreaterThan(0);
    expect(leaksOf(accounts)).toEqual([]);
  });

  // The same fixture with one closed value beside the key. A boolean has no other per-key facet (`output_mode` also has `size`, which its string value emits), and a boolean, or a list that names all its values, is a value of every
  // call that sends the key, so its cells sum to the key's calls under any key name, an open list's `model` included; if the facet counted only some calls it would stand apart from the `keys` cells and the bundle would serve what they recover.
  it.each([
    ['an exhaustive list', 'Grep', 'output_mode', 'count'],
    ['a boolean', 'Grep', '-i', true],
    ['a boolean under the key of an open list', 'Agent', 'model', true],
  ])('serves nothing that gives back a keys cell through the enum cell of %s', (_, native, key, value) => {
    const other = native === 'Agent' ? 'description' : 'pattern';
    const send = (input: { readonly [key: string]: unknown }): Atom => atomOf(call(native, input));
    const accounts = [...accountsOf(FLOOR + 5, () => send({ [key]: value })), ...accountsOf(FLOOR - 1, () => send({ [key]: value, [other]: 'foo' })), ...accountsOf(FLOOR + 5, () => send({ [other]: 'foo' }))];
    expect(servedOf(accounts)).toBeGreaterThan(0);
    expect(leaksOf(accounts)).toEqual([]);
  });

  it('serves nothing that gives back arg/none: 12 calls of a tool, 10 with query and 2 with no input, at floor 5', () => {
    const accounts = [...accountsOf(10, () => atomOf(call('WebSearch', { query: 'q' }))), ...accountsOf(2, () => atomOf(call('WebSearch', {})))];
    expect(servedOf(accounts)).toBeGreaterThan(0);
    expect(leaksOf(accounts)).toEqual([]);
  });

  // `arg/none` is a part of the `keys` family (`complement.ts`, the `facet` rule), and the sum is inexact for two calls: one whose keys are all null sends a key and no value, so it is in `keys/query` and in `arg/none`, and one
  // with only an off-list key sends neither a public key nor a null, so it is in no `keys` cell. Each is held here beside keyed and keyless calls, and the oracle says whether the inexact sum ever serves what it recovers.
  it.each([
    ['a call whose only key is null', { query: null }],
    ['a call with only an off-list key', { not_a_public_key: 'x' }],
  ])('serves nothing that gives back arg/none beside %s', (_, odd) => {
    const accounts = [...accountsOf(10, () => atomOf(call('WebSearch', { query: 'q' }))), ...accountsOf(2, () => atomOf(call('WebSearch', {}))), ...accountsOf(3, () => atomOf(call('WebSearch', odd)))];
    expect(servedOf(accounts)).toBeGreaterThan(0);
    expect(leaksOf(accounts)).toEqual([]);
  });

  it('serves nothing that gives back arg/number: keys/file_path,limit 40 beside keys/file_path,offset 3, beside arg/number 43, which is held and not served', () => {
    const path = { file_path: 'src/a.ts' };
    const accounts = [...accountsOf(10, () => atomOf(call('Read', path))), ...accountsOf(40, () => atomOf(call('Read', { ...path, limit: 10 }))), ...accountsOf(3, () => atomOf(call('Read', { ...path, offset: 0 })))];
    expect(servedOf(accounts)).toBeGreaterThan(0);
    expect(leaksOf(accounts)).toEqual([]);
  });

  it('serves nothing that gives back depth 1 through dir root: depth 0 and dir root count the same calls, beside the keys total and depth 2', () => {
    const at = (file: string) => atomOf(call('Read', { file_path: file }));
    const accounts = [...accountsOf(20, () => at('a.ts')), ...accountsOf(3, () => at('src/a.ts')), ...accountsOf(10, () => at('src/lib/a.ts')), ...accountsOf(20, () => at('docs/lib/a.md'))];
    expect(servedOf(accounts)).toBeGreaterThan(0);
    expect(leaksOf(accounts)).toEqual([]);
  });
});
