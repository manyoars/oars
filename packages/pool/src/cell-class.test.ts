// t900 Item 3: the pool reads the class table. A value on the public list is `clear`, one off it takes the field's `longTail` class, and a served read takes the class of the cell it counts.
import { describe, expect, it } from 'vitest';
import { NO_AXES, type Cell } from '../../cli/src/sessions/cells.js';
import { frame, printOf, prompt, session, sessionsFrom, step, store, storedNames, tool } from '../../cli/src/sessions/pool-fixture.js';
import { parseSkeleton, skeletonOf, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import type { Motif } from '../../cli/src/sessions/motif.js';
import type { Read } from '../../cli/src/sessions/read.js';
import { PROMPT_CLASSES, type StepIdentity } from '../../cli/src/sessions/schema.js';
import { cellClassOf, type CellClass } from './cell-class.js';
import { bundleOf } from './derive.js';
import { incrementsOf } from './ingest.js';
import { DEFAULT_FLOORS, DEFAULT_PUBLIC_FLOOR, floorsOf } from './floors.js';
import { classFor, isListed } from './field-classes.js';
import type { StoredPool } from './stored.js';

describe('a value against its list', () => {
  it('lists a public model and version, and not a private build', () => {
    expect(isListed('model', 'claude-sonnet-4-5')).toBe(true);
    expect(isListed('model', 'acme-private-finetune-v7')).toBe(false);
    expect(isListed('harnessVersion', '2.1.314')).toBe(true);
    expect(isListed('harnessVersion', '2.1.314-acme.build')).toBe(false);
  });

  it('takes the field class on the list and the long-tail class off it', () => {
    expect(classFor('model', true)).toBe('clear');
    expect(classFor('model', false)).toBe('thresholded');
    expect(classFor('harnessVersion', false)).toBe('thresholded');
    expect(classFor('program', false)).toBe('thresholded');
    expect(classFor('tokens', false)).toBe('clear');
    expect(classFor('host', true)).toBe('hashed at ingest');
  });

  it('fails closed for a field with no row', () => {
    expect(classFor('a-field-no-batch-carries', true)).toBe('thresholded');
  });
});

const motifOf = (id: string, identity: StepIdentity): Motif => ({ motifId: id, level: 'named', steps: [{ action: 'shell.exec', identity }], cls: null });
const git = (flags: string[] = [], sub: string | null = 'status'): StepIdentity => ({ program: 'git', sub, flags });
const cellOf = (motifId: string, frameBucket: string, clusters: number): Cell => ({ motifId, frameBucket, grain: 'day', day: '2026-11-01', sessions: clusters, clusters, ok: clusters, failed: 0, tokens: 0, durationMs: 0, exposed: false });

describe('the class of a cell', () => {
  const frame = 'claude-code/2.1.31x/claude-sonnet-4-5';
  it('is clear when the model, version, and every name are on the lists', () => {
    expect(cellClassOf(cellOf('m', frame, 1), motifOf('m', git(['--force'])))).toBe('clear');
    expect(cellClassOf(cellOf('m', 'claude-code/unknown/unknown', 1), motifOf('m', null))).toBe('clear');
    // The version-free model cell that `bundleOf` serves beside the bucket's: no version axis, so only the model decides.
    expect(cellClassOf(cellOf('m', `claude-code/${NO_AXES}/claude-sonnet-4-5`, 1), motifOf('m', git(['--force'])))).toBe('clear');
    // The version-only cell `versionBucketOf` builds for the recovery and error-version cells: no model axis (`-`), so only the version decides.
    expect(cellClassOf(cellOf('m', `claude-code/2.1.31x/${NO_AXES}`, 1), motifOf('m', git(['--force'])))).toBe('clear');
  });

  it('is thresholded when any one part is off a list', () => {
    expect(cellClassOf(cellOf('m', `claude-code/${NO_AXES}/acme-private-finetune-v7`, 1), motifOf('m', git()))).toBe('thresholded');
    expect(cellClassOf(cellOf('m', 'claude-code/2.1.31x/acme-private-finetune-v7', 1), motifOf('m', git()))).toBe('thresholded');
    expect(cellClassOf(cellOf('m', 'claude-code/acme-nightly/claude-sonnet-4-5', 1), motifOf('m', git()))).toBe('thresholded');
    expect(cellClassOf(cellOf('m', frame, 1), motifOf('m', { program: 'acme-deploy', sub: null, flags: [] }))).toBe('thresholded');
    expect(cellClassOf(cellOf('m', frame, 1), motifOf('m', git([], 'acme-sub')))).toBe('thresholded');
    expect(cellClassOf(cellOf('m', frame, 1), motifOf('m', git(['--acme-flag'])))).toBe('thresholded');
    expect(cellClassOf(cellOf('m', frame, 1), motifOf('m', { program: 'npm', sub: 'install', flags: [], pulls: [{ registry: 'npm', name: 'acme-internal-lib', version: null }] }))).toBe('thresholded');
    expect(cellClassOf(cellOf('m', frame, 1), motifOf('m', { server: 'acme-mcp', tool: 'run' }))).toBe('thresholded');
    expect(cellClassOf(cellOf('m', frame, 1), motifOf('m', { skill: 'acme-skill' }))).toBe('thresholded');
    expect(cellClassOf(cellOf('m', frame, 1), motifOf('m', { host: 'a1b2c3' }))).toBe('thresholded');
  });

  it('is thresholded when the motif is not held (fail closed)', () => {
    expect(cellClassOf(cellOf('m', frame, 1), undefined)).toBe('thresholded');
  });

  it('is clear for a single-letter flag and a step with no host', () => {
    expect(cellClassOf(cellOf('m', frame, 1), motifOf('m', git(['-n'])))).toBe('clear');
    expect(cellClassOf(cellOf('m', frame, 1), motifOf('m', { host: null }))).toBe('clear');
  });
});

describe('a served bundle reads the class', () => {
  const clearMotif = motifOf('m-clear', git());
  const tailMotif = motifOf('m-tail', { program: 'acme-deploy', sub: null, flags: [] });
  const stored = (clusters: number): StoredPool => ({
    cells: [cellOf('m-clear', 'claude-code/2.1.31x/claude-sonnet-4-5', clusters), cellOf('m-clear', 'claude-code/2.1.31x/acme-private-finetune-v7', clusters), cellOf('m-tail', 'claude-code/2.1.31x/claude-sonnet-4-5', clusters)],
    environment: [],
    motifs: [clearMotif, tailMotif],
    strata: [],
  });
  const frames = (clusters: number, floors = DEFAULT_FLOORS): string[] => bundleOf('claude-code', '2.1.314', stored(clusters), floors).cells.map((cell) => `${cell.motifId} ${cell.frameBucket}`);

  const mixed: Motif = { motifId: 'm-mixed', level: 'named', steps: [{ action: 'shell.exec', identity: git() }, { action: 'shell.exec', identity: { program: 'acme-deploy', sub: null, flags: [] } }], cls: null };
  const withMixed = (clusters: number): StoredPool => ({ ...stored(clusters), cells: [cellOf('m-mixed', 'claude-code/2.1.31x/claude-sonnet-4-5', clusters)], motifs: [mixed] });

  it('serves a clear cell held by one cluster at the default clear floor, and a thresholded one never', () => {
    expect(frames(1)).toEqual(['m-clear claude-code/2.1.31x/claude-sonnet-4-5']);
    expect(frames(DEFAULT_PUBLIC_FLOOR - 1)).toEqual(['m-clear claude-code/2.1.31x/claude-sonnet-4-5']);
  });

  it('withholds that clear cell when the deploy sets CLEAR_FLOOR to 5, and states both floors', () => {
    const five = floorsOf({ CLEAR_FLOOR: '5' }, () => undefined);
    expect(frames(1, five)).toEqual([]);
    expect(frames(DEFAULT_PUBLIC_FLOOR - 1, five)).toEqual([]);
    expect(bundleOf('claude-code', '2.1.314', stored(1), DEFAULT_FLOORS).floors).toEqual({ public: 5, disclosure: 2, clear: 1 });
  });

  it('serves all three at the public floor', () => {
    expect(frames(DEFAULT_PUBLIC_FLOOR)).toHaveLength(3);
  });

  it('states on a read across classes the lowest of its cells floors, and the most of their clusters', () => {
    // One motif on a listed model (a clear cell, one account) and on a long-tail model (a thresholded cell, five accounts): the adoption read groups the motif across frames and cites both cells.
    const week = (frame: string, clusters: number): Cell => ({ ...cellOf('m-clear', frame, clusters), grain: 'week', day: '2026-11-02' });
    const across: StoredPool = {
      cells: [week('claude-code/2.1.31x/claude-sonnet-4-5', 1), week('claude-code/2.1.31x/acme-private-finetune-v7', DEFAULT_PUBLIC_FLOOR)],
      environment: [],
      motifs: [clearMotif],
      strata: [],
    };
    const adoption = bundleOf('claude-code', '2.1.314', across, DEFAULT_FLOORS).reads.filter(({ family, inputs }) => family === 'adoption' && inputs.length === 2);
    expect(adoption.map(({ floor, clusters }) => [floor, clusters])).toEqual([[DEFAULT_FLOORS.clear, DEFAULT_PUBLIC_FLOOR]]);
  });

  it('holds a cell with one clear part and one long-tail part to the public floor', () => {
    const served = (clusters: number): number => bundleOf('claude-code', '2.1.314', withMixed(clusters), DEFAULT_FLOORS).cells.length;
    expect([served(1), served(DEFAULT_PUBLIC_FLOOR - 1), served(DEFAULT_PUBLIC_FLOOR)]).toEqual([0, 0, 1]);
  });

  it('states on a read the floor of the lowest class among its cells, so no read has fewer clusters than its floor', () => {
    const weekly = (clusters: number): StoredPool => ({
      cells: [{ ...cellOf('m-clear', 'claude-code/2.1.31x/claude-sonnet-4-5', clusters), grain: 'week', day: '2026-11-02' }, { ...cellOf('m-tail', 'claude-code/2.1.31x/claude-sonnet-4-5', clusters), grain: 'week', day: '2026-11-02' }],
      environment: [],
      motifs: [clearMotif, tailMotif],
      strata: [],
    });
    const reads = (clusters: number): Read[] => bundleOf('claude-code', '2.1.314', weekly(clusters), DEFAULT_FLOORS).reads;
    // One account: the clear cell's read says the clear floor it cleared, not the public floor it never met, and the long-tail cell has no read.
    const one = reads(1);
    expect(one.length).toBeGreaterThan(0);
    expect(new Set(one.map(({ floor, clusters }) => `${String(floor)}/${String(clusters)}`))).toEqual(new Set([`${String(DEFAULT_FLOORS.clear)}/1`]));
    expect(new Set(reads(DEFAULT_PUBLIC_FLOOR).map(({ floor }) => floor))).toEqual(new Set([DEFAULT_FLOORS.clear, DEFAULT_PUBLIC_FLOOR]));
    for (const clusters of [1, DEFAULT_PUBLIC_FLOOR - 1, DEFAULT_PUBLIC_FLOOR]) {
      for (const read of reads(clusters)) expect(read.clusters).toBeGreaterThanOrEqual(read.floor ?? Infinity);
    }
  });

  it('states the thresholded floor as the bundle\'s floor, and the clear floor beside it', () => {
    expect(DEFAULT_FLOORS.clear).toBe(1);
    expect(bundleOf('claude-code', '2.1.314', stored(DEFAULT_PUBLIC_FLOOR), DEFAULT_FLOORS).floor).toBe(DEFAULT_PUBLIC_FLOOR);
  });
});

// A failed call's `error:<code>/<name>` and `error-version:<code>/<name>` cells hold the step's identity in the class name with no steps behind it, so the class has to be read from the name.
describe('a failed call\'s class cells', () => {
  const failedSkeleton = (identity: StepIdentity): SessionSkeleton => {
    const framed = frame({ day: '2026-11-01' });
    const shell = step(0, 0, 'shell.exec', { native: 'Bash', status: 'error', identity });
    const [only] = sessionsFrom(
      store({ sessions: [session('s1', { frame: framed })], prompts: [prompt('s1', 0, { frame: framed })], tools: [tool('s1', 0, 'Bash', { status: 'error', errorCode: '429', steps: [shell] })] }),
    );
    const built = only === undefined ? null : skeletonOf(only, '0000000000000001', storedNames, printOf);
    if (built === null) throw new Error('no skeleton');
    return built;
  };
  const storedOfFailed = (identity: StepIdentity, clusters: number): StoredPool => {
    const parsed = parseSkeleton(JSON.parse(JSON.stringify(failedSkeleton(identity))));
    if (!parsed.ok) throw new Error('skeleton refused');
    const { cells, motifs } = incrementsOf(parsed.skeleton);
    // The same motif is held once however many cells name it.
    const held = [...new Map(motifs.map((motif) => [motif.motifId, motif])).values()];
    return {
      cells: [...cells.values()].map((row): Cell => ({ motifId: row.motifId, frameBucket: row.frameBucket, grain: row.grain, day: row.day, sessions: row.sessions, clusters, ok: row.ok, failed: row.failed, tokens: row.tokens, durationMs: row.durationMs, exposed: row.exposed === 1 })),
      environment: [],
      motifs: held,
      strata: [],
    };
  };
  const served = (identity: StepIdentity, clusters: number): string[] =>
    bundleOf('claude-code', '2.1.314', storedOfFailed(identity, clusters), DEFAULT_FLOORS).motifs.map((motif) => motif.cls ?? '').filter((cls) => cls.startsWith('error'));
  const namedIn = (held: string[]): string[] => held.filter((cls) => cls.includes('acme-deploy'));
  const classOf = (identity: StepIdentity, prefix: string, name: string): CellClass[] => {
    const { cells, motifs } = storedOfFailed(identity, 1);
    return cells.flatMap((cell) => {
      const motif = motifs.find(({ motifId }) => motifId === cell.motifId);
      return (motif?.cls ?? '').startsWith(prefix) && (motif?.cls ?? '').endsWith(name) ? [cellClassOf(cell, motif)] : [];
    });
  };
  const tail: StepIdentity = { program: 'acme-deploy', sub: 'ship', flags: [] };

  it('holds a long-tail name in an error or error-version class to the thresholded floor', () => {
    expect(classOf(tail, 'error:429/', 'ship]')).toEqual(['thresholded']);
    expect(classOf(tail, 'error-version:429/', 'ship]')).toEqual(['thresholded']);
    expect(namedIn(served(tail, 1))).toEqual([]);
    expect(namedIn(served(tail, DEFAULT_PUBLIC_FLOOR - 1))).toEqual([]);
    expect(namedIn(served(tail, DEFAULT_PUBLIC_FLOOR))).toHaveLength(2);
  });

  it('keeps an action-only error name clear, served at one account', () => {
    expect(classOf(tail, 'error:429/', 'shell.exec')).toEqual(['clear']);
    expect(served(tail, 1)).toEqual(['error:429/shell.exec', 'error-version:429/shell.exec']);
  });
});

// A class motif holds no steps, so its class is read from `cls` alone. Only the forms the client writes are clear; a class the pool cannot read is the strict one, never the loose one.
describe('a class motif the pool cannot read', () => {
  const frameBucket = 'claude-code/2.1.31x/claude-sonnet-4-5';
  const classMotif = (cls: string): Motif => ({ motifId: 'm', level: 'named', steps: [], cls });
  const classOf = (cls: string): CellClass => cellClassOf(cellOf('m', frameBucket, 1), classMotif(cls));

  it('is thresholded for an unknown prefix, an unknown shape facet, and an error class with no name', () => {
    expect(classOf('unknown:acme-deploy')).toBe('thresholded');
    expect(classOf('shape:file.read/nofacet/acme')).toBe('thresholded');
    expect(classOf('error:429')).toBe('thresholded');
    expect(classOf('error-version:429')).toBe('thresholded');
  });

  it('stays clear for a prompt class, an effort class, a recovery class, and an action-only error name', () => {
    for (const cls of PROMPT_CLASSES) expect(classOf(cls)).toBe('clear');
    expect(classOf('')).toBe('clear');
    expect(classOf('effort:high/thinking:4')).toBe('clear');
    expect(classOf('recovery:429/file.read>shell.exec')).toBe('clear');
    expect(classOf('error:429/shell.exec')).toBe('clear');
  });

  // A name with an identity waits for the public floor even when it is a listed program: `motifName` has no parser to rebuild the identity, and thresholded serves less, never more.
  it('holds a listed program\'s name in an error class to the thresholded floor', () => {
    expect(classOf('error:429/shell.exec[program=git sub=push]')).toBe('thresholded');
    expect(classOf('error-version:429/shell.exec[program=git sub=push]')).toBe('thresholded');
  });
});
