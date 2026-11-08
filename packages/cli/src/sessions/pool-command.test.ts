import { createHash, webcrypto } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { defaultConfigDir } from '../credentials.js';
import { ExitCode } from '../errors.js';
import { readSpool } from '../telemetry/spool.js';
import { harness, server, useServer, type Harness } from '../test-support.js';
import { DEFAULT_POOL_URL, networkSender, poolCoverage, poolDeposit, poolServer, RAW_PROMPT, type Reply, type Sender } from './pool-command.js';
import { localNames } from './redact.js';
import { batchHash, canonicalBytes, FIELD_ROWS, fieldsOf, outboxFolder, writeBatch } from './pool-outbox.js';
import { markSent, sentHashes } from './pool-sent.js';
import { withSendLock } from './pool-send-lock.js';
import type { Outgoing } from './pool-print.js';
import { REGISTRY_MAX_AGE_DAYS, VOCAB_SNAPSHOT_DATE } from './public-vocabulary.js';
import type * as PoolWire from './pool-wire.js';
import { session as sessionRow } from './pool-fixture.js';
import { slugOf } from './allow.js';
import { parseSkeleton, skeletonOf, VOCAB_VERSION, type PinnedKey, type SkeletonFrame } from './pool-wire.js';
import { contentHash } from './read.js';
import { deposit, updatePoolChoices } from './store.js';
import { spoolEvents } from '../telemetry/read-events.js';
import { addProject, cleanup, NOW, settledClock, stage, TEST_FLOOR, type Staged } from './test-support.js';

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
const SHARED = '77777777-7777-4777-8777-777777777777';

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
  const h = harness({ OARS_EXCLUSION_TERMS: termsFile, ...env });
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

// Invented values: none is a real handle or token.
const HANDLE = 'a-sealed-login-handle';
const POOL_TOKEN = 'a-pool-token';

/** The pool's answer to the poll that finds the person approved. */
const okLogin = (signingKey: PinnedKey = FIXED_KEY): object => ({ status: 'authorized', token: POOL_TOKEN, account: 'acct_one', expiresAt: LATER, signingKey });
const authorized = (signingKey: PinnedKey = FIXED_KEY): Response => HttpResponse.json(okLogin(signingKey));
/** What the pool answers while the person has not approved, or tells the client to slow down. */
const state = (status: string): Response => HttpResponse.json({ status });

interface PoolOptions {
  /** Fields of the start answer to change; an undefined one is dropped. */
  start?: object;
  /** The answers to successive polls; the last stands once the list is spent. */
  polls?: Response[];
}

/** A fake pool: the start route and the poll route, each recording what arrived. */
const poolAt = (scene: Scene, { start = {}, polls = [authorized()] }: PoolOptions = {}, base: string = POOL): void => {
  const record = async (request: Request): Promise<void> => {
    scene.seen.push({ url: request.url, headers: JSON.stringify([...request.headers.entries()]), body: await request.text(), err: scene.h.err.join('') });
  };
  server.use(
    http.post(`${base}/v1/login/start`, async ({ request }) => {
      await record(request);
      return HttpResponse.json({ handle: HANDLE, userCode: 'USER-1', verificationUrl: 'https://provider.test/device', interval: 2, expiresIn: 10, ...start });
    }),
    http.post(`${base}/v1/login/poll`, async ({ request }) => {
      await record(request);
      return polls.length > 1 ? (polls.shift() ?? authorized()) : (polls[0]?.clone() ?? authorized());
    }),
  );
};

/** One sign-in at once: the pool answers a credential on the first poll. */
const signIn = async (scene: Scene, signingKey: PinnedKey = FIXED_KEY): Promise<void> => {
  poolAt(scene, { polls: [authorized(signingKey)] });
  expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
  scene.seen.length = 0;
  scene.h.out.length = 0;
  scene.h.err.length = 0;
};

const capture = (scene: Scene): Promise<unknown> => deposit(scene.staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });

const at = (value: unknown, name: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined);

describe('the raw prompt states when and what uploads', () => {
  it('names the nightly task, covenant acceptance, and the skeleton-only/off exception', () => {
    expect(RAW_PROMPT).toContain('the nightly task uploads');
    expect(RAW_PROMPT).toContain('once the pool says your account accepted its covenant');
    expect(RAW_PROMPT).toContain('except a folder you set to skeleton only or off');
  });
});

describe('the pool server', () => {
  it('defaults to the Many Oars pool, and takes a flag over the environment over the default', () => {
    expect(DEFAULT_POOL_URL).toBe('https://pool.manyoars.com');
    expect(poolServer({}, 's')).toBe(DEFAULT_POOL_URL);
    expect(poolServer({ OARS_POOL_URL: '' }, 's')).toBe(DEFAULT_POOL_URL);
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

  it('with no server named, a command asks for a sign-in to the Many Oars pool, and sends nothing', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'deposit')).toBe(ExitCode.AUTH);
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.0')).toBe(ExitCode.AUTH);
    expect(scene.h.err.join('')).toContain(DEFAULT_POOL_URL);
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
  it.each(['github', 'google'] as const)('signs in by %s through the pool alone: it starts, shows the code, polls at the interval, and pins the key', async (flavor) => {
    const scene = setting();
    poolAt(scene, { polls: [state('pending'), state('slow_down'), authorized()] });
    expect(await scene.cli('pool', 'login', '--provider', flavor, '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(scene.document()).toEqual({ ok: true, server: POOL, account: 'acct_one', expiresAt: LATER });
    expect(scene.h.err.join('')).toContain('https://provider.test/device');
    expect(scene.h.err.join('')).toContain('USER-1');
    expect(scene.h.opened).toEqual(['https://provider.test/device']);
    // The interval it was told, then five more seconds from the slow_down.
    expect(scene.h.sleeps).toEqual([2000, 2000, 7000]);

    // Every request goes to the pool: the provider is never reached from here.
    expect(scene.seen.map((entry) => entry.url)).toEqual([`${POOL}/v1/login/start`, `${POOL}/v1/login/poll`, `${POOL}/v1/login/poll`, `${POOL}/v1/login/poll`]);
    expect(JSON.parse(scene.seen[0]?.body ?? '')).toEqual({ provider: flavor });
    for (const poll of scene.seen.slice(1)) expect(JSON.parse(poll.body)).toEqual({ handle: HANDLE });

    const saved = join(scene.staged.storeDir, 'pool-accounts.json');
    expect(readFileSync(saved, 'utf8')).toContain(POOL_TOKEN);
    expect(readFileSync(saved, 'utf8')).not.toContain(HANDLE);
    if (process.platform !== 'win32') expect(statSync(saved).mode & 0o777).toBe(0o600);
  });

  it('says signed in, in words, without --json', async () => {
    const scene = setting();
    poolAt(scene);
    expect(await scene.cli('pool', 'login', '--provider', 'google', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toBe(`Signed in to ${POOL} as acct_one.\n`);
  });

  it('goes on with a printed link when no browser opens', async () => {
    const scene = setting();
    scene.h.deps.openBrowser = () => Promise.reject(new Error('no browser'));
    poolAt(scene);
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
    poolAt(scene, { start: { verificationUrl: 'not a url' } });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
    expect(scene.h.err.join('')).toContain('The pool did not start a sign-in.');
    expect(opened).toBe(false);
    expect(scene.seen).toHaveLength(1);
  });

  it.each([
    ['a pool with no client ID', 503, 'not_configured', ExitCode.UNREACHABLE],
    ['a provider that would not start', 502, 'provider_error', ExitCode.UNREACHABLE],
  ])('names what %s answered at the start, and polls nothing', async (_name, status, code, expected) => {
    const scene = setting();
    server.use(http.post(`${POOL}/v1/login/start`, () => HttpResponse.json({ error: code, message: 'The pool says no.' }, { status })));
    const exit = await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json');
    expect(exit).toBe(expected);
    expect(scene.document()).toMatchObject({ problem: { code, status } });
    expect(scene.h.sleeps).toEqual([]);
    expect(existsSync(join(scene.staged.storeDir, 'pool-accounts.json'))).toBe(false);
  });

  it('polls on the defaults when the pool names no interval', async () => {
    const scene = setting();
    poolAt(scene, { start: { interval: undefined, expiresIn: undefined } });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.sleeps).toEqual([5000]);
  });

  it.each([0, -3])('takes the default wait for an interval of %i, rather than polling with none', async (interval) => {
    const scene = setting();
    poolAt(scene, { start: { interval }, polls: [state('pending'), authorized()] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.sleeps).toEqual([5000, 5000]);
  });

  it('refuses a provider it does not know, before sending anything', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'login', '--provider', 'facebook', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(await scene.cli('pool', 'login', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(scene.seen).toEqual([]);
  });

  it('needs no provider setting of its own: no client ID or secret is read from the environment', async () => {
    const sentinels = ['sentinel-github-client-id', 'sentinel-google-client-id', 'sentinel-google-client-secret'];
    const scene = setting({ OARS_GITHUB_CLIENT_ID: sentinels[0], OARS_GOOGLE_CLIENT_ID: sentinels[1], OARS_GOOGLE_CLIENT_SECRET: sentinels[2] });
    poolAt(scene);
    expect(await scene.cli('pool', 'login', '--provider', 'google', '--server', POOL)).toBe(ExitCode.OK);
    const everything = scene.sent() + scene.h.out.join('') + scene.h.err.join('');
    for (const sentinel of sentinels) expect(everything).not.toContain(sentinel);
  });

  it('a second login to the same server keeps one entry and the same pin; another server gets its own', async () => {
    const scene = setting();
    await signIn(scene);
    await signIn(scene);
    poolAt(scene, {}, 'https://other.test');
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', 'https://other.test')).toBe(ExitCode.OK);
    const saved: unknown = JSON.parse(readFileSync(join(scene.staged.storeDir, 'pool-accounts.json'), 'utf8'));
    expect(saved).toHaveLength(2);
  });

  it('refuses a login whose signing key differs from the pin, and saves nothing', async () => {
    const scene = setting();
    await signIn(scene);
    const file = join(scene.staged.storeDir, 'pool-accounts.json');
    const before = readFileSync(file, 'utf8');
    poolAt(scene, { polls: [HttpResponse.json({ ...okLogin(), token: 'a-swapped-token', signingKey: { ...FIXED_KEY, x: 'another-key' } })] });
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

  it('stops, naming the refusal, when the person denies the sign-in', async () => {
    const scene = setting();
    poolAt(scene, { polls: [state('pending'), state('denied')] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(scene.document()).toMatchObject({ problem: { code: 'login_refused', title: 'The provider refused the sign-in: access_denied.' } });
    expect(existsSync(join(scene.staged.storeDir, 'pool-accounts.json'))).toBe(false);
  });

  it('stops when the code expires: at the pool\'s word, and at the clock', async () => {
    const told = setting();
    poolAt(told, { polls: [state('pending'), state('expired')] });
    expect(await told.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(told.document()).toMatchObject({ problem: { code: 'EXPIRED_TOKEN' } });

    const counted = setting();
    poolAt(counted, { start: { interval: 4, expiresIn: 8 }, polls: [state('pending')] });
    expect(await counted.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(counted.document()).toMatchObject({ problem: { code: 'EXPIRED_TOKEN' } });
    expect(counted.h.sleeps).toEqual([4000, 4000]);
  });

  it('names the pool\'s refusal of a poll, such as a handle it did not issue', async () => {
    const scene = setting();
    poolAt(scene, { polls: [HttpResponse.json({ error: 'invalid_handle', message: 'This pool did not issue that login handle.' }, { status: 401 })] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(scene.document()).toMatchObject({ problem: { code: 'invalid_handle', status: 401 } });
    expect(existsSync(join(scene.staged.storeDir, 'pool-accounts.json'))).toBe(false);
  });

  it('treats a malformed answer as a failure, not a sign-in', async () => {
    const noCode = setting();
    poolAt(noCode, { start: { userCode: undefined } });
    expect(await noCode.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);

    const notObject = setting();
    server.use(http.post(`${POOL}/v1/login/start`, () => HttpResponse.json('nope')));
    expect(await notObject.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);

    for (const poll of [new HttpResponse('not json', { status: 200 }), state('something-new')]) {
      const odd = setting();
      poolAt(odd, { polls: [poll] });
      expect(await odd.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
    }

    for (const signingKey of [{ kty: 'RSA', crv: 'Ed25519', x: 'x' }, 'text', null]) {
      const badKey = setting();
      poolAt(badKey, { polls: [HttpResponse.json({ ...okLogin(), signingKey })] });
      expect(await badKey.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
      expect(existsSync(join(badKey.staged.storeDir, 'pool-accounts.json'))).toBe(false);
    }
  });

  it('a pool that cannot be reached, or answers with no message, still gets a plain failure', async () => {
    const scene = setting();
    server.use(http.post(`${POOL}/v1/login/start`, () => HttpResponse.error()));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNREACHABLE);

    const bare = setting();
    server.use(http.post(`${POOL}/v1/login/start`, () => new HttpResponse('oops', { status: 500 })));
    expect(await bare.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
    expect(bare.h.err.join('')).toContain('HTTP 500');
  });

  it('will not follow a redirect, at the start or at a poll', async () => {
    const atStart = setting();
    server.use(http.post(`${POOL}/v1/login/start`, () => new HttpResponse(null, { status: 307, headers: { location: 'https://elsewhere.test/v1/login/start' } })));
    expect(await atStart.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNREACHABLE);

    const atPoll = setting();
    poolAt(atPoll);
    server.use(http.post(`${POOL}/v1/login/poll`, () => new HttpResponse(null, { status: 307, headers: { location: 'https://elsewhere.test/v1/login/poll' } })));
    expect(await atPoll.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNREACHABLE);
  });
});

describe('oars pool login prints what it sends', () => {
  /** The request lines in a stderr snapshot, in the order they were printed. */
  const requestLines = (text: string): string[] => text.split('\n').filter((line) => /^(GET|POST) \S+ HTTP\/1\.1$/.test(line));

  it.each(['github', 'google'] as const)('prints every %s request, headers and body, before sending it, with the handle masked', async (flavor) => {
    const scene = setting();
    poolAt(scene, { polls: [state('pending'), authorized()] });
    expect(await scene.cli('pool', 'login', '--provider', flavor, '--server', POOL)).toBe(ExitCode.OK);

    // Each request found its own request line already printed, and no later one.
    expect(scene.seen).toHaveLength(3);
    scene.seen.forEach((entry, index) => {
      const lines = requestLines(entry.err);
      expect(lines).toHaveLength(index + 1);
      expect(lines.at(-1)).toBe(`POST ${new URL(entry.url).pathname} HTTP/1.1`);
    });

    const printed = scene.h.err.join('');
    expect(requestLines(printed)).toEqual(['POST /v1/login/start HTTP/1.1', 'POST /v1/login/poll HTTP/1.1', 'POST /v1/login/poll HTTP/1.1']);
    // Every header goes out as printed: host, user-agent, content-type, and the length of the body.
    expect(printed).toContain(`host: ${new URL(POOL).host}`);
    expect(printed).toContain('content-type: application/json');
    expect(printed).toMatch(/content-length: \d+/);
    expect(printed).toContain(`{"provider":"${flavor}"}`);

    // The handle prints as its size alone, wherever it sits (the start request carries none); the pool's credential is in no request and is never printed.
    expect(printed).toContain(`{"handle":"<credential: ${String(HANDLE.length)} bytes>"}`);
    for (const secret of [HANDLE, POOL_TOKEN]) expect(scene.h.out.join('') + printed).not.toContain(secret);
  });
});

describe('no harness token is ever read', () => {
  it('a token planted in the harness config and environment appears in no request across login, deposit, and fetch', async () => {
    const scene = setting({ ANTHROPIC_API_KEY: HARNESS_SECRET, CLAUDE_CODE_OAUTH_TOKEN: HARNESS_SECRET });
    writeFileSync(join(scene.staged.projectsRoot, '..', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: HARNESS_SECRET } }));
    await capture(scene);
    poolAt(scene);
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, () => HttpResponse.json({ error: 'fetch_cap', message: 'capped' }, { status: 429 }));
    await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL);
    // Login now takes two requests (start, poll) where the provider-token route took more.
    expect(scene.seen.length).toBeGreaterThanOrEqual(3);
    expect(scene.sent()).not.toContain(HARNESS_SECRET);
    expect(scene.sent()).toContain(POOL_TOKEN);
  });
});

/** Every batch file in the outbox, by path relative to the store. */
const outboxFiles = (scene: Scene): string[] => {
  const root = join(scene.staged.storeDir, 'pool-outbox');
  return existsSync(root) ? readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.jsonl')).sort() : [];
};

/** Empties every `sent.log` under the outbox, for a test that posts one batch again to read how the second post ends; the skip of a sent hash is tested on its own. */
const forgetSent = (scene: Scene): void => {
  const root = join(scene.staged.storeDir, 'pool-outbox');
  for (const name of readdirSync(root, { recursive: true, encoding: 'utf8' })) if (name.endsWith('sent.log')) rmSync(join(root, name));
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

  // t881 fix rounds 1 and 2: the deposit's own gate (the operator's redact domains) decides what the outbox holds, so this goes through the command and reads the written batch. The host is on the public list, so capture kept it even before t903 and only the gate can turn it into `private`.
  it('writes private for a name the operator redacts, an off-list program in clear, and a public-list host the operator redacts, as private', async () => {
    const SESSION = '66666666-6666-4666-8666-666666666666';
    const folder = 'gate-repo';
    const stamp = (n: number): string => `2026-06-01T00:00:0${String(n)}.000Z`;
    const call = (n: number, name: string, input: object): string =>
      JSON.stringify({ type: 'assistant', uuid: `g-${String(n)}`, parentUuid: n === 1 ? null : `g-${String(n - 1)}`, isSidechain: false, sessionId: SESSION, timestamp: stamp(n), version: '2.1.300', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${String(n)}`, name, input }] } });
    const scene = setting();
    rmSync(join(scene.staged.projectsRoot, 'proj'), { recursive: true, force: true });
    addProject(scene.staged, folder, SESSION, [
      JSON.stringify({ type: 'user', uuid: 'g-0', parentUuid: null, isSidechain: false, sessionId: SESSION, cwd: '/w', timestamp: stamp(0), version: '2.1.300', message: { role: 'user', content: 'deploy it' } }),
      call(1, 'WebFetch', { url: 'https://docs.stripe.com/api' }),
      call(2, 'Bash', { command: 'acme-deploy --prod' }),
      call(3, 'mcp__git.acme.internal__run', {}),
    ]);
    // Captured with nothing redacted, then the operator names a domain: the store holds the clear host, and only the deposit's gate can keep it off the wire.
    await deposit(scene.staged.runtime, { allow: [folder], redactDomains: [], now: () => NOW });
    const state = join(scene.staged.storeDir, 'state.json');
    writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), redactDomains: ['acme.internal', 'stripe.com'] }));
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
    const written = batchBytes(scene).join('\n');
    expect(written).not.toContain('acme.internal');
    expect(written).not.toContain('stripe.com');
    expect(written).toContain('"host":"private"');
    expect(written).toContain('"server":"private"');
    expect(written).toContain('"program":"acme-deploy"');
  });

  // t903: capture keeps a skill-run, host, and pull name as it is after redaction, so the one gate sends an off-list one in clear (the pool hashes the host on arrival); there is no second projection.
  it('writes an off-list host, skill-run name, and pull name in clear, and the command takes the batch', async () => {
    const SESSION = '77777777-7777-4777-8777-777777777777';
    const folder = 'long-tail-repo';
    const stamp = (n: number): string => `2026-06-01T00:00:0${String(n)}.000Z`;
    const call = (n: number, name: string, input: object): string =>
      JSON.stringify({ type: 'assistant', uuid: `l-${String(n)}`, parentUuid: n === 1 ? null : `l-${String(n - 1)}`, isSidechain: false, sessionId: SESSION, timestamp: stamp(n), version: '2.1.300', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${String(n)}`, name, input }] } });
    const scene = setting();
    rmSync(join(scene.staged.projectsRoot, 'proj'), { recursive: true, force: true });
    addProject(scene.staged, folder, SESSION, [
      JSON.stringify({ type: 'user', uuid: 'l-0', parentUuid: null, isSidechain: false, sessionId: SESSION, cwd: '/w', timestamp: stamp(0), version: '2.1.300', message: { role: 'user', content: 'go' } }),
      call(1, 'WebFetch', { url: 'https://wiki.longtail-example.dev/page?token=abc123' }),
      call(2, 'Skill', { skill: 'longtail-release' }),
      call(3, 'Bash', { command: 'npm install longtail-widget@1.2.3' }),
    ]);
    await deposit(scene.staged.runtime, { allow: [folder], redactDomains: [], now: () => NOW });
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
    const written = batchBytes(scene).join('\n');
    expect(written).toContain('"host":"wiki.longtail-example.dev"');
    expect(written).toContain('"skill":"longtail-release"');
    expect(written).toContain('"name":"longtail-widget"');
    expect(written).not.toContain('abc123');
    for (const bytes of batchBytes(scene)) expect(parseSkeleton(JSON.parse(bytes)).ok).toBe(true);
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
      const rewriteSessions = (scene: Scene, change: (session: { frame?: { day?: unknown } }) => void): void => {
        const file = join(scene.staged.storeDir, 'observations.jsonl');
        const isSession = (record: unknown): record is { kind: 'session'; frame?: { day?: unknown } } => at(record, 'kind') === 'session';
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
          if (session.frame !== undefined) session.frame.day = 'tomorrow';
        });
        await expectWithdrawn(scene, hash);
      });

      it('the same sessions under another account', async () => {
        const { scene, hash } = await built();
        poolAt(scene, { polls: [HttpResponse.json({ ...okLogin(), account: 'acct_two' })] });
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
    const isSession = (record: unknown): record is { kind: 'session'; frame?: { day?: unknown } } => at(record, 'kind') === 'session';
    const rewrite = (change: (session: { frame?: { day?: unknown } }) => void): void => {
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
      if (session.frame !== undefined) session.frame.day = 'tomorrow';
    });
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(outboxFiles(scene)).toEqual([]);
    expect(scene.h.out.join('')).toContain('refused by the vocabulary (transcripts[0].frame.day)');
    expect(scene.h.out.join('')).not.toContain('tomorrow');
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
    expect(await scene.cli('pool', 'outbox')).toBe(ExitCode.AUTH);
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.AUTH);
    expect(scene.h.err.join('')).toContain(DEFAULT_POOL_URL);
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
    forgetSent(scene);
    const finished = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
    await poolDeposit(scene.h.deps, sendOptions(hash, finished.via));
    expect(finished.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    // A last part that is not 201, and a middle part that is neither 202 nor 201, are refusals.
    forgetSent(scene);
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

  it('sends from the command line once the covenant is accepted, and sends nothing before', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    let accepted = false;
    on(scene, 'get', '/v1/covenant', () => HttpResponse.json({ version: 'v1', accepted }));
    on(scene, 'post', '/v1/covenant/accept', () => {
      accepted = true;
      return HttpResponse.json({ ok: true, version: 'v1' });
    });
    on(scene, 'post', '/v1/deposits', () => HttpResponse.json({ ok: true }, { status: 201 }));
    // The lock runs first: a hash that was never printed is refused with no request made.
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--send', '1'.repeat(64), '--json')).toBe(ExitCode.CONFLICT);
    expect(scene.document()).toMatchObject({ problem: { code: 'batch_unknown' } });
    expect(scene.seen).toEqual([]);
    // Not yet accepted: the covenant is read, and no batch leaves.
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--send', hash, '--json')).toBe(ExitCode.AUTH);
    expect(scene.document()).toMatchObject({ problem: { code: 'covenant_not_accepted' } });
    expect(scene.seen.map((entry) => new URL(entry.url).pathname)).toEqual(['/v1/covenant']);
    scene.seen.length = 0;
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--send', hash, '--accept-covenant', 'v1', '--json')).toBe(ExitCode.OK);
    expect(scene.document()).toMatchObject({ ok: true, sent: true, hash });
    expect(scene.seen.map((entry) => new URL(entry.url).pathname)).toEqual(['/v1/covenant', '/v1/covenant/accept', '/v1/deposits']);
  });

  it('skips a hash already in sent.log, as the nightly does: one line, exit 0, one POST over two runs', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
    const first = await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
    expect(first.document).toMatchObject({ ok: true, sent: true, hash });
    const second = await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
    expect(second.document).toMatchObject({ ok: true, sent: false, hash });
    expect(second.text).toMatch(new RegExp(`^already sent ${hash} at \\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z$`));
    expect(pool.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
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

    forgetSent(scene);
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

  it('explains a batch whose response made two calls: the allocated marker has its row', async () => {
    const scene = setting();
    rmSync(join(scene.staged.projectsRoot, 'proj'), { recursive: true, force: true });
    const use = (id: string): object => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } });
    const answer = (id: string): string => JSON.stringify({ type: 'user', sessionId: SHARED, cwd: '/w', timestamp: '2026-05-01T00:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'r' }] } });
    const prompted = JSON.stringify({ type: 'user', sessionId: SHARED, cwd: '/w', timestamp: '2026-05-01T00:00:00Z', message: { role: 'user', content: 'a plain request' } });
    const replied = JSON.stringify({ type: 'assistant', sessionId: SHARED, cwd: '/w', requestId: 'r1', timestamp: '2026-05-01T00:00:01Z', message: { id: 'm-r1', role: 'assistant', content: [use('a'), use('b')], usage: { input_tokens: 1, output_tokens: 1000 } } });
    addProject(scene.staged, 'proj', SHARED, [prompted, replied, answer('a'), answer('b')]);
    await capture(scene);
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    scene.h.out.length = 0;
    expect(batchBytes(scene).join('')).toContain('"allocated":true');
    expect(await scene.cli('pool', 'outbox', '--explain', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.err.join('')).not.toContain('field_without_row');
    expect(scene.h.out.join('')).toContain(`  allocated: ${FIELD_ROWS.allocated ?? 'no row'}`);
    expect(FIELD_ROWS.allocated).toBeDefined();
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

  const bundleBody = (version: string, harness = 'claude-code'): string => JSON.stringify({ format: 1, harness, harnessVersion: version, vocabVersion: VOCAB_VERSION, floor: TEST_FLOOR, asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: [{}, {}], strata: [] });

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

  describe('prints the floor it finds in the bundle and holds none of its own', () => {
    const floored = async (sign: (text: string) => Promise<string>, floors: unknown, version = '2.1.314'): Promise<() => Response> => {
      const payload = JSON.stringify({ format: 1, harness: 'claude-code', harnessVersion: version, vocabVersion: VOCAB_VERSION, floor: 5, asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: [{}, {}], strata: [], ...(floors === undefined ? {} : { floors }) });
      const signature = await sign(payload);
      return () => HttpResponse.json({ payload, signature }, { headers: { etag: '"floored"' } });
    };

    it.each([3, 5, 10])('prints a bundle at floor %i as that number', async (floor) => {
      const { scene, sign } = await signedScene();
      on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, await floored(sign, { public: floor, disclosure: 2 }));
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      expect(scene.h.out.join('')).toContain(`The pool served it at a public floor of ${String(floor)} clusters and a disclosure floor of 2.`);
    });

    it('names a family on a floor of its own, and puts the floors in --json', async () => {
      const { scene, sign } = await signedScene();
      const floors = { public: 3, disclosure: 4, families: { live: 2, 'tool-day': 8 } };
      on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, await floored(sign, floors));
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      expect(scene.document()).toMatchObject({ floors });
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      expect(scene.h.out.join('')).toContain('a disclosure floor of 4, with live at 2 and tool-day at 8.');
    });

    it('prints the floor of the bundle it kept when the pool answers 304', async () => {
      const { scene, sign } = await signedScene();
      bundleRoute(scene, '2.1.314', [await floored(sign, { public: 7, disclosure: 2 }), () => new HttpResponse(null, { status: 304 })]);
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      expect(scene.document()).toMatchObject({ unchanged: true, floors: { public: 7, disclosure: 2 } });
    });

    it('says nothing of a floor when the bundle states none: an older pool\'s bundle still parses', async () => {
      const { scene, sign } = await signedScene();
      on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, await floored(sign, undefined));
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      expect(scene.document()).not.toHaveProperty('floors');
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      expect(scene.h.out.join('')).not.toContain('floor');
    });

    it('parses a family this client does not know and prints none of it, so a later pool that adds one breaks no released client', async () => {
      const { scene, sign } = await signedScene();
      on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, await floored(sign, { public: 5, disclosure: 2, families: { 'a-later-family': 3 } }));
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      const text = scene.h.out.join('');
      expect(text).toContain('a disclosure floor of 2.');
      expect(text).not.toContain('a-later-family');
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      expect(scene.document()).toMatchObject({ floors: { families: { 'a-later-family': 3 } } });
    });

    it.each([{ public: 0, disclosure: 2 }, { public: 5.5, disclosure: 2 }, { public: 5 }, { public: 5, disclosure: 2, families: { live: 0 } }, 'five'])('refuses a signed bundle whose floors are %j, rather than print them', async (floors) => {
      const { scene, sign } = await signedScene();
      on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, await floored(sign, floors));
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.INVALID);
      expect(scene.h.err.join('')).toContain('not a signed bundle this version reads');
    });
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

  it('refuses a validly signed bundle that states no floor, and keeps nothing', async () => {
    const { scene, sign } = await signedScene();
    // The signature holds and the version is right: only the missing `floor` is wrong, so a bundle that does not say what floor the pool applied is not served as a read.
    const payload = bundleBody('2.1.314').replace(`"floor":${String(TEST_FLOOR)},`, '');
    expect(payload).not.toContain('floor');
    const signature = await sign(payload);
    on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, () => HttpResponse.json({ payload, signature }));
    expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.INVALID);
    expect(scene.document()).toMatchObject({ problem: { code: 'bundle_unverified' } });
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
    const payload = JSON.stringify({ format: 1, harness, harnessVersion: version, vocabVersion: VOCAB_VERSION, floor: TEST_FLOOR, asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: Array.from({ length: reads }, () => ({})), strata: [] });
    const signature = await sign(payload);
    return () => HttpResponse.json({ payload, signature }, etag === null ? {} : { headers: { etag } });
  };

  const keptFile = (scene: Scene): string => join(scene.staged.storeDir, 'pool-replica', readdirSync(join(scene.staged.storeDir, 'pool-replica'))[0] ?? '', 'claude-code', '2.1.314.json');

  describe('names its harness', () => {
    const serve = async (scene: Scene, sign: (text: string) => Promise<string>, harness: string, version = '2.1.314', etag: string | null = null): Promise<Array<{ headers: Headers; printedBefore: string }>> => bundleRoute(scene, version, [await signedReply(sign, version, etag, 2, harness)], harness);

    /** A store that holds `count` sessions of each harness, written as the capture log holds them (the fixture's rows, no transcripts). */
    const holding = (scene: Scene, counts: ReadonlyArray<readonly ['claude-code' | 'cursor' | 'codex' | 'otel', number]>): void => {
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
      expect(scene.h.err.join('')).toContain('acme is not a harness the pool serves. Choose one of claude-code, cursor, codex, copilot, gemini, grok, opencode, pi, vscode-copilot.');
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
      expect(scene.h.err.join('')).toContain('No --harness given: fetching cursor, the harness your local store holds the most sessions of (3 of 4). Pass --harness <name> to fetch another (claude-code, cursor, codex, copilot, gemini, grok, opencode, pi, vscode-copilot).');
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

    it('refuses otel before asking: the pool serves no OpenTelemetry bundle', async () => {
      const { scene } = await signedScene();
      expect(await scene.cli('pool', 'fetch', '--harness', 'otel', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.USAGE);
      expect(scene.h.err.join('')).toContain('otel has no pool bundle.');
      expect(scene.h.err.join('')).toContain('Choose one of claude-code, cursor, codex, copilot, gemini, grok, opencode, pi, vscode-copilot.');
      expect(scene.seen).toEqual([]);
    });

    it('leaves otel sessions out of the default: an otel-majority store asks for the next harness, or claude-code on a tie', async () => {
      const next = await signedScene();
      holding(next.scene, [['otel', 5], ['cursor', 2], ['codex', 1]]);
      await serve(next.scene, next.sign, 'cursor');
      expect(await next.scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      expect(next.scene.seen[0]?.url).toBe(`${POOL}/bundle/cursor/2.1.314/${VOCAB_VERSION}`);
      expect(next.scene.h.err.join('')).toContain('No --harness given: fetching cursor, the harness your local store holds the most sessions of (2 of 3).');

      const tied = await signedScene();
      holding(tied.scene, [['otel', 5], ['cursor', 1], ['codex', 1]]);
      await serve(tied.scene, tied.sign, 'claude-code');
      expect(await tied.scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      expect(tied.scene.seen[0]?.url).toBe(`${POOL}/bundle/claude-code/2.1.314/${VOCAB_VERSION}`);
      expect(tied.scene.h.err.join('')).toContain('no one harness leads your local store, so Claude Code is the default');

      const only = await signedScene();
      holding(only.scene, [['otel', 4]]);
      await serve(only.scene, only.sign, 'claude-code');
      expect(await only.scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
      expect(only.scene.seen[0]?.url).toBe(`${POOL}/bundle/claude-code/2.1.314/${VOCAB_VERSION}`);
      expect(only.scene.h.err.join('')).toContain('your local store holds no session of a harness the pool serves, so Claude Code is the default');
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

/** A case-insensitive match for `name` between word boundaries: not inside a longer run of letters and digits such as a hex hash. */
const wholeWord = (name: string): RegExp => new RegExp(`\\b${name}\\b`, 'i');

describe('coverage on the wire (t871)', () => {
  const REMOTE_URL = 'https://github.com/secret-org/secret-app.git';
  /** A transcript whose every line names `cwd`, in a project folder named for it, so the deposit can find the repository the session sat in. */
  const inRepo = async (): Promise<{ scene: Scene; repo: string }> => {
    const repo = mkdtempSync(join(tmpdir(), 'oars-coverage-repo-'));
    mkdirSync(join(repo, '.git'));
    // A remote the repository's identity is read from: its text must never reach a request, only the salted key of it.
    writeFileSync(join(repo, '.git', 'config'), `[remote "origin"]
	url = ${REMOTE_URL}
`);
    const scene = setting();
    const project = slugOf(repo);
    const line = (value: object): string => JSON.stringify(value);
    addProject(scene.staged, project, 'sess1', [
      line({ type: 'user', uuid: 'u1', timestamp: '2026-06-01T05:00:01.000Z', version: '2.1.300', cwd: repo, message: { role: 'user', content: 'read it' } }),
      line({ type: 'assistant', uuid: 'u2', timestamp: '2026-06-01T05:00:02.000Z', version: '2.1.301', cwd: repo, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    ]);
    await deposit(scene.staged.runtime, { allow: [project], redactDomains: [], now: () => NOW });
    await signIn(scene);
    return { scene, repo };
  };

  /** The transcript frame of the first batch in the outbox, as the parser reads it. */
  const frameOfBatch = (scene: Scene): SkeletonFrame | undefined => {
    const parsed = parseSkeleton(JSON.parse(batchBytes(scene)[0] ?? 'null'));
    return parsed.ok ? parsed.skeleton.transcripts[0]?.frame : undefined;
  };

  it('prints the setting with no flag, and saves each flag on its own', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'coverage', '--json')).toBe(ExitCode.OK);
    expect(scene.document()).toEqual({ ok: true, saved: false, orgSize: 'unknown', repoVisibility: 'unknown' });
    expect(await scene.cli('pool', 'coverage', '--org-size', '11-100', '--json')).toBe(ExitCode.OK);
    expect(scene.document()).toEqual({ ok: true, saved: true, orgSize: '11-100', repoVisibility: 'unknown' });
    expect(await scene.cli('pool', 'coverage', '--repo-visibility', 'private')).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('Organization size: 11-100');
    expect(scene.h.out.join('')).toContain('Repository visibility: private');
    expect(JSON.parse(readFileSync(join(scene.staged.storeDir, 'pool-coverage.json'), 'utf8'))).toEqual({ orgSize: '11-100', repoVisibility: 'private' });
  });

  it('refuses a value outside the lists and saves nothing', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'coverage', '--org-size', '5000')).toBe(ExitCode.USAGE);
    expect(await scene.cli('pool', 'coverage', '--repo-visibility', 'internal')).toBe(ExitCode.USAGE);
    expect(existsSync(join(scene.staged.storeDir, 'pool-coverage.json'))).toBe(false);
  });

  it('needs the session store', async () => {
    const scene = setting();
    scene.h.deps.sessions = undefined;
    await expect(poolCoverage(scene.h.deps, {})).rejects.toThrow(/not configured/);
  });

  it('states unknown for all three bands when nothing was set and nothing could be read', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(frameOfBatch(scene)).toMatchObject({ orgSize: 'unknown', team: 'unknown', repoVisibility: 'unknown' });
  });

  it('states the operator setting and the team band counted from the local log, and sends no author', async () => {
    const { scene, repo } = await inRepo();
    expect(await scene.cli('pool', 'coverage', '--org-size', '2-10', '--repo-visibility', 'public')).toBe(ExitCode.OK);
    const git = vi.fn((_root: string, args: readonly string[]) => Promise.resolve(args.includes('log') ? 'ada@example.com\ngrace@example.com\n' : ''));
    expect(await poolDeposit(scene.h.deps, { server: POOL, git })).toMatchObject({ document: { ok: true, batched: 1 } });
    expect(git).toHaveBeenCalledTimes(1);
    expect(frameOfBatch(scene)).toMatchObject({ orgSize: '2-10', team: 'team', repoVisibility: 'public' });
    const text = batchBytes(scene).join('');
    // The key is there, so the search below is not over a batch that never held a repository.
    expect(frameOfBatch(scene)?.repoKey).toMatch(/^[0-9a-f]{16}$/);
    // A name is searched for as a whole word: the body is full of lowercase hex (ids, hashes, `repoKey`), and `ada` is three hex digits, so a bare substring of it turns up in a random hash now and then (t929).
    for (const name of ['ada', 'grace']) expect(text).not.toMatch(wholeWord(name));
    for (const forbidden of ['example.com', repo, slugOf(repo), REMOTE_URL, 'secret-org', 'secret-app', 'github.com']) expect(text).not.toContain(forbidden);
    rmSync(repo, { recursive: true, force: true });
  });

  it('looks for an author name as a whole word, so a hash that holds ada as hex is not a leak', () => {
    const hashed = '{"repoKey":"3f0ada9c11b2d4e5","id":"9a1b2c3d4e5f6071"}';
    // The old check, a bare substring, calls this body a leak.
    expect(hashed.includes('ada')).toBe(true);
    expect(hashed).not.toMatch(wholeWord('ada'));
    // A real author value still matches: a quoted field, a bare word, and the start of an email.
    expect('{"author":"ada"}').toMatch(wholeWord('ada'));
    expect('{"author":"Ada Lovelace"}').toMatch(wholeWord('ada'));
    expect('{"author":"ada@example.com"}').toMatch(wholeWord('ada'));
  });

  it('states solo for one author, and unknown when git cannot be read', async () => {
    const { scene, repo } = await inRepo();
    expect(await poolDeposit(scene.h.deps, { server: POOL, git: () => Promise.resolve('ada@example.com\n') })).toMatchObject({ document: { batched: 1 } });
    expect(frameOfBatch(scene)).toMatchObject({ team: 'solo' });
    expect(await poolDeposit(scene.h.deps, { server: POOL, git: () => Promise.reject(new Error('no git')) })).toMatchObject({ document: { batched: 1 } });
    expect(frameOfBatch(scene)).toMatchObject({ team: 'unknown' });
    rmSync(repo, { recursive: true, force: true });
  });
});

describe('pool telemetry: deposit batches and fetches leave counts', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** Turns telemetry on for a scene, in a telemetry folder under a temp APPDATA (confirmed to be where the CLI would put it). */
  const recording = (scene: Scene): string => {
    const appData = mkdtempSync(join(tmpdir(), 'oars-pool-telemetry-'));
    roots.push(appData);
    const configDir = defaultConfigDir({ APPDATA: appData }, 'win32', 'C:\\unused-home');
    expect(configDir).toBe(appData);
    const dir = join(configDir, 'oars', 'telemetry');
    scene.h.deps.telemetry = { dir, platform: 'linux' };
    return dir;
  };

  const eventsOf = (dir: string, type: string): { [field: string]: unknown }[] =>
    readSpool(dir).flatMap((text) => {
      const parsed: unknown = JSON.parse(text);
      const data: unknown = at(parsed, 'type') === type ? at(parsed, 'data') : undefined;
      return typeof data === 'object' && data !== null ? [Object.fromEntries(Object.entries(data))] : [];
    });

  const OTHER_FOLDER = 'zz-private-repo';
  const SESSION = '55555555-5555-4555-8555-555555555555';
  const line = (text: string): string => JSON.stringify({ type: 'user', sessionId: SESSION, cwd: '/w', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: text } });

  /** A store holding only the one session, in a folder the allowlist can admit or not. */
  const alone = async (lines: string[], allow: string[]): Promise<Scene> => {
    const scene = setting();
    rmSync(join(scene.staged.projectsRoot, 'proj'), { recursive: true, force: true });
    addProject(scene.staged, OTHER_FOLDER, SESSION, lines);
    await deposit(scene.staged.runtime, { allow: [OTHER_FOLDER], redactDomains: [], now: () => NOW });
    await signIn(scene);
    const state = join(scene.staged.storeDir, 'state.json');
    writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, 'utf8')), allow }));
    return scene;
  };

  it('a deposit pass records the sessions counted, the batches built, and their bytes', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    const dir = recording(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    const [event, ...rest] = eventsOf(dir, 'deposit');
    expect(rest).toEqual([]);
    const sizes = batchBytes(scene).map((bytes) => Buffer.byteLength(bytes));
    expect(event).toMatchObject({ step: 'build', sessions: outboxFiles(scene).length, batched: outboxFiles(scene).length, excludedFolder: 0, excludedTerm: 0, excludedNoRaw: 0, excludedNoTerms: 0, excludedUnreadable: 0 });
    expect(event?.bytes).toBe(sizes.reduce((sum, size) => sum + size, 0));
    expect(event?.bytes).toBeGreaterThan(0);
  });

  it('a run with an excluded session records a count and no folder', async () => {
    const scene = await alone([line('a plain request')], ['some-other-folder']);
    const dir = recording(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(eventsOf(dir, 'deposit')[0]).toMatchObject({ step: 'build', sessions: 1, batched: 0, bytes: 0, excludedFolder: 1, excludedTerm: 0 });
    const spool = readSpool(dir).join('\n');
    for (const private_ of [OTHER_FOLDER, 'some-other-folder', SESSION, TERM, 'plain request']) expect(spool).not.toContain(private_);
  });

  it('a term hit records a count and no term', async () => {
    const scene = await alone([line(`working at ${TERM}`)], [OTHER_FOLDER]);
    const dir = recording(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(eventsOf(dir, 'deposit')[0]).toMatchObject({ sessions: 1, batched: 0, excludedFolder: 0, excludedTerm: 1 });
    const spool = readSpool(dir).join('\n');
    for (const private_ of [OTHER_FOLDER, SESSION, TERM]) expect(spool).not.toContain(private_);
  });

  it('prints and returns the same with telemetry on as without', async () => {
    const [off, on] = [setting(), setting()];
    for (const scene of [off, on]) {
      await capture(scene);
      await signIn(scene);
    }
    const dir = recording(on);
    expect(await off.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(await on.cli('pool', 'deposit', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(on.document()).toEqual(off.document());
    expect(on.h.out).toEqual(off.h.out);
    expect(eventsOf(dir, 'deposit')).toHaveLength(1);
  });

  it('a batch sent records one sent and its bytes', async () => {
    const scene = await batched();
    const dir = recording(scene);
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
    await poolDeposit(scene.h.deps, sendOptions(printedHashes(scene)[0] ?? '', pool.via));
    expect(eventsOf(dir, 'deposit')).toEqual([{ step: 'send', sent: 1, bytes: Buffer.byteLength(batchBytes(scene)[0] ?? '') }]);
  });

  const bundleBody = (version: string): string => JSON.stringify({ format: 1, harness: 'claude-code', harnessVersion: version, vocabVersion: VOCAB_VERSION, floor: TEST_FLOOR, asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: [{}, {}], strata: [] });
  const BUNDLE = `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`;

  const signed = async (): Promise<{ scene: Scene; reply: () => Promise<Response> }> => {
    const scene = setting();
    const { pinned, sign } = await key();
    await signIn(scene, pinned);
    const payload = bundleBody('2.1.314');
    const signature = await sign(payload);
    return { scene, reply: () => Promise.resolve(HttpResponse.json({ payload, signature }, { headers: { etag: '"tag-1"' } })) };
  };

  it('a fetch records itself, and a second that the pool answers 304 to records an ETag hit', async () => {
    const { scene, reply } = await signed();
    const dir = recording(scene);
    const answers = [async () => reply(), () => Promise.resolve(new HttpResponse(null, { status: 304 }))];
    server.use(http.get(`${POOL}${BUNDLE}`, () => (answers.shift() ?? (() => Promise.resolve(new HttpResponse(null, { status: 500 }))))()));
    expect(await scene.cli('pool', 'fetch', '--harness', 'claude-code', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
    expect(await scene.cli('pool', 'fetch', '--harness', 'claude-code', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.OK);
    expect(eventsOf(dir, 'fetch')).toEqual([
      { harness: 'claude-code', fetches: 1, reads: 2 },
      { harness: 'claude-code', fetches: 1, etagHits: 1, reads: 2 },
    ]);
  });

  it('a fetch the pool refuses still reached the pool: it records a fetch and exits as it did', async () => {
    const { scene } = await signed();
    const dir = recording(scene);
    server.use(http.get(`${POOL}${BUNDLE}`, () => HttpResponse.json({ error: 'server_error', message: 'The pool is down.' }, { status: 500 })));
    const quiet = await signed();
    server.use(http.get(`${POOL}${BUNDLE}`, () => HttpResponse.json({ error: 'server_error', message: 'The pool is down.' }, { status: 500 })));
    const without = await quiet.scene.cli('pool', 'fetch', '--harness', 'claude-code', '--harness-version', '2.1.314', '--server', POOL);
    expect(without).not.toBe(ExitCode.OK);
    expect(await scene.cli('pool', 'fetch', '--harness', 'claude-code', '--harness-version', '2.1.314', '--server', POOL)).toBe(without);
    expect(eventsOf(dir, 'fetch')).toEqual([{ harness: 'claude-code', fetches: 1 }]);
  });

  it('a bundle that fails verification still reached the pool: it records a fetch and exits as it did, keeping nothing', async () => {
    const { scene } = await signed();
    const dir = recording(scene);
    server.use(http.get(`${POOL}${BUNDLE}`, () => HttpResponse.json({ payload: bundleBody('2.1.314'), signature: 'not-a-signature' })));
    expect(await scene.cli('pool', 'fetch', '--harness', 'claude-code', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.INVALID);
    expect(scene.document()).toMatchObject({ problem: { code: 'bundle_unverified' } });
    expect(eventsOf(dir, 'fetch')).toEqual([{ harness: 'claude-code', fetches: 1 }]);
  });

  it('a 304 to a fetch that named no kept bundle still reached the pool: it records a fetch and exits UNEXPECTED', async () => {
    const { scene } = await signed();
    const dir = recording(scene);
    server.use(http.get(`${POOL}${BUNDLE}`, () => new HttpResponse(null, { status: 304 })));
    expect(await scene.cli('pool', 'fetch', '--harness', 'claude-code', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
    expect(eventsOf(dir, 'fetch')).toEqual([{ harness: 'claude-code', fetches: 1 }]);
  });

  it('a fetch the pool caps records a cap hit and still exits as capped', async () => {
    const { scene } = await signed();
    const dir = recording(scene);
    server.use(http.get(`${POOL}${BUNDLE}`, () => HttpResponse.json({ error: 'fetch_cap', message: 'An account without access may fetch 1 per ISO week.' }, { status: 429 })));
    expect(await scene.cli('pool', 'fetch', '--harness', 'claude-code', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.CAPPED);
    expect(scene.document()).toMatchObject({ problem: { code: 'fetch_cap' } });
    expect(eventsOf(dir, 'fetch')).toEqual([{ harness: 'claude-code', fetches: 1, capHits: 1 }]);
  });
});

describe('wire policing in telemetry', () => {
  const printedAndHash = async (scene: Scene): Promise<string> => {
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    return printedHashes(scene)[0] ?? '';
  };
  /** Telemetry for a scene: a temp config folder (APPDATA), with the telemetry folder where main.ts puts it. */
  const watched = (scene: Scene): string => {
    scene.h.deps.env.APPDATA = scene.staged.root;
    const dir = join(scene.staged.root, 'oars', 'telemetry');
    scene.h.deps.telemetry = { dir, platform: 'linux' };
    return dir;
  };
  const spooled = (dir: string, type: string): { data: { [field: string]: unknown } }[] => spoolEvents(dir, type);

  it('counts the fields of a pass against a hand count of the batches it wrote', async () => {
    const scene = setting();
    const dir = watched(scene);
    await capture(scene);
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    const batches = batchBytes(scene);
    expect(batches.length).toBeGreaterThan(0);
    const events = spooled(dir, 'wire');
    // One event for the harness of the fixture, with every batch of the pass.
    expect(events).toHaveLength(1);
    const data = events[0]?.data ?? {};
    expect(data.batches).toBe(batches.length);
    expect(data.bytes).toBe(batches.reduce((sum, bytes) => sum + Buffer.byteLength(bytes.trimEnd()), 0));
    const fields = Array.isArray(data.fields) ? data.fields.map(String) : [];
    const at = (name: string): number => fields.indexOf(name);
    const numbers = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
    // `format` is one number in each batch: the hand count reads it from the written bytes.
    const formats = batches.flatMap((bytes) => [...bytes.matchAll(/"format":(\d+)/g)].map((found) => found[1] ?? ''));
    expect(numbers(data.present)[at('format')]).toBe(batches.length);
    expect(numbers(data.fieldBytes)[at('format')]).toBe(formats.join('').length);
    // Only names the register holds.
    for (const name of fields) expect(Object.keys(FIELD_ROWS)).toContain(name);
    expect(readSpool(dir).join('')).not.toContain(TERM);
  });

  it('records a taken send with its bytes, and a refused one with the pool\'s code', async () => {
    const scene = await batched();
    const dir = watched(scene);
    const hash = await printedAndHash(scene);
    const taken = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
    await poolDeposit(scene.h.deps, sendOptions(hash, taken.via));
    forgetSent(scene);
    const refused = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(429, { error: 'rate_limited', message: 'Slow down.' }) });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, refused.via))).rejects.toMatchObject({ problem: { code: 'rate_limited' } });
    const bytes = Buffer.byteLength(batchBytes(scene)[0] ?? '');
    expect(spooled(dir, 'wire-send').map((event) => event.data)).toEqual([
      { sent: 1, status: 201, bytes },
      { sent: 0, status: 429, code: 'rate_limited', bytes },
    ]);
  });

  it('records one send for a batch sent in parts, on the reply that ends it, with the whole batch\'s bytes', async () => {
    const scene = await batched();
    const dir = watched(scene);
    const file = join(scene.staged.storeDir, 'pool-outbox', outboxFiles(scene)[0] ?? '');
    const bytes = canonicalBytes({ ...JSON.parse(readFileSync(file, 'utf8')), pad: 'é'.repeat(700_000) });
    const hash = batchHash(bytes);
    rmSync(file);
    writeFileSync(join(file, '..', `${outboxFiles(scene)[0]?.split(/[\\/]/).at(-1)?.split('.')[0] ?? ''}.${hash}.jsonl`), bytes);
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const whole = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': [answer(202, { ok: true, pending: 2 }), answer(202, { ok: true, pending: 1 }), answer(201, { ok: true })] });
    await poolDeposit(scene.h.deps, sendOptions(hash, whole.via));
    expect(whole.requests.filter((request) => request.method === 'POST')).toHaveLength(3);
    // Not one event per part: three would triple the weekly sent bytes the health report reads.
    expect(spooled(dir, 'wire-send').map((event) => event.data)).toEqual([{ sent: 1, status: 201, bytes: Buffer.byteLength(bytes) }]);
    // A first part that is refused ends the batch there: one event, with that status.
    forgetSent(scene);
    const refused = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(500, { error: 'boom', message: 'no' }) });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, refused.via))).rejects.toMatchObject({ problem: { status: 500 } });
    expect(refused.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
    expect(spooled(dir, 'wire-send').map((event) => event.data)).toEqual([
      { sent: 1, status: 201, bytes: Buffer.byteLength(bytes) },
      { sent: 0, status: 500, code: 'boom', bytes: Buffer.byteLength(bytes) },
    ]);
    // A last part answered 202 never completed the deposit: it ends the batch, records 202, and is refused.
    const unfinished = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': [answer(202, { ok: true }), answer(202, { ok: true }), answer(202, { ok: true })] });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, unfinished.via))).rejects.toMatchObject({ problem: { status: 202 } });
    expect(unfinished.requests.filter((request) => request.method === 'POST')).toHaveLength(3);
    expect(spooled(dir, 'wire-send').map((event) => event.data).at(-1)).toEqual({ sent: 0, status: 202, bytes: Buffer.byteLength(bytes) });
  });

  it('records nothing without a telemetry folder, and a send still raises what it did', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    const refused = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(500, {}) });
    await expect(poolDeposit(scene.h.deps, sendOptions(hash, refused.via))).rejects.toMatchObject({ problem: { status: 500 } });
  });
});

describe('oars pool deposit: the raw copy (t884)', () => {
  const rawFiles = (scene: Scene): string[] => {
    const root = join(scene.staged.storeDir, 'pool-outbox');
    return existsSync(root) ? readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.redacted')).sort() : [];
  };
  const ready = async (consent: 'granted' | 'declined' | null, folders: { [entry: string]: 'skeleton' | 'off' } = {}): Promise<Scene> => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    await updatePoolChoices(scene.staged.storeDir, (choices) => {
      choices.rawConsent = consent;
      Object.assign(choices.folders, folders);
    });
    return scene;
  };

  it('writes a redacted copy of each transcript beside each skeleton once raw consent is granted', async () => {
    const scene = await ready('granted');
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    const copies = rawFiles(scene);
    expect(copies.length).toBeGreaterThanOrEqual(outboxFiles(scene).length);
    for (const name of copies) {
      const body = readFileSync(join(scene.staged.storeDir, 'pool-outbox', name), 'utf8');
      expect(createHash('sha256').update(body).digest('hex')).toBe(name.split('.').at(-2));
    }
  });

  it('writes no raw copy before an answer, after a no, or with the folder at skeleton only or off, and still writes the skeletons unless the folder is off', async () => {
    for (const [consent, folders, skeletons] of [
      [null, {}, true],
      ['declined', {}, true],
      ['granted', { proj: 'skeleton' }, true],
      ['granted', { proj: 'off' }, false],
    ] as const) {
      const scene = await ready(consent, folders);
      expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
      expect(rawFiles(scene)).toEqual([]);
      expect(outboxFiles(scene).length > 0).toBe(skeletons);
    }
  });

  it('turning a folder off removes what was queued and sends nothing more of it', async () => {
    const scene = await ready('granted');
    await scene.cli('pool', 'deposit', '--server', POOL);
    expect(rawFiles(scene).length).toBeGreaterThan(0);
    await updatePoolChoices(scene.staged.storeDir, (choices) => {
      choices.folders.proj = 'off';
    });
    await scene.cli('pool', 'deposit', '--server', POOL);
    expect(rawFiles(scene)).toEqual([]);
    expect(outboxFiles(scene)).toEqual([]);
  });

  it('masks the local account and home folder name in the queued copy, wherever it stands', async () => {
    const scene = await ready('granted');
    const [name] = localNames();
    if (name === undefined) throw new Error('this machine has no usable account name');
    writeFileSync(join(scene.staged.projectsRoot, 'proj', 'who.jsonl'), `${JSON.stringify({ type: 'user', message: { content: `see /x/.claude/projects/-Users-${name}-app and ${name}@box:~/app$` } })}\n`, { flag: 'a' });
    await scene.cli('pool', 'deposit', '--server', POOL);
    const bodies = rawFiles(scene).map((file) => readFileSync(join(scene.staged.storeDir, 'pool-outbox', file), 'utf8'));
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body.toLowerCase()).not.toContain(name.toLowerCase());
  });

  it('says a no to the raw prompt was heard and how to change it, and asks only when there was no answer', async () => {
    const declined = await ready('declined');
    await declined.cli('pool', 'deposit', '--server', POOL);
    expect(declined.h.out.join('')).toContain('You answered no to the raw prompt; oars pool raw --consent yes changes it.');
    expect(declined.h.out.join('')).not.toContain('until you answer the raw prompt');
  });

  it('writes no raw copy for a session the exclusion gate stops', async () => {
    const scene = await ready('granted');
    writeFileSync(join(scene.staged.projectsRoot, 'proj', 'tldr.jsonl'), `${TERM} appears here\n`, { flag: 'a' });
    await scene.cli('pool', 'deposit', '--server', POOL);
    expect(rawFiles(scene).filter((name) => name.includes('tldr'))).toEqual([]);
    expect(scene.sent()).not.toContain(TERM);
  });

  it('names the real command for the raw prompt in the deposit summary until it is answered yes', async () => {
    const asked = await ready(null);
    await asked.cli('pool', 'deposit', '--server', POOL);
    expect(asked.h.out.join('')).toContain('until you answer the raw prompt with oars pool raw --consent yes.');
    expect(asked.h.out.join('')).not.toContain('raw consent yes');
    const granted = await ready('granted');
    await granted.cli('pool', 'deposit', '--server', POOL);
    expect(granted.h.out.join('')).not.toContain('--consent yes');
  });

  it('lists each raw copy in the outbox with its hash and bytes, and prints the body only with --explain', async () => {
    const scene = await ready('granted');
    await scene.cli('pool', 'deposit', '--server', POOL);
    scene.h.out.length = 0;
    await scene.cli('pool', 'outbox', '--server', POOL);
    const listing = scene.h.out.join('');
    expect(listing).toMatch(/raw part 1\/1 sha256: [0-9a-f]{64} bytes: \d+/);
    const name = rawFiles(scene)[0] ?? '';
    const body = readFileSync(join(scene.staged.storeDir, 'pool-outbox', name), 'utf8');
    expect(listing).not.toContain(body.slice(0, 200));
    scene.h.out.length = 0;
    await scene.cli('pool', 'outbox', '--explain', '--server', POOL);
    expect(scene.h.out.join('')).toContain(body.slice(0, 200));
  });
});

describe('oars pool deposit --send holds the send lock (t884 fix round)', () => {
  it('waits while another run holds the lock, sends once it is released, and gives up with send_locked when the lock stays held', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    const outbox = outboxFolder(scene.staged.storeDir, POOL);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
    let release: () => void = () => undefined;
    let taken: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const holder = withSendLock(outbox, () => new Promise<void>((resolve) => {
      release = resolve;
      taken();
    }));
    await held;
    const sending = poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pool.requests).toEqual([]);
    release();
    await holder;
    expect(await sending).toMatchObject({ document: { ok: true, hash, sent: true } });
    expect(pool.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('refuses with send_locked when a fresh lock stays held past the wait', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const outbox = outboxFolder(scene.staged.storeDir, POOL);
      mkdirSync(outbox, { recursive: true });
      writeFileSync(join(outbox, 'send.lock'), '');
      const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
      const sending = poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
      // The lock waits on the wall clock, so the test moves a clock that only Date reads, a minute at a time, until the wait is over.
      const clock = setInterval(() => {
        vi.setSystemTime(Date.now() + 60_000);
      }, 10);
      const failed = await sending.catch((error: unknown) => error).finally(() => {
        clearInterval(clock);
      });
      expect(failed).toMatchObject({ exitCode: ExitCode.CONFLICT, problem: { code: 'send_locked' } });
      expect(pool.requests).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('oars pool outbox after the nightly send (t884 fix round)', () => {
  const grant = async (scene: Scene): Promise<void> => {
    await capture(scene);
    await signIn(scene);
    await updatePoolChoices(scene.staged.storeDir, (choices) => {
      choices.rawConsent = 'granted';
    });
    await scene.cli('pool', 'deposit', '--server', POOL);
  };
  const sentAt = '2026-11-07T03:04:05.000Z';
  const listed = (scene: Scene): { batches: { hash: string; sent?: string }[]; raw: { hash: string; sent?: string }[] } => {
    const document = scene.document();
    if (!isListing(document)) throw new Error('not an outbox document');
    return document;
  };
  const isListing = (value: unknown): value is { batches: { hash: string; sent?: string }[]; raw: { hash: string; sent?: string }[] } => typeof value === 'object' && value !== null && 'batches' in value && 'raw' in value;

  it('marks a batch and a raw copy the nightly task sent as sent, in the text and the document, and leaves the unsent ones plain', async () => {
    const scene = setting();
    await grant(scene);
    const outbox = outboxFolder(scene.staged.storeDir, POOL);
    scene.h.out.length = 0;
    await scene.cli('pool', 'outbox', '--server', POOL, '--json');
    const before = listed(scene);
    expect(before.batches.length).toBeGreaterThan(0);
    expect(before.raw.length).toBeGreaterThan(0);
    expect(before.batches.concat(before.raw).some((entry) => entry.sent !== undefined)).toBe(false);
    const [firstBatch, firstRaw] = [before.batches[0]?.hash ?? '', before.raw[0]?.hash ?? ''];
    await markSent(outbox, firstBatch, Date.parse(sentAt));
    await markSent(outbox, firstRaw, Date.parse(sentAt));
    scene.h.out.length = 0;
    await scene.cli('pool', 'outbox', '--server', POOL, '--json');
    const after = listed(scene);
    expect(after.batches[0]).toMatchObject({ hash: firstBatch, sent: sentAt });
    expect(after.raw[0]).toMatchObject({ hash: firstRaw, sent: sentAt });
    scene.h.out.length = 0;
    await scene.cli('pool', 'outbox', '--server', POOL);
    const text = scene.h.out.join('');
    expect(text).toContain(`sha256: ${firstBatch}\nsent: ${sentAt}`);
    expect(text).toMatch(new RegExp(`raw part 1/1 sha256: ${firstRaw} bytes: \\d+ sent: ${sentAt}`));
  });

  it('prints no sent mark for what was never sent', async () => {
    const scene = setting();
    await grant(scene);
    scene.h.out.length = 0;
    await scene.cli('pool', 'outbox', '--server', POOL);
    expect(scene.h.out.join('')).not.toContain('sent:');
  });

  it('marks a batch sent by `deposit --send` the same way, so the nightly task does not send it again', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
    await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
    expect((await sentHashes(outboxFolder(scene.staged.storeDir, POOL))).has(hash)).toBe(true);
  });
});

describe('oars pool raw (t884)', () => {
  it('shows the prompt until it is answered, records the answer, and can change it', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'raw')).toBe(ExitCode.OK);
    const shown = scene.h.out.join('');
    expect(shown).toContain('best effort');
    for (const unsafe of ['a host with no dot', 'quoted file contents and command output', 'a secret split across lines', 'images and attachments', 'a JSON env value', 'a common-word account name is masked everywhere', 'a public host name outside a link', 'your username written another way', 'an IPv6 address with a zone or inside a longer word', "another person's hyphenated name in a project folder path"]) expect(shown).toContain(unsafe);
    expect(shown).toContain('not answered yet: only skeletons go to the pool');
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'raw', '--consent', 'yes')).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('yes: redacted raw copies leave');
    expect(scene.h.out.join('')).not.toContain('best effort');
    expect(await scene.cli('pool', 'raw', '--consent', 'no')).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('no: only skeletons go to the pool');
  });

  it('sets and clears a folder switch, and refuses a half-given or unknown option', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'raw', '--folder', 'proj', '--mode', 'off')).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('proj: nothing sent to the pool');
    expect(await scene.cli('pool', 'raw', '--folder', 'proj', '--mode', 'skeleton')).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('proj: skeletons only');
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'raw', '--folder', 'proj', '--mode', 'all')).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).not.toContain('proj:');
    expect(await scene.cli('pool', 'raw', '--folder', 'proj')).toBe(ExitCode.USAGE);
    expect(await scene.cli('pool', 'raw', '--consent', 'maybe')).toBe(ExitCode.USAGE);
    expect(await scene.cli('pool', 'raw', '--folder', 'proj', '--mode', 'some')).toBe(ExitCode.USAGE);
  });
});

describe('oars pool logout (S8)', () => {
  const OTHER = 'https://other-pool.test';
  const entries = (scene: Scene): unknown => {
    const parsed: unknown = JSON.parse(readFileSync(join(scene.staged.storeDir, 'pool-accounts.json'), 'utf8'));
    return parsed;
  };
  const serversOf = (scene: Scene): string[] => {
    const held = entries(scene);
    return Array.isArray(held) ? held.map((entry) => String(at(entry, 'server'))) : [];
  };
  /** The pool's answer to `DELETE /v1/login`, recording the credential it was shown. */
  const revoking = (scene: Scene, reply: () => Response): void => {
    server.use(
      http.delete(`${POOL}/v1/login`, ({ request }) => {
        scene.seen.push({ url: request.url, headers: request.headers.get('authorization') ?? '', body: '', err: '' });
        return reply();
      }),
    );
  };

  it('revokes the credential at the pool with it, then removes the local entry and keeps the other servers', async () => {
    const scene = setting();
    await signIn(scene);
    const file = join(scene.staged.storeDir, 'pool-accounts.json');
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const saved: unknown[] = Array.isArray(parsed) ? parsed : [];
    writeFileSync(file, `${JSON.stringify([...saved, { server: OTHER, account: 'acct_two', token: 'other-token', expiresAt: LATER, signingKey: FIXED_KEY }])}\n`);
    revoking(scene, () => new HttpResponse(null, { status: 204 }));
    expect(await scene.cli('pool', 'logout', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(scene.seen).toEqual([{ url: `${POOL}/v1/login`, headers: `Bearer ${POOL_TOKEN}`, body: '', err: '' }]);
    expect(scene.document()).toEqual({ ok: true, server: POOL, revoked: true, removed: true });
    expect(serversOf(scene)).toEqual([OTHER]);
  });

  it('still removes the entry when the pool is out of reach, and says the credential was not revoked there', async () => {
    const scene = setting();
    await signIn(scene);
    revoking(scene, () => HttpResponse.error());
    expect(await scene.cli('pool', 'logout', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('could not be reached');
    expect(scene.h.out.join('')).toContain('not revoked');
    expect(serversOf(scene)).toEqual([]);
    scene.h.out.length = 0;
    await signIn(scene);
    revoking(scene, () => new HttpResponse(null, { status: 503 }));
    expect(await scene.cli('pool', 'logout', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(scene.document()).toEqual({ ok: true, server: POOL, revoked: false, removed: true });
    expect(serversOf(scene)).toEqual([]);
  });

  it('removes an entry the pool no longer knows (401), and keeps one when the pool refuses for another reason', async () => {
    const scene = setting();
    await signIn(scene);
    revoking(scene, () => HttpResponse.json({ error: 'unauthorized', message: 'Sign in with oars pool login first.' }, { status: 401 }));
    expect(await scene.cli('pool', 'logout', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('already revoked');
    expect(serversOf(scene)).toEqual([]);
    await signIn(scene);
    revoking(scene, () => HttpResponse.json({ error: 'internal', message: 'boom' }, { status: 500 }));
    expect(await scene.cli('pool', 'logout', '--server', POOL)).not.toBe(ExitCode.OK);
    expect(serversOf(scene)).toEqual([POOL]);
  });

  it('says so, and sends nothing, when there is no sign-in to that server', async () => {
    const scene = setting();
    revoking(scene, () => new HttpResponse(null, { status: 204 }));
    expect(await scene.cli('pool', 'logout', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(scene.document()).toEqual({ ok: true, server: POOL, revoked: false, removed: false });
    expect(scene.seen).toEqual([]);
  });
});

describe('the pool account file is the owner\'s alone (S9)', () => {
  const posix = it.skipIf(process.platform === 'win32');
  const modeOf = (path: string): number => statSync(path).mode & 0o777;

  posix('a login narrows an account file and a data folder that were once wider, and a logout keeps them narrow', async () => {
    const scene = setting();
    const file = join(scene.staged.storeDir, 'pool-accounts.json');
    mkdirSync(scene.staged.storeDir, { recursive: true });
    writeFileSync(file, '[]\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    chmodSync(scene.staged.storeDir, 0o755);
    poolAt(scene);
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(scene.staged.storeDir)).toBe(0o700);
    chmodSync(file, 0o644);
    server.use(http.delete(`${POOL}/v1/login`, () => new HttpResponse(null, { status: 204 })));
    expect(await scene.cli('pool', 'logout', '--server', POOL)).toBe(ExitCode.OK);
    expect(modeOf(file)).toBe(0o600);
  });
});

describe('oars pool login pins keys by key id (S17)', () => {
  const pinnedIn = (scene: Scene): unknown => {
    const parsed: unknown = JSON.parse(readFileSync(join(scene.staged.storeDir, 'pool-accounts.json'), 'utf8'));
    return Array.isArray(parsed) ? at(parsed[0], 'signingKeys') : undefined;
  };

  it('pins the key under the id the pool names (k1 for a pool that names none), adds a new id beside it, and refuses a changed key behind an id it holds', async () => {
    const scene = setting();
    poolAt(scene, { polls: [HttpResponse.json({ ...okLogin(), kid: 'k1' })] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(pinnedIn(scene)).toEqual({ k1: FIXED_KEY });
    const second: PinnedKey = { kty: 'OKP', crv: 'Ed25519', x: 'a-second-key' };
    poolAt(scene, { polls: [HttpResponse.json({ ...okLogin(second), kid: 'k2' })] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(pinnedIn(scene)).toEqual({ k1: FIXED_KEY, k2: second });
    poolAt(scene, { polls: [HttpResponse.json({ ...okLogin({ ...second, x: 'swapped' }), kid: 'k2' })] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(scene.document()).toMatchObject({ problem: { code: 'signing_key_changed' } });
    expect(JSON.stringify(at(scene.document(), 'problem'))).toContain('pinned for k2');
    expect(pinnedIn(scene)).toEqual({ k1: FIXED_KEY, k2: second });
  });
});
