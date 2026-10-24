import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExitCode } from './errors.js';
import { resolveAuthToken } from './session.js';
import { API, discovery, harness, ISSUER, loginSuccess, server, tokenEndpoint, tokens, useServer } from './test-support.js';
import { http, HttpResponse } from 'msw';
import type { StoredCredentials } from './credentials.js';

useServer();

const stored = (expiresAt: string): StoredCredentials => ({
  issuerUrl: ISSUER,
  apiUrl: API,
  email: 'dev@example.com',
  refreshToken: 'kc-refresh-old',
  accessToken: 'api-access-old',
  expiresAt,
});
const onDisk = (configDir: string) => readFileSync(join(configDir, 'oars', 'credentials.json'), 'utf8');

describe('resolveAuthToken', () => {
  it('OARS_API_KEY wins over a stored login and touches no network', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    await h.deps.store.write(stored('2000-01-01T00:00:00Z'));
    server.use(http.all('*', () => HttpResponse.error()));
    await expect(resolveAuthToken(h.deps)).resolves.toBe('key-123');
  });

  it('uses the stored access token while it is still valid', async () => {
    const h = harness();
    await h.deps.store.write(stored('2099-01-01T00:00:00Z'));
    server.use(http.all('*', () => HttpResponse.error()));
    await expect(resolveAuthToken(h.deps)).resolves.toBe('api-access-old');
  });

  it('refreshes an expired token: the rotated refresh token is on disk before the exchange sees the new access token', async () => {
    const h = harness();
    await h.deps.store.write(stored('2026-10-22T00:00:00Z'));
    const keycloak = tokenEndpoint([tokens('new')]);
    let diskAtExchange = '';
    server.use(
      discovery,
      keycloak.handler,
      http.post(`${API}/auth/oidc/exchange`, async ({ request }) => {
        diskAtExchange = onDisk(h.configDir);
        const body: unknown = await request.json();
        expect(body).toEqual({ accessToken: 'kc-access-new' });
        return HttpResponse.json(loginSuccess('new'));
      }),
    );
    await expect(resolveAuthToken(h.deps)).resolves.toBe('api-access-new');
    expect(keycloak.seen[0]?.get('grant_type')).toBe('refresh_token');
    expect(keycloak.seen[0]?.get('refresh_token')).toBe('kc-refresh-old');
    expect(keycloak.seen[0]?.get('client_id')).toBe('oars-cli');
    expect(diskAtExchange).toContain('kc-refresh-new');
    expect(diskAtExchange).not.toContain('kc-refresh-old');
    expect(onDisk(h.configDir)).toContain('api-access-new');
  });

  it('keeps the new refresh token even when the exchange then fails', async () => {
    const h = harness();
    await h.deps.store.write(stored('2026-10-22T00:00:00Z'));
    server.use(discovery, tokenEndpoint([tokens('new')]).handler, http.post(`${API}/auth/oidc/exchange`, () => HttpResponse.json({ title: 'Unauthorized' }, { status: 401 })));
    await expect(resolveAuthToken(h.deps)).rejects.toMatchObject({ exitCode: ExitCode.AUTH });
    expect(onDisk(h.configDir)).toContain('kc-refresh-new');
  });

  it('asks the developer to log in again when Keycloak answers invalid_grant', async () => {
    const h = harness();
    await h.deps.store.write(stored('2026-10-22T00:00:00Z'));
    server.use(discovery, tokenEndpoint([{ error: 'invalid_grant' }]).handler);
    const failure = await resolveAuthToken(h.deps).catch((error: unknown) => error);
    expect(failure).toMatchObject({ exitCode: ExitCode.AUTH });
    expect(failure instanceof Error ? failure.message : '').toContain('oars login');
  });

  it('exits 3 when there is neither an API key nor a stored login', async () => {
    await expect(resolveAuthToken(harness().deps)).rejects.toMatchObject({ exitCode: ExitCode.AUTH });
  });
});

