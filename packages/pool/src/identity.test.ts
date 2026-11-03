import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPool, stubUser, textOf, type TestPool } from './test-pool.js';

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const everyRow = async (): Promise<string> => {
  const db = await pool.db();
  const rows: unknown[] = [];
  for (const table of ['accounts', 'tokens', 'deposits']) rows.push((await db.prepare(`SELECT * FROM ${table}`).all()).results);
  return JSON.stringify(rows);
};

describe.each([
  ['github', 'github-client', 'https://github.com/login/oauth/access_token'],
  ['google', 'google-client', 'https://oauth2.googleapis.com/token'],
])('the %s device flow', (provider, clientId, tokenUrl) => {
  it('asks the provider with the client id from the environment, is pending until approved, then signs in', async () => {
    const started = await pool.post('/v1/login/start', { provider });
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({ userCode: expect.stringMatching(/^USER-/), verificationUri: expect.stringMatching(/^https:/), interval: 1, expiresIn: 900 });
    expect(pool.stub.calls.at(-1)?.body).toContain(`client_id=${clientId}`);
    const deviceCode = textOf(started.json, 'deviceCode');

    expect(await pool.post('/v1/login/poll', { provider, deviceCode })).toEqual({ status: 200, json: { status: 'pending' } });
    expect(pool.stub.calls.at(-1)?.url).toBe(tokenUrl);

    pool.stub.approve(deviceCode, stubUser('101'));
    const polled = await pool.post('/v1/login/poll', { provider, deviceCode });
    expect(polled.status).toBe(200);
    expect(polled.json).toMatchObject({ status: 'ok', token: expect.any(String), account: expect.stringMatching(/^acct_[0-9a-f]{32}$/), expiresAt: expect.any(Number), signingKey: pool.signingKey() });
  });

  it('keeps one pseudonym across sign-ins, and a new token each time', async () => {
    const first = await pool.signIn(provider, stubUser('202'));
    const second = await pool.signIn(provider, stubUser('202'));
    expect(second.account).toBe(first.account);
    expect(second.token).not.toBe(first.token);
    expect((await pool.signIn(provider, stubUser('203'))).account).not.toBe(first.account);
  });

  it('turns away a denied sign-in and an expired one', async () => {
    const started = await pool.post('/v1/login/start', { provider });
    const deviceCode = textOf(started.json, 'deviceCode');
    pool.stub.deny(deviceCode);
    expect(await pool.post('/v1/login/poll', { provider, deviceCode })).toMatchObject({ status: 401, json: { error: 'login_refused', message: expect.stringContaining('access_denied') } });
    expect(await pool.post('/v1/login/poll', { provider, deviceCode: 'gone' })).toMatchObject({ status: 401, json: { error: 'login_refused', message: expect.stringContaining('expired_token') } });
  });
});

describe('the pseudonym', () => {
  it('differs across providers for one provider id, and no row holds an email, a login, a provider id, or a token', async () => {
    const user = stubUser('987654321');
    const github = await pool.signIn('github', user);
    const google = await pool.signIn('google', user);
    expect(github.account).not.toBe(google.account);
    const stored = await everyRow();
    expect(stored).toContain(github.account);
    for (const held of [user.id, user.login, user.email, 'access-device', github.token]) expect(stored).not.toContain(held);
  });

  it('sends a client secret to Google alone', () => {
    const google = pool.stub.calls.filter((call) => call.url === 'https://oauth2.googleapis.com/token');
    expect(google.at(-1)?.body).toContain('client_secret=google-secret');
    const github = pool.stub.calls.filter((call) => call.url === 'https://github.com/login/oauth/access_token');
    expect(github.at(-1)?.body).not.toContain('client_secret');
    expect(github.at(-1)?.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
  });
});

describe('a login request that cannot go on', () => {
  it('names an unknown provider, a body that is not JSON, and a missing device code', async () => {
    expect(await pool.post('/v1/login/start', { provider: 'acme' })).toMatchObject({ status: 400, json: { error: 'unknown_provider', field: 'provider' } });
    expect(await pool.post('/v1/login/start', 'not json')).toMatchObject({ status: 400, json: { error: 'unknown_provider', field: 'provider' } });
    expect(await pool.post('/v1/login/poll', { provider: 'github' })).toMatchObject({ status: 400, json: { error: 'missing_field', field: 'deviceCode' } });
  });

  it('says so when the provider is not configured', async () => {
    const bare = await startPool({ GITHUB_CLIENT_ID: '' });
    try {
      expect(await bare.post('/v1/login/start', { provider: 'github' })).toMatchObject({ status: 503, json: { error: 'not_configured', message: expect.stringContaining('GITHUB_CLIENT_ID') } });
    } finally {
      await bare.dispose();
    }
  }, 60_000);
});
