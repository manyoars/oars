import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { ExitCode } from './errors.js';
import { API, deviceAuthorization, discovery, exchangeOk, harness, ISSUER, loginSuccess, server, tokenEndpoint, tokens, useServer } from './test-support.js';

useServer();

const PENDING = { error: 'authorization_pending' };
const single = (text: string[]): unknown => JSON.parse(text.join(''));

describe('oars login', () => {
  it('runs the device flow, exchanges the Keycloak token, stores the credentials and prints {ok, email}', async () => {
    const h = harness();
    const keycloak = tokenEndpoint([PENDING, tokens('1')]);
    const exchange = exchangeOk();
    server.use(discovery, deviceAuthorization(), keycloak.handler, exchange.handler);

    expect(await run(['login', '--no-browser', '--json'], h.deps)).toBe(ExitCode.OK);

    expect(single(h.out)).toEqual({ ok: true, email: 'dev@example.com' });
    expect(h.err.join('')).toContain('ABCD-EFGH');
    expect(h.err.join('')).toContain(`${ISSUER}/device?user_code=ABCD-EFGH`);
    expect(h.opened).toEqual([]);
    expect(keycloak.seen).toHaveLength(2);
    expect(keycloak.seen[1]?.get('client_id')).toBe('oars-cli');
    expect(await exchange.seen[0]?.json()).toEqual({ accessToken: 'kc-access-1' });
    expect(await h.deps.store.read()).toMatchObject({ refreshToken: 'kc-refresh-1', accessToken: 'api-access-1', email: 'dev@example.com' });
  });

  it('opens the verification page in the browser unless --no-browser, and prints human output without --json', async () => {
    const h = harness();
    server.use(discovery, deviceAuthorization(), tokenEndpoint([tokens('1')]).handler, exchangeOk().handler);
    expect(await run(['login'], h.deps)).toBe(ExitCode.OK);
    expect(h.opened).toEqual([`${ISSUER}/device?user_code=ABCD-EFGH`]);
    expect(h.out.join('')).toBe('Logged in as dev@example.com\n');
  });

  it('honors slow_down: the next poll waits five seconds longer', async () => {
    const h = harness();
    const keycloak = tokenEndpoint([{ error: 'slow_down' }, tokens('1')]);
    server.use(discovery, deviceAuthorization(), keycloak.handler, exchangeOk().handler);
    expect(await run(['login', '--no-browser'], h.deps)).toBe(ExitCode.OK);
    const [first = 0, second = 0] = keycloak.times;
    expect(second - first).toBeGreaterThanOrEqual(4900);
  }, 20_000);

  it.each([['expired_token'], ['access_denied']])('exits 3 on %s and prints the {ok:false, step, problem} document', async (error) => {
    const h = harness();
    server.use(discovery, deviceAuthorization(), tokenEndpoint([{ error }]).handler);
    expect(await run(['login', '--no-browser', '--json'], h.deps)).toBe(ExitCode.AUTH);
    expect(single(h.out)).toMatchObject({ ok: false, step: 'login', problem: { code: error.toUpperCase() } });
    expect(await h.deps.store.read()).toBeUndefined();
  });

  it('exits 3 and prints title and detail when the exchange refuses the token', async () => {
    const h = harness();
    server.use(
      discovery,
      deviceAuthorization(),
      tokenEndpoint([tokens('1')]).handler,
      http.post(`${API}/auth/oidc/exchange`, () => HttpResponse.json({ title: 'Email not verified', detail: 'Verify your email.', status: 401 }, { status: 401 })),
    );
    expect(await run(['login', '--no-browser'], h.deps)).toBe(ExitCode.AUTH);
    expect(h.out).toEqual([]);
    expect(h.err.join('')).toContain('Email not verified');
    expect(h.err.join('')).toContain('Verify your email.');
  });

  it('prints the actionUrl of a problem that carries one and exits 6', async () => {
    const h = harness();
    const problem = { title: 'Add a payment method', code: 'PAYMENT_METHOD_REQUIRED', actionUrl: 'https://app.test/pay', status: 402 };
    server.use(discovery, deviceAuthorization(), tokenEndpoint([tokens('1')]).handler, http.post(`${API}/auth/oidc/exchange`, () => HttpResponse.json(problem, { status: 402 })));
    expect(await run(['login', '--no-browser'], h.deps)).toBe(ExitCode.HUMAN);
    expect(h.err.join('')).toContain('https://app.test/pay');
  });

  it('retries the exchange on a 429 with Retry-After, then succeeds', async () => {
    const h = harness();
    let calls = 0;
    server.use(
      discovery,
      deviceAuthorization(),
      tokenEndpoint([tokens('1')]).handler,
      http.post(`${API}/auth/oidc/exchange`, () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({ title: 'Slow down', code: 'RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': '2' } });
        return HttpResponse.json(loginSuccess('1'));
      }),
    );
    expect(await run(['login', '--no-browser'], h.deps)).toBe(ExitCode.OK);
    expect(calls).toBe(2);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it('exits 7 after three retries of a 429 and 8 after three retries of a 503', async () => {
    for (const [status, exit] of [[429, ExitCode.RATE_LIMITED], [503, ExitCode.UNREACHABLE]] as const) {
      const h = harness();
      let calls = 0;
      server.use(
        discovery,
        deviceAuthorization(),
        tokenEndpoint([tokens('1')]).handler,
        http.post(`${API}/auth/oidc/exchange`, () => {
          calls += 1;
          return HttpResponse.json({ title: 'No' }, { status, headers: { 'Retry-After': '1' } });
        }),
      );
      expect(await run(['login', '--no-browser'], h.deps)).toBe(exit);
      expect(calls).toBe(4);
    }
  });

  it('exits 8 when the platform is unreachable', async () => {
    const h = harness();
    server.use(discovery, deviceAuthorization(), tokenEndpoint([tokens('1')]).handler, http.post(`${API}/auth/oidc/exchange`, () => HttpResponse.error()));
    expect(await run(['login', '--no-browser'], h.deps)).toBe(ExitCode.UNREACHABLE);
  });

  it('sends User-Agent: oars/<version> to Keycloak and the API', async () => {
    const h = harness();
    const agents: Array<string | null> = [];
    const spy = http.all('*', ({ request }) => {
      agents.push(request.headers.get('user-agent'));
      return undefined;
    });
    server.use(spy, discovery, deviceAuthorization(), tokenEndpoint([tokens('1')]).handler, exchangeOk().handler);
    await run(['login', '--no-browser'], h.deps);
    expect(agents.length).toBeGreaterThanOrEqual(4);
    expect(new Set(agents)).toEqual(new Set(['oars/9.9.9']));
  });

  it('takes --api-url and --issuer-url over the environment', async () => {
    const h = harness({ OARS_API_URL: 'https://wrong.test', OARS_ISSUER_URL: 'http://localhost:1/realms/wrong' });
    server.use(discovery, deviceAuthorization(), tokenEndpoint([tokens('1')]).handler, exchangeOk().handler);
    expect(await run(['login', '--no-browser', '--api-url', API, '--issuer-url', ISSUER], h.deps)).toBe(ExitCode.OK);
  });
});

describe('oars logout', () => {
  it('revokes the refresh token at Keycloak, deletes the credentials and prints {ok}', async () => {
    const h = harness();
    await h.deps.store.write({ issuerUrl: ISSUER, apiUrl: API, email: 'dev@example.com', refreshToken: 'kc-refresh-9', accessToken: 'a', expiresAt: '2099-01-01T00:00:00Z' });
    const forms: URLSearchParams[] = [];
    server.use(
      discovery,
      http.post(`${ISSUER}/protocol/openid-connect/revoke`, async ({ request }) => {
        forms.push(new URLSearchParams(await request.text()));
        return new HttpResponse(null, { status: 200 });
      }),
    );
    expect(await run(['logout', '--json'], h.deps)).toBe(ExitCode.OK);
    expect(single(h.out)).toEqual({ ok: true });
    expect(forms[0]?.get('token')).toBe('kc-refresh-9');
    expect(forms[0]?.get('client_id')).toBe('oars-cli');
    expect(await h.deps.store.read()).toBeUndefined();
  });

  it('still deletes the credentials when the revocation fails, and says so on stderr', async () => {
    const h = harness();
    await h.deps.store.write({ issuerUrl: ISSUER, apiUrl: API, email: 'dev@example.com', refreshToken: 'r', accessToken: 'a', expiresAt: '2099-01-01T00:00:00Z' });
    server.use(discovery, http.post(`${ISSUER}/protocol/openid-connect/revoke`, () => HttpResponse.error()));
    expect(await run(['logout'], h.deps)).toBe(ExitCode.OK);
    expect(h.err.join('')).toContain('could not be revoked');
    expect(await h.deps.store.read()).toBeUndefined();
  });

  it('is ok when nobody is logged in', async () => {
    const h = harness();
    expect(await run(['logout', '--json'], h.deps)).toBe(ExitCode.OK);
    expect(single(h.out)).toEqual({ ok: true });
  });
});

describe('usage', () => {
  it('exits 2 on an unknown command and keeps stdout empty', async () => {
    const h = harness();
    expect(await run(['frobnicate'], h.deps)).toBe(ExitCode.USAGE);
    expect(h.out).toEqual([]);
    expect(h.err.join('')).toContain('frobnicate');
  });

  it('prints the version on stdout and exits 0', async () => {
    const h = harness();
    expect(await run(['--version'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toBe('9.9.9\n');
  });
});
