import { webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, server, useServer, type Harness } from '../test-support.js';
import { poolServer } from './pool-command.js';
import { parseSkeleton, type PinnedKey } from './pool-wire.js';
import { deposit } from './store.js';
import { addProject, cleanup, NOW, stage, type Staged } from './test-support.js';

useServer();
afterEach(cleanup);

const POOL = 'https://pool.test';
const LATER = Date.parse('2099-01-01T00:00:00Z');
// An invented term and an invented secret: neither is real, and the secret must never reach a request.
const TERM = 'zorblax';
const HARNESS_SECRET = 'planted-harness-secret';

interface Seen {
  url: string;
  headers: string;
  body: string;
  /** What the command had printed to stderr when this request arrived. */
  err: string;
}

interface Scene {
  h: Harness;
  staged: Staged;
  seen: Seen[];
  /** Everything each request carried, to search for what must not leave. */
  sent: () => string;
  cli: (...args: string[]) => Promise<ExitCode>;
  document: () => unknown;
}

const setting = (env: NodeJS.ProcessEnv = {}): Scene => {
  const staged = stage();
  const termsFile = join(staged.root, 'terms.txt');
  writeFileSync(termsFile, `${TERM}\n`);
  const h = harness({ OARS_EXCLUSION_TERMS: termsFile, OARS_GITHUB_CLIENT_ID: 'gh-client', OARS_GOOGLE_CLIENT_ID: 'google-client', OARS_GOOGLE_CLIENT_SECRET: 'google-secret', ...env });
  h.deps.sessions = staged.runtime;
  const seen: Seen[] = [];
  return {
    h,
    staged,
    seen,
    sent: () => JSON.stringify(seen),
    cli: (...args) => run(args, h.deps),
    document: () => {
      const parsed: unknown = JSON.parse(h.out.at(-1) ?? 'null');
      return parsed;
    },
  };
};

const key = async (): Promise<{ pinned: PinnedKey; sign: (text: string) => Promise<string> }> => {
  const pair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('no key pair');
  const { x } = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    pinned: { kty: 'OKP', crv: 'Ed25519', x: x ?? '' },
    sign: async (text) => Buffer.from(await webcrypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(text))).toString('base64'),
  };
};

const FIXED_KEY: PinnedKey = { kty: 'OKP', crv: 'Ed25519', x: 'a-pinned-key' };

/** Records every request the CLI makes, then answers it. `err` is what the command had printed when the request arrived, so a test can tell whether the print came first. */
const on = (scene: Scene, method: 'get' | 'post', path: string, reply: () => Response): void => {
  server.use(
    http[method](`${POOL}${path}`, async ({ request }) => {
      const body = await request.text();
      scene.seen.push({ url: request.url, headers: JSON.stringify([...request.headers.entries()]), body, err: scene.h.err.join('') });
      return reply();
    }),
  );
};

type Flavor = 'github' | 'google';

const PROVIDER_URLS: { [flavor in Flavor]: { device: string; token: string } } = {
  github: { device: 'https://github.com/login/device/code', token: 'https://github.com/login/oauth/access_token' },
  google: { device: 'https://oauth2.googleapis.com/device/code', token: 'https://oauth2.googleapis.com/token' },
};

// Invented values: none is a real client, device code, or token.
const DEVICE_CODE = 'device-code-1';
const PROVIDER_TOKEN = 'provider-access-token';
const POOL_TOKEN = 'a-pool-token';

/** What each provider answers while the operator has not yet approved: GitHub's 200, and Google's 428. */
const pending = (flavor: Flavor): Response => HttpResponse.json({ error: 'authorization_pending' }, { status: flavor === 'github' ? 200 : 428 });
const slowDown = (flavor: Flavor): Response => HttpResponse.json({ error: 'slow_down' }, { status: flavor === 'github' ? 200 : 400 });
const granted = (): Response => HttpResponse.json({ access_token: PROVIDER_TOKEN, token_type: 'bearer' });

interface ProviderOptions {
  /** Fields of the device answer to change; an undefined one is dropped. */
  device?: object;
  /** The answers to successive polls; the last stands once the list is spent. */
  polls?: Response[];
}

/** A fake provider: the device route and the token route, each recording what arrived. */
const providerAt = (scene: Scene, flavor: Flavor, { device = {}, polls = [granted()] }: ProviderOptions = {}): void => {
  const urls = PROVIDER_URLS[flavor];
  const record = async (request: Request): Promise<void> => {
    scene.seen.push({ url: request.url, headers: JSON.stringify([...request.headers.entries()]), body: await request.text(), err: scene.h.err.join('') });
  };
  const link = flavor === 'github' ? { verification_uri: 'https://provider.test/device' } : { verification_url: 'https://provider.test/device' };
  server.use(
    http.post(urls.device, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ device_code: DEVICE_CODE, user_code: 'USER-1', ...link, interval: 2, expires_in: 10, ...device });
    }),
    http.post(urls.token, async ({ request }) => {
      await record(request);
      return polls.length > 1 ? (polls.shift() ?? granted()) : (polls[0]?.clone() ?? granted());
    }),
  );
};

const okLogin = (signingKey: PinnedKey = FIXED_KEY): object => ({ token: POOL_TOKEN, account: 'acct_one', expiresAt: LATER, signingKey });

/** One sign-in at once: the fake provider approves on the first poll and the pool answers a credential. */
const signIn = async (scene: Scene, signingKey: PinnedKey = FIXED_KEY): Promise<void> => {
  providerAt(scene, 'github');
  on(scene, 'post', '/v1/login', () => HttpResponse.json(okLogin(signingKey)));
  expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
  scene.seen.length = 0;
  scene.h.out.length = 0;
  scene.h.err.length = 0;
};

const capture = (scene: Scene): Promise<unknown> => deposit(scene.staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });

/** An open pool whose covenant this account has accepted, recording what it was sent. */
const openPool = (scene: Scene): void => {
  on(scene, 'get', '/v1/covenant', () => HttpResponse.json({ version: 'v1', accepted: true }));
  on(scene, 'post', '/v1/deposits', () => HttpResponse.json({ ok: true }, { status: 201 }));
};

const depositBodies = (scene: Scene): unknown[] =>
  scene.seen
    .filter((entry) => entry.url.endsWith('/v1/deposits'))
    .map((entry) => {
      const parsed: unknown = JSON.parse(entry.body);
      return parsed;
    });

const at = (value: unknown, name: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined);

describe('the pool server is always named', () => {
  it('has no default, and takes a flag over the environment', () => {
    expect(() => poolServer({}, 's')).toThrow(/--server or OARS_POOL_URL/);
    expect(() => poolServer({ OARS_POOL_URL: '' }, 's')).toThrow(/no default/);
    expect(poolServer({ OARS_POOL_URL: 'https://from-env.test' }, 's')).toBe('https://from-env.test');
    expect(poolServer({ OARS_POOL_URL: 'https://from-env.test' }, 's', 'https://from-flag.test')).toBe('https://from-flag.test');
  });

  it('refuses plain http except to localhost', () => {
    for (const local of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) expect(poolServer({}, 's', local)).toBe(local);
    for (const remote of ['http://pool.test', 'http://localhost.evil.test', 'http://127.0.0.1.evil.test', 'ftp://localhost']) expect(() => poolServer({}, 's', remote)).toThrow(/plain http only to localhost/);
  });

  it('refuses what is not a bare origin, so nothing can hide where the token goes', () => {
    expect(() => poolServer({}, 's', 'not a url')).toThrow(/not a URL/);
    expect(() => poolServer({}, 's', 'http://127.0.0.1@evil.test')).toThrow(/plain http only/);
    for (const hidden of ['https://user:pass@pool.test', 'https://pool.test/path', 'https://pool.test/?q=1', 'https://pool.test/#f']) expect(() => poolServer({}, 's', hidden)).toThrow(/origin only/);
  });

  it('every command exits as a usage error with no server named, and sends nothing', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'login', '--provider', 'github')).toBe(ExitCode.USAGE);
    expect(await scene.cli('pool', 'deposit')).toBe(ExitCode.USAGE);
    expect(await scene.cli('pool', 'fetch')).toBe(ExitCode.USAGE);
    expect(scene.seen).toEqual([]);
  });

  it('a run with no session store says so', async () => {
    const scene = setting();
    delete scene.h.deps.sessions;
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
    expect(scene.h.err.join('')).toContain('not configured');
  });
});

describe('oars pool login', () => {
  it.each(['github', 'google'] as const)('signs in by %s: the provider flow runs here, the pool gets the provider token once, and the key is pinned', async (flavor) => {
    const scene = setting();
    providerAt(scene, flavor, { polls: [pending(flavor), slowDown(flavor), granted()] });
    on(scene, 'post', '/v1/login', () => HttpResponse.json(okLogin()));
    expect(await scene.cli('pool', 'login', '--provider', flavor, '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(scene.document()).toEqual({ ok: true, server: POOL, account: 'acct_one', expiresAt: LATER });
    expect(scene.h.err.join('')).toContain('https://provider.test/device');
    expect(scene.h.err.join('')).toContain('USER-1');
    expect(scene.h.opened).toEqual(['https://provider.test/device']);
    // The interval it was told, then five more seconds from the slow_down.
    expect(scene.h.sleeps).toEqual([2000, 2000, 7000]);

    const [device, ...rest] = scene.seen;
    const clientId = flavor === 'github' ? 'gh-client' : 'google-client';
    expect(device?.url).toBe(PROVIDER_URLS[flavor].device);
    expect(new URLSearchParams(device?.body).get('client_id')).toBe(clientId);
    expect(new URLSearchParams(device?.body).get('scope')).toBe(flavor === 'github' ? '' : 'openid');
    const polls = rest.slice(0, 3);
    for (const poll of polls) {
      expect(poll.url).toBe(PROVIDER_URLS[flavor].token);
      const form = new URLSearchParams(poll.body);
      expect([form.get('client_id'), form.get('device_code'), form.get('grant_type')]).toEqual([clientId, DEVICE_CODE, 'urn:ietf:params:oauth:grant-type:device_code']);
      // Google's token route takes the client secret; GitHub's takes none.
      expect(form.get('client_secret')).toBe(flavor === 'github' ? null : 'google-secret');
    }
    // The pool sees the provider's token once, in one request, and nothing of the device flow.
    const pool = rest.slice(3);
    expect(pool).toHaveLength(1);
    expect(pool[0]?.url).toBe(`${POOL}/v1/login`);
    expect(JSON.parse(pool[0]?.body ?? '')).toEqual({ provider: flavor, token: PROVIDER_TOKEN });
    expect(pool[0]?.body).not.toContain(DEVICE_CODE);
    expect(scene.seen.filter((entry) => entry.url.startsWith(POOL) && entry.body.includes('client_secret'))).toEqual([]);

    const saved = join(scene.staged.storeDir, 'pool-accounts.json');
    expect(readFileSync(saved, 'utf8')).toContain(POOL_TOKEN);
    expect(readFileSync(saved, 'utf8')).not.toContain(PROVIDER_TOKEN);
    if (process.platform !== 'win32') expect(statSync(saved).mode & 0o777).toBe(0o600);
  });

  it('says signed in, in words, without --json', async () => {
    const scene = setting();
    providerAt(scene, 'google');
    on(scene, 'post', '/v1/login', () => HttpResponse.json(okLogin()));
    expect(await scene.cli('pool', 'login', '--provider', 'google', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toBe(`Signed in to ${POOL} as acct_one.\n`);
  });

  it('goes on with a printed link when no browser opens', async () => {
    const scene = setting();
    scene.h.deps.openBrowser = () => Promise.reject(new Error('no browser'));
    providerAt(scene, 'github');
    on(scene, 'post', '/v1/login', () => HttpResponse.json(okLogin()));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.err.join('')).toContain('open the link above yourself');
  });

  it('refuses a sign-in link that does not parse, before opening a browser or polling', async () => {
    const scene = setting();
    let opened = false;
    scene.h.deps.openBrowser = () => {
      opened = true;
      return Promise.resolve();
    };
    providerAt(scene, 'github', { device: { verification_uri: 'not a url' } });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
    expect(scene.h.err.join('')).toContain('The provider did not start a sign-in.');
    expect(opened).toBe(false);
    expect(scene.seen).toHaveLength(1);
  });

  it('polls on the defaults when the provider names no interval', async () => {
    const scene = setting();
    providerAt(scene, 'github', { device: { interval: undefined, expires_in: undefined } });
    on(scene, 'post', '/v1/login', () => HttpResponse.json(okLogin()));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.sleeps).toEqual([5000]);
  });

  it('refuses a provider it does not know, before sending anything', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'login', '--provider', 'facebook', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(await scene.cli('pool', 'login', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(scene.seen).toEqual([]);
  });

  it.each([
    ['github', 'OARS_GITHUB_CLIENT_ID', { OARS_GITHUB_CLIENT_ID: '' }],
    ['google', 'OARS_GOOGLE_CLIENT_ID', { OARS_GOOGLE_CLIENT_ID: '' }],
    ['google', 'OARS_GOOGLE_CLIENT_SECRET', { OARS_GOOGLE_CLIENT_SECRET: '' }],
  ] as const)('refuses %s with %s unset, naming it, before sending anything', async (flavor, variable, unset) => {
    const scene = setting(unset);
    providerAt(scene, flavor);
    expect(await scene.cli('pool', 'login', '--provider', flavor, '--server', POOL)).toBe(ExitCode.USAGE);
    expect(scene.h.err.join('')).toContain(variable);
    expect(scene.seen).toEqual([]);
  });

  it('a second login to the same server keeps one entry and the same pin; another server gets its own', async () => {
    const scene = setting();
    await signIn(scene);
    await signIn(scene);
    const other = 'https://other.test';
    providerAt(scene, 'github');
    server.use(http.post(`${other}/v1/login`, () => HttpResponse.json(okLogin())));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', other)).toBe(ExitCode.OK);
    const saved: unknown = JSON.parse(readFileSync(join(scene.staged.storeDir, 'pool-accounts.json'), 'utf8'));
    expect(saved).toHaveLength(2);
  });

  it('refuses a login whose signing key differs from the pin, and saves nothing', async () => {
    const scene = setting();
    await signIn(scene);
    const file = join(scene.staged.storeDir, 'pool-accounts.json');
    const before = readFileSync(file, 'utf8');
    providerAt(scene, 'github');
    on(scene, 'post', '/v1/login', () => HttpResponse.json({ ...okLogin(), token: 'a-swapped-token', signingKey: { ...FIXED_KEY, x: 'another-key' } }));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(scene.document()).toMatchObject({ ok: false, problem: { code: 'signing_key_changed' } });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it.each(['not json', '{}', '[{"server":"x"}]'])('a damaged file of sign-ins (%s) stops the login, rather than forgetting a pin', async (damaged) => {
    const scene = setting();
    await signIn(scene);
    writeFileSync(join(scene.staged.storeDir, 'pool-accounts.json'), damaged);
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.INVALID);
    expect(scene.seen).toEqual([]);
  });

  it('a directory where the file should be is a failure, not an empty list', async () => {
    const scene = setting();
    await signIn(scene);
    const file = join(scene.staged.storeDir, 'pool-accounts.json');
    rmSync(file);
    mkdirSync(file);
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
  });

  it.each(['access_denied', 'unsupported_grant_type', undefined])('names the refusal when the provider answers %s, and never reaches the pool', async (error) => {
    const scene = setting();
    providerAt(scene, 'github', { polls: [HttpResponse.json(error === undefined ? {} : { error }, { status: 400 })] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(scene.document()).toMatchObject({ problem: { code: 'login_refused', title: `The provider refused the sign-in: ${error ?? 'no_token'}.` } });
    expect(scene.seen.filter((entry) => entry.url.startsWith(POOL))).toEqual([]);
  });

  it('names the refusal when the pool will not take the token', async () => {
    const scene = setting();
    providerAt(scene, 'github');
    on(scene, 'post', '/v1/login', () => HttpResponse.json({ error: 'login_refused', message: 'The provider did not accept the token.' }, { status: 401 }));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(scene.document()).toMatchObject({ problem: { code: 'login_refused', status: 401 } });
    expect(existsSync(join(scene.staged.storeDir, 'pool-accounts.json'))).toBe(false);
  });

  it.each(['github', 'google'] as const)('stops when the %s code expires: at the provider\'s word, and at the clock', async (flavor) => {
    const told = setting();
    providerAt(told, flavor, { polls: [pending(flavor), HttpResponse.json({ error: 'expired_token' }, { status: 400 })] });
    expect(await told.cli('pool', 'login', '--provider', flavor, '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(told.document()).toMatchObject({ problem: { code: 'EXPIRED_TOKEN' } });
    expect(told.seen.filter((entry) => entry.url.startsWith(POOL))).toEqual([]);

    const counted = setting();
    providerAt(counted, flavor, { device: { interval: 4, expires_in: 8 }, polls: [pending(flavor)] });
    expect(await counted.cli('pool', 'login', '--provider', flavor, '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(counted.document()).toMatchObject({ problem: { code: 'EXPIRED_TOKEN' } });
    expect(counted.h.sleeps).toEqual([4000, 4000]);
  });

  it('treats a malformed answer as a failure, not a sign-in', async () => {
    const noStart = setting();
    providerAt(noStart, 'github', { device: { user_code: undefined } });
    expect(await noStart.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);

    const notObject = setting();
    server.use(http.post(PROVIDER_URLS.github.device, () => HttpResponse.json('nope')));
    expect(await notObject.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);

    const emptyPoll = setting();
    providerAt(emptyPoll, 'github', { polls: [new HttpResponse('not json', { status: 200 })] });
    expect(await emptyPoll.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);

    for (const signingKey of [{ kty: 'RSA', crv: 'Ed25519', x: 'x' }, 'text', null]) {
      const badKey = setting();
      providerAt(badKey, 'github');
      on(badKey, 'post', '/v1/login', () => HttpResponse.json({ ...okLogin(), signingKey }));
      expect(await badKey.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
      expect(existsSync(join(badKey.staged.storeDir, 'pool-accounts.json'))).toBe(false);
    }

    const noBody = setting();
    providerAt(noBody, 'github');
    on(noBody, 'post', '/v1/login', () => new HttpResponse('not json', { status: 200 }));
    expect(await noBody.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
  });

  it('a provider or pool that cannot be reached, or answers with no message, still gets a plain failure', async () => {
    const scene = setting();
    server.use(http.post(PROVIDER_URLS.github.device, () => HttpResponse.error()));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNREACHABLE);

    const poolDown = setting();
    providerAt(poolDown, 'github');
    server.use(http.post(`${POOL}/v1/login`, () => HttpResponse.error()));
    expect(await poolDown.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNREACHABLE);

    const bare = setting();
    providerAt(bare, 'github');
    on(bare, 'post', '/v1/login', () => new HttpResponse('oops', { status: 500 }));
    expect(await bare.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
    expect(bare.h.err.join('')).toContain('HTTP 500');
  });

  it('will not follow a redirect with a token, from the provider or the pool', async () => {
    const fromProvider = setting();
    server.use(http.post(PROVIDER_URLS.github.device, () => new HttpResponse(null, { status: 307, headers: { location: 'https://elsewhere.test/device' } })));
    expect(await fromProvider.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNREACHABLE);

    const fromPool = setting();
    providerAt(fromPool, 'github');
    server.use(http.post(`${POOL}/v1/login`, () => new HttpResponse(null, { status: 307, headers: { location: 'https://elsewhere.test/v1/login' } })));
    expect(await fromPool.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNREACHABLE);
  });
});

describe('oars pool login prints what it sends', () => {
  /** The request lines in a stderr snapshot, in the order they were printed. */
  const requestLines = (text: string): string[] => text.split('\n').filter((line) => /^(GET|POST) \S+ HTTP\/1\.1$/.test(line));

  it.each(['github', 'google'] as const)('prints every %s request, headers and body, before sending it, with the secrets masked', async (flavor) => {
    const scene = setting();
    providerAt(scene, flavor, { polls: [pending(flavor), granted()] });
    on(scene, 'post', '/v1/login', () => HttpResponse.json(okLogin()));
    expect(await scene.cli('pool', 'login', '--provider', flavor, '--server', POOL)).toBe(ExitCode.OK);

    // Each request found its own request line already printed, and no later one.
    expect(scene.seen).toHaveLength(4);
    scene.seen.forEach((entry, index) => {
      const lines = requestLines(entry.err);
      expect(lines).toHaveLength(index + 1);
      expect(lines.at(-1)).toBe(`POST ${new URL(entry.url).pathname} HTTP/1.1`);
    });

    const printed = scene.h.err.join('');
    expect(requestLines(printed)).toEqual([
      `POST ${new URL(PROVIDER_URLS[flavor].device).pathname} HTTP/1.1`,
      `POST ${new URL(PROVIDER_URLS[flavor].token).pathname} HTTP/1.1`,
      `POST ${new URL(PROVIDER_URLS[flavor].token).pathname} HTTP/1.1`,
      'POST /v1/login HTTP/1.1',
    ]);
    // Every header goes out as printed: host, user-agent, content-type, and the length of the body.
    expect(printed).toContain(`host: ${new URL(PROVIDER_URLS[flavor].device).host}`);
    expect(printed).toContain('content-type: application/x-www-form-urlencoded');
    expect(printed).toContain('content-type: application/json');
    expect(printed).toMatch(/content-length: \d+/);

    // The client ID, scope, grant type, and Google's client secret print as they are.
    expect(printed).toContain(`client_id=${flavor === 'github' ? 'gh-client' : 'google-client'}`);
    expect(printed).toContain(flavor === 'github' ? 'scope=\n' : 'scope=openid');
    expect(printed).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
    if (flavor === 'google') expect(printed).toContain('client_secret=google-secret');
    else expect(printed).not.toContain('client_secret');

    // The device code and the provider's token print as their size alone, wherever they sit; the pool's credential is never in a request, and never printed.
    expect(printed).toContain(`device_code=<credential: ${String(DEVICE_CODE.length)} bytes>`);
    expect(printed).toContain(`{"provider":"${flavor}","token":"<credential: ${String(PROVIDER_TOKEN.length)} bytes>"}`);
    for (const secret of [DEVICE_CODE, PROVIDER_TOKEN, POOL_TOKEN]) expect(scene.h.out.join('') + printed).not.toContain(secret);
  });
});

describe('no harness token is ever read', () => {
  it('a token planted in the harness config and environment appears in no request across login, deposit, and fetch', async () => {
    const scene = setting({ ANTHROPIC_API_KEY: HARNESS_SECRET, CLAUDE_CODE_OAUTH_TOKEN: HARNESS_SECRET });
    writeFileSync(join(scene.staged.projectsRoot, '..', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: HARNESS_SECRET } }));
    await capture(scene);
    providerAt(scene, 'github');
    on(scene, 'post', '/v1/login', () => HttpResponse.json(okLogin()));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    openPool(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    on(scene, 'get', '/bundle/2.1.314/0', () => HttpResponse.json({ error: 'fetch_cap', message: 'capped' }, { status: 429 }));
    await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL);
    expect(scene.seen.length).toBeGreaterThan(3);
    expect(scene.sent()).not.toContain(HARNESS_SECRET);
    expect(scene.sent()).toContain(POOL_TOKEN);
  });
});

describe('oars pool deposit', () => {
  it('asks for a sign-in first, and an expired one is no sign-in', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.AUTH);
    expect(scene.h.err.join('')).toContain('oars pool login');
    expect(scene.seen).toEqual([]);

    await signIn(scene);
    scene.h.deps.now = () => LATER + 1;
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.AUTH);
    expect(scene.seen).toEqual([]);
  });

  it('sends a closed skeleton for each clean session, under an id that is not the session id', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    openPool(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
    const bodies = depositBodies(scene);
    expect(bodies.length).toBeGreaterThan(0);
    expect(scene.document()).toMatchObject({ ok: true, server: POOL, deposited: bodies.length, refused: 0, refusedFields: [] });
    for (const body of bodies) expect(parseSkeleton(body).ok).toBe(true);
    const observations = readFileSync(join(scene.staged.storeDir, 'observations.jsonl'), 'utf8');
    for (const body of bodies) expect(observations).not.toContain(String(at(body, 'id')));
    for (const entry of scene.seen) expect(entry.headers).toContain('oars/9.9.9');
  });

  it('never builds or sends a session the V15 check excludes, for a term or a missing term file', async () => {
    const dirty = setting();
    const id = '44444444-4444-4444-8444-444444444444';
    addProject(dirty.staged, 'proj', id, [JSON.stringify({ type: 'user', sessionId: id, cwd: '/w', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: `working at ${TERM}` } })]);
    await capture(dirty);
    await signIn(dirty);
    openPool(dirty);
    expect(await dirty.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(dirty.document()).toMatchObject({ excluded: { term: 1, noRaw: 0, noTerms: 0, unreadable: 0 } });
    expect(dirty.sent()).not.toContain(TERM);

    const noTerms = setting({ OARS_EXCLUSION_TERMS: join(dirty.staged.root, 'no-such-terms.txt') });
    await capture(noTerms);
    await signIn(noTerms);
    openPool(noTerms);
    expect(await noTerms.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
    const counted = noTerms.document();
    expect(depositBodies(noTerms)).toEqual([]);
    expect(counted).toMatchObject({ deposited: 0, excluded: { noTerms: at(counted, 'sessions') } });
  });

  it('a session whose raw is gone never deposits', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    rmSync(scene.staged.projectsRoot, { recursive: true, force: true });
    rmSync(join(scene.staged.storeDir, 'raw'), { recursive: true, force: true });
    openPool(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
    const counted = scene.document();
    expect(depositBodies(scene)).toEqual([]);
    expect(counted).toMatchObject({ deposited: 0, excluded: { noRaw: at(counted, 'sessions') } });
  });

  it('counts a session captured before steps and frames, and one the vocabulary refuses, without sending either', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    openPool(scene);
    const file = join(scene.staged.storeDir, 'observations.jsonl');
    const original = readFileSync(file, 'utf8');
    const isSession = (record: unknown): record is { kind: 'session'; frame?: { model?: unknown } } => at(record, 'kind') === 'session';
    const rewrite = (change: (session: { frame?: { model?: unknown } }) => void): void => {
      const lines = original.split('\n').filter((line) => line !== '').map((line) => {
        const record: unknown = JSON.parse(line);
        if (isSession(record)) change(record);
        return JSON.stringify(record);
      });
      writeFileSync(file, `${lines.join('\n')}\n`);
    };
    rewrite((session) => {
      delete session.frame;
    });
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
    const counted = scene.document();
    expect(depositBodies(scene)).toEqual([]);
    expect(counted).toMatchObject({ deposited: 0, uncaptured: at(counted, 'sessions') });

    rewrite((session) => {
      if (session.frame !== undefined) session.frame.model = 'acme-private-llm';
    });
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(depositBodies(scene)).toEqual([]);
    expect(scene.h.out.join('')).toContain('refused by the vocabulary (transcripts[0].frame.model)');
    expect(scene.h.out.join('')).not.toContain('acme-private-llm');
  });

  it('counts a server refusal for one session and goes on; anything else stops the run', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    on(scene, 'get', '/v1/covenant', () => HttpResponse.json({ version: 'v1', accepted: true }));
    const answers = [HttpResponse.json({ error: 'closed_vocabulary', field: 'transcripts[0].harness' }, { status: 422 }), HttpResponse.json({ error: 'closed_vocabulary' }, { status: 422 }), HttpResponse.json({ error: 'too_large' }, { status: 413 })];
    on(scene, 'post', '/v1/deposits', () => answers.shift() ?? HttpResponse.json({ ok: true }, { status: 201 }));
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(scene.document()).toMatchObject({ refusedFields: ['transcripts[0].harness'] });
    expect(at(scene.document(), 'refused')).toBeGreaterThan(0);

    const stopped = setting();
    await capture(stopped);
    await signIn(stopped);
    on(stopped, 'get', '/v1/covenant', () => HttpResponse.json({ version: 'v1', accepted: true }));
    on(stopped, 'post', '/v1/deposits', () => HttpResponse.json({ error: 'unauthorized', message: 'Sign in with oars pool login first.' }, { status: 401 }));
    expect(await stopped.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.AUTH);
    expect(depositBodies(stopped)).toHaveLength(1);
  });

  it('stops before building anything when the pool is closed, and when the covenant is not accepted', async () => {
    const closed = setting();
    await capture(closed);
    await signIn(closed);
    on(closed, 'get', '/v1/covenant', () => HttpResponse.json({ version: null }));
    expect(await closed.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(closed.document()).toMatchObject({ problem: { code: 'deposits_closed' } });
    expect(depositBodies(closed)).toEqual([]);

    const unaccepted = setting();
    await capture(unaccepted);
    await signIn(unaccepted);
    on(unaccepted, 'get', '/v1/covenant', () => HttpResponse.json({ version: 'v1', accepted: false }));
    expect(await unaccepted.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(unaccepted.document()).toMatchObject({ problem: { code: 'covenant_not_accepted' } });
    expect(depositBodies(unaccepted)).toEqual([]);

    const broken = setting();
    await signIn(broken);
    on(broken, 'get', '/v1/covenant', () => HttpResponse.json({ error: 'not_found', message: 'No such route.' }, { status: 404 }));
    expect(await broken.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
  });

  it('accepts the version it was told to, and stops if the pool refuses that', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    on(scene, 'get', '/v1/covenant', () => HttpResponse.json({ version: 'v1', accepted: false }));
    on(scene, 'post', '/v1/covenant/accept', () => HttpResponse.json({ ok: true, version: 'v1' }));
    on(scene, 'post', '/v1/deposits', () => HttpResponse.json({ ok: true }, { status: 201 }));
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--accept-covenant', 'v1')).toBe(ExitCode.OK);
    expect(scene.seen.find((entry) => entry.url.endsWith('/accept'))?.body).toBe(JSON.stringify({ version: 'v1' }));
    expect(depositBodies(scene).length).toBeGreaterThan(0);

    const stale = setting();
    await capture(stale);
    await signIn(stale);
    on(stale, 'get', '/v1/covenant', () => HttpResponse.json({ version: 'v2', accepted: false }));
    on(stale, 'post', '/v1/covenant/accept', () => HttpResponse.json({ error: 'covenant_version', message: 'The current covenant is v2.' }, { status: 409 }));
    expect(await stale.cli('pool', 'deposit', '--server', POOL, '--accept-covenant', 'v1')).toBe(ExitCode.UNEXPECTED);
    expect(depositBodies(stale)).toEqual([]);
  });
});

describe('oars pool fetch', () => {
  it('has no pull, since that word belongs to recall: it is an unknown command', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'pull', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(scene.h.err.join('')).toContain("unknown command 'pull'");
    expect(scene.seen).toEqual([]);
  });

  const bundleBody = (version: string): string => JSON.stringify({ format: 1, harnessVersion: version, vocabVersion: '0', asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: [{}, {}], strata: [] });

  const signedScene = async (): Promise<{ scene: Scene; sign: (text: string) => Promise<string> }> => {
    const scene = setting();
    const { pinned, sign } = await key();
    await signIn(scene, pinned);
    return { scene, sign };
  };

  const replicas = (scene: Scene): string[] => {
    const root = join(scene.staged.storeDir, 'pool-replica');
    return existsSync(root) ? readdirSync(root, { recursive: true }).map(String).filter((name) => name.endsWith('.json')) : [];
  };

  it('verifies the bundle against the pinned key and keeps it in its signed form', async () => {
    const { scene, sign } = await signedScene();
    const payload = bundleBody('2.1.314');
    const signature = await sign(payload);
    on(scene, 'get', '/bundle/2.1.314/0', () => HttpResponse.json({ payload, signature }));
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
    const answer = scene.document();
    expect(answer).toMatchObject({ ok: true, harnessVersion: '2.1.314', reads: 2, cells: 1, motifs: 0 });
    expect(scene.seen[0]?.headers).toContain('a-pool-token');
    expect(JSON.parse(readFileSync(String(at(answer, 'file')), 'utf8'))).toEqual({ payload, signature });
  });

  it('names the version it fetched', async () => {
    const { scene, sign } = await signedScene();
    const payload = bundleBody('2.1.9');
    const signature = await sign(payload);
    on(scene, 'get', '/bundle/2.1.9/0', () => HttpResponse.json({ payload, signature }));
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.9', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('Fetched 2.1.9: 2 reads');
  });

  it('refuses a tampered bundle and a bundle of another harness version, and keeps neither', async () => {
    const { scene, sign } = await signedScene();
    const payload = bundleBody('2.1.314');
    const signature = await sign(payload);
    on(scene, 'get', '/bundle/2.1.314/0', () => HttpResponse.json({ payload: payload.replace('"cells":[{}]', '"cells":[{},{}]'), signature }));
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.INVALID);
    expect(scene.document()).toMatchObject({ problem: { code: 'bundle_unverified' } });
    expect(replicas(scene)).toEqual([]);

    on(scene, 'get', '/bundle/2.1.9/0', () => HttpResponse.json({ payload, signature }));
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.9', '--server', POOL)).toBe(ExitCode.INVALID);
    expect(replicas(scene)).toEqual([]);
  });

  it('refuses a harness version the vocabulary does not hold before asking, asks for a sign-in, and passes on a named refusal', async () => {
    const { scene } = await signedScene();
    expect(await scene.cli('pool', 'fetch', '--harness-version', '../secret', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(scene.seen).toEqual([]);
    expect(await scene.cli('pool', 'fetch', '--harness-version', '<literal>', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(scene.seen).toEqual([]);
    // The option is required: no default version stands in for one.
    scene.h.err.length = 0;
    expect(await scene.cli('pool', 'fetch', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(scene.h.err.join('')).toContain('--harness-version');
    expect(scene.seen).toEqual([]);

    on(scene, 'get', '/bundle/2.1.314/0', () => HttpResponse.json({ error: 'fetch_cap', message: 'An account without access may fetch 1 per ISO week.' }, { status: 429 }));
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.CAPPED);
    expect(scene.document()).toMatchObject({ problem: { code: 'fetch_cap' } });

    const anon = setting();
    expect(await anon.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.AUTH);
  });

  /** One handler for the bundle route that records each request, snapshots what had been printed when it arrived, and answers from a queue. */
  const bundleRoute = (scene: Scene, version: string, replies: Array<(request: Request) => Response>): Array<{ headers: Headers; printedBefore: string }> => {
    const arrivals: Array<{ headers: Headers; printedBefore: string }> = [];
    server.use(
      http.get(`${POOL}/bundle/${version}/0`, ({ request }) => {
        arrivals.push({ headers: request.headers, printedBefore: scene.h.err.join('') });
        scene.seen.push({ url: request.url, headers: JSON.stringify([...request.headers.entries()]), body: '', err: scene.h.err.join('') });
        return (replies.shift() ?? (() => new HttpResponse(null, { status: 500 })))(request);
      }),
    );
    return arrivals;
  };

  const signedReply = async (sign: (text: string) => Promise<string>, version: string, etag: string | null, reads = 2): Promise<() => Response> => {
    const payload = JSON.stringify({ format: 1, harnessVersion: version, vocabVersion: '0', asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: Array.from({ length: reads }, () => ({})), strata: [] });
    const signature = await sign(payload);
    return () => HttpResponse.json({ payload, signature }, etag === null ? {} : { headers: { etag } });
  };

  const keptFile = (scene: Scene): string => join(scene.staged.storeDir, 'pool-replica', readdirSync(join(scene.staged.storeDir, 'pool-replica'))[0] ?? '', '2.1.314.json');

  describe('prints before it sends', () => {
    it('prints the request line and every header before the request arrives, with the credential as its size and nothing else masked', async () => {
      const { scene, sign } = await signedScene();
      const arrivals = bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', '"e1"')]);
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      const before = arrivals[0]?.printedBefore ?? '';
      expect(before).toContain('GET /bundle/2.1.314/0 HTTP/1.1\nhost: pool.test\nconnection: keep-alive\n');
      expect(before).toContain('authorization: Bearer <credential: 12 bytes>');
      expect(before).toContain('user-agent: oars/');
      // Whatever header the request carried when it arrived is in the print, word for word, except the credential.
      for (const [name, value] of arrivals[0]?.headers.entries() ?? []) {
        if (name !== 'authorization') expect(before).toContain(`${name}: ${value}`);
      }
      expect(before).toContain('accept-encoding: identity');
      expect(scene.h.out.join('') + scene.h.err.join('')).not.toContain('a-pool-token');
      expect(scene.h.out.join('')).not.toContain('HTTP/1.1');
    });

    it('prints to stderr, so --json keeps its one document on stdout', async () => {
      const { scene, sign } = await signedScene();
      bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', null)]);
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      expect(scene.h.err.join('')).toContain('GET /bundle/2.1.314/0 HTTP/1.1');
      expect(scene.document()).toMatchObject({ ok: true });
    });

    it('prints the If-None-Match it sends', async () => {
      const { scene, sign } = await signedScene();
      const arrivals = bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', '"e1"'), () => new HttpResponse(null, { status: 304 })]);
      await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL);
      await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL);
      expect(arrivals[0]?.headers.get('if-none-match')).toBeNull();
      expect(arrivals[1]?.printedBefore).toContain('if-none-match: "e1"');
    });

    it('a recall and a read never come to the fetch send path', async () => {
      const { scene } = await signedScene();
      const arrivals = bundleRoute(scene, '2.1.314', []);
      await capture(scene);
      expect(await scene.cli('sessions', 'recall', '--path', 'a.ts', '--json')).toBe(ExitCode.OK);
      expect(await scene.cli('sessions', 'read', '--json')).toBe(ExitCode.OK);
      expect(arrivals).toEqual([]);
      expect(scene.seen).toEqual([]);
      expect(scene.h.err.join('')).not.toContain('HTTP/1.1');
    });
  });

  describe('fetches only what changed', () => {
    it('a 200 keeps the bundle with its ETag, and the next fetch sends If-None-Match', async () => {
      const { scene, sign } = await signedScene();
      const arrivals = bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', '"e1"'), await signedReply(sign, '2.1.314', '"e2"', 3)]);
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      expect(scene.document()).toMatchObject({ unchanged: false, reads: 2 });
      const first = readFileSync(keptFile(scene), 'utf8');
      expect(JSON.parse(first)).toMatchObject({ etag: '"e1"' });
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      expect(arrivals[1]?.headers.get('if-none-match')).toBe('"e1"');
      // A changed bundle replaces the kept one, and its ETag.
      expect(scene.document()).toMatchObject({ unchanged: false, reads: 3 });
      const second = readFileSync(keptFile(scene), 'utf8');
      expect(second).not.toBe(first);
      expect(JSON.parse(second)).toMatchObject({ etag: '"e2"' });
    });

    it('a 304 keeps the bundle byte for byte, says it is unchanged, and exits 0', async () => {
      const { scene, sign } = await signedScene();
      bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', '"e1"'), () => new HttpResponse(null, { status: 304, headers: { etag: '"e1"' } })]);
      await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL);
      const before = readFileSync(keptFile(scene));
      scene.h.out.length = 0;
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      expect(readFileSync(keptFile(scene)).equals(before)).toBe(true);
      expect(scene.h.out.join('')).toContain('2.1.314 is unchanged');
    });

    it('a 429 with a Retry-After keeps the bundle byte for byte, says when to try again in words, and exits with its own code', async () => {
      const { scene, sign } = await signedScene();
      const capped = (): Response => HttpResponse.json({ error: 'fetch_cap', message: 'An account without access may fetch 1 per ISO week.' }, { status: 429, headers: { 'retry-after': '345600' } });
      bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', '"e1"'), capped]);
      await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL);
      const before = readFileSync(keptFile(scene));
      scene.h.err.length = 0;
      expect(ExitCode.CAPPED).toBe(10);
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.CAPPED);
      expect(readFileSync(keptFile(scene)).equals(before)).toBe(true);
      expect(scene.document()).toMatchObject({ ok: false, step: 'pool-fetch', retryAfter: '345600', problem: { code: 'fetch_cap', status: 429 } });
      expect(String(at(at(scene.document(), 'problem'), 'title'))).toContain('Try again in 4 days.');
    });

    it('a 429 with no Retry-After still keeps the bundle, and says so rather than guessing a time', async () => {
      const { scene, sign } = await signedScene();
      const capped = (): Response => HttpResponse.json({ error: 'fetch_cap', message: 'capped' }, { status: 429 });
      bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', '"e1"'), capped, capped]);
      await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL);
      const before = readFileSync(keptFile(scene));
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.CAPPED);
      expect(readFileSync(keptFile(scene)).equals(before)).toBe(true);
      expect(scene.document()).toMatchObject({ retryAfter: null });
      expect(String(at(at(scene.document(), 'problem'), 'title'))).toContain('did not say when');
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.CAPPED);
      expect(scene.h.err.join('')).toContain('already on disk is untouched');
    });

    it('a 429 as a date, and one with nothing kept yet, are read the same way', async () => {
      const { scene } = await signedScene();
      const date = new Date(scene.h.deps.now() + 3 * 3_600_000).toUTCString();
      bundleRoute(scene, '2.1.314', [() => HttpResponse.json({ error: 'fetch_cap' }, { status: 429, headers: { 'retry-after': date } }), () => HttpResponse.json({ error: 'fetch_cap' }, { status: 429, headers: { 'retry-after': 'soon' } })]);
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.CAPPED);
      expect(scene.h.err.join('')).toContain('Try again in 3 hours.');
      expect(scene.h.err.join('')).toContain('No bundle is kept yet.');
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.CAPPED);
      expect(existsSync(join(scene.staged.storeDir, 'pool-replica'))).toBe(false);
    });

    it('sends no If-None-Match for a bundle that cannot be verified any more, or that came with no ETag', async () => {
      const { scene, sign } = await signedScene();
      const arrivals = bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', null), await signedReply(sign, '2.1.314', '"e1"'), await signedReply(sign, '2.1.314', '"e2"'), await signedReply(sign, '2.1.314', '"e3"')]);
      await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL);
      await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL);
      expect(arrivals[1]?.headers.get('if-none-match')).toBeNull();
      writeFileSync(keptFile(scene), readFileSync(keptFile(scene), 'utf8').replace('"signature":"', '"signature":"AAAA'));
      await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL);
      expect(arrivals[2]?.headers.get('if-none-match')).toBeNull();
      writeFileSync(keptFile(scene), 'not json');
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      expect(arrivals[3]?.headers.get('if-none-match')).toBeNull();
      expect(JSON.parse(readFileSync(keptFile(scene), 'utf8'))).toMatchObject({ etag: '"e3"' });
    });

    it('refuses a 304 to a fetch that named nothing kept', async () => {
      const { scene } = await signedScene();
      bundleRoute(scene, '2.1.314', [() => new HttpResponse(null, { status: 304 })]);
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
      expect(scene.h.err.join('')).toContain('304');
    });
  });
});

describe('with no sign-in and no server', () => {
  it('local capture, recall, and reads work, and nothing is sent', async () => {
    const scene = setting();
    expect(await scene.cli('sessions', 'deposit', '--allow', 'proj')).toBe(ExitCode.OK);
    expect(await scene.cli('sessions', 'recall', '--path', 'a.ts', '--json')).toBe(ExitCode.OK);
    expect(await scene.cli('sessions', 'read', '--json')).toBe(ExitCode.OK);
    expect(scene.seen).toEqual([]);
    expect(existsSync(join(scene.staged.storeDir, 'pool-accounts.json'))).toBe(false);
  });
});
