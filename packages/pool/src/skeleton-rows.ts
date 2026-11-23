// A stored skeleton past one D1 row (t1583, migration 0044). D1 holds at most 2,000,000 bytes in a row, and a deposit may be larger than that, so a long skeleton keeps its first piece in `deposits.skeleton` and the rest in
// `deposit_skeleton_rows`, in order from piece 1. A skeleton that fits one row has no pieces, which is how every row stored before the table reads. The Worker and the operator's scripts read and cut it here, so they cannot drift.
import { fieldOf } from './http.js';

/** What one stored row gives a skeleton: D1 caps a row at 2,000,000 bytes, and a piece's other columns, or the deposit row's, take the rest. */
export const SKELETON_ROW_BYTES = 1_800_000;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * `text` in pieces that join back to it: the first at most `first` UTF-8 bytes (what the deposit row has left beside its other columns), each one after it at most `SKELETON_ROW_BYTES`, cut between code points. A text within `first` is one piece.
 * The pieces are slices of `text`, so the cut costs one buffer of a piece and no copy of the whole.
 */
export const piecesOf = (text: string, first: number = SKELETON_ROW_BYTES): string[] => {
  const encoder = new TextEncoder();
  const buffer = new Uint8Array(Math.max(first, SKELETON_ROW_BYTES));
  const pieces: string[] = [];
  let at = 0;
  let limit = first;
  do {
    // A slice that ends between the two halves of a pair would encode its half as a replacement character, so it ends before the pair; the encoder then stops at the last code point that fits.
    let end = Math.min(text.length, at + limit);
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    const { read } = encoder.encodeInto(text.slice(at, end), buffer.subarray(0, limit));
    pieces.push(text.slice(at, at + read));
    at += read;
    limit = SKELETON_ROW_BYTES;
  } while (at < text.length);
  return pieces;
};

/**
 * One statement that reads a deposit's skeleton whole, as rows in order: the deposit row as piece 0, its `skeleton` as `body` beside `columns` (more of its columns), then each stored piece. One statement reads one state of the row and its
 * pieces, so a resend that lands between two reads cannot mix them. Bind `account`, `id`, `account`, `id`.
 */
export const wholeSkeletonSql = (columns: readonly string[]): string =>
  `SELECT 0 AS piece, skeleton AS body${columns.map((column) => `, ${column}`).join('')} FROM deposits WHERE account = ? AND id = ? UNION ALL SELECT piece, body${columns.map((column) => `, NULL AS ${column}`).join('')} FROM deposit_skeleton_rows WHERE account = ? AND id = ? ORDER BY piece`;

/** The rows `wholeSkeletonSql` read, as the deposit row and its skeleton joined back, or none when the account holds no row under the id. */
export const wholeSkeletonOf = (rows: readonly unknown[]): { row: unknown; skeleton: string } | undefined => {
  const [row] = rows;
  if (row === undefined) return undefined;
  return { row, skeleton: rows.map((held) => fieldOf(held, 'body')).filter((body) => typeof body === 'string').join('') };
};
