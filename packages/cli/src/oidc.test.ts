import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { CliError, ExitCode } from './errors.js';
import { discover, refreshTokens, revokeRefreshToken, startDeviceAuthorization } from './oidc.js';
import { deviceAuthorization, discovery, harness, ISSUER, server, useServer } from './test-support.js';

useServer();

/** The context a command passes: the run's deps (version, sleep, random) plus the step; `sleeps` records each retry wait. */
const contextOf = () => {
  const { deps, sleeps } = harness();
  return { context: { ...deps, step: 'login' }, sleeps };
};
const { context } = contextOf();

const realmAt = (issuer: string) =>
  http.get(`${issuer}/.well-known/openid-configuration`, () =>
    HttpResponse.json({ issuer, token_endpoint: `${issuer}/protocol/openid-connect/token`, device_authorization_endpoint: `${issuer}/protocol/openid-connect/auth/device` }),
  );

describe('discover', () => {
  it.each([['http://localhost:8180/realms/aor'], ['http://127.0.0.1:8180/realms/aor'], ['http://[::1]:8180/realms/aor']])(
    'accepts the plain-http issuer %s because it is on loopback',
    async (issuer) => {
      server.use(realmAt(issuer));
      const config = await discover(issuer, context);
      expect(config.serverMetadata().issuer).toBe(issuer);
    },
  );

  it('accepts an https issuer', async () => {
    const issuer = 'https://auth.example.com/realms/aor';
    server.use(realmAt(issuer));
    expect((await discover(issuer, context)).serverMetadata().issuer).toBe(issuer);
  });

  // The handlers are absent on purpose: with onUnhandledFrame 'error', any request the refusal let through would fail the test differently.
  it.each([['http://idp.example.com/realms/aor'], ['http://localhost.example.com/realms/aor'], ['http://127.0.0.1.example.com/realms/aor'], ['ftp://localhost/realms/aor']])(
    'exits 2 for %s and says the issuer must be https',
    async (issuer) => {
      const failure = await discover(issuer, context).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CliError);
      expect(failure).toMatchObject({ exitCode: ExitCode.USAGE, step: 'usage' });
      expect(failure instanceof Error ? failure.message : '').toContain('https');
    },
  );

  it('exits 2 for a value that is not a URL', async () => {
    const failure = await discover('not a url', context).catch((error: unknown) => error);
    expect(failure).toMatchObject({ exitCode: ExitCode.USAGE });
  });
});

// Design §3.2 applies to the calls to Keycloak as to the API: a network error or a 502-504 is retried, so one blip is not an exit 8.
// The token endpoint is the exception: it rotates the refresh token, so a request it may have processed is never repeated blindly.
describe('Keycloak calls retry transient failures', () => {
  const REVOKE = `${ISSUER}/protocol/openid-connect/revoke`;
  const TOKEN = `${ISSUER}/protocol/openid-connect/token`;

  it.each([
    ['a 503', () => HttpResponse.json({}, { status: 503 })],
    ['a network error', () => HttpResponse.error()],
  ])('discovery that fails once with %s succeeds on the retry', async (_name, failure) => {
    const { context: retrying, sleeps } = contextOf();
    server.use(http.get(`${ISSUER}/.well-known/openid-configuration`, failure, { once: true }), discovery);
    expect((await discover(ISSUER, retrying)).serverMetadata().issuer).toBe(ISSUER);
    expect(sleeps).toHaveLength(1);
  });

  it('exits 8 after three retries when Keycloak never answers', async () => {
    const { context: retrying, sleeps } = contextOf();
    server.use(http.get(`${ISSUER}/.well-known/openid-configuration`, () => HttpResponse.error()));
    const failure = await discover(ISSUER, retrying).catch((error: unknown) => error);
    expect(failure).toMatchObject({ exitCode: ExitCode.UNREACHABLE, step: 'login' });
    expect(sleeps).toHaveLength(3);
  });

  it('retries the device authorization POST once after a 502', async () => {
    const { context: retrying, sleeps } = contextOf();
    server.use(discovery, http.post(`${ISSUER}/protocol/openid-connect/auth/device`, () => HttpResponse.json({}, { status: 502 }), { once: true }), deviceAuthorization());
    const device = await startDeviceAuthorization(await discover(ISSUER, retrying), 'login');
    expect(device.device_code).toBe('dev-code');
    expect(sleeps).toHaveLength(1);
  });

  it('retries the revocation POST once after a 503', async () => {
    const { context: retrying, sleeps } = contextOf();
    server.use(discovery, http.post(REVOKE, () => HttpResponse.json({}, { status: 503 }), { once: true }), http.post(REVOKE, () => new HttpResponse(null, { status: 200 })));
    await revokeRefreshToken(await discover(ISSUER, retrying), 'r1', 'logout');
    expect(sleeps).toHaveLength(1);
  });

  it('never repeats a request to the token endpoint (refresh-token rotation)', async () => {
    const { context: retrying, sleeps } = contextOf();
    let requests = 0;
    server.use(
      discovery,
      http.post(TOKEN, () => {
        requests += 1;
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    await expect(refreshTokens(await discover(ISSUER, retrying), 'r1', 'api')).rejects.toBeInstanceOf(CliError);
    expect(requests).toBe(1);
    expect(sleeps).toHaveLength(0);
  });
});
