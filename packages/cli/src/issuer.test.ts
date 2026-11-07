import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { ExitCode } from './errors.js';
import { PRODUCTION_ISSUER_URL } from './issuer.js';
import { API, deviceAuthorization, discovery, exchangeOk, harness, ISSUER, server, tokenEndpoint, tokens, useServer } from './test-support.js';

useServer();

/** The file the retired launch switch read. Nothing reads it now; a request for it would be a regression. */
const LAUNCH_FILE_URL = 'https://manyoars.com/.well-known/oars.json';
const UNAVAILABLE = 'Cannot reach Many Oars sign-in at login.manyoars.com (Many Oars and its pool at pool.manyoars.com may not be deployed yet). Pass --issuer-url or set OARS_ISSUER_URL to use another issuer.';
const single = (text: string[]): unknown => JSON.parse(text.join(''));

/** Answers the retired launch file as launched=false and counts the requests, so a test can prove a login never asked and is not held by it. */
const countFlagCalls = () => {
  const calls = { count: 0 };
  server.use(
    http.get(LAUNCH_FILE_URL, () => {
      calls.count += 1;
      return HttpResponse.json({ launched: false });
    }),
  );
  return calls;
};

/** The production realm's Keycloak endpoints, so a login that resolves the built-in issuer can finish. */
const production = () => {
  const realm = PRODUCTION_ISSUER_URL;
  return [
    http.get(`${realm}/.well-known/openid-configuration`, () =>
      HttpResponse.json({
        issuer: realm,
        token_endpoint: `${realm}/protocol/openid-connect/token`,
        device_authorization_endpoint: `${realm}/protocol/openid-connect/auth/device`,
        revocation_endpoint: `${realm}/protocol/openid-connect/revoke`,
        grant_types_supported: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      }),
    ),
    http.post(`${realm}/protocol/openid-connect/auth/device`, () =>
      HttpResponse.json({ device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: `${realm}/device`, verification_uri_complete: `${realm}/device?user_code=ABCD-EFGH`, expires_in: 900, interval: 1 }),
    ),
    http.post(`${realm}/protocol/openid-connect/token`, () => HttpResponse.json(tokens('1'))),
  ];
};

describe('the issuer oars login uses', () => {
  it('is the production Keycloak realm', () => {
    expect(PRODUCTION_ISSUER_URL).toBe('https://login.manyoars.com/realms/aor');
  });

  it('is --issuer-url before OARS_ISSUER_URL, with no call to the launch file', async () => {
    const h = harness({ OARS_ISSUER_URL: 'http://localhost:1/realms/wrong' });
    const flag = countFlagCalls();
    server.use(discovery, deviceAuthorization(), tokenEndpoint([tokens('1')]).handler, exchangeOk().handler);
    expect(await run(['login', '--no-browser', '--api-url', API, '--issuer-url', ISSUER], h.deps)).toBe(ExitCode.OK);
    expect(flag.count).toBe(0);
  });

  it('is OARS_ISSUER_URL when there is no flag, with no call to the launch file', async () => {
    const h = harness();
    const flag = countFlagCalls();
    server.use(discovery, deviceAuthorization(), tokenEndpoint([tokens('1')]).handler, exchangeOk().handler);
    expect(await run(['login', '--no-browser'], h.deps)).toBe(ExitCode.OK);
    expect(flag.count).toBe(0);
  });

  it('is the production issuer when neither is set, with no launch file and no call to one', async () => {
    const h = harness({ OARS_ISSUER_URL: '' });
    const flag = countFlagCalls();
    server.use(...production(), exchangeOk().handler);
    expect(await run(['login', '--no-browser', '--json'], h.deps)).toBe(ExitCode.OK);
    expect(flag.count).toBe(0);
    expect(h.opened).toEqual([]);
    expect(await h.deps.store.read()).toMatchObject({ issuerUrl: PRODUCTION_ISSUER_URL });
  });

  const PRODUCTION_DISCOVERY = `${PRODUCTION_ISSUER_URL}/.well-known/openid-configuration`;

  it.each([
    ['the request fails', () => HttpResponse.error()],
    ['the answer is 503', () => new HttpResponse(null, { status: 503 })],
    ['the answer is 404', () => new HttpResponse(null, { status: 404 })],
    ['the answer is 500', () => new HttpResponse(null, { status: 500 })],
    ['the answer is not JSON', () => new HttpResponse('<html>maintenance</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
  ])(
    'names login.manyoars.com and exits 2 when the built-in issuer does not answer discovery (%s)',
    async (_name, answer) => {
      const h = harness({ OARS_ISSUER_URL: '' });
      server.use(http.get(PRODUCTION_DISCOVERY, answer));
      expect(await run(['login', '--no-browser', '--json'], h.deps)).toBe(ExitCode.USAGE);
      expect(single(h.out)).toMatchObject({ ok: false, step: 'usage', problem: { title: UNAVAILABLE } });
      expect(await h.deps.store.read()).toBeUndefined();
    },
  );

  it('keeps the unreachable error when the issuer came from OARS_ISSUER_URL or --issuer-url', async () => {
    server.use(http.get(`${ISSUER}/.well-known/openid-configuration`, () => HttpResponse.error()));
    const fromEnv = harness({ OARS_ISSUER_URL: ISSUER });
    expect(await run(['login', '--no-browser'], fromEnv.deps)).toBe(ExitCode.UNREACHABLE);
    const fromFlag = harness({ OARS_ISSUER_URL: '' });
    expect(await run(['login', '--no-browser', '--issuer-url', ISSUER], fromFlag.deps)).toBe(ExitCode.UNREACHABLE);
  });

  it('keeps the library error when an issuer the developer named answers discovery with 404', async () => {
    server.use(http.get(`${ISSUER}/.well-known/openid-configuration`, () => new HttpResponse(null, { status: 404 })));
    const fromEnv = harness({ OARS_ISSUER_URL: ISSUER });
    expect(await run(['login', '--no-browser'], fromEnv.deps)).toBe(ExitCode.UNEXPECTED);
    const fromFlag = harness({ OARS_ISSUER_URL: '' });
    expect(await run(['login', '--no-browser', '--issuer-url', ISSUER], fromFlag.deps)).toBe(ExitCode.UNEXPECTED);
  });

  it('prints the unavailable sentence to stderr without --json', async () => {
    const h = harness({ OARS_ISSUER_URL: '' });
    server.use(http.get(PRODUCTION_DISCOVERY, () => HttpResponse.error()));
    expect(await run(['login', '--no-browser'], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toBe(`${UNAVAILABLE}\n`);
  });
});
