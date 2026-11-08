import { createHash } from 'node:crypto';
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

/** One poll of the pool, made due first: the pool holds the provider's interval per handle, and a poll right after a start comes early (the early poll has its own tests). */
const poll = async (handle: string, target: TestPool = pool): Promise<{ status: number; json: unknown }> => {
  await target.due(handle);
  return target.post('/v1/login/poll', { handle });
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
    expect(await poll(handle)).toEqual({ status: 200, json: { status: 'pending' } });
    pool.stub.approve(device, stubUser('101'));
    const before = pool.stub.calls.length;
    const signedIn = await poll(handle);
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
    expect(await poll(handle)).toEqual({ status: 200, json: { status } });
  });

  it('reads a code the provider has forgotten as expired', async () => {
    const { handle, device } = await startOf(provider);
    pool.stub.forget(device);
    expect(await poll(handle)).toEqual({ status: 200, json: { status: 'expired' } });
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
    for (const where of ['front', 'middle', 'end'] as const) expect(await poll(altered(handle, where)), where).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
    expect(await poll(handle.slice(0, 10))).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
    expect(await poll(handle.slice(0, 40))).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
    expect(await poll('not a handle!')).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
    // Nothing reached the provider for any of them.
    expect(pool.stub.calls.length).toBe(before);
  });

  it("answers slow_down itself to a poll that comes before the provider's interval, without calling the provider", async () => {
    const { handle, device } = await startOf(provider);
    pool.stub.approve(device, stubUser('501'));
    const before = pool.stub.calls.length;
    // No `due`: the start set the next poll one interval (1 second in the stub) out, and this comes at once.
    expect(await pool.post('/v1/login/poll', { handle })).toEqual({ status: 200, json: { status: 'slow_down' } });
    expect(await pool.post('/v1/login/poll', { handle })).toEqual({ status: 200, json: { status: 'slow_down' } });
    expect(pool.stub.calls.length).toBe(before);
    // A poll that is due reaches the provider, and an approved one signs in.
    expect(await poll(handle)).toMatchObject({ status: 200, json: { status: 'authorized' } });
    expect(pool.stub.calls.length).toBeGreaterThan(before);
  });

  it('holds the interval after a poll: the next poll is early until the interval has passed', async () => {
    const { handle } = await startOf(provider);
    expect(await poll(handle)).toEqual({ status: 200, json: { status: 'pending' } });
    const before = pool.stub.calls.length;
    expect(await pool.post('/v1/login/poll', { handle })).toEqual({ status: 200, json: { status: 'slow_down' } });
    expect(pool.stub.calls.length).toBe(before);
  });

  it("adds 5 seconds to the handle's interval when the provider says slow_down, and holds it", async () => {
    const { handle, device } = await startOf(provider);
    pool.stub.script(device, 'slow_down');
    const db = await pool.db();
    const rowOf = async (): Promise<{ interval: unknown; wait: unknown }> => {
      const row = await db.prepare('SELECT interval_sec AS interval, next_at - ? AS wait FROM login_polls WHERE handle_hash = ?').bind(Date.now(), createHash('sha256').update(handle).digest('hex')).first();
      return { interval: fieldOf(row, 'interval'), wait: fieldOf(row, 'wait') };
    };
    expect(await poll(handle)).toEqual({ status: 200, json: { status: 'slow_down' } });
    const held = await rowOf();
    expect(held.interval).toBe(6);
    // The next poll is 6 seconds out (less the little that passed), and the pool answers it itself.
    expect(Number(held.wait)).toBeGreaterThan(4_000);
    const before = pool.stub.calls.length;
    expect(await pool.post('/v1/login/poll', { handle })).toEqual({ status: 200, json: { status: 'slow_down' } });
    expect(pool.stub.calls.length).toBe(before);
  });

  it('turns away a handle the pool holds no record of, and calls nobody', async () => {
    const { handle } = await startOf(provider);
    const db = await pool.db();
    await db.prepare('DELETE FROM login_polls WHERE handle_hash = ?').bind(createHash('sha256').update(handle).digest('hex')).run();
    const before = pool.stub.calls.length;
    expect(await poll(handle)).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
    expect(pool.stub.calls.length).toBe(before);
  });

  it('binds the provider and the expiry to the handle: a swapped provider or a later expiry fails closed, with no provider call', async () => {
    const { handle, device } = await startOf(provider);
    pool.stub.approve(device, stubUser('502'));
    const bytes = Buffer.from(handle, 'base64url');
    const nameAt = 13;
    const nameLength = bytes[12] ?? 0;
    expect(bytes.subarray(nameAt, nameAt + nameLength).toString('utf8')).toBe(provider);
    // github and google are both 6 bytes, so the swap keeps the layout and only the tag can tell.
    const swapped = Buffer.from(bytes);
    Buffer.from(provider === 'github' ? 'google' : 'github').copy(swapped, nameAt);
    const later = Buffer.from(bytes);
    later.writeBigUInt64BE(later.readBigUInt64BE(nameAt + nameLength) + 3_600_000n, nameAt + nameLength);
    // Each tampered handle gets a due row of its own, so the pool's record lookup would let it through: only the seal's tag can turn it away.
    const db = await pool.db();
    for (const tampered of [swapped.toString('base64url'), later.toString('base64url')]) {
      await db.prepare('INSERT INTO login_polls (handle_hash, next_at, interval_sec, expires_at) VALUES (?, 0, 5, ?)').bind(createHash('sha256').update(tampered).digest('hex'), Date.now() + 600_000).run();
    }
    const before = pool.stub.calls.length;
    const swappedAnswer = await poll(swapped.toString('base64url'));
    expect(swappedAnswer).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
    expect(textOf(swappedAnswer.json, 'message')).toContain('did not issue');
    const laterAnswer = await poll(later.toString('base64url'));
    expect(laterAnswer).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
    expect(textOf(laterAnswer.json, 'message')).toContain('did not issue');
    expect(pool.stub.calls.length).toBe(before);
    // The handle itself is untouched and still signs in.
    expect(await poll(handle)).toMatchObject({ status: 200, json: { status: 'authorized' } });
  });

  it('turns away a handle another Worker sealed, and one a client forged from a device code', async () => {
    const other = await startPool({ PSEUDONYM_KEY: 'another-workers-pseudonym-key' });
    try {
      const foreign = await startOf(provider, other);
      expect(await poll(foreign.handle)).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
      const forged = Buffer.from(JSON.stringify({ provider, deviceCode: 'device-1', expiresAt: Date.now() + 60_000 })).toString('base64url');
      expect(await poll(forged)).toMatchObject({ status: 401, json: { error: 'invalid_handle' } });
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
        expect(await poll(handle), url).toMatchObject({ status: 502, json: { error: 'provider_error' } });
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
      expect(await poll(handle)).toMatchObject({ status: 502, json: { error: 'provider_error' } });
    } finally {
      pool.stub.forbidden.clear();
    }
  });

  // S19: a non-2xx answer whose body still names an id (a proxy, a fault, a provider error page that echoes a profile) signs nobody in, and mints no credential.
  it.each([403, 500, 503, 302])('signs nobody in when the profile read answers %i with a body that names an id', async (status) => {
    const { handle, device } = await startOf(provider);
    pool.stub.approve(device, stubUser('403'));
    pool.stub.statused.set(userUrl, status);
    const db = await pool.db();
    const before = Number(await db.prepare('SELECT COUNT(*) AS n FROM tokens').first('n'));
    try {
      expect(await poll(handle)).toMatchObject({ status: 502, json: { error: 'provider_error' } });
    } finally {
      pool.stub.statused.clear();
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tokens').first('n')).toBe(before);
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
    expect(await poll(handle)).toMatchObject({ status: 502, json: { error: 'provider_error', message: containing('incorrect_client_credentials') } });
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
    const google = await poll(handle);
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

describe('the start route per client address', () => {
  it("answers 429 with Retry-After once an address has started its hour's sign-ins, without calling the provider, and leaves another address alone", async () => {
    const capped = await startPool({ LOGIN_STARTS_PER_HOUR: '3' });
    try {
      const from = (address: string): ReturnType<TestPool['post']> => capped.post('/v1/login/start', { provider: 'github' }, undefined, { 'cf-connecting-ip': address });
      for (let started = 0; started < 3; started += 1) expect((await from('203.0.113.7')).status).toBe(200);
      const before = capped.stub.calls.length;
      expect(await from('203.0.113.7')).toMatchObject({ status: 429, json: { error: 'rate_limited' } });
      expect(capped.stub.calls.length).toBe(before);
      expect((await from('203.0.113.8')).status).toBe(200);
      const over = await capped.send('/v1/login/start', { method: 'POST', body: JSON.stringify({ provider: 'github' }) }, undefined, { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' });
      expect(over.status).toBe(429);
      expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(Number(over.headers.get('retry-after'))).toBeLessThanOrEqual(3_600);
      // The table names no address: the client is an HMAC.
      const rows = JSON.stringify((await (await capped.db()).prepare('SELECT * FROM login_starts').all()).results);
      expect(rows).not.toContain('203.0.113');
    } finally {
      await capped.dispose();
    }
  }, 60_000);

  it('counts a request with no address as one client of its own', async () => {
    const capped = await startPool({ LOGIN_STARTS_PER_HOUR: '1' });
    try {
      expect((await capped.post('/v1/login/start', { provider: 'github' })).status).toBe(200);
      expect((await capped.post('/v1/login/start', { provider: 'github' })).status).toBe(429);
    } finally {
      await capped.dispose();
    }
  }, 60_000);
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
  const db = { prepare: () => ({ bind: () => ({ first: () => Promise.resolve({ count: 1 }), all: () => Promise.resolve({ results: [] }), run: () => Promise.resolve({ meta: { changes: 1 } }) }) }), batch: () => Promise.resolve([]) };
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
  it('refuses with 503 and calls nobody when the interval store fails: a bound that opens when its store fails is no bound', async () => {
    const store = (answers: { first: unknown; changes: number }, failAt: (sql: string) => boolean = () => false): object => ({
      prepare: (sql: string) => ({
        bind: () => ({
          first: () => (failAt(sql) ? Promise.reject(new Error('d1 down')) : Promise.resolve(answers.first)),
          all: () => Promise.resolve({ results: [] }),
          run: () => (failAt(sql) ? Promise.reject(new Error('d1 down')) : Promise.resolve({ meta: { changes: answers.changes } })),
        }),
      }),
      batch: () => Promise.resolve([]),
    });
    const fine = { first: { count: 1 }, changes: 1 };
    const fetcher = vi.fn(() => Promise.resolve(device()));
    vi.stubGlobal('fetch', fetcher);
    // The count failing, and the count coming back as no number.
    expect(await post('/v1/login/start', { provider }, { DB: store(fine, (sql) => sql.includes('login_starts')) })).toMatchObject({ status: 503 });
    expect(await post('/v1/login/start', { provider }, { DB: store({ first: null, changes: 1 }) })).toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
    // The handle's row failing to write: the handle could never be polled, so none is handed out.
    expect(await post('/v1/login/start', { provider }, { DB: store(fine, (sql) => sql.includes('INSERT INTO login_polls')) })).toMatchObject({ status: 503 });
    const handle = textOf(await (await post('/v1/login/start', { provider })).json(), 'handle');
    fetcher.mockClear();
    expect(await post('/v1/login/poll', { handle }, { DB: store(fine, (sql) => sql.startsWith('UPDATE login_polls SET next_at = ? +')) })).toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
    // The provider's slow_down could not be held.
    fetcher.mockImplementation(() => Promise.resolve(Response.json({ error: 'slow_down' })));
    expect(await post('/v1/login/poll', { handle }, { DB: store(fine, (sql) => sql.includes('interval_sec = interval_sec +')) })).toMatchObject({ status: 503 });
    // A handle with no row, the store answering: start again.
    fetcher.mockClear();
    expect(await post('/v1/login/poll', { handle }, { DB: store({ first: null, changes: 0 }) })).toMatchObject({ status: 401 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
