// The Merkle root of a raw transcript, recomputed from the file (spec 2.4). The capture side is `merkleRoot` in `extract.ts`; the two must
// agree byte for byte, which `merkle.test.ts` checks against a real capture.
import { createHash } from 'node:crypto';

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A root over fewer lines than this joins no cluster and counts toward no `n` (spec 2.5, open question 5.4 item 3). */
export const MIN_ROOT_LEAVES = 10;

/** The lines capture hashes: split on any line ending, and a final empty piece (the trailing newline) is no line. */
export const rawLinesOf = (text: string): string[] => {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** SHA-256 over the SHA-256 of every line, an odd node paired with itself; no lines is `sha256('')`. */
export const merkleRootOf = (lines: readonly string[]): string => {
  if (lines.length === 0) return sha256('');
  let level = lines.map(sha256);
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index] ?? '';
      next.push(sha256(left + (level[index + 1] ?? left)));
    }
    level = next;
  }
  return level[0] ?? sha256('');
};
