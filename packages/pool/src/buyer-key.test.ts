import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBuyerKey } from './buyer-key.js';

const keyFile = (text: string): string => {
  const file = join(mkdtempSync(join(tmpdir(), 'buyer-key-')), 'k.key');
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
    const missing = await resolveBuyerKey(undefined, join(tmpdir(), 'no-such-buyer-key-file'));
    expect(missing).toMatchObject({ refusal: expect.stringContaining('Cannot read') });
    expect(await resolveBuyerKey(undefined, keyFile(' \n'))).toMatchObject({ refusal: expect.stringContaining('is empty') });
  });
});
