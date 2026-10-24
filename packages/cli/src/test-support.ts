import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import type { RunDeps } from './cli.js';
import { fileCredentialStore } from './credentials.js';

export const ISSUER = 'http://localhost:8180/realms/aor';
export const API = 'https://api.test';
export const server = setupServer();

const configDirs: string[] = [];

/** Removes the config directories `harness()` made so far: each holds token-shaped credentials files. */
export const removeTestDirs = (): void => {
  for (const dir of configDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

/** Starts the shared msw server for one test file; an unmocked request fails the test. */
export const useServer = (): void => {
  beforeAll(() => {
    server.listen({ onUnhandledFrame: 'error' });
  });
  afterEach(() => {
    server.resetHandlers();
    removeTestDirs();
  });
  afterAll(() => {
    server.close();
  });
};

/** Keycloak's discovery document for the test realm. */
export const discovery = http.get(`${ISSUER}/.well-known/openid-configuration`, () =>
  HttpResponse.json({
    issuer: ISSUER,
    token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
    device_authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth/device`,
    revocation_endpoint: `${ISSUER}/protocol/openid-connect/revoke`,
  }),
);

// openid-client rejects an interval of 0 (RFC 8628 wants a positive one), so the polls in these tests wait 20 ms.
export const deviceAuthorization = (interval = 0.02) =>
  http.post(`${ISSUER}/protocol/openid-connect/auth/device`, () =>
    HttpResponse.json({
      device_code: 'dev-code',
      user_code: 'ABCD-EFGH',
      verification_uri: `${ISSUER}/device`,
      verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
      expires_in: 900,
      interval,
    }),
  );

export interface TokenAnswer {
  error?: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_expires_in?: number;
}

/** The token endpoint answering each request with the next answer (the last one repeats); `seen` records the form bodies. */
export const tokenEndpoint = (answers: TokenAnswer[]) => {
  const queue = [...answers];
  const seen: URLSearchParams[] = [];
  const times: number[] = [];
  const handler = http.post(`${ISSUER}/protocol/openid-connect/token`, async ({ request }) => {
    seen.push(new URLSearchParams(await request.text()));
    times.push(Date.now());
    const answer = (queue.length > 1 ? queue.shift() : queue[0]) ?? {};
    return HttpResponse.json(answer, { status: answer.error === undefined ? 200 : 400 });
  });
  return { handler, seen, times };
};

export const tokens = (suffix: string): TokenAnswer => ({
  access_token: `kc-access-${suffix}`,
  refresh_token: `kc-refresh-${suffix}`,
  token_type: 'Bearer',
  expires_in: 300,
  refresh_expires_in: 1800,
});

export const loginSuccess = (suffix: string, expiresAt = '2099-01-01T00:00:00Z') => ({
  accessToken: `api-access-${suffix}`,
  expiresAt,
  message: 'ok',
  permissions: [],
  requires2fa: false,
  sessionId: 's1',
  type: 'SUCCESS',
  user: { email: 'dev@example.com' },
});

/** The exchange endpoint accepting any token; `seen` records each request (with its body still readable). */
export const exchangeOk = (suffix = '1') => {
  const seen: Request[] = [];
  const handler = http.post(`${API}/auth/oidc/exchange`, ({ request }) => {
    seen.push(request.clone());
    return HttpResponse.json(loginSuccess(suffix));
  });
  return { handler, seen };
};

export interface Harness {
  deps: RunDeps;
  out: string[];
  err: string[];
  sleeps: number[];
  opened: string[];
  configDir: string;
}

export const harness = (env: NodeJS.ProcessEnv = {}): Harness => {
  const configDir = mkdtempSync(join(tmpdir(), 'oars-cli-test-'));
  configDirs.push(configDir);
  const out: string[] = [];
  const err: string[] = [];
  const sleeps: number[] = [];
  const opened: string[] = [];
  const deps: RunDeps = {
    env: { OARS_API_URL: API, OARS_ISSUER_URL: ISSUER, ...env },
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    store: fileCredentialStore(configDir),
    version: '9.9.9',
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
    now: () => Date.parse('2026-10-23T00:00:00Z'),
    openBrowser: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
  };
  return { deps, out, err, sleeps, opened, configDir };
};
