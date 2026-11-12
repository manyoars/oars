import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBuyerKey } from './buyer-key.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const keyFile = (text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'buyer-key-'));
  dirs.push(dir);
  const file = join(dir, 'k.key');
  writeFileSync(file, text);
  return file;
};

describe('resolveBuyerKey', () => {
  it('returns undefined when neither flag is given', async () => {
    expect(await resolveBuyerKey(undefined, undefined)).toBeUndefined();
  });

  it('returns the key as given when only --buyer-key is given', async () => {
    expect(await resolveBuyerKey('abc', undefined)).toEqual({ key: 'abc' });
  });

  it('returns the file text without a BOM or trailing whitespace', async () => {
    expect(await resolveBuyerKey(undefined, keyFile('\uFEFFabc\r\n'))).toEqual({ key: 'abc' });
  });

  it('returns a refusal for both flags, a missing file, and an empty file, never the key', async () => {
    const both = await resolveBuyerKey('abc', keyFile('abc'));
    expect(both).toEqual({ refusal: 'Give --buyer-key or --buyer-key-file, not both.' });
    const absent = join(tmpdir(), 'no-such-buyer-key-file');
    expect(await resolveBuyerKey(undefined, absent)).toEqual({ refusal: `Cannot read the --buyer-key-file ${absent}.` });
    const empty = keyFile(' \n');
    expect(await resolveBuyerKey(undefined, empty)).toEqual({ refusal: `The --buyer-key-file ${empty} is empty.` });
  });
});
