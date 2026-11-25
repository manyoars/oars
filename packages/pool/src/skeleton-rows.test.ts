import { describe, expect, it } from 'vitest';
import { piecesOf, SKELETON_ROW_BYTES, wholeSkeletonOf } from './skeleton-rows.js';

const bytes = (text: string): number => new TextEncoder().encode(text).length;

/** A three-byte character and an astral pair (four bytes in UTF-8, two UTF-16 units): the two a cut by bytes or by units can split. */
const THREE = '€';
const PAIR = '😀';

/** What a cut must hold, whatever the text: the pieces join back to it, each is within its limit, and none holds a replacement character the text did not. */
const expectCut = (text: string, first: number, pieces: readonly string[]): void => {
  expect(pieces.join('') === text).toBe(true);
  pieces.forEach((piece, at) => {
    expect(bytes(piece)).toBeLessThanOrEqual(at === 0 ? first : SKELETON_ROW_BYTES);
    expect(piece.includes('�')).toBe(false);
  });
};

describe('piecesOf', () => {
  it('keeps a text within the first limit as one piece', () => {
    expect(piecesOf('abc', 3)).toEqual(['abc']);
    expect(piecesOf('', 3)).toEqual(['']);
  });

  it('cuts a three-byte character and an astral pair at the first limit between code points, whatever the byte offset they straddle', () => {
    for (let spare = 0; spare <= 6; spare += 1) {
      const first = 40;
      const text = `${'a'.repeat(first - spare)}${THREE}${PAIR}${THREE}${PAIR}${'b'.repeat(10)}`;
      const pieces = piecesOf(text, first);
      expectCut(text, first, pieces);
      expect(pieces.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('cuts at the row limit the same way, in a text of more than one row, for the first piece and each piece after it', () => {
    for (let spare = 0; spare <= 6; spare += 1) {
      // The first piece ends inside a pair or a three-byte character at the row limit, and so does the second at its own.
      const text = `${'a'.repeat(SKELETON_ROW_BYTES - spare)}${PAIR}${THREE}${'a'.repeat(SKELETON_ROW_BYTES - spare)}${PAIR}${THREE}${PAIR}`;
      const pieces = piecesOf(text);
      expectCut(text, SKELETON_ROW_BYTES, pieces);
      expect(pieces.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('cuts a small first piece before a character too wide for it, and keeps the cut text whole after it', () => {
    // A first limit of one byte holds no three-byte character and no pair: the first piece is empty and the rest follows whole.
    expect(piecesOf(THREE, 1)).toEqual(['', THREE]);
    expect(piecesOf(PAIR, 3)).toEqual(['', PAIR]);
    const text = `${PAIR}${THREE}${PAIR}`;
    for (const first of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
      const pieces = piecesOf(text, first);
      expectCut(text, first, pieces);
      // The first piece holds every whole character that fits and nothing past them.
      expect(bytes(pieces[0] ?? '')).toBe(first >= 11 ? 11 : first >= 7 ? 7 : first >= 4 ? 4 : 0);
    }
  });

  it('joins a long text of mixed widths back byte for byte over several pieces', () => {
    const unit = `${PAIR}${THREE}ab${PAIR}`;
    const text = unit.repeat(Math.ceil((SKELETON_ROW_BYTES * 2.5) / bytes(unit)));
    const pieces = piecesOf(text, 123_457);
    expectCut(text, 123_457, pieces);
    expect(pieces).toHaveLength(4);
  });
});

describe('wholeSkeletonOf', () => {
  it('joins the deposit row and its pieces in the order read, and is none for no row', () => {
    expect(wholeSkeletonOf([])).toBeUndefined();
    expect(wholeSkeletonOf([{ piece: 0, body: 'ab' }, { piece: 1, body: 'cd' }])?.skeleton).toBe('abcd');
  });
});
