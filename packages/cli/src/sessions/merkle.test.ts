import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { merkleRootOf, rawLinesOf, sha256 } from './merkle.js';
import { cleanup, FIXTURES } from './test-support.js';

afterEach(cleanup);

describe('merkleRootOf', () => {
  it('matches the root capture wrote for every fixture transcript', () => {
    for (const name of ['errors-a', 'errors-b', 'sidechain', 'tldr']) {
      const text = readFileSync(join(FIXTURES, 'proj', `${name}.jsonl`), 'utf8');
      const capture = captureSession({ text, session: name, project: 'proj', rev: 1, at: '2026-06-10T00:00:00Z', bytes: text.length, redact: makeRedactor() });
      expect(merkleRootOf(rawLinesOf(text))).toBe(capture.skeleton.merkleRoot);
      expect(rawLinesOf(text)).toHaveLength(capture.skeleton.leaves);
    }
  });

  it('roots no lines at the hash of the empty string and pairs an odd node with itself', () => {
    expect(merkleRootOf([])).toBe(sha256(''));
    const [a, b, c] = ['a', 'b', 'c'].map(sha256);
    expect(merkleRootOf(['a'])).toBe(a);
    expect(merkleRootOf(['a', 'b', 'c'])).toBe(sha256(sha256((a ?? '') + (b ?? '')) + sha256((c ?? '') + (c ?? ''))));
  });

  it('splits on any line ending and drops only the final empty piece', () => {
    expect(rawLinesOf('a\r\nb\rc\n')).toEqual(['a', 'b', 'c']);
    expect(rawLinesOf('a\n\n')).toEqual(['a', '']);
    expect(rawLinesOf('')).toEqual([]);
  });
});
