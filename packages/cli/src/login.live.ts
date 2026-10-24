import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { text } from 'node:stream/consumers';
import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { run, type RunDeps } from './cli.js';
import { fileCredentialStore } from './credentials.js';
import { fileJournalStore } from './journal.js';
import { ExitCode } from './errors.js';
import { discover, refreshTokens } from './oidc.js';

// Design §6 *CLI*, live login: the real CLI against a running Keycloak holding T67's realm (the local stack's, or the throwaway
// one `just live-keycloak` starts). Playwright approves the device code on Keycloak's verification page as a realm user.
// The platform API is not part of this check, so a stub answers `POST /auth/oidc/exchange`; everything before it is live.

const ISSUER_URL = process.env.OARS_LIVE_ISSUER_URL ?? 'http://localhost:8180/realms/aor';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. The live login signs in as a user of the realm at ${ISSUER_URL}: set OARS_LIVE_USERNAME and OARS_LIVE_PASSWORD.`);
  }
  return value;
};

/** One claim of a JWT's payload, unverified (the CLI never reads it; the assertions here do). */
const claim = (jwt: string, name: string): unknown => {
  const payload: unknown = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
  return typeof payload === 'object' && payload !== null ? Reflect.get(payload, name) : undefined;
};

interface StubApi {
  url: string;
  /** The Keycloak access tokens it was asked to exchange. */
  exchanged: string[];
  close: () => Promise<void>;
}

const answerExchange = async (request: IncomingMessage, response: ServerResponse, exchanged: string[]): Promise<void> => {
  const body: unknown = request.method === 'POST' && request.url === '/auth/oidc/exchange' ? JSON.parse(await text(request)) : undefined;
  const token: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'accessToken') : undefined;
  if (typeof token !== 'string') {
    response.writeHead(404).end();
    return;
  }
  exchanged.push(token);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      accessToken: 'stub-api-access-token',
      expiresAt: '2099-01-01T00:00:00Z',
      message: 'ok',
      permissions: [],
      requires2fa: false,
      sessionId: 'live-session',
      type: 'SUCCESS',
      user: { email: String(claim(token, 'email')) },
    }),
  );
};

const startStubApi = async (): Promise<StubApi> => {
  const exchanged: string[] = [];
  const server = createServer((request, response) => {
    answerExchange(request, response, exchanged).catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The stub API has no TCP address.');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    exchanged,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
};

/** What a developer does in the browser: open the link, sign in, grant the CLI access. */
const approveDeviceCode = async (verificationUrl: string, username: string, password: string): Promise<void> => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(verificationUrl);
    await page.locator('#username').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#kc-login').click();
    // The oars-cli client has consentRequired: Keycloak asks the user to grant it access.
    await page.locator('#kc-login').click();
    await page.getByText(/device login successful/i).waitFor();
  } finally {
    await browser.close();
  }
};

interface Session {
  api: StubApi;
  configDir: string;
  username: string;
  password: string;
}

const loginThenLogout = async ({ api, configDir, username, password }: Session): Promise<void> => {
  const out: string[] = [];
  const err: string[] = [];
  let announce: (url: string) => void = () => undefined;
  const announced = new Promise<string>((resolve) => {
    announce = resolve;
  });
  const deps: RunDeps = {
    env: {},
    io: {
      stdout: (chunk) => out.push(chunk),
      stderr: (chunk) => {
        err.push(chunk);
        const url = /open (\S+)/.exec(chunk)?.[1];
        if (url !== undefined) announce(url);
      },
    },
    store: fileCredentialStore(configDir),
    journal: fileJournalStore(configDir),
    version: '0.0.0-live',
    sleep: (ms) => sleep(ms),
    random: Math.random,
    now: Date.now,
    openBrowser: () => Promise.reject(new Error('--no-browser must not open a browser')),
  };

  const login = run(['login', '--no-browser', '--json', '--issuer-url', ISSUER_URL, '--api-url', api.url], deps);
  const verificationUrl = await Promise.race([
    announced,
    login.then((code) => {
      throw new Error(`oars login exited ${String(code)} before it showed the link: ${err.join('')}${out.join('')}`);
    }),
  ]);
  await approveDeviceCode(verificationUrl, username, password);

  expect(await login, err.join('')).toBe(ExitCode.OK);
  expect(JSON.parse(out.join(''))).toEqual({ ok: true, email: username });

  // The exchange got a real Keycloak access token for this client, issued for the platform.
  const [exchanged = ''] = api.exchanged;
  expect(api.exchanged).toHaveLength(1);
  expect(claim(exchanged, 'azp')).toBe('oars-cli');
  expect(claim(exchanged, 'iss')).toBe(ISSUER_URL);
  expect(claim(exchanged, 'email')).toBe(username);
  expect(JSON.stringify(claim(exchanged, 'aud'))).toContain('aor-platform');

  const stored = await deps.store.read();
  expect(stored).toMatchObject({ issuerUrl: ISSUER_URL, apiUrl: api.url, email: username, accessToken: 'stub-api-access-token' });
  const refreshToken = stored?.refreshToken ?? '';
  expect(refreshToken).not.toBe('');

  err.length = 0;
  expect(await run(['logout', '--json'], deps), err.join('')).toBe(ExitCode.OK);
  expect(err.join('')).toBe('');
  expect(await deps.store.read()).toBeUndefined();

  // Revoked at Keycloak, not merely forgotten locally: the old refresh token is refused.
  const config = await discover(ISSUER_URL, { ...deps, step: 'live' });
  await expect(refreshTokens(config, refreshToken, 'live')).rejects.toMatchObject({ exitCode: ExitCode.AUTH });
};

describe('oars login against a live Keycloak', () => {
  it('receives tokens once the device code is approved, then logout revokes the refresh token', async () => {
    const username = required('OARS_LIVE_USERNAME');
    const password = required('OARS_LIVE_PASSWORD');
    const api = await startStubApi();
    const configDir = await mkdtemp(join(tmpdir(), 'oars-live-'));
    try {
      await loginThenLogout({ api, configDir, username, password });
    } finally {
      await api.close();
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
