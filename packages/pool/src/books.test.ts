// The set of four (direction conclusion section 20 rule 1), as the pool states it. These tests hold served and sub-floor cells and ask what the totals say: a count of served cells, a backlog that is
// a total and never a list, a panel that is one account count, and fields with no source that never read as zero.
import { describe, expect, it } from 'vitest';
import type { Cell } from '../../cli/src/sessions/cells.js';
import { namedId, shapeMotif, type Motif, type WindowStep } from '../../cli/src/sessions/motif.js';
import type { Harness } from '../../cli/src/sessions/schema.js';
import { bundleOf, K_CELL } from './derive.js';
import type { StoredPool } from './stored.js';

const HARNESS: Harness = 'claude-code';
const VERSION = '2.1.314';
const BUCKET = 'claude-code/2.1.31x';
const WEEK = '2026-11-02';
const READ = shapeMotif([{ action: 'file.read', identity: null }]);
const SHELL = shapeMotif([{ action: 'shell.exec', identity: null }]);
const SEARCH = shapeMotif([{ action: 'file.search', identity: null }]);

const weekCell = (motifId: string, clusters: number, over: Partial<Cell> = {}): Cell => ({ motifId, frameBucket: `${BUCKET}/opus`, grain: 'week', day: WEEK, sessions: clusters, clusters, ok: clusters, failed: 0, tokens: 0, durationMs: 0, exposed: false, ...over });

const booksOver = (cells: Cell[], extra: Partial<StoredPool> = {}, motifs: Motif[] = [READ, SHELL, SEARCH]): NonNullable<ReturnType<typeof bundleOf>['books']> => {
  const books = bundleOf(HARNESS, VERSION, { cells, environment: [], motifs, strata: [], ...extra }).books;
  if (books === undefined) throw new Error('the bundle carries no books');
  return books;
};

describe('books: served cells and the below-floor backlog', () => {
  it('counts the week cells at or above the floor as served, and the rest as one backlog total', () => {
    const books = booksOver([weekCell(READ.motifId, K_CELL), weekCell(SHELL.motifId, K_CELL - 1), weekCell(SEARCH.motifId, 1)]);
    expect(books.served.total).toBe(1);
    expect(books.backlog).toBe(2);
  });

  it('breaks served cells down by week and by tuple, and names no sub-floor value', () => {
    const next = '2026-11-09';
    const books = booksOver([weekCell(READ.motifId, 9), weekCell(READ.motifId, K_CELL, { day: next }), weekCell(SHELL.motifId, 7), weekCell(SEARCH.motifId, 2)]);
    expect(books.served.byWeek).toEqual([{ week: WEEK, cells: 2 }, { week: next, cells: 1 }]);
    expect(books.served.byTuple).toEqual([{ tuple: `${READ.motifId}|${BUCKET}/opus`, weeks: 2 }, { tuple: `${SHELL.motifId}|${BUCKET}/opus`, weeks: 1 }]);
    const text = JSON.stringify(books);
    expect(text).not.toContain(SEARCH.motifId);
    expect(books.backlog).toBe(1);
  });

  it('counts a served cell that complementary withholding drops as backlog, so the total never overstates what a reader sees', () => {
    const named = (tool: string): Motif => {
      const steps: WindowStep[] = [{ action: 'mcp.call', identity: { server: 'a', tool } }];
      return { motifId: namedId(steps), level: 'named', steps: [{ action: 'mcp.call', identity: { server: 'a', tool } }], cls: null };
    };
    const shape = shapeMotif([{ action: 'mcp.call', identity: null }]);
    const big = named('big');
    const small = named('small');
    const cells = [weekCell(shape.motifId, 8), weekCell(big.motifId, 6), weekCell(small.motifId, 2)];
    const bundle = bundleOf(HARNESS, VERSION, { cells, environment: [], motifs: [shape, big, small], strata: [] });
    expect(bundle.cells.map((cell) => cell.motifId)).toEqual([shape.motifId]);
    expect(bundle.books?.served.total).toBe(1);
    expect(bundle.books?.backlog).toBe(2);
  });

  it('carries its lineage: the floor, the versions, and the as-of of the served cells', () => {
    const bundle = bundleOf(HARNESS, VERSION, { cells: [weekCell(READ.motifId, K_CELL)], environment: [], motifs: [READ], strata: [] });
    expect(bundle.books).toMatchObject({ floor: K_CELL, format: bundle.format, vocabVersion: bundle.vocabVersion, asOf: bundle.asOf });
  });

  it('serves zero cells as zero served with the backlog beside it, because cells exist and are measured', () => {
    const books = booksOver([weekCell(READ.motifId, 1)]);
    expect(books.served.total).toBe(0);
    expect(books.backlog).toBe(1);
  });
});

describe('books: the panel', () => {
  it('is a number when the pool read its deposits, and no source yet when it did not', () => {
    expect(booksOver([weekCell(READ.motifId, K_CELL)], { panel: 3 }).panel).toEqual({ state: 'value', value: 3 });
    expect(booksOver([weekCell(READ.motifId, K_CELL)]).panel).toEqual({ state: 'no source yet', reason: expect.stringContaining('deposit') });
  });

  it('keeps a panel of zero as zero: a read that found nobody is a measurement', () => {
    expect(booksOver([weekCell(READ.motifId, K_CELL)], { panel: 0 }).panel).toEqual({ state: 'value', value: 0 });
  });
});

describe('books: demand and revenue have no source yet', () => {
  it('states each as no source yet with a reason, and never as 0', () => {
    const books = booksOver([weekCell(READ.motifId, K_CELL)]);
    for (const field of [books.demand.comparisonReadOwners, books.demand.paidReads, books.goal.readRevenue, books.goal.costPerServedCell, books.goal.revenuePerServedCell]) {
      expect(field).toEqual({ state: 'no source yet', reason: expect.stringMatching(/\S+ \S+ \S+/) });
    }
    expect(JSON.stringify(books.demand)).not.toMatch(/"value"/);
    expect(JSON.stringify(books.goal)).not.toMatch(/"value"/);
  });
});
