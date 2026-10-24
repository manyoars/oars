import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileCredentialStore, type StoredCredentials } from './credentials.js';
import { harness } from './test-support.js';

const creds: StoredCredentials = {
  issuerUrl: 'http://localhost:8180/realms/aor',
  apiUrl: 'https://api.test',
  email: 'dev@example.com',
  refreshToken: 'r1',
  accessToken: 'a1',
  expiresAt: '2099-01-01T00:00:00Z',
};

describe('fileCredentialStore', () => {
  it('round-trips credentials under <dir>/oars/credentials.json and deletes them', async () => {
    const store = fileCredentialStore(harness().configDir);
    expect(await store.read()).toBeUndefined();
    await store.write(creds);
    expect(await store.read()).toEqual(creds);
    await store.delete();
    expect(await store.read()).toBeUndefined();
    await store.delete();
  });

  it.skipIf(process.platform === 'win32')('creates the file owner-only (mode 0600)', async () => {
    const { configDir } = harness();
    await fileCredentialStore(configDir).write(creds);
    expect(statSync(join(configDir, 'oars', 'credentials.json')).mode & 0o777).toBe(0o600);
  });

  it('replaces the file atomically: no temp file stays, and a failed write keeps the old file', async () => {
    const { configDir } = harness();
    const store = fileCredentialStore(configDir);
    await store.write(creds);
    await store.write({ ...creds, refreshToken: 'r2' });
    expect(readdirSync(join(configDir, 'oars'))).toEqual(['credentials.json']);

    const blocked = harness().configDir;
    mkdirSync(join(blocked, 'oars', 'credentials.json'), { recursive: true });
    await expect(fileCredentialStore(blocked).write(creds)).rejects.toThrow();
    expect(readdirSync(join(blocked, 'oars'))).toEqual(['credentials.json']);
    expect((await store.read())?.refreshToken).toBe('r2');
  });

  it('treats a malformed file as not logged in', async () => {
    const { configDir } = harness();
    mkdirSync(join(configDir, 'oars'));
    writeFileSync(join(configDir, 'oars', 'credentials.json'), '{"refreshToken": 3}');
    expect(await fileCredentialStore(configDir).read()).toBeUndefined();
  });
});
