import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { anyNumber, anyText, containing, fieldOf, matching, startPool, stubUser, TEST_GOOGLE_SECRET, textOf, wranglerConfig, type TestPool } from './test-pool.js';
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

const { parsed } = wranglerConfig();
const vars = fieldOf(parsed, 'vars');
const GITHUB_ID = textOf(vars, 'GITHUB_CLIENT_ID');
const GOOGLE_ID = textOf(vars, 'GOOGLE_CLIENT_ID');

const FLOWS = [
  { provider: 'github', clientId: GITHUB_ID, deviceUrl: 'https://github.com/login/device/code', tokenUrl: 'https://github.com/login/oauth/access_token', userUrl: 'https://api.github.com/user', link: 'https://github.com/login/device', scope: '' },
  { provider: 'google', clientId: GOOGLE_ID, deviceUrl: 'https://oauth2.googleapis.com/device/code', tokenUrl: 'https://oauth2.googleapis.com/token', userUrl: 'https://openidconnect.googleapis.com/v1/userinfo', link: 'https://www.google.com/device', scope: 'openid' },
];

/** The device code a start put behind a handle, as the stub named it: `USER-n` is for `device-n`. */
const deviceOf = (userCode: string): string => `device-${/USER-(\d+)/.exec(userCode)?.[1] ?? ''}`;

const startOf = async (provider: string, target: TestPool = pool): Promise<{ handle: string; userCode: string; device: string }> => {
  const started = await target.post('/v1/login/start', { provider });
  expect(started.status).toBe(200);
  const userCode = textOf(started.json, 'userCode');
  return { handle: textOf(started.json, 'handle'), userCode, device: deviceOf(userCode) };
};

/** The handle with one bit of one byte flipped: `where` picks the nonce (front), the ciphertext (middle), or the tag (end). A bit of the bytes and not a character of the text, since the last base64url character can carry unused bits. */
const altered = (handle: string, where: 'front' | 'middle' | 'end'): string => {
  const bytes = Buffer.from(handle, 'base64url');
  const at = where === 'front' ? 0 : where === 'middle' ? Math.floor(bytes.length / 2) : bytes.length - 1;
  bytes[at] = (bytes[at] ?? 0) ^ 1;
  return bytes.toString('base64url');
};

describe.each(FLOWS)('the $provider brokered sign-in', ({ provider, clientId, deviceUrl, tokenUrl, userUrl, link, scope }) => {
  it("starts the provider's device flow with the pool's own client ID, and answers the code, the link, and an opaque handle", async () => {
    const before = pool.stub.calls.length;
    const started = await pool.post('/v1/login/start', { provider });
    expect(started.status).toBe(200);
    expect(started.json).toEqual({ handle: anyText(), userCode: matching(/^USER-\d+$/), verificationUrl: link, interval: 1, expiresIn: 900 });
    const calls = pool.stub.calls.slice(before);
    expect(calls).toEqual([{ url: deviceUrl, body: new URLSearchParams([['client_id', clientId], ['scope', scope]]).toString() }]);
    // The client never sees the provider's device code: not in the clear, and not under the base64 the handle is written in.
    const handle = textOf(started.json, 'handle');
    expect(handle).not.toContain('device-');
    expect(Buffer.from(handle, 'base64url').toString('latin1')).not.toContain('device-');
  });

  it('answers pending until the person approves, then reads the person with the token it received and answers the pool credential', async () => {
    const { handle, device } = await startOf(provider);
    expect(await pool.post('/v1/login/poll', { handle })).toEqual({ status: 200, json: { status: 'pending' } });
    pool.stub.approve(device, stubUser('101'));
    const before = pool.stub.calls.length;
    const signedIn = await pool.post('/v1/login/poll', { handle });
    expect(signedIn.status).toBe(200);
    expect(signedIn.json).toMatchObject({ status: 'authorized', token: anyText(), account: matching(/^acct_[0-9a-f]{32}$/), expiresAt: anyNumber() });
    // Exactly the public half: a matcher on the whole answer would still pass if the private `d` came along.
    expect(fieldOf(signedIn.json, 'signingKey')).toEqual(pool.signingKey());
    // The provider's access token is not in the answer, and the pool reached its token route with its own client ID before it read the person.
    expect(JSON.stringify(signedIn.json)).not.toContain(`access-${device}`);
    const calls = pool.stub.calls.slice(before);
    expect(calls.map((call) => call.url)).toEqual([tokenUrl, userUrl]);
    const form = new URLSearchParams(calls[0]?.body);
    expect(form.get('client_id')).toBe(clientId);
    expect(form.get('device_code')).toBe(device);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    // Only Google's token route takes the secret; GitHub's device flow takes none.
    expect(form.get('client_secret')).toBe(provider === 'google' ? TEST_GOOGLE_SECRET : null);
    expect(calls[1]?.body).toBe('');
  });

  it.each([
    ['slow_down', 'slow_down'],
    ['expired_token', 'expired'],
    ['access_denied', 'denied'],
  ])('maps the provider\'s %s to %s', async (word, status) => {
    const { handle, device } = await startOf(provider);
    pool.stub.script(device, word);
    expect(await pool.post('/v1/login/poll', { handle })).toEqual({ status: 200, json: { status } });
  });

  it('reads a code the provider has forgotten as expired', async () => {
    const { handle, device } = await startOf(provider);
    pool.stub.script(device, 'expired_token');
    expect(fieldOf((await pool.post('/v1/login/poll', { handle })).json, 'status')).toBe('expired');
  });

  it('keeps one pseudonym across sign-ins, and a new credential each time', async () => {
    const first = await pool.signIn(provider, stubUser('202'));
    const second = await pool.signIn(provider, stubUser('202'));
    expect(second.account).toBe(first.account);
    expect(second.token).not.toBe(first.token);
    expect((await pool.signIn(provider, stubUser('203'))).account).not.toBe(first.account);
  });

  it('turns away a handle that was altered anywhere, in the nonce, the ciphertext, or the tag', async () => {
    const { handle, device } = await startOf(provider);
    pool.stub.approve(device, stubUser('301'));
    const before = pool.stub.calls.length;
    for (const where of ['front', 'middle', 'end'] as const) expect(await pool.post('/v1/login/poll', { handle: altered(handle, where) }), where).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
    expect(await pool.post('/v1/login/poll', { handle: handle.slice(0, 10) })).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
    expect(await pool.post('/v1/login/poll', { handle: 'not a handle!' })).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
    // Nothing reached the provider for any of them.
    expect(pool.stub.calls.length).toBe(before);
  });

  it('turns away a handle another Worker sealed, and one a client forged from a device code', async () => {
    const other = await startPool({ PSEUDONYM_KEY: 'another-workers-pseudonym-key' });
    try {
      const foreign = await startOf(provider, other);
      expect(await pool.post('/v1/login/poll', { handle: foreign.handle })).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
      const forged = Buffer.from(JSON.stringify({ provider, deviceCode: 'device-1', expiresAt: Date.now() + 60_000 })).toString('base64url');
      expect(await pool.post('/v1/login/poll', { handle: forged })).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
    } finally {
      await other.dispose();
    }
  }, 60_000);

  it('is a named provider_error when the provider answers HTML at the device route, the token route, or the profile route', async () => {
    pool.stub.html.add(deviceUrl);
    try {
      expect(await pool.post('/v1/login/start', { provider })).toMatchObject({ status: 502, json: { error: 'provider_error' } });
    } finally {
      pool.stub.html.clear();
    }
    const { handle, device } = await startOf(provider);
    pool.stub.approve(device, stubUser('401'));
    for (const url of [tokenUrl, userUrl]) {
      pool.stub.html.add(url);
      try {
        expect(await pool.post('/v1/login/poll', { handle }), url).toMatchObject({ status: 502, json: { error: 'provider_error' } });
      } finally {
        pool.stub.html.clear();
      }
    }
  });

  // GitHub answers a call over its rate limit with 403, so the token may be fine: this is the provider's trouble, not a refused sign-in.
  it('is a named provider_error, not login_refused, when the profile read answers 403', async () => {
    const { handle, device } = await startOf(provider);
    pool.stub.approve(device, stubUser('402'));
    pool.stub.forbidden.add(userUrl);
    try {
      expect(await pool.post('/v1/login/poll', { handle })).toMatchObject({ status: 502, json: { error: 'provider_error' } });
    } finally {
      pool.stub.forbidden.clear();
    }
  });

  it("is a named provider_error carrying the provider's word when it refuses to start a flow, or answers a word the pool does not know", async () => {
    pool.stub.refuse.set(deviceUrl, 'device_flow_disabled');
    try {
      expect(await pool.post('/v1/login/start', { provider })).toMatchObject({ status: 502, json: { error: 'provider_error', message: containing('device_flow_disabled') } });
    } finally {
      pool.stub.refuse.clear();
    }
    const { handle, device } = await startOf(provider);
    pool.stub.script(device, 'incorrect_client_credentials');
    expect(await pool.post('/v1/login/poll', { handle })).toMatchObject({ status: 502, json: { error: 'provider_error', message: containing('incorrect_client_credentials') } });
  });
});

describe('a start that cannot go on', () => {
  it('names an unknown provider, and a body that is not JSON', async () => {
    expect(await pool.post('/v1/login/start', { provider: 'acme' })).toMatchObject({ status: 400, json: { error: 'unknown_provider', field: 'provider' } });
    expect(await pool.post('/v1/login/start', 'not json')).toMatchObject({ status: 400, json: { error: 'unknown_provider', field: 'provider' } });
  });

  it.each([
    ['github', 'GITHUB_CLIENT_ID', { GITHUB_CLIENT_ID: '' }],
    ['google', 'GOOGLE_CLIENT_ID', { GOOGLE_CLIENT_ID: '' }],
    ['google', 'GOOGLE_CLIENT_SECRET', { GOOGLE_CLIENT_SECRET: '' }],
    ['github', 'PSEUDONYM_KEY', { PSEUDONYM_KEY: '' }],
  ])('refuses %s with 503 not_configured naming %s, and calls nobody', async (provider, binding, bindings) => {
    const bare = await startPool(bindings);
    try {
      expect(await bare.post('/v1/login/start', { provider })).toMatchObject({ status: 503, json: { error: 'not_configured', message: containing(binding) } });
      expect(bare.stub.calls).toEqual([]);
    } finally {
      await bare.dispose();
    }
  }, 60_000);

  it('does not need the other provider\'s settings: GitHub starts with no Google client ID or secret', async () => {
    const bare = await startPool({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' });
    try {
      expect((await bare.post('/v1/login/start', { provider: 'github' })).status).toBe(200);
    } finally {
      await bare.dispose();
    }
  }, 60_000);
});

describe('a poll that cannot go on', () => {
  it('names a missing handle, and a body that is not JSON', async () => {
    expect(await pool.post('/v1/login/poll', {})).toMatchObject({ status: 400, json: { error: 'missing_field', field: 'handle' } });
    expect(await pool.post('/v1/login/poll', 'not json')).toMatchObject({ status: 400, json: { error: 'missing_field', field: 'handle' } });
  });
});

describe('the pseudonym', () => {
  it('differs across providers for one provider id, and no row holds an email, a login, a provider id, the provider token, a device code, or the handle', async () => {
    const user = stubUser('987654321');
    const github = await pool.signIn('github', user);
    const { handle, device } = await startOf('google');
    pool.stub.approve(device, user);
    const google = await pool.post('/v1/login/poll', { handle });
    expect(github.account).not.toBe(fieldOf(google.json, 'account'));
    const stored = await everyRow();
    expect(stored).toContain(github.account);
    for (const held of [user.id, user.login, user.email, `access-${device}`, device, handle, github.token, String(fieldOf(google.json, 'token'))]) expect(stored).not.toContain(held);
  });
});

describe('the old token route', () => {
  it('is gone: it answers 410 naming the two routes, and reads nothing the client sends', async () => {
    const before = pool.stub.calls.length;
    const gone = await pool.post('/v1/login', { provider: 'github', token: 'a-token-another-app-holds' });
    expect(gone).toMatchObject({ status: 410, json: { error: 'gone', message: containing('/v1/login/start') } });
    expect(fieldOf(gone.json, 'message')).toEqual(containing('/v1/login/poll'));
    expect(pool.stub.calls.length).toBe(before);
    expect((await pool.post('/v1/login', 'not json')).status).toBe(410);
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

// Outside the runtime, where the clock and a stand-in fetch can be set.
describe.each(['github', 'google'])('%s with the Worker\'s clock and network set by the test', (provider) => {
  const db = { prepare: () => ({ bind: () => ({ first: () => Promise.resolve(null), all: () => Promise.resolve({ results: [] }), run: () => Promise.resolve({ meta: { changes: 1 } }) }) }), batch: () => Promise.resolve([]) };
  const env = { DB: db, PSEUDONYM_KEY: 'k', BUNDLE_SIGNING_KEY: '{}', GITHUB_CLIENT_ID: 'gh', GOOGLE_CLIENT_ID: 'goog', GOOGLE_CLIENT_SECRET: 'sekret' };
  const post = (path: string, body: object, over: object = {}): Promise<Response> => worker.fetch(new Request(`http://pool.test${path}`, { method: 'POST', body: JSON.stringify(body) }), { ...env, ...over });
  const device = (): Response => Response.json({ device_code: 'dc-1', user_code: 'ABCD-EFGH', verification_uri: 'https://example.test/device', expires_in: 600, interval: 5 });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('answers expired for a handle past its expiry, without calling the provider', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const fetcher = vi.fn(() => Promise.resolve(device()));
    vi.stubGlobal('fetch', fetcher);
    const handle = textOf(await (await post('/v1/login/start', { provider })).json(), 'handle');
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The handle holds for the 600 seconds the provider gave, to the millisecond.
    vi.setSystemTime(new Date('2030-01-01T00:09:59Z'));
    fetcher.mockImplementation(() => Promise.resolve(Response.json({ error: 'authorization_pending' })));
    expect(await (await post('/v1/login/poll', { handle })).json()).toEqual({ status: 'pending' });
    vi.setSystemTime(new Date('2030-01-01T00:10:00Z'));
    expect(await (await post('/v1/login/poll', { handle })).json()).toEqual({ status: 'expired' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('is a named provider_error when the provider is out of reach, at the start and at the poll', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network down')));
    const started = await post('/v1/login/start', { provider });
    expect(started.status).toBe(502);
    expect(await started.json()).toMatchObject({ error: 'provider_error' });
    vi.stubGlobal('fetch', () => Promise.resolve(device()));
    const handle = textOf(await (await post('/v1/login/start', { provider })).json(), 'handle');
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('network down')));
    const polled = await post('/v1/login/poll', { handle });
    expect(polled.status).toBe(502);
    expect(await polled.json()).toMatchObject({ error: 'provider_error' });
  });

  it('is a named provider_error for a provider answer that is no sign-in: a device code with no link, a poll with no body, a token with no person', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ device_code: 'dc-1', user_code: 'ABCD-EFGH' })));
    expect(await post('/v1/login/start', { provider })).toMatchObject({ status: 502 });
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ device_code: 'dc-1', user_code: 'ABCD-EFGH', verification_uri: 'not a link' })));
    expect(await post('/v1/login/start', { provider })).toMatchObject({ status: 502 });
    vi.stubGlobal('fetch', () => Promise.resolve(device()));
    const handle = textOf(await (await post('/v1/login/start', { provider })).json(), 'handle');
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('', { status: 200 })));
    expect(await post('/v1/login/poll', { handle })).toMatchObject({ status: 502 });
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ token_type: 'bearer' })));
    expect(await post('/v1/login/poll', { handle })).toMatchObject({ status: 502 });
    // A token the profile read turns away, and one whose profile names nobody.
    vi.stubGlobal('fetch', (url: string) => Promise.resolve(url.includes('token') ? Response.json({ access_token: 'a' }) : Response.json({ message: 'Bad credentials' }, { status: 401 })));
    expect(await post('/v1/login/poll', { handle })).toMatchObject({ status: 401 });
    vi.stubGlobal('fetch', (url: string) => Promise.resolve(url.includes('token') ? Response.json({ access_token: 'a' }) : Response.json({})));
    expect(await post('/v1/login/poll', { handle })).toMatchObject({ status: 502 });
  });

  it('defaults an interval or expiry the provider leaves out or gives as no wait', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ device_code: 'dc', user_code: 'U', verification_url: 'https://example.test/device', interval: 0, expires_in: -1 })));
    expect(await (await post('/v1/login/start', { provider })).json()).toMatchObject({ interval: 5, expiresIn: 900 });
  });

  it('refuses a poll with 503 and calls nobody when the provider\'s settings, or a key, are gone since the handle was sealed', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(device()));
    const handle = textOf(await (await post('/v1/login/start', { provider })).json(), 'handle');
    const fetcher = vi.fn(() => Promise.resolve(Response.json({ error: 'authorization_pending' })));
    vi.stubGlobal('fetch', fetcher);
    const gone = provider === 'github' ? { GITHUB_CLIENT_ID: '' } : { GOOGLE_CLIENT_SECRET: '' };
    expect(await post('/v1/login/poll', { handle }, gone)).toMatchObject({ status: 503 });
    expect(await post('/v1/login/poll', { handle }, { BUNDLE_SIGNING_KEY: '' })).toMatchObject({ status: 503 });
    expect(await post('/v1/login/poll', { handle }, { PSEUDONYM_KEY: '' })).toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
