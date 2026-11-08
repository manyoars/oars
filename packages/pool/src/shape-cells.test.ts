// The pool serves a call's shape cells (layer 0): a target class, an argument class, and a count of unsent key names are closed lists, so their cells are `clear` and served at the clear floor;
// the sorted key names are a long tail, so their cell is `thresholded` and served only at the public floor. The bundle's `fit` reads cite them.
import { describe, expect, it } from 'vitest';
import { NO_AXES, shapeClass, type Cell } from '../../cli/src/sessions/cells.js';
import { classMotif } from '../../cli/src/sessions/motif.js';
import { cellClassOf } from './cell-class.js';
import { bundleOf } from './derive.js';
import { DEFAULT_FLOORS, DEFAULT_PUBLIC_FLOOR } from './floors.js';
import type { StoredPool } from './stored.js';

const bucket = `claude-code/2.1.31x/${NO_AXES}`;
const target = classMotif(shapeClass('file.read', 'target', 'source'));
const arg = classMotif(shapeClass('file.read', 'arg', 'path'));
const dropped = classMotif(shapeClass('file.read', 'dropped', '1'));
const keys = classMotif(shapeClass('file.read', 'keys', 'file_path,limit'));
const cellOf = (motifId: string, clusters: number): Cell => ({ motifId, frameBucket: bucket, grain: 'week', day: '2026-10-26', sessions: clusters, clusters, ok: clusters, failed: 1, tokens: null, durationMs: 0, exposed: false });

describe('the class of a shape cell', () => {
  it('is clear for a target class, an argument class, and a dropped count', () => {
    for (const motif of [target, arg, dropped]) expect(cellClassOf(cellOf(motif.motifId, 1), motif)).toBe('clear');
  });

  it('is thresholded for the key names', () => {
    expect(cellClassOf(cellOf(keys.motifId, 1), keys)).toBe('thresholded');
  });
});

describe('a bundle of shape cells', () => {
  const stored = (clusters: number): StoredPool => ({ cells: [target, arg, dropped, keys].map(({ motifId }) => cellOf(motifId, clusters)), environment: [], motifs: [target, arg, dropped, keys], strata: [] });
  const served = (clusters: number, floors = DEFAULT_FLOORS): (string | null)[] => {
    const held = bundleOf('claude-code', '2.1.314', stored(clusters), floors);
    return held.cells.map(({ motifId }) => held.motifs.find((motif) => motif.motifId === motifId)?.cls ?? null).sort();
  };

  it('serves the clear cells at the clear floor and the key names only at the public floor', () => {
    expect(served(DEFAULT_PUBLIC_FLOOR - 1, { ...DEFAULT_FLOORS, clear: 1 })).toEqual([target.cls, arg.cls, dropped.cls].sort());
    expect(served(DEFAULT_PUBLIC_FLOOR)).toEqual([target.cls, arg.cls, dropped.cls, keys.cls].sort());
    expect(served(DEFAULT_PUBLIC_FLOOR - 1)).toEqual([]);
  });

  it('carries a fit read per served shape cell, each citing its cell', () => {
    const held = bundleOf('claude-code', '2.1.314', stored(DEFAULT_PUBLIC_FLOOR), DEFAULT_FLOORS);
    const shapes = held.reads.filter(({ family, slice }) => family === 'fit' && slice.facet !== undefined);
    expect(shapes.map(({ slice }) => `${slice.facet ?? ''}/${slice.value ?? ''}`).sort()).toEqual(['arg/path', 'dropped/1', 'keys/file_path,limit', 'target/source']);
    expect(shapes.every(({ inputs, value }) => inputs.length === 1 && value.failed === 1)).toBe(true);
  });
});
