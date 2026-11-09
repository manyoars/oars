// `OARS_EXCLUSION_TERMS_INLINE`: the terms a machine's enrollment put in one variable go to an owner-only file in the store, and `OARS_EXCLUSION_TERMS` names that file. The store is a temp folder and the test confirms it before it writes.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTerms } from './exclusion.js';
import { inlineTermsFile, withInlineTerms } from './machine.js';
import { cleanup, stage } from './test-support.js';

afterEach(cleanup);

const store = (): string => {
  const { storeDir } = stage();
  if (!storeDir.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  return storeDir;
};

describe('withInlineTerms', () => {
  it('writes the terms owner-only into the store and points OARS_EXCLUSION_TERMS at the file', async () => {
    const storeDir = store();
    const env = { OARS_HOST_CLASS: 'cloud', OARS_EXCLUSION_TERMS_INLINE: 'Zorblax\nacme-secret' };
    const made = await withInlineTerms(env, storeDir);
    const file = inlineTermsFile(storeDir);
    expect(made.OARS_EXCLUSION_TERMS).toBe(file);
    expect(made.OARS_HOST_CLASS).toBe('cloud');
    expect(readFileSync(file, 'utf8')).toBe('Zorblax\nacme-secret\n');
    expect(await loadTerms(file)).toEqual(['zorblax', 'acme-secret']);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('does not change the environment it was given', async () => {
    const env = { OARS_EXCLUSION_TERMS_INLINE: 'zorblax' };
    await withInlineTerms(env, store());
    expect(env).toEqual({ OARS_EXCLUSION_TERMS_INLINE: 'zorblax' });
  });

  it('rewrites the file with the current terms at every Stop', async () => {
    const storeDir = store();
    await withInlineTerms({ OARS_EXCLUSION_TERMS_INLINE: 'first' }, storeDir);
    await withInlineTerms({ OARS_EXCLUSION_TERMS_INLINE: 'second\n' }, storeDir);
    expect(readFileSync(inlineTermsFile(storeDir), 'utf8')).toBe('second\n');
  });

  it('replaces the file by a rename, so a reader never sees it empty, and leaves no staging file', async () => {
    const storeDir = store();
    await withInlineTerms({ OARS_EXCLUSION_TERMS_INLINE: 'first' }, storeDir);
    const before = statSync(inlineTermsFile(storeDir), { bigint: true }).ino;
    await withInlineTerms({ OARS_EXCLUSION_TERMS_INLINE: 'second' }, storeDir);
    expect(statSync(inlineTermsFile(storeDir), { bigint: true }).ino).not.toBe(before);
    expect(readdirSync(storeDir).filter((name) => name.startsWith('exclusion-terms-inline.txt'))).toEqual(['exclusion-terms-inline.txt']);
  });

  it('wins over a file named by OARS_EXCLUSION_TERMS, since the enrollment is where the operator stated the terms', async () => {
    const storeDir = store();
    const made = await withInlineTerms({ OARS_EXCLUSION_TERMS: '/elsewhere/terms.txt', OARS_EXCLUSION_TERMS_INLINE: 'zorblax' }, storeDir);
    expect(made.OARS_EXCLUSION_TERMS).toBe(inlineTermsFile(storeDir));
  });

  it.each([[undefined], [''], ['  \n ']])('leaves the environment as it is with no inline terms (%j), and writes no file', async (inline) => {
    const storeDir = store();
    const env = { OARS_EXCLUSION_TERMS: '/elsewhere/terms.txt', ...(inline === undefined ? {} : { OARS_EXCLUSION_TERMS_INLINE: inline }) };
    expect(await withInlineTerms(env, storeDir)).toBe(env);
    expect(existsSync(inlineTermsFile(storeDir))).toBe(false);
  });
});
