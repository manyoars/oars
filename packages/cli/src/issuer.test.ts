import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { ExitCode } from './errors.js';
import { LAUNCH_FLAG_URL, PRODUCTION_ISSUER_URL } from './issuer.js';
import { API, deviceAuthorization, discovery, exchangeOk, harness, ISSUER, server, tokenEndpoint, tokens, useServer } from './test-support.js';

useServer();

const NOT_LAUNCHED = 'Many Oars has not launched yet: pass --issuer-url or set OARS_ISSUER_URL.';
const single = (text: string[]): unknown => JSON.parse(text.join(''));

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
  it('is the production Keycloak realm, and the launch flag the marketing site serves', () => {
    expect(PRODUCTION_ISSUER_URL).toBe('https://login.manyoars.com/realms/aor');
    expect(LAUNCH_FLAG_URL).toBe('https://manyoars.com/.well-known/oars.json');
  });

  it('is --issuer-url before OARS_ISSUER_URL, with no call to the launch flag', async () => {
    const h = harness({ OARS_ISSUER_URL: 'http://localhost:1/realms/wrong' });
    server.use(discovery, deviceAuthorization(), tokenEndpoint([tokens('1')]).handler, exchangeOk().handler);
    expect(await run(['login', '--no-browser', '--api-url', API, '--issuer-url', ISSUER], h.deps)).toBe(ExitCode.OK);
    expect(h.opened).toEqual([]);
  });

  it('is OARS_ISSUER_URL when there is no flag, with no call to the launch flag', async () => {
    const h = harness();
    server.use(discovery, deviceAuthorization(), tokenEndpoint([tokens('1')]).handler, exchangeOk().handler);
    expect(await run(['login', '--no-browser'], h.deps)).toBe(ExitCode.OK);
  });

  it('is the production issuer when neither is set and the launch flag says launched', async () => {
    const h = harness({ OARS_ISSUER_URL: '' });
    const asked: string[] = [];
    server.use(
      http.get(LAUNCH_FLAG_URL, ({ request }) => {
        asked.push(request.headers.get('user-agent') ?? '');
        return HttpResponse.json({ launched: true });
      }),
      ...production(),
      exchangeOk().handler,
    );
    expect(await run(['login', '--no-browser', '--json'], h.deps)).toBe(ExitCode.OK);
    expect(asked).toEqual(['oars/9.9.9']);
    expect(h.opened).toEqual([]);
    expect(await h.deps.store.read()).toMatchObject({ issuerUrl: PRODUCTION_ISSUER_URL });
  });

  it('takes the issuer from the constant only: a launch flag naming another URL changes nothing', async () => {
    const h = harness({ OARS_ISSUER_URL: '' });
    server.use(http.get(LAUNCH_FLAG_URL, () => HttpResponse.json({ launched: true, issuerUrl: 'https://evil.test/realms/aor' })), ...production(), exchangeOk().handler);
    expect(await run(['login', '--no-browser'], h.deps)).toBe(ExitCode.OK);
    expect(await h.deps.store.read()).toMatchObject({ issuerUrl: PRODUCTION_ISSUER_URL });
  });

  const unlaunched: Array<[string, ReturnType<typeof http.get>]> = [
    ['launched is false', http.get(LAUNCH_FLAG_URL, () => HttpResponse.json({ launched: false }))],
    ['launched is the string "true"', http.get(LAUNCH_FLAG_URL, () => HttpResponse.json({ launched: 'true' }))],
    ['the document has no launched member', http.get(LAUNCH_FLAG_URL, () => HttpResponse.json({}))],
    ['the document is not an object', http.get(LAUNCH_FLAG_URL, () => HttpResponse.json(true))],
    ['the document is null', http.get(LAUNCH_FLAG_URL, () => HttpResponse.json(null))],
    ['the answer is 404', http.get(LAUNCH_FLAG_URL, () => HttpResponse.json({ launched: true }, { status: 404 }))],
    ['the answer is 500', http.get(LAUNCH_FLAG_URL, () => HttpResponse.json({ launched: true }, { status: 500 }))],
    ['the body is not JSON', http.get(LAUNCH_FLAG_URL, () => new HttpResponse('<html>launched</html>', { headers: { 'Content-Type': 'text/html' } }))],
    ['the request fails', http.get(LAUNCH_FLAG_URL, () => HttpResponse.error())],
    ['the answer is a redirect', http.get(LAUNCH_FLAG_URL, () => new HttpResponse(null, { status: 302, headers: { Location: 'https://evil.test/oars.json' } }))],
  ];
  it.each(unlaunched)('says Many Oars has not launched yet and exits 2 when %s', async (_name, handler) => {
    const h = harness({ OARS_ISSUER_URL: '' });
    server.use(handler);
    expect(await run(['login', '--no-browser', '--json'], h.deps)).toBe(ExitCode.USAGE);
    expect(single(h.out)).toMatchObject({ ok: false, step: 'usage', problem: { title: NOT_LAUNCHED } });
    expect(await h.deps.store.read()).toBeUndefined();
  });

  it('prints the not-launched sentence to stderr without --json', async () => {
    const h = harness({ OARS_ISSUER_URL: '' });
    server.use(http.get(LAUNCH_FLAG_URL, () => HttpResponse.json({ launched: false })));
    expect(await run(['login', '--no-browser'], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toBe(`${NOT_LAUNCHED}\n`);
  });
});
