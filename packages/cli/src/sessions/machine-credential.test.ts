// The credential adapter: a cloud machine's pool credential is the proxy's (the child sends no Authorization header), any other class reads the owner-only key file, else the enrollment's token file.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialOf, keyFile, tokenFile } from './machine-credential.js';

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const store = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-credential-'));
  made.push(folder);
  return folder;
};

describe('credentialOf', () => {
  it('is the proxy for a cloud machine, whatever files the store holds', async () => {
    const dir = store();
    writeFileSync(keyFile(dir), 'key-in-file\n');
    expect(await credentialOf('cloud', {}, dir)).toEqual({ source: 'proxy' });
  });

  it.each(['vps', 'ci'] as const)('reads the key file first for a %s machine', async (hostClass) => {
    const dir = store();
    writeFileSync(keyFile(dir), 'the-key\n');
    writeFileSync(tokenFile({}, dir), 'the-token\n');
    expect(await credentialOf(hostClass, {}, dir)).toEqual({ source: 'key', token: 'the-key' });
  });

  it('falls back to the enrollment token file, in the store or where OARS_MACHINE_TOKEN_FILE names it', async () => {
    const dir = store();
    writeFileSync(tokenFile({}, dir), 'the-token\n');
    expect(await credentialOf('vps', {}, dir)).toEqual({ source: 'token', token: 'the-token' });
    const elsewhere = join(store(), 'secret');
    writeFileSync(elsewhere, 'other-token');
    expect(await credentialOf('vps', { OARS_MACHINE_TOKEN_FILE: elsewhere }, store())).toEqual({ source: 'token', token: 'other-token' });
  });

  it('is undefined when neither file exists or the file is empty', async () => {
    const dir = store();
    expect(await credentialOf('vps', {}, dir)).toBeUndefined();
    writeFileSync(keyFile(dir), '  \n');
    expect(await credentialOf('vps', {}, dir)).toBeUndefined();
  });
});
