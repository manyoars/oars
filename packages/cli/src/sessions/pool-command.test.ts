import { createHash, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, server, useServer, type Harness } from '../test-support.js';
import { networkSender, poolDeposit, poolServer, type Reply, type Sender } from './pool-command.js';
import { batchHash, canonicalBytes, FIELD_ROWS, fieldsOf, writeBatch } from './pool-outbox.js';
import type { Outgoing } from './pool-print.js';
import { REGISTRY_MAX_AGE_DAYS, VOCAB_SNAPSHOT_DATE } from './public-vocabulary.js';
import type * as PoolWire from './pool-wire.js';
import { session as sessionRow } from './pool-fixture.js';
import { parseSkeleton, skeletonOf, VOCAB_VERSION, type PinnedKey } from './pool-wire.js';
import { contentHash } from './read.js';
import { deposit } from './store.js';
import { addProject, cleanup, NOW, settledClock, stage, type Staged } from './test-support.js';

// The session gates must stop a session before the projection runs; the real projection is wrapped so a test can see whether it was called.
vi.mock('./pool-wire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PoolWire>();
  return { ...actual, skeletonOf: vi.fn(actual.skeletonOf) };
});

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
  h.deps.now = settledClock;
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
    // GitHub answers form-encoded unless it is asked for JSON, so the device and token requests both ask.
    for (const request of [device, ...polls]) expect(JSON.parse(request?.headers ?? '[]')).toContainEqual(['accept', 'application/json']);
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

  it.each([['github', 'device_flow_disabled', 200], ['google', 'invalid_client', 401]] as const)('names what the %s device route refused (%s), as a refused sign-in and not an unexpected one', async (flavor, error, status) => {
    const scene = setting();
    const hits: string[] = [];
    server.use(http.post(PROVIDER_URLS[flavor].device, () => {
      hits.push('device');
      return HttpResponse.json({ error, error_description: 'set up the app first' }, { status });
    }));
    expect(await scene.cli('pool', 'login', '--provider', flavor, '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(scene.document()).toMatchObject({ problem: { code: 'login_refused', title: `The provider refused the sign-in: ${error}.` } });
    expect(hits).toEqual(['device']);
    expect(scene.h.sleeps).toEqual([]);
    expect(scene.seen.filter((entry) => entry.url.startsWith(POOL))).toEqual([]);
  });

  it('polls on the defaults when the provider names no interval', async () => {
    const scene = setting();
    providerAt(scene, 'github', { device: { interval: undefined, expires_in: undefined } });
    on(scene, 'post', '/v1/login', () => HttpResponse.json(okLogin()));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.sleeps).toEqual([5000]);
  });

  it.each([0, -3])('takes the default wait for an interval of %i, rather than polling with none', async (interval) => {
    const scene = setting();
    providerAt(scene, 'github', { device: { interval }, polls: [pending('github'), granted()] });
    on(scene, 'post', '/v1/login', () => HttpResponse.json(okLogin()));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.sleeps).toEqual([5000, 5000]);
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
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, () => HttpResponse.json({ error: 'fetch_cap', message: 'capped' }, { status: 429 }));
    await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL);
    expect(scene.seen.length).toBeGreaterThan(3);
    expect(scene.sent()).not.toContain(HARNESS_SECRET);
    expect(scene.sent()).toContain(POOL_TOKEN);
  });
});

/** Every batch file in the outbox, by path relative to the store. */
const outboxFiles = (scene: Scene): string[] => {
  const root = join(scene.staged.storeDir, 'pool-outbox');
  return existsSync(root) ? readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.jsonl')).sort() : [];
};

const batchBytes = (scene: Scene): string[] => outboxFiles(scene).map((name) => readFileSync(join(scene.staged.storeDir, 'pool-outbox', name), 'utf8'));

/** The hash `oars pool outbox` printed for each batch, in the order printed. */
const printedHashes = (scene: Scene): string[] => [...scene.h.out.join('').matchAll(/^sha256: ([0-9a-f]{64})$/gm)].map((found) => found[1] ?? '');

/** Stands in for the pool: the command line passes no sender, so these tests hand `poolDeposit` one that records each request and answers from `routes`. */
const wire = (routes: { [route: string]: Reply | Reply[] }): { requests: Outgoing[]; via: Sender } => {
  const requests: Outgoing[] = [];
  return {
    requests,
    via: (request) => {
      requests.push(request);
      const route = routes[`${request.method} ${request.url.pathname}`];
      const reply = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
      return Promise.resolve(reply ?? answer(404, { error: 'not_found', message: 'No such route.' }));
    },
  };
};

const answer = (status: number, body: unknown = {}): Reply => ({ status, body, headers: new Headers() });
const OPEN_COVENANT = answer(200, { version: 'v1', accepted: true });

/** A scene with one clean session captured, signed in, and its batch written to the outbox. */
const batched = async (): Promise<Scene> => {
  const scene = setting();
  await capture(scene);
  await signIn(scene);
  expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
  scene.seen.length = 0;
  scene.h.out.length = 0;
  scene.h.err.length = 0;
  return scene;
};

const sendOptions = (hash: string, via: Sender | undefined): { server: string; send: string; via?: Sender } => ({ server: POOL, send: hash, ...(via === undefined ? {} : { via }) });

describe('oars pool deposit', () => {
  beforeEach(() => {
    vi.mocked(skeletonOf).mockClear();
  });

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

  it('builds no batch once its vocabulary is past registry_max_age, and names the upgrade', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    const before = scene.seen.length;
    scene.h.deps.now = () => Date.parse(`${VOCAB_SNAPSHOT_DATE}T00:00:00Z`) + (REGISTRY_MAX_AGE_DAYS + 1) * 86_400_000;
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.CONFLICT);
    expect(scene.h.err.join('')).toContain('Upgrade with npm install -g @manyoars/oars');
    expect(scene.seen).toHaveLength(before);
    expect(outboxFiles(scene)).toEqual([]);
    expect(skeletonOf).not.toHaveBeenCalled();
  });

  it('refuses a send past registry_max_age too, with no request made', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201) });
    scene.h.deps.now = () => Date.parse(`${VOCAB_SNAPSHOT_DATE}T00:00:00Z`) + (REGISTRY_MAX_AGE_DAYS + 1) * 86_400_000;
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, pool.via))).rejects.toMatchObject({ problem: { code: 'vocabulary_expired' } });
    expect(pool.requests).toEqual([]);
  });

  it('writes one canonical batch for each clean session, under an id that is not the session id, and sends nothing', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(scene.seen).toEqual([]);
    const files = outboxFiles(scene);
    expect(files.length).toBeGreaterThan(0);
    expect(scene.document()).toMatchObject({ ok: true, server: POOL, batched: files.length, refused: 0, refusedFields: [], discarded: 0 });
    const observations = readFileSync(join(scene.staged.storeDir, 'observations.jsonl'), 'utf8');
    for (const [index, bytes] of batchBytes(scene).entries()) {
      const parsed: unknown = JSON.parse(bytes);
      expect(parseSkeleton(parsed).ok).toBe(true);
      expect(bytes).toBe(canonicalBytes(parsed));
      expect(files[index]).toContain(batchHash(bytes));
      expect(observations).not.toContain(String(at(parsed, 'id')));
    }
  });

  it('writes a changed session over its old batch, and the same bytes again as the same file', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    const first = outboxFiles(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(outboxFiles(scene)).toEqual(first);
  });

  describe('the session gates run before any projection', () => {
    const OTHER_FOLDER = 'zz-private-repo';
    const SESSION = '55555555-5555-4555-8555-555555555555';
    const line = (text: string): string => JSON.stringify({ type: 'user', sessionId: SESSION, cwd: '/w', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: text } });

    /** A store holding only this one session, so an empty outbox and an uncalled projection can only be the gate's doing. */
    const alone = async (lines: string[]): Promise<Scene> => {
      const scene = setting();
      rmSync(join(scene.staged.projectsRoot, 'proj'), { recursive: true, force: true });
      addProject(scene.staged, OTHER_FOLDER, SESSION, lines);
      await deposit(scene.staged.runtime, { allow: [OTHER_FOLDER], redactDomains: [], now: () => NOW });
      await signIn(scene);
      return scene;
    };

    const expectNothingBuilt = async (scene: Scene, counted: object): Promise<void> => {
      expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
      expect(outboxFiles(scene)).toEqual([]);
      expect(skeletonOf).not.toHaveBeenCalled();
      expect(scene.document()).toMatchObject({ sessions: 1, batched: 0, excluded: counted });
      // The reason is a count: neither the term nor the folder is named anywhere the command wrote.
      const written = [...scene.h.out, ...scene.h.err].join('');
      expect(written).not.toContain(TERM);
      expect(written).not.toContain(OTHER_FOLDER);
    };

    it('a clean session in an allowed folder is built, so the checks below can tell a gate from an empty store', async () => {
      const scene = await alone([line('a plain request')]);
      expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
      expect(outboxFiles(scene)).toHaveLength(1);
      expect(skeletonOf).toHaveBeenCalledTimes(1);
    });

    it('a folder the operator has not allowed', async () => {
      const scene = await alone([line('a plain request')]);
      const state = join(scene.staged.storeDir, 'state.json');
      writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), allow: ['some-other-folder'] }));
      await expectNothingBuilt(scene, { folder: 1, term: 0, noRaw: 0, noTerms: 0, unreadable: 0 });
    });

    it('a term hit in the main transcript', async () => {
      await expectNothingBuilt(await alone([line(`working at ${TERM}`)]), { folder: 0, term: 1, noRaw: 0, noTerms: 0, unreadable: 0 });
    });

    it('a term hit in a subagent transcript', async () => {
      const scene = await alone([line('a plain request')]);
      const agents = join(scene.staged.projectsRoot, OTHER_FOLDER, SESSION, 'subagents');
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, 'agent-a.jsonl'), `${line(`the subagent saw ${TERM}`)}\n`);
      await expectNothingBuilt(scene, { folder: 0, term: 1, noRaw: 0, noTerms: 0, unreadable: 0 });
    });

    it('a session with no raw to scan', async () => {
      const scene = await alone([line('a plain request')]);
      rmSync(scene.staged.projectsRoot, { recursive: true, force: true });
      rmSync(join(scene.staged.storeDir, 'raw'), { recursive: true, force: true });
      await expectNothingBuilt(scene, { folder: 0, term: 0, noRaw: 1, noTerms: 0, unreadable: 0 });
    });

    it('a missing term file excludes everything', async () => {
      const scene = await alone([line('a plain request')]);
      scene.h.deps.env.OARS_EXCLUSION_TERMS = join(scene.staged.root, 'no-such-terms.txt');
      await expectNothingBuilt(scene, { folder: 0, term: 0, noRaw: 0, noTerms: 1, unreadable: 0 });
    });

    describe('a session that passed once and fails a gate later leaves the outbox', () => {
      /** A built and printed batch, and its hash. */
      const built = async (): Promise<{ scene: Scene; hash: string }> => {
        const scene = await alone([line('a plain request')]);
        expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
        expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
        const hash = printedHashes(scene)[0] ?? '';
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        scene.h.out.length = 0;
        return { scene, hash };
      };

      const expectWithdrawn = async (scene: Scene, hash: string): Promise<void> => {
        expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
        expect(scene.document()).toMatchObject({ batched: 0, withdrawn: 1 });
        expect(outboxFiles(scene)).toEqual([]);
        scene.h.out.length = 0;
        expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
        expect(printedHashes(scene)).toEqual([]);
        const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201) });
        await expect(poolDeposit(scene.h.deps, sendOptions(hash, pool.via))).rejects.toMatchObject({ problem: { code: 'batch_unknown' } });
        expect(pool.requests).toEqual([]);
      };

      it('a term added to the term file', async () => {
        const { scene, hash } = await built();
        writeFileSync(join(scene.staged.root, 'terms.txt'), `${TERM}\nplain\n`);
        await expectWithdrawn(scene, hash);
      });

      it('a folder taken off the allowlist', async () => {
        const { scene, hash } = await built();
        const state = join(scene.staged.storeDir, 'state.json');
        writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), allow: ['some-other-folder'] }));
        await expectWithdrawn(scene, hash);
      });

      it('a batch whose session the store no longer holds, such as one of another account', async () => {
        const { scene } = await built();
        const server = join(scene.staged.storeDir, 'pool-outbox', outboxFiles(scene)[0]?.split(/[\\/]/)[0] ?? '');
        const current = readdirSync(server).filter((name) => name.startsWith('v'))[0] ?? '';
        const orphan = `${'e'.repeat(16)}.${'f'.repeat(64)}.jsonl`;
        writeFileSync(join(server, current, orphan), '{}\n');
        expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
        expect(scene.document()).toMatchObject({ batched: 1, withdrawn: 1 });
        expect(readdirSync(join(server, current))).toHaveLength(1);
      });

      /** Rewrites every stored session record, the way an older capture or a damaged store would hold it. */
      const rewriteSessions = (scene: Scene, change: (session: { frame?: { model?: unknown } }) => void): void => {
        const file = join(scene.staged.storeDir, 'observations.jsonl');
        const isSession = (record: unknown): record is { kind: 'session'; frame?: { model?: unknown } } => at(record, 'kind') === 'session';
        const lines = readFileSync(file, 'utf8').split('\n').filter((text) => text !== '').map((text) => {
          const record: unknown = JSON.parse(text);
          if (isSession(record)) change(record);
          return JSON.stringify(record);
        });
        writeFileSync(file, `${lines.join('\n')}\n`);
      };

      it('a session the store holds without steps and frames', async () => {
        const { scene, hash } = await built();
        rewriteSessions(scene, (session) => {
          delete session.frame;
        });
        await expectWithdrawn(scene, hash);
      });

      it('a session the vocabulary now refuses', async () => {
        const { scene, hash } = await built();
        rewriteSessions(scene, (session) => {
          if (session.frame !== undefined) session.frame.model = 'acme-private-llm';
        });
        await expectWithdrawn(scene, hash);
      });

      it('the same sessions under another account', async () => {
        const { scene, hash } = await built();
        on(scene, 'post', '/v1/login', () => HttpResponse.json({ ...okLogin(), account: 'acct_two' }));
        expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
        scene.h.out.length = 0;
        expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
        expect(outboxFiles(scene)).toHaveLength(1);
        expect(outboxFiles(scene).join('')).not.toContain(hash);
        expect(scene.document()).toMatchObject({ batched: 1, withdrawn: 1 });
      });

      // The batch goes when its session fails a gate, not after the pass: a session handled later may throw, and the pass stops there.
      it('before a later session fails the pass', async () => {
        const { scene } = await built();
        addProject(scene.staged, 'second-folder', '66666666-6666-4666-8666-666666666666', [line('another plain request')]);
        await deposit(scene.staged.runtime, { allow: [OTHER_FOLDER, 'second-folder'], redactDomains: [], now: () => NOW });
        const state = join(scene.staged.storeDir, 'state.json');
        writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), allow: ['second-folder'] }));
        vi.mocked(skeletonOf).mockImplementationOnce(() => {
          throw new Error('the disk is full');
        });
        expect(await scene.cli('pool', 'deposit', '--server', POOL)).not.toBe(ExitCode.OK);
        expect(outboxFiles(scene)).toEqual([]);
      });

      it('before a later session fails the pass, when the term check stopped the first', async () => {
        const { scene } = await built();
        addProject(scene.staged, 'second-folder', '66666666-6666-4666-8666-666666666666', [line('another request')]);
        await deposit(scene.staged.runtime, { allow: [OTHER_FOLDER, 'second-folder'], redactDomains: [], now: () => NOW });
        writeFileSync(join(scene.staged.root, 'terms.txt'), `${TERM}
plain
`);
        vi.mocked(skeletonOf).mockImplementationOnce(() => {
          throw new Error('the disk is full');
        });
        expect(await scene.cli('pool', 'deposit', '--server', POOL)).not.toBe(ExitCode.OK);
        expect(outboxFiles(scene)).toEqual([]);
      });

      it('and says so in the text, in the singular', async () => {
        const { scene } = await built();
        const state = join(scene.staged.storeDir, 'state.json');
        writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), allow: ['some-other-folder'] }));
        expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
        expect(scene.h.out.join('')).toContain('Removed 1 batch of sessions that no longer pass the gates, have not ended, or are no longer in the store.');
      });

      // Nothing is sent from an older spelling: a deposit builds the session's batch again and removes the older file under its key, so a batch written before the wire spelled "not admitted" one way is not left to send.
      it('a batch of the same session written before the wire spelled a name one way is replaced, not kept', async () => {
        const { scene, hash } = await built();
        const server = join(scene.staged.storeDir, 'pool-outbox', outboxFiles(scene)[0]?.split(/[\\/]/)[0] ?? '');
        const current = readdirSync(server).filter((name) => name.startsWith('v'))[0] ?? '';
        const [name = ''] = readdirSync(join(server, current));
        const older = `${name.split('.')[0] ?? ''}.${'a'.repeat(64)}.jsonl`;
        writeFileSync(join(server, current, older), '{"native":"<literal>"}\n');
        expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
        expect(readdirSync(join(server, current))).toEqual([`${name.split('.')[0] ?? ''}.${hash}.jsonl`]);
      });
    });
  });

  describe('a session is built once it has ended', () => {
    const FOLDER = 'ended-folder';
    const MAIN = '66666666-6666-4666-8666-666666666666';
    const HOUR = 60 * 60 * 1000;
    // The harness clock of the command tests: the command reads it as now.
    const END = Date.parse('2026-10-23T00:00:00Z');
    const user = (text: string): string => JSON.stringify({ type: 'user', sessionId: MAIN, cwd: '/w', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: text } });

    /** Sets every file under a folder to one time, as the harness's files are when nothing has written them since. */
    const settle = (folder: string, at: number): void => {
      for (const name of readdirSync(folder, { recursive: true, encoding: 'utf8' })) {
        const path = join(folder, name);
        if (statSync(path).isFile()) utimesSync(path, at / 1000, at / 1000);
      }
    };

    interface Quiet {
      scene: Scene;
      agentFile: string;
    }

    /** A signed-in store holding one session and one subagent: the main last captured `mainHours` before the command runs, and the subagent `agentHours` before it. */
    const quiet = async (mainHours: number, agentHours: number): Promise<Quiet> => {
      const scene = setting();
      rmSync(join(scene.staged.projectsRoot, 'proj'), { recursive: true, force: true });
      addProject(scene.staged, FOLDER, MAIN, [user('a plain request')]);
      const agents = join(scene.staged.projectsRoot, FOLDER, MAIN, 'subagents');
      mkdirSync(agents, { recursive: true });
      const agentFile = join(agents, 'agent-a.jsonl');
      writeFileSync(agentFile, `${user('the subagent starts')}
`);
      await deposit(scene.staged.runtime, { allow: [FOLDER], redactDomains: [], now: () => END - mainHours * HOUR });
      writeFileSync(agentFile, `${user('the subagent starts')}
${user('and goes on')}
`);
      await deposit(scene.staged.runtime, { allow: [FOLDER], redactDomains: [], now: () => END - agentHours * HOUR });
      settle(scene.staged.projectsRoot, END - 10 * HOUR);
      settle(join(scene.staged.storeDir, 'raw'), END - 10 * HOUR);
      await signIn(scene);
      scene.h.deps.now = () => END;
      return { scene, agentFile };
    };

    const deposited = async (scene: Scene): Promise<void> => {
      scene.h.out.length = 0;
      expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
    };

    it('builds one batch when the session and its subagent have both been quiet for six hours', async () => {
      const { scene } = await quiet(7, 7);
      await deposited(scene);
      expect(scene.document()).toMatchObject({ sessions: 1, batched: 1, notEnded: 0, uncaptured: 0 });
      expect(outboxFiles(scene)).toHaveLength(1);
    });

    it('builds nothing while the subagent has been quiet for five hours, and withdraws the batch it built before', async () => {
      const { scene } = await quiet(7, 5);
      scene.h.deps.now = () => END + 2 * HOUR;
      await deposited(scene);
      expect(scene.document()).toMatchObject({ batched: 1, notEnded: 0 });
      expect(outboxFiles(scene)).toHaveLength(1);
      scene.h.deps.now = () => END;
      await deposited(scene);
      expect(scene.document()).toMatchObject({ sessions: 1, batched: 0, notEnded: 1, withdrawn: 1 });
      expect(outboxFiles(scene)).toEqual([]);
    });

    it('counts a captured subagent that has no root as not built', async () => {
      const { scene } = await quiet(7, 7);
      const folder = join(scene.staged.storeDir, 'skeletons');
      const agent = readdirSync(folder).filter((name) => name.includes('~'));
      expect(agent).toHaveLength(1);
      rmSync(join(folder, agent[0] ?? ''));
      await deposited(scene);
      expect(scene.document()).toMatchObject({ sessions: 1, batched: 0, uncaptured: 1, notEnded: 0 });
      expect(outboxFiles(scene)).toEqual([]);
    });

    it.each(['main', 'subagent'])('reads a transcript as still growing when its %s raw file is newer than the last capture', async (which) => {
      const { scene, agentFile } = await quiet(7, 7);
      const file = which === 'main' ? join(scene.staged.projectsRoot, FOLDER, `${MAIN}.jsonl`) : agentFile;
      const grown = END - 2 * HOUR;
      utimesSync(file, grown / 1000, grown / 1000);
      await deposited(scene);
      expect(scene.document()).toMatchObject({ batched: 0, notEnded: 1 });
      scene.h.deps.now = () => grown + 6 * HOUR;
      await deposited(scene);
      expect(scene.document()).toMatchObject({ batched: 1, notEnded: 0 });
    });
  });

  it('counts a session captured before steps and frames, and one the vocabulary refuses, without building either', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
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
    expect(outboxFiles(scene)).toEqual([]);
    expect(counted).toMatchObject({ batched: 0, uncaptured: at(counted, 'sessions') });

    rewrite((session) => {
      if (session.frame !== undefined) session.frame.model = 'acme-private-llm';
    });
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(outboxFiles(scene)).toEqual([]);
    expect(scene.h.out.join('')).toContain('refused by the vocabulary (transcripts[0].frame.model)');
    expect(scene.h.out.join('')).not.toContain('acme-private-llm');
    expect(scene.seen).toEqual([]);
  });
});

describe('the pool request that gets no answer', () => {
  it('names the pool server and the reason the network gave', async () => {
    const cause = new AggregateError([new Error('connect ECONNREFUSED ::1:9')], '');
    const fetching = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed', { cause }));
    try {
      const failure = await networkSender(harness().deps, 'pool-fetch')({ method: 'GET', url: new URL('/v1/covenant', POOL), headers: [] }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ exitCode: ExitCode.UNREACHABLE, step: 'pool-fetch', message: `Cannot reach the server at ${POOL}: connect ECONNREFUSED ::1:9` });
    } finally {
      fetching.mockRestore();
    }
  });
});

describe('oars pool outbox', () => {
  it('asks for a sign-in, and names the server', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'outbox')).toBe(ExitCode.USAGE);
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.AUTH);
  });

  it('says so when there is nothing to print', async () => {
    const scene = setting();
    await signIn(scene);
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('The outbox is empty');
  });

  it('prints each batch as it would be sent, with the credential as its size and nothing else masked, then its hash, and the body hashes to that hash', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const shown = scene.h.out.join('');
    const [hash] = printedHashes(scene);
    const bytes = batchBytes(scene)[0] ?? '';
    expect(hash).toBe(batchHash(bytes));
    const block = shown.slice(0, shown.indexOf('\nsha256:'));
    expect(block.startsWith('POST /v1/deposits HTTP/1.1\nhost: pool.test\nconnection: keep-alive\n')).toBe(true);
    for (const line of ['user-agent: oars/9.9.9', 'accept: application/json', `authorization: Bearer <credential: ${String(Buffer.byteLength(POOL_TOKEN))} bytes>`, 'content-type: application/json', `content-length: ${String(Buffer.byteLength(bytes))}`, 'accept-encoding: identity']) {
      expect(block.split('\n')).toContain(line);
    }
    // The body is everything after the blank line that ends the headers, less the one newline `printed` adds after it.
    const body = block.slice(block.indexOf('\n\n') + 2).replace(/\n$/, '');
    expect(body).toBe(bytes);
    expect(createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')).toBe(hash);
    expect([...scene.h.out, ...scene.h.err].join('')).not.toContain(POOL_TOKEN);
    expect(scene.seen).toEqual([]);
  });

  it('prints every part of a batch past one request, in order under the one hash, and the wire sender then receives those same requests', async () => {
    const scene = await batched();
    const file = join(scene.staged.storeDir, 'pool-outbox', outboxFiles(scene)[0] ?? '');
    const bytes = canonicalBytes({ ...JSON.parse(readFileSync(file, 'utf8')), pad: 'é'.repeat(700_000) });
    const hash = batchHash(bytes);
    const folder = join(file, '..');
    rmSync(file);
    writeFileSync(join(folder, `${outboxFiles(scene)[0]?.split(/[\\/]/).at(-1)?.split('.')[0] ?? ''}.${hash}.jsonl`), bytes);
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const shown = scene.h.out.join('');
    expect(printedHashes(scene)).toContain(hash);
    // The scene holds other batches too; this one's three requests are the last three before its hash line.
    const requests = shown.slice(0, shown.indexOf(`\nsha256: ${hash}`)).split(/\n(?=POST \/v1\/deposits HTTP\/1\.1\n)/).slice(-3);
    expect(requests).toHaveLength(3);
    // Each print: the part header pair, then the body after the blank line, and together the bodies are the batch.
    const printedBodies = requests.map((request, at) => {
      const lines = request.split('\n');
      expect(lines).toContain(`oars-part: ${String(at + 1)}/3`);
      expect(lines).toContain(`oars-batch: ${hash}`);
      return request.slice(request.indexOf('\n\n') + 2).replace(/\n$/, '');
    });
    expect(printedBodies.join('')).toBe(bytes);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': [answer(202, { ok: true, pending: 2 }), answer(202, { ok: true, pending: 1 }), answer(201, { ok: true })] });
    await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
    const posts = pool.requests.filter((request) => request.method === 'POST');
    expect(posts.map((request) => request.body)).toEqual(printedBodies);
    expect(posts.map((request) => request.headers.find(([name]) => name === 'oars-part')?.[1])).toEqual(['1/3', '2/3', '3/3']);
  });

  it('records that each batch was shown, one line for each print, and only for what printed', async () => {
    const scene = await batched();
    const outbox = join(scene.staged.storeDir, 'pool-outbox');
    expect(existsSync(join(outbox, readdirSync(outbox)[0] ?? '', 'shown.log'))).toBe(false);
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hashes = printedHashes(scene);
    expect(hashes.length).toBeGreaterThan(0);
    const log = readFileSync(join(outbox, readdirSync(outbox)[0] ?? '', 'shown.log'), 'utf8');
    expect(log.split('\n').filter((entry) => entry !== '').map((entry) => entry.split(' ')[0])).toEqual(hashes);
  });
});

describe('oars pool deposit --send', () => {
  const printedAndHash = async (scene: Scene): Promise<string> => {
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    return printedHashes(scene)[0] ?? '';
  };
  const only = (scene: Scene): string => join(scene.staged.storeDir, 'pool-outbox', ...[readdirSync(join(scene.staged.storeDir, 'pool-outbox'))[0] ?? ''], ...outboxFilePath(scene));
  const outboxFilePath = (scene: Scene): string[] => (outboxFiles(scene)[0] ?? '').split(/[\\/]/).slice(1);
  const edit = (scene: Scene): void => {
    const file = join(scene.staged.storeDir, 'pool-outbox', outboxFiles(scene)[0] ?? '');
    writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()} \n`);
  };

  it('sends a batch that was shown and is unchanged, once, as the bytes that were printed', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
    const outcome = await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
    expect(outcome.document).toMatchObject({ ok: true, hash, sent: true });
    const posts = pool.requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toBe(batchBytes(scene)[0]);
    expect(batchHash(posts[0]?.body ?? '')).toBe(hash);
  });

  it('sends a batch past one request in ordered parts under the cap, each naming the whole batch, and stops at a finished deposit', async () => {
    const scene = await batched();
    const file = join(scene.staged.storeDir, 'pool-outbox', outboxFiles(scene)[0] ?? '');
    const bytes = canonicalBytes({ ...JSON.parse(readFileSync(file, 'utf8')), pad: 'é'.repeat(700_000) });
    const hash = batchHash(bytes);
    const folder = join(file, '..');
    rmSync(file);
    writeFileSync(join(folder, `${outboxFiles(scene)[0]?.split(/[\\/]/).at(-1)?.split('.')[0] ?? ''}.${hash}.jsonl`), bytes);
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const parts = [answer(202, { ok: true, pending: 2 }), answer(202, { ok: true, pending: 1 }), answer(201, { ok: true })];
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': parts });
    await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
    const posts = pool.requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(3);
    expect(posts.map((request) => request.headers.find(([name]) => name === 'oars-part')?.[1])).toEqual(['1/3', '2/3', '3/3']);
    for (const request of posts) {
      expect(request.headers.find(([name]) => name === 'oars-batch')?.[1]).toBe(hash);
      expect(Buffer.byteLength(request.body ?? '', 'utf8')).toBeLessThan(1024 * 1024);
    }
    expect(posts.map((request) => request.body).join('')).toBe(bytes);
    // A part answered 201 means the deposit finished already, so the parts after it are not sent.
    const finished = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
    await poolDeposit(scene.h.deps, sendOptions(hash, finished.via));
    expect(finished.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    // A last part that is not 201, and a middle part that is neither 202 nor 201, are refusals.
    const refused = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': [answer(202, { ok: true }), answer(202, { ok: true }), answer(400, { error: 'part_mismatch', message: 'no' })] });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, refused.via))).rejects.toMatchObject({ problem: { status: 400 } });
    const early = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(500, { error: 'boom', message: 'no' }) });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, early.via))).rejects.toMatchObject({ problem: { status: 500 } });
  });

  it('refuses a batch that was never printed, and sends nothing', async () => {
    const scene = await batched();
    const hash = batchHash(batchBytes(scene)[0] ?? '');
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201) });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, pool.via))).rejects.toMatchObject({ exitCode: ExitCode.CONFLICT, problem: { code: 'batch_not_shown' } });
    expect(pool.requests).toEqual([]);
  });

  it('refuses a batch edited after it was printed, and sends nothing', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    edit(scene);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201) });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, pool.via))).rejects.toMatchObject({ exitCode: ExitCode.CONFLICT, problem: { code: 'batch_changed' } });
    expect(pool.requests).toEqual([]);
  });

  it('refuses a batch edited between the check and the send, and sends no deposit', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201) });
    const seam: Sender = (request) => {
      // The covenant is the last thing asked before the body is read for the final time.
      if (request.url.pathname === '/v1/covenant') edit(scene);
      return pool.via(request);
    };
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, seam))).rejects.toMatchObject({ exitCode: ExitCode.CONFLICT, problem: { code: 'batch_changed' } });
    expect(pool.requests.map((request) => request.url.pathname)).toEqual(['/v1/covenant']);
  });

  it('refuses a batch whose file was removed between the check and the send', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201) });
    const seam: Sender = (request) => {
      if (request.url.pathname === '/v1/covenant') rmSync(only(scene));
      return pool.via(request);
    };
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, seam))).rejects.toMatchObject({ problem: { code: 'batch_changed' } });
    expect(pool.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('refuses a hash that names no batch, and one that is not a SHA-256', async () => {
    const scene = await batched();
    const pool = wire({});
    await expect(poolDeposit(scene.h.deps, sendOptions('0'.repeat(64), pool.via))).rejects.toMatchObject({ problem: { code: 'batch_unknown' } });
    await expect(poolDeposit(scene.h.deps, sendOptions('not-a-hash', pool.via))).rejects.toMatchObject({ exitCode: ExitCode.USAGE });
    expect(pool.requests).toEqual([]);
  });

  it('refuses --accept-covenant without --send, as a usage error, and sends nothing', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--accept-covenant', 'v1', '--json')).toBe(ExitCode.USAGE);
    expect(JSON.stringify(scene.document())).toContain('--accept-covenant belongs to --send');
    expect(scene.seen).toEqual([]);
  });

  it('is disabled from the command line: every check runs, and then it refuses with no request made', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    scene.h.err.length = 0;
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--send', hash, '--json')).toBe(ExitCode.CONFLICT);
    expect(scene.document()).toMatchObject({ problem: { code: 'sending_disabled' } });
    expect(scene.seen).toEqual([]);
    // The checks do run first: a hash that was never printed is refused for that, not for the disabled send.
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--send', '1'.repeat(64), '--json')).toBe(ExitCode.CONFLICT);
    expect(scene.document()).toMatchObject({ problem: { code: 'batch_unknown' } });
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--send', hash)).toBe(ExitCode.CONFLICT);
    expect(scene.h.err.join('')).toContain('waits on the pool covenant');
  });

  it('sends a deposit again when the pool answers deposit_conflict, and does not count it as a refusal', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    const conflict = answer(409, { error: 'deposit_conflict', message: 'Another deposit of this session landed first.' });
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': [conflict, conflict, answer(201, { ok: true })] });
    const outcome = await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
    expect(outcome.document).toMatchObject({ ok: true, sent: true });
    const posts = pool.requests.filter((request) => request.method === 'POST');
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((request) => request.body)).size).toBe(1);
  });

  it('gives up on a deposit that keeps conflicting, and says what the pool said', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(409, { error: 'deposit_conflict', message: 'Another deposit of this session landed first.' }) });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, pool.via))).rejects.toThrow('Another deposit of this session landed first.');
    expect(pool.requests.filter((request) => request.method === 'POST')).toHaveLength(3);
  });

  it('passes on a refusal the pool names, such as a revoked credential', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(401, { error: 'unauthorized', message: 'Sign in with oars pool login first.' }) });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, pool.via))).rejects.toMatchObject({ exitCode: ExitCode.AUTH });
  });

  it('stops before the request when the pool is closed, and when the covenant is not accepted', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    const closed = wire({ 'GET /v1/covenant': answer(200, { version: null }) });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, closed.via))).rejects.toMatchObject({ problem: { code: 'deposits_closed' } });
    const unaccepted = wire({ 'GET /v1/covenant': answer(200, { version: 'v1', accepted: false }) });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, unaccepted.via))).rejects.toMatchObject({ problem: { code: 'covenant_not_accepted' } });
    const broken = wire({ 'GET /v1/covenant': answer(404, { error: 'not_found', message: 'No such route.' }) });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, broken.via))).rejects.toMatchObject({ exitCode: ExitCode.UNEXPECTED });
    for (const pool of [closed, unaccepted, broken]) expect(pool.requests.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('accepts the covenant version it was told to, and stops if the pool refuses that', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    const accepting = wire({ 'GET /v1/covenant': answer(200, { version: 'v1', accepted: false }), 'POST /v1/covenant/accept': answer(200, { ok: true, version: 'v1' }), 'POST /v1/deposits': answer(201) });
    await poolDeposit(scene.h.deps, { ...sendOptions(hash, accepting.via), acceptCovenant: 'v1' });
    expect(accepting.requests.find((request) => request.url.pathname === '/v1/covenant/accept')?.body).toBe(JSON.stringify({ version: 'v1' }));
    expect(accepting.requests.at(-1)?.url.pathname).toBe('/v1/deposits');

    const stale = wire({ 'GET /v1/covenant': answer(200, { version: 'v2', accepted: false }), 'POST /v1/covenant/accept': answer(409, { error: 'covenant_version', message: 'The current covenant is v2.' }) });
    await expect(poolDeposit(scene.h.deps, { ...sendOptions(hash, stale.via), acceptCovenant: 'v1' })).rejects.toMatchObject({ exitCode: ExitCode.UNEXPECTED });
    expect(stale.requests.map((request) => request.url.pathname)).toEqual(['/v1/covenant', '/v1/covenant/accept']);
  });

  it('builds the request the print showed, with the credential in the header and nothing in the URL', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201) });
    await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
    const post = pool.requests.find((request) => request.method === 'POST');
    expect(post?.headers).toContainEqual(['authorization', `Bearer ${POOL_TOKEN}`]);
    expect(post?.url.toString()).toBe(`${POOL}/v1/deposits`);
  });
});

describe('oars pool outbox --explain and older batches', () => {
  it('prints each field of the batch with its row', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--explain', '--server', POOL)).toBe(ExitCode.OK);
    const shown = scene.h.out.join('');
    const fields = fieldsOf(batchBytes(scene)[0] ?? '');
    expect(fields.length).toBeGreaterThan(3);
    for (const field of fields) expect(shown).toContain(`  ${field}: ${FIELD_ROWS[field] ?? 'no row'}`);
  });

  it('fails, rather than printing a blank, for a field with no row', async () => {
    const scene = await batched();
    const outbox = join(scene.staged.storeDir, 'pool-outbox', readdirSync(join(scene.staged.storeDir, 'pool-outbox'))[0] ?? '');
    await writeBatch(outbox, 'cccccccccccccccc', { format: 1, id: 'x', transcripts: [], surprise: 1 });
    expect(await scene.cli('pool', 'outbox', '--explain', '--server', POOL, '--json')).toBe(ExitCode.INVALID);
    expect(scene.document()).toMatchObject({ problem: { code: 'field_without_row' } });
    expect(JSON.stringify(scene.document())).toContain('surprise');
  });

  it('fails for a field with no row at any depth, not only at the top', async () => {
    const scene = await batched();
    const outbox = join(scene.staged.storeDir, 'pool-outbox', readdirSync(join(scene.staged.storeDir, 'pool-outbox'))[0] ?? '');
    await writeBatch(outbox, 'cccccccccccccccc', { format: 1, id: 'x', transcripts: [{ frame: { stack: { surprise: 1 } }, tools: [{ steps: [{ identity: { surprise: 2 } }] }] }] });
    expect(await scene.cli('pool', 'outbox', '--explain', '--server', POOL, '--json')).toBe(ExitCode.INVALID);
    expect(scene.document()).toMatchObject({ problem: { code: 'field_without_row' } });
    expect(JSON.stringify(scene.document())).toContain('surprise');
  });

  it('discards a batch built under an older vocabulary, field list, or skeleton format: never printed, never sent, counted by deposit', async () => {
    const scene = await batched();
    const outbox = join(scene.staged.storeDir, 'pool-outbox', readdirSync(join(scene.staged.storeDir, 'pool-outbox'))[0] ?? '');
    const old = await writeBatch(outbox, 'dddddddddddddddd', { format: 1, id: 'old', transcripts: [] }, 'v0-00000000');
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    expect(printedHashes(scene)).not.toContain(old.hash);
    expect(scene.h.out.join('')).toContain('1 batch was built under an older vocabulary, field list, or skeleton format and will never be sent.');
    await expect(poolDeposit(scene.h.deps, sendOptions(old.hash, wire({}).via))).rejects.toMatchObject({ problem: { code: 'batch_unknown' } });
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('Discarded 1 batch built under an older vocabulary, field list, or skeleton format.');
    expect(existsSync(old.folder)).toBe(false);
  });

  it('does not print a batch whose file was edited since it was written, and says how many', async () => {
    const scene = await batched();
    const file = join(scene.staged.storeDir, 'pool-outbox', outboxFiles(scene)[0] ?? '');
    const edited = batchHash(readFileSync(file, 'utf8'));
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n`);
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    expect(printedHashes(scene)).not.toContain(edited);
    expect(printedHashes(scene)).toHaveLength(outboxFiles(scene).length - 1);
    expect(scene.h.out.join('')).toContain('1 batch was edited on disk since it was written and is not printed or sent.');
  });
});

describe('oars pool fetch', () => {
  it('has no pull, since that word belongs to recall: it is an unknown command', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'pull', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(scene.h.err.join('')).toContain("unknown command 'pull'");
    expect(scene.seen).toEqual([]);
  });

  const bundleBody = (version: string, harness = 'claude-code'): string => JSON.stringify({ format: 1, harness, harnessVersion: version, vocabVersion: VOCAB_VERSION, asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: [{}, {}], strata: [] });

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
    on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, () => HttpResponse.json({ payload, signature }));
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
    on(scene, 'get', `/bundle/claude-code/2.1.9/${VOCAB_VERSION}`, () => HttpResponse.json({ payload, signature }));
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.9', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('Fetched claude-code 2.1.9: 2 reads');
  });

  it('fetches the bundle of a harness with no version on record by asking for `unknown`, and keeps it under that name', async () => {
    const { scene, sign } = await signedScene();
    const payload = bundleBody('unknown', 'cursor');
    const signature = await sign(payload);
    on(scene, 'get', `/bundle/cursor/unknown/${VOCAB_VERSION}`, () => HttpResponse.json({ payload, signature }));
    expect(await scene.cli('pool', 'fetch', '--harness', 'cursor', '--harness-version', 'unknown', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(scene.document()).toMatchObject({ ok: true, harness: 'cursor', harnessVersion: 'unknown', reads: 2, cells: 1 });
    expect(replicas(scene)).toHaveLength(1);
  });

  it('refuses a tampered bundle and a bundle of another harness version, and keeps neither', async () => {
    const { scene, sign } = await signedScene();
    const payload = bundleBody('2.1.314');
    const signature = await sign(payload);
    on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, () => HttpResponse.json({ payload: payload.replace('"cells":[{}]', '"cells":[{},{}]'), signature }));
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.INVALID);
    expect(scene.document()).toMatchObject({ problem: { code: 'bundle_unverified' } });
    expect(replicas(scene)).toEqual([]);

    on(scene, 'get', `/bundle/claude-code/2.1.9/${VOCAB_VERSION}`, () => HttpResponse.json({ payload, signature }));
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.9', '--server', POOL)).toBe(ExitCode.INVALID);
    expect(replicas(scene)).toEqual([]);
  });

  it('refuses a harness version the vocabulary does not hold before asking, asks for a sign-in, and takes the weekly cap as its own exit code', async () => {
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

    on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, () => HttpResponse.json({ error: 'fetch_cap', message: 'An account without access may fetch 1 per ISO week.' }, { status: 429 }));
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.CAPPED);
    expect(scene.document()).toMatchObject({ problem: { code: 'fetch_cap' } });

    const anon = setting();
    expect(await anon.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.AUTH);
  });

  /** One handler for the bundle route that records each request, snapshots what had been printed when it arrived, and answers from a queue. */
  const bundleRoute = (scene: Scene, version: string, replies: Array<(request: Request) => Response>, harness = 'claude-code'): Array<{ headers: Headers; printedBefore: string }> => {
    const arrivals: Array<{ headers: Headers; printedBefore: string }> = [];
    server.use(
      http.get(`${POOL}/bundle/${harness}/${version}/${VOCAB_VERSION}`, ({ request }) => {
        arrivals.push({ headers: request.headers, printedBefore: scene.h.err.join('') });
        scene.seen.push({ url: request.url, headers: JSON.stringify([...request.headers.entries()]), body: '', err: scene.h.err.join('') });
        return (replies.shift() ?? (() => new HttpResponse(null, { status: 500 })))(request);
      }),
    );
    return arrivals;
  };

  const signedReply = async (sign: (text: string) => Promise<string>, version: string, etag: string | null, reads = 2, harness = 'claude-code'): Promise<() => Response> => {
    const payload = JSON.stringify({ format: 1, harness, harnessVersion: version, vocabVersion: VOCAB_VERSION, asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: Array.from({ length: reads }, () => ({})), strata: [] });
    const signature = await sign(payload);
    return () => HttpResponse.json({ payload, signature }, etag === null ? {} : { headers: { etag } });
  };

  const keptFile = (scene: Scene): string => join(scene.staged.storeDir, 'pool-replica', readdirSync(join(scene.staged.storeDir, 'pool-replica'))[0] ?? '', 'claude-code', '2.1.314.json');

  describe('names its harness', () => {
    const serve = async (scene: Scene, sign: (text: string) => Promise<string>, harness: string, version = '2.1.314', etag: string | null = null): Promise<Array<{ headers: Headers; printedBefore: string }>> => bundleRoute(scene, version, [await signedReply(sign, version, etag, 2, harness)], harness);

    /** A store that holds `count` sessions of each harness, written as the capture log holds them (the fixture's rows, no transcripts). */
    const holding = (scene: Scene, counts: ReadonlyArray<readonly ['claude-code' | 'cursor' | 'codex', number]>): void => {
      const rows = counts.flatMap(([name, count]) => Array.from({ length: count }, (_, index) => JSON.stringify(sessionRow(`${name}-${String(index)}`, name === 'claude-code' ? {} : { harness: name }))));
      writeFileSync(join(scene.staged.storeDir, 'observations.jsonl'), `${rows.join('\n')}\n`);
    };

    it('asks for the harness --harness names, keeps it under that harness, and prints no choice line', async () => {
      const { scene, sign } = await signedScene();
      const arrivals = await serve(scene, sign, 'cursor');
      expect(await scene.cli('pool', 'fetch', '--harness', 'cursor', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      expect(arrivals).toHaveLength(1);
      expect(scene.seen[0]?.url).toBe(`${POOL}/bundle/cursor/2.1.314/${VOCAB_VERSION}`);
      expect(scene.document()).toMatchObject({ ok: true, harness: 'cursor', harnessVersion: '2.1.314' });
      expect(String(at(scene.document(), 'file'))).toContain(join('cursor', '2.1.314.json'));
      expect(scene.h.err.join('')).not.toContain('No --harness given');
    });

    it('refuses a harness the pool does not serve before asking, and lists the ones it does', async () => {
      const { scene } = await signedScene();
      expect(await scene.cli('pool', 'fetch', '--harness', 'acme', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.USAGE);
      expect(scene.h.err.join('')).toContain('acme is not a harness the pool serves. Choose one of claude-code, cursor, codex, copilot, gemini, grok, vscode-copilot.');
      expect(scene.seen).toEqual([]);
    });

    it('refuses a validly signed bundle of another harness, and keeps nothing', async () => {
      const { scene, sign } = await signedScene();
      // The pool signs a cursor bundle and a claude-code request is answered with it: the signature holds and the version is right, so only the harness is wrong.
      bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', null, 2, 'cursor')], 'claude-code');
      expect(await scene.cli('pool', 'fetch', '--harness', 'claude-code', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.INVALID);
      expect(scene.document()).toMatchObject({ problem: { code: 'bundle_unverified', title: 'Refused the bundle: this bundle is for harness cursor, not claude-code.' } });
      expect(replicas(scene)).toEqual([]);
    });

    it('defaults to the harness the local store holds the most sessions of, says so on stderr, and sends no count', async () => {
      const { scene, sign } = await signedScene();
      holding(scene, [['cursor', 3], ['claude-code', 1]]);
      const arrivals = await serve(scene, sign, 'cursor');
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      // The choice is on stderr before the request goes out, not after it.
      expect(arrivals[0]?.printedBefore).toContain('No --harness given: fetching cursor');
      expect(scene.h.err.join('')).toContain('No --harness given: fetching cursor, the harness your local store holds the most sessions of (3 of 4). Pass --harness <name> to fetch another (claude-code, cursor, codex, copilot, gemini, grok, vscode-copilot).');
      expect(scene.document()).toMatchObject({ ok: true, harness: 'cursor' });
      // Counts stay here: the request names the harness and the versions, nothing else.
      expect(scene.seen[0]?.url).toBe(`${POOL}/bundle/cursor/2.1.314/${VOCAB_VERSION}`);
      expect(scene.seen[0]?.body).toBe('');
    });

    it('reads no store and prints no choice line for a signed-out fetch with no --harness', async () => {
      const scene = setting();
      mkdirSync(scene.staged.storeDir, { recursive: true });
      holding(scene, [['cursor', 3]]);
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.AUTH);
      expect(scene.h.err.join('')).toContain('oars pool login');
      expect(scene.h.err.join('')).not.toContain('No --harness given');
      expect(scene.seen).toEqual([]);
    });

    it('asks for claude-code and says so when the store is empty or two harnesses tie', async () => {
      const empty = await signedScene();
      await serve(empty.scene, empty.sign, 'claude-code');
      expect(await empty.scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      expect(empty.scene.seen[0]?.url).toBe(`${POOL}/bundle/claude-code/2.1.314/${VOCAB_VERSION}`);
      expect(empty.scene.h.err.join('')).toContain('No --harness given: fetching claude-code, your local store is empty, so Claude Code is the default. Pass --harness <name> to fetch another (');

      const tied = await signedScene();
      holding(tied.scene, [['cursor', 2], ['codex', 2], ['claude-code', 1]]);
      await serve(tied.scene, tied.sign, 'claude-code');
      expect(await tied.scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      expect(tied.scene.seen[0]?.url).toBe(`${POOL}/bundle/claude-code/2.1.314/${VOCAB_VERSION}`);
      expect(tied.scene.h.err.join('')).toContain('No --harness given: fetching claude-code, no one harness leads your local store, so Claude Code is the default. Pass --harness <name> to fetch another (');
    });

    it('keeps one bundle per harness: two fetches of one version, then a read for each', async () => {
      const { scene, sign } = await signedScene();
      const claude = bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', '"claude-tag"', 2, 'claude-code'), () => new HttpResponse(null, { status: 304 })], 'claude-code');
      const cursor = bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', '"cursor-tag"', 3, 'cursor'), () => new HttpResponse(null, { status: 304 })], 'cursor');
      const fetchOf = (name: string): Promise<ExitCode> => scene.cli('pool', 'fetch', '--harness', name, '--harness-version', '2.1.314', '--server', POOL, '--json');
      expect(await fetchOf('claude-code')).toBe(ExitCode.OK);
      const claudeFile = String(at(scene.document(), 'file'));
      expect(await fetchOf('cursor')).toBe(ExitCode.OK);
      const cursorFile = String(at(scene.document(), 'file'));
      // Two files; the second fetch did not overwrite the first.
      expect(cursorFile).not.toBe(claudeFile);
      expect(replicas(scene)).toHaveLength(2);
      expect(String(at(JSON.parse(readFileSync(claudeFile, 'utf8')), 'payload'))).toContain('"harness":"claude-code"');
      expect(String(at(JSON.parse(readFileSync(cursorFile, 'utf8')), 'payload'))).toContain('"harness":"cursor"');
      // The read of each kept bundle is conditional on its own ETag and answers from its own counts.
      expect(await fetchOf('claude-code')).toBe(ExitCode.OK);
      expect(scene.document()).toMatchObject({ harness: 'claude-code', unchanged: true, reads: 2 });
      expect(await fetchOf('cursor')).toBe(ExitCode.OK);
      expect(scene.document()).toMatchObject({ harness: 'cursor', unchanged: true, reads: 3 });
      expect(claude[1]?.headers.get('if-none-match')).toBe('"claude-tag"');
      expect(cursor[1]?.headers.get('if-none-match')).toBe('"cursor-tag"');
    });

    it('does not read another harness bundle as the kept one, even when it sits at this harness path', async () => {
      const { scene, sign } = await signedScene();
      bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', '"claude-tag"', 2, 'claude-code')], 'claude-code');
      expect(await scene.cli('pool', 'fetch', '--harness', 'claude-code', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      const claudeFile = String(at(scene.document(), 'file'));
      const cursorFile = join(claudeFile, '..', '..', 'cursor', '2.1.314.json');
      mkdirSync(join(cursorFile, '..'), { recursive: true });
      writeFileSync(cursorFile, readFileSync(claudeFile));
      const second = bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', '"cursor-tag"', 2, 'cursor')], 'cursor');
      expect(await scene.cli('pool', 'fetch', '--harness', 'cursor', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      // The copy verifies under the key but names the wrong harness, so it is no kept bundle: no If-None-Match went out.
      expect(second[0]?.headers.get('if-none-match')).toBeNull();
      expect(scene.document()).toMatchObject({ harness: 'cursor', unchanged: false });
    });
  });

  describe('prints before it sends', () => {
    it('prints the request line and every header before the request arrives, with the credential as its size and nothing else masked', async () => {
      const { scene, sign } = await signedScene();
      const arrivals = bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', '"e1"')]);
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      const before = arrivals[0]?.printedBefore ?? '';
      expect(before).toContain(`GET /bundle/claude-code/2.1.314/${VOCAB_VERSION} HTTP/1.1\nhost: pool.test\nconnection: keep-alive\n`);
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
      expect(scene.h.err.join('')).toContain(`GET /bundle/claude-code/2.1.314/${VOCAB_VERSION} HTTP/1.1`);
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
      expect(scene.h.out.join('')).toContain('claude-code 2.1.314 is unchanged');
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
      expect(scene.h.err.join('')).toContain('The bundle already on disk is untouched.');
      // Nothing reads the kept bundle yet, so the message promises nothing about what reads it.
      expect(scene.h.err.join('')).not.toContain('recall');
    });

    it('a refusal the pool names (a revoked credential, 401) passes on as its own exit code and message, and the bundle on disk is untouched', async () => {
      const { scene, sign } = await signedScene();
      const revoked = (): Response => HttpResponse.json({ error: 'unauthorized', message: 'This credential is no longer valid.' }, { status: 401 });
      bundleRoute(scene, '2.1.314', [await signedReply(sign, '2.1.314', '"e1"'), revoked]);
      await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL);
      const before = readFileSync(keptFile(scene));
      scene.h.err.length = 0;
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.AUTH);
      expect(scene.h.err.join('')).toContain('This credential is no longer valid.');
      expect(readFileSync(keptFile(scene)).equals(before)).toBe(true);
    });

    it('a 429 as a date, and one with nothing kept yet, are read the same way', async () => {
      const { scene } = await signedScene();
      const date = new Date(scene.h.deps.now() + 3 * 3_600_000).toUTCString();
      bundleRoute(scene, '2.1.314', [() => HttpResponse.json({ error: 'fetch_cap' }, { status: 429, headers: { 'retry-after': date } }), () => HttpResponse.json({ error: 'fetch_cap' }, { status: 429, headers: { 'retry-after': 'soon' } })]);
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.CAPPED);
      expect(scene.h.err.join('')).toContain('Try again in 3 hours.');
      expect(scene.h.err.join('')).toContain('No verified bundle is kept.');
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

describe('oars pool deposit: local deltas', () => {
  const FOLDER = 'zz-delta-repo';
  const sid = (n: number): string => `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`;
  const lineOf = (n: number, day: string, mode: string): string => JSON.stringify({ type: 'user', sessionId: sid(n), cwd: '/w', timestamp: `2026-05-${day}T0${String(n % 10)}:00:00Z`, permissionMode: mode, message: { role: 'user', content: 'a plain request' } });

  /** Five sessions in a first week in `default` mode, and `later` in the next week in `plan` mode, all ended: the 5th of the later ones fills the after window. */
  const weeks = async (later: number): Promise<Scene> => {
    const scene = setting();
    rmSync(join(scene.staged.projectsRoot, 'proj'), { recursive: true, force: true });
    for (let n = 0; n < 5; n += 1) addProject(scene.staged, FOLDER, sid(n), [lineOf(n, '01', 'default')]);
    for (let n = 0; n < later; n += 1) addProject(scene.staged, FOLDER, sid(10 + n), [lineOf(10 + n, '09', 'plan')]);
    await deposit(scene.staged.runtime, { allow: [FOLDER], redactDomains: [], now: () => NOW });
    await signIn(scene);
    return scene;
  };

  const deposited = async (scene: Scene): Promise<ExitCode> => {
    scene.h.out.length = 0;
    return scene.cli('pool', 'deposit', '--server', POOL, '--json');
  };

  /** The deltas of every batch in the outbox, each with the batch it rode in. */
  const carriedBy = (scene: Scene): { batch: number; entry: unknown }[] =>
    batchBytes(scene).flatMap((bytes, batch) => {
      const deltas: unknown = at(JSON.parse(bytes), 'deltas');
      return Array.isArray(deltas) ? deltas.map((entry: unknown) => ({ batch, entry })) : [];
    });

  const logOf = (scene: Scene): string[] => {
    const root = join(scene.staged.storeDir, 'pool-outbox');
    const found = existsSync(root) ? readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('deltas-sent.log')) : [];
    return found.flatMap((name) => readFileSync(join(root, name), 'utf8').split('\n').filter((line) => line !== ''));
  };

  const MODE_DELTA = { deltaKind: 'changed', field: 'permissionMode', name: null, registry: null, metric: 'callsPerSession', change: 0 };

  beforeEach(() => {
    vi.mocked(skeletonOf).mockClear();
  });

  it('carries no delta while the after window holds 4 sessions', async () => {
    const scene = await weeks(4);
    expect(await deposited(scene)).toBe(ExitCode.OK);
    expect(scene.document()).toMatchObject({ batched: 9 });
    expect(carriedBy(scene)).toEqual([]);
    expect(logOf(scene)).toEqual([]);
  });

  it('carries the delta in one batch once the after window fills, and marks it sent', async () => {
    const scene = await weeks(5);
    expect(await deposited(scene)).toBe(ExitCode.OK);
    expect(scene.document()).toMatchObject({ batched: 10, refused: 0 });
    const carried = carriedBy(scene);
    expect(carried.map(({ entry }) => entry)).toEqual([MODE_DELTA]);
    expect(logOf(scene)).toHaveLength(1);
    // The batch that carries it is the 5th session of the after window, the filler.
    const [only] = carried;
    expect(at(JSON.parse(batchBytes(scene)[only?.batch ?? -1] ?? 'null'), 'id')).toBe(contentHash(['acct_one', sid(14)]));
    // The entry names no session, no root, no date, and neither mode.
    const text = JSON.stringify(carried);
    expect(text).not.toMatch(/66666666|merkle|2026|default|plan/);
  });

  it('shows the delta under --explain, with a row for each of its fields', async () => {
    const scene = await weeks(5);
    expect(await deposited(scene)).toBe(ExitCode.OK);
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'outbox', '--explain', '--server', POOL)).toBe(ExitCode.OK);
    const shown = scene.h.out.join('');
    expect(scene.h.err.join('')).not.toContain('field_without_row');
    for (const field of ['deltas', 'deltaKind', 'field', 'name', 'registry', 'metric', 'change']) expect(shown).toContain(`  ${field}: ${FIELD_ROWS[field] ?? 'no row'}`);
  });

  it('builds a delta once: a second deposit rebuilds every batch without it, and the mark stays', async () => {
    const scene = await weeks(5);
    expect(await deposited(scene)).toBe(ExitCode.OK);
    const marks = logOf(scene);
    expect(carriedBy(scene)).toHaveLength(1);
    expect(await deposited(scene)).toBe(ExitCode.OK);
    expect(scene.document()).toMatchObject({ batched: 10 });
    // The limit: the batch that carried the delta is replaced by one without it, sent or not, since the mark was written with the batch.
    expect(carriedBy(scene)).toEqual([]);
    expect(logOf(scene)).toEqual(marks);
  });

  it('marks nothing when the deposit stops before the batch is written, and builds the delta again', async () => {
    const scene = await weeks(5);
    const real = vi.mocked(skeletonOf).getMockImplementation();
    if (real === undefined) throw new Error('no projection to wrap');
    vi.mocked(skeletonOf).mockImplementation((records, ...rest) => {
      if (records.main.session === sid(14)) throw new Error('the deposit stopped');
      return real(records, ...rest);
    });
    try {
      expect(await deposited(scene)).not.toBe(ExitCode.OK);
      expect(logOf(scene)).toEqual([]);
      expect(carriedBy(scene)).toEqual([]);
    } finally {
      vi.mocked(skeletonOf).mockImplementation(real);
    }
    expect(await deposited(scene)).toBe(ExitCode.OK);
    expect(carriedBy(scene).map(({ entry }) => entry)).toEqual([MODE_DELTA]);
    expect(logOf(scene)).toHaveLength(1);
  });
});
