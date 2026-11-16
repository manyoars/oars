import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { priceDeps } from './price-deps.js';

const API_URL = 'https://api.example.test';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A temp APPDATA holding `oars/credentials.json` for `API_URL`, valid for a day. */
const loggedIn = async (accessToken: string) => {
  const appdata = await mkdtemp(join(tmpdir(), 'price-deps-'));
  roots.push(appdata);
  mkdirSync(join(appdata, 'oars'));
  const file = join(appdata, 'oars', 'credentials.json');
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  writeFileSync(file, JSON.stringify({ issuerUrl: 'https://login.example.test', apiUrl: API_URL, email: 'op@example.test', refreshToken: 'r', accessToken, expiresAt }));
  return { appdata, file };
};

describe('priceDeps', () => {
  it('reads the stored login under APPDATA', async () => {
    const { appdata, file } = await loggedIn('stored-access-token');
    expect(file.startsWith(appdata)).toBe(true);
    expect(await priceDeps({ APPDATA: appdata }, 'win32', join(appdata, 'home')).token(API_URL)).toBe('stored-access-token');
  });

  it('lets OARS_API_KEY win over the stored login', async () => {
    const { appdata } = await loggedIn('stored-access-token');
    expect(await priceDeps({ APPDATA: appdata, OARS_API_KEY: 'key-from-env' }, 'win32', join(appdata, 'home')).token(API_URL)).toBe('key-from-env');
  });

  it('refuses with no login anywhere', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'price-deps-'));
    roots.push(empty);
    await expect(priceDeps({ APPDATA: empty }, 'win32', empty).token(API_URL)).rejects.toThrow('Not logged in');
  });
});
