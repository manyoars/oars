import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { anyNumber, anyText, containing, fieldOf, matching, startPool, stubUser, type TestPool } from './test-pool.js';
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
  ['github', 'https://api.github.com/user'],
  ['google', 'https://openidconnect.googleapis.com/v1/userinfo'],
])('the %s sign-in', (provider, userUrl) => {
  it("reads the subject with the provider's token, and answers the pool's credential and the public half of the signing key", async () => {
    const token = pool.stub.issue(stubUser('101'));
    const signedIn = await pool.post('/v1/login', { provider, token });
    expect(signedIn.status).toBe(200);
    expect(signedIn.json).toMatchObject({ token: anyText(), account: matching(/^acct_[0-9a-f]{32}$/), expiresAt: anyNumber() });
    expect(fieldOf(signedIn.json, 'token')).not.toBe(token);
    // Exactly the public half: a matcher on the whole answer would still pass if the private `d` came along.
    expect(fieldOf(signedIn.json, 'signingKey')).toEqual(pool.signingKey());
    expect(pool.stub.calls.at(-1)?.url).toBe(userUrl);
  });

  it('keeps one pseudonym across sign-ins, and a new credential each time', async () => {
    const first = await pool.signIn(provider, stubUser('202'));
    const second = await pool.signIn(provider, stubUser('202'));
    expect(second.account).toBe(first.account);
    expect(second.token).not.toBe(first.token);
    expect((await pool.signIn(provider, stubUser('203'))).account).not.toBe(first.account);
  });

  it('turns away a token the provider does not know', async () => {
    expect(await pool.post('/v1/login', { provider, token: 'access-never-issued' })).toMatchObject({ status: 401, json: { error: 'login_refused' } });
  });
});

describe('the pseudonym', () => {
  it('differs across providers for one provider id, and no row holds an email, a login, a provider id, or the provider token', async () => {
    const user = stubUser('987654321');
    const accessToken = pool.stub.issue(user);
    const github = await pool.post('/v1/login', { provider: 'github', token: accessToken });
    const google = await pool.signIn('google', user);
    expect(fieldOf(github.json, 'account')).not.toBe(google.account);
    const stored = await everyRow();
    expect(stored).toContain(String(fieldOf(github.json, 'account')));
    for (const held of [user.id, user.login, user.email, accessToken, 'access-device', String(fieldOf(github.json, 'token'))]) expect(stored).not.toContain(held);
  });

  it('sends the provider no client id and no secret: the pool holds none', () => {
    for (const call of pool.stub.calls) expect(call.body).toBe('');
  });
});

describe('sign-in rows', () => {
  it('sheds the credentials past their expiry at a login, and keeps the live ones', async () => {
    const db = await pool.db();
    await db.prepare('INSERT INTO accounts (id) VALUES (?) ON CONFLICT (id) DO NOTHING').bind('acct_old').run();
    await db.prepare('INSERT INTO tokens (hash, account, expires_at) VALUES (?, ?, ?)').bind('stale-hash', 'acct_old', 1).run();
    await db.prepare('INSERT INTO tokens (hash, account, expires_at) VALUES (?, ?, ?)').bind('live-hash', 'acct_old', Date.now() + 60_000).run();
    await pool.signIn('github', stubUser('404'));
    expect(await db.prepare("SELECT COUNT(*) AS count FROM tokens WHERE hash = 'stale-hash'").first('count')).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM tokens WHERE hash = 'live-hash'").first('count')).toBe(1);
  });
});

describe('a login request that cannot go on', () => {
  it('names an unknown provider, a body that is not JSON, and a missing token', async () => {
    expect(await pool.post('/v1/login', { provider: 'acme', token: 't' })).toMatchObject({ status: 400, json: { error: 'unknown_provider', field: 'provider' } });
    expect(await pool.post('/v1/login', 'not json')).toMatchObject({ status: 400, json: { error: 'unknown_provider', field: 'provider' } });
    expect(await pool.post('/v1/login', { provider: 'github' })).toMatchObject({ status: 400, json: { error: 'missing_field', field: 'token' } });
  });

  it('has no device-flow routes: the pool never calls a provider to start one', async () => {
    for (const path of ['/v1/login/start', '/v1/login/poll']) expect(await pool.post(path, { provider: 'github' })).toMatchObject({ status: 404, json: { error: 'not_found' } });
  });

  it.each([
    ['PSEUDONYM_KEY', { PSEUDONYM_KEY: '' }],
    ['SLICE_SIGNING_KEY', { SLICE_SIGNING_KEY: '' }],
  ])('says so when %s is not bound', async (binding, bindings) => {
    const bare = await startPool(bindings);
    try {
      expect(await bare.post('/v1/login', { provider: 'github', token: bare.stub.issue(stubUser('1')) })).toMatchObject({ status: 503, json: { error: 'not_configured', message: containing(binding) } });
    } finally {
      await bare.dispose();
    }
  }, 60_000);
});

describe.each([
  { provider: 'github', userUrl: 'https://api.github.com/user' },
  { provider: 'google', userUrl: 'https://openidconnect.googleapis.com/v1/userinfo' },
])('$provider answering HTML', ({ provider, userUrl }) => {
  it('is a named provider_error when reading the profile', async () => {
    const token = pool.stub.issue(stubUser('301'));
    pool.stub.html.add(userUrl);
    try {
      expect(await pool.post('/v1/login', { provider, token })).toMatchObject({ status: 502, json: { error: 'provider_error' } });
    } finally {
      pool.stub.html.clear();
    }
  });
});

describe.each(['github', 'google'])('%s out of reach', (provider) => {
  // Outside the runtime, where a stand-in fetch can reject the way a network failure does.
  const db = { prepare: () => ({ bind: () => ({ first: () => Promise.resolve(null), all: () => Promise.resolve({ results: [] }), run: () => Promise.resolve({ meta: { changes: 1 } }) }) }) };
  const env = { DB: db, PSEUDONYM_KEY: 'k', SLICE_SIGNING_KEY: '{}' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a named provider_error when reading the profile', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network down')));
    const response = await worker.fetch(new Request('http://pool.test/v1/login', { method: 'POST', body: JSON.stringify({ provider, token: 'a-provider-token' }) }), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'provider_error' });
  });
});
