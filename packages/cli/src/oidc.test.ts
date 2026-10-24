import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { CliError, ExitCode } from './errors.js';
import { discover } from './oidc.js';
import { server, useServer } from './test-support.js';

useServer();

const context = { version: '9.9.9', step: 'login' };

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
