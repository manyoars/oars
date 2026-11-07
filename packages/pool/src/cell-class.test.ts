// t900 Item 3: the pool reads the class table. A value on the public list is `clear`, one off it takes the field's `longTail` class, and a served read takes the class of the cell it counts.
import { describe, expect, it } from 'vitest';
import { NO_AXES, type Cell } from '../../cli/src/sessions/cells.js';
import type { Motif } from '../../cli/src/sessions/motif.js';
import type { StepIdentity } from '../../cli/src/sessions/schema.js';
import { cellClassOf } from './cell-class.js';
import { bundleOf, CLEAR_FLOOR, FLOORS, K_CELL } from './derive.js';
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
  });

  it('is thresholded when any one part is off a list', () => {
    expect(cellClassOf(cellOf('m', `claude-code/${NO_AXES}/acme-private-finetune-v7`, 1), motifOf('m', git()))).toBe('thresholded');
    expect(cellClassOf(cellOf('m', 'claude-code/2.1.31x/acme-private-finetune-v7', 1), motifOf('m', git()))).toBe('thresholded');
    expect(cellClassOf(cellOf('m', 'claude-code/2.1.31x-acme/claude-sonnet-4-5', 1), motifOf('m', git()))).toBe('thresholded');
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
  const frames = (clusters: number, floors?: Parameters<typeof bundleOf>[3]): string[] => bundleOf('claude-code', '2.1.314', stored(clusters), floors).cells.map((cell) => `${cell.motifId} ${cell.frameBucket}`);

  it('serves a clear cell below the clear floor only when the floor says so, and a thresholded one never', () => {
    expect(frames(K_CELL - 1, { clear: 1, thresholded: K_CELL })).toEqual(['m-clear claude-code/2.1.31x/claude-sonnet-4-5']);
  });

  it('serves all three at the floor', () => {
    expect(frames(K_CELL)).toHaveLength(3);
  });

  it('keeps one cell floor for both classes today, and states the thresholded floor on the bundle', () => {
    expect(CLEAR_FLOOR).toBe(K_CELL);
    expect(FLOORS).toEqual({ clear: K_CELL, thresholded: K_CELL });
    expect(frames(K_CELL - 1)).toEqual([]);
    expect(bundleOf('claude-code', '2.1.314', stored(K_CELL)).floor).toBe(K_CELL);
  });
});
