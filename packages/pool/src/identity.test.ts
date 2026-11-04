import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { anyNumber, anyText, containing, fieldOf, matching, startPool, stubUser, type TestPool, textOf } from './test-pool.js';
import worker from './worker.js';

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
    expect(started.json).toMatchObject({ userCode: matching(/^USER-/), verificationUri: matching(/^https:/), interval: 1, expiresIn: 900 });
    expect(pool.stub.calls.at(-1)?.body).toContain(`client_id=${clientId}`);
    const deviceCode = textOf(started.json, 'deviceCode');

    expect(await pool.post('/v1/login/poll', { provider, deviceCode })).toEqual({ status: 200, json: { status: 'pending' } });
    expect(pool.stub.calls.at(-1)?.url).toBe(tokenUrl);

    pool.stub.approve(deviceCode, stubUser('101'));
    const polled = await pool.post('/v1/login/poll', { provider, deviceCode });
    expect(polled.status).toBe(200);
    expect(polled.json).toMatchObject({ status: 'ok', token: anyText(), account: matching(/^acct_[0-9a-f]{32}$/), expiresAt: anyNumber() });
    // Exactly the public half: a matcher on the whole answer would still pass if the private `d` came along.
    expect(fieldOf(polled.json, 'signingKey')).toEqual(pool.signingKey());
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
    expect(await pool.post('/v1/login/poll', { provider, deviceCode })).toMatchObject({ status: 401, json: { error: 'login_refused', message: containing('access_denied') } });
    expect(await pool.post('/v1/login/poll', { provider, deviceCode: 'gone' })).toMatchObject({ status: 401, json: { error: 'login_refused', message: containing('expired_token') } });
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
      expect(await bare.post('/v1/login/start', { provider: 'github' })).toMatchObject({ status: 503, json: { error: 'not_configured', message: containing('GITHUB_CLIENT_ID') } });
    } finally {
      await bare.dispose();
    }
  }, 60_000);
});

describe.each([
  { provider: 'github', deviceUrl: 'https://github.com/login/device/code', tokenUrl: 'https://github.com/login/oauth/access_token', userUrl: 'https://api.github.com/user' },
  { provider: 'google', deviceUrl: 'https://oauth2.googleapis.com/device/code', tokenUrl: 'https://oauth2.googleapis.com/token', userUrl: 'https://openidconnect.googleapis.com/v1/userinfo' },
])('$provider answering HTML', ({ provider, deviceUrl, tokenUrl, userUrl }) => {
  const providerError = { status: 502, json: { error: 'provider_error' } };

  const withHtmlAt = async (url: string, run: () => Promise<void>): Promise<void> => {
    pool.stub.html.add(url);
    try {
      await run();
    } finally {
      pool.stub.html.clear();
    }
  };

  it('is a named provider_error when starting a device flow', async () => {
    await withHtmlAt(deviceUrl, async () => {
      expect(await pool.post('/v1/login/start', { provider })).toMatchObject(providerError);
    });
  });

  it('is a named provider_error when polling for the token', async () => {
    const deviceCode = textOf((await pool.post('/v1/login/start', { provider })).json, 'deviceCode');
    await withHtmlAt(tokenUrl, async () => {
      expect(await pool.post('/v1/login/poll', { provider, deviceCode })).toMatchObject(providerError);
    });
  });

  it('is a named provider_error when reading the profile', async () => {
    const deviceCode = textOf((await pool.post('/v1/login/start', { provider })).json, 'deviceCode');
    pool.stub.approve(deviceCode, stubUser('301'));
    await withHtmlAt(userUrl, async () => {
      expect(await pool.post('/v1/login/poll', { provider, deviceCode })).toMatchObject(providerError);
    });
  });
});

describe.each([
  { provider: 'github', deviceUrl: 'https://github.com/login/device/code', tokenUrl: 'https://github.com/login/oauth/access_token', userUrl: 'https://api.github.com/user' },
  { provider: 'google', deviceUrl: 'https://oauth2.googleapis.com/device/code', tokenUrl: 'https://oauth2.googleapis.com/token', userUrl: 'https://openidconnect.googleapis.com/v1/userinfo' },
])('$provider out of reach', ({ provider, deviceUrl, tokenUrl, userUrl }) => {
  // Outside the runtime, where a stand-in fetch can reject the way a network failure does.
  const db = { prepare: () => ({ bind: () => ({ first: () => Promise.resolve(null), all: () => Promise.resolve({ results: [] }), run: () => Promise.resolve({ meta: { changes: 1 } }) }) }) };
  const env = { DB: db, PSEUDONYM_KEY: 'k', SLICE_SIGNING_KEY: '{}', GITHUB_CLIENT_ID: 'c', GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's' };
  const post = (path: string, body: object): Promise<Response> => worker.fetch(new Request(`http://pool.test${path}`, { method: 'POST', body: JSON.stringify(body) }), env);
  const failingAt = (url: string): void => {
    vi.stubGlobal('fetch', (input: string) => (input === url ? Promise.reject(new TypeError('network down')) : Promise.resolve(new Response(JSON.stringify({ access_token: 'an-access-token' })))));
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['starting a device flow', '/v1/login/start', deviceUrl],
    ['polling for the token', '/v1/login/poll', tokenUrl],
    ['reading the profile', '/v1/login/poll', userUrl],
  ])('is a named provider_error when %s', async (_step, path, url) => {
    failingAt(url);
    const response = await post(path, { provider, deviceCode: 'a-device-code' });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'provider_error' });
  });
});
