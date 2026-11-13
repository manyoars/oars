import { spawnSync } from 'node:child_process';
import { createHash, createHmac, webcrypto } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The one pool source this test reads: the screen the pool holds for the newest covenant, which the CLI must present word for word.
import { COVENANT_TEXTS, COVENANT_VERSION_2_1 } from '../../../pool/src/covenant-texts.js';
import { run } from '../cli.js';
import { defaultConfigDir } from '../credentials.js';
import { ExitCode } from '../errors.js';
import { readSpool } from '../telemetry/spool.js';
import { harness, server, useServer, type Harness } from '../test-support.js';
import { busyLine, DEFAULT_POOL_URL, networkSender, OFFER_AFTER, OFFER_BEFORE, poolCoverage, poolDeposit, poolLogin, poolOutbox, poolRaw, poolRemove, poolServer, RAW_PHRASE, RAW_PROMPT, sleeps, waitingLine, type Reply, type Sender } from './pool-command.js';
import { localNames } from './redact.js';
import { batchHash, canonicalBytes, currentStamp, FIELD_ROWS, fieldsOf, heldAcross, outboxFolder, readPulled, readRemoved, writeBatch, writePulled } from './pool-outbox.js';
import { heldRaw, writeRaw } from './pool-raw.js';
import { markSent, sentHashes } from './pool-sent.js';
import { SendInterrupted, withSendLock, type LockFs, type LockTimes } from './pool-send-lock.js';
import type { Outgoing } from './pool-print.js';
import { REGISTRY_MAX_AGE_DAYS, VOCAB_SNAPSHOT_DATE } from './public-vocabulary.js';
import type * as PoolWire from './pool-wire.js';
import { session as sessionRow } from './pool-fixture.js';
import { slugOf } from './allow.js';
import { hookRowOf } from './codex-hook.js';
import { parseSkeleton, skeletonOf, VOCAB_VERSION, type PinnedKey, type SkeletonFrame } from './pool-wire.js';
import { appendRecall, makeRecall, type Recall } from './recall-object.js';
import { contentHash } from './read.js';
import { deposit, derive, loadStore, localSalt, paths, updatePoolChoices, type PoolChoices } from './store.js';
import { spoolEvents } from '../telemetry/read-events.js';
import { addProject, cleanup, FIXTURES, NOW, payloadOf, rolloutLine, settledClock, stage, stageCodex, TEST_FLOOR, type Staged } from './test-support.js';

// The session gates must stop a session before the projection runs; the real projection is wrapped so a test can see whether it was called.
vi.mock('./pool-wire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PoolWire>();
  // The memory proof's child must not keep a record of every call's arguments (a spy holds the whole session and batch it saw, about 33 KB a session), so there it runs the real function.
  return process.env.OARS_SEND_ALL_MEMORY_CHILD === undefined ? { ...actual, skeletonOf: vi.fn(actual.skeletonOf) } : actual;
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

async function refusalOf(promise: Promise<unknown>): Promise<{ message: string; problem: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return { message: error.message, problem: Reflect.get(error, 'problem') };
  }
  throw new Error('the call was not refused');
}

describe('the raw prompt states when and what uploads', () => {
  it('names the sender a hook or command starts, covenant acceptance, and the skeleton-only/off exception', () => {
    expect(RAW_PROMPT).toContain('the sender that a session-end hook or any oars command starts (at most about once an hour) uploads');
    // The sender is not nightly; only the pool's erasure of held copies is, and the prompt says so in those words.
    expect(RAW_PROMPT).not.toMatch(/nightly (send|upload)/);
    expect(RAW_PROMPT).toContain("A no stops later sends. If the GDPR or the UK GDPR protects you, it also reaches copies already sent. The pool starts erasing the raw copies it already holds for you at the pool's next nightly run; a large account, or a busy night, can take more than one night.");
    expect(RAW_PROMPT).toContain('Raw copies are covered by the covenant you accepted, including its license to sell them and to train on them.');
    expect(RAW_PROMPT).not.toContain('separate from the covenant');
    expect(RAW_PROMPT).not.toContain('cannot recall');
    expect(RAW_PROMPT).toContain('once the pool says your account accepted its covenant');
    expect(RAW_PROMPT).toContain('except a folder you set to skeleton only or off');
    expect(RAW_PROMPT).toContain('a block in a shape the redactor does not list yet, a summary the harness writes for a session you left, a file it quotes after compaction, the echo of a command you ran, a reminder the harness puts in the middle of a message, and what an agent reports back are not, and stay as written; the project folder name and working directory on each line also stay readable, apart from the masking above.');
  });
});

describe('the raw prompt matches the covenant it points to', () => {
  const covenant = readFileSync(fileURLToPath(new URL('../../../../docs/covenant/2.1-ec0ca3f6ff73.md', import.meta.url)), 'utf8').replace(/\s+/g, ' ');

  it('still licenses Raw Copies (2.3) and reaches copies already sent on withdrawal (6.6(b))', () => {
    expect(covenant).toContain('The grant covers Skeletons, Raw Copies, every other part of a Deposit');
    expect(covenant).toContain('Withdrawal reaches Raw Copies already sent');
    expect(RAW_PROMPT).toContain('covered by the covenant you accepted, including its license to sell them');
    expect(RAW_PROMPT).toContain('it also reaches copies already sent');
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

  it('names the exclusion-terms file and the variable that sets it when there is none, and says nothing when there is one', async () => {
    const bare = setting();
    const missing = join(bare.staged.root, 'no-such-terms.txt');
    bare.h.deps.env.OARS_EXCLUSION_TERMS = missing;
    poolAt(bare);
    expect(await bare.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    const lines = bare.h.out.join('').split('\n');
    expect(lines[0]).toBe(`Signed in to ${POOL} as acct_one.`);
    expect(bare.h.out.join('')).toContain(missing);
    expect(bare.h.out.join('')).toContain('OARS_EXCLUSION_TERMS');

    // The default place, when the variable is not set, is named too.
    const unset = setting();
    delete unset.h.deps.env.OARS_EXCLUSION_TERMS;
    poolAt(unset);
    expect(await unset.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(unset.h.out.join('')).toContain(join('session-commons', 'exclusion-terms.txt'));

    // --json stays one document, and an empty file counts as none.
    const json = setting();
    writeFileSync(join(json.staged.root, 'terms.txt'), '\n');
    poolAt(json);
    expect(await json.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(json.document()).toMatchObject({ ok: true, termsFile: join(json.staged.root, 'terms.txt') });
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

  it('leaves at most one abort listener on the signal however many polls wait, so a long sign-in prints no listener warning', async () => {
    const scene = setting();
    poolAt(scene, { start: { interval: 1, expiresIn: 1000 }, polls: [...Array.from({ length: 20 }, () => state('pending')), authorized()] });
    const stop = new AbortController();
    const seen: number[] = [];
    const sleep = scene.h.deps.sleep;
    scene.h.deps.sleep = async (ms) => {
      seen.push(getEventListeners(stop.signal, 'abort').length);
      await sleep(ms);
    };
    await poolLogin(scene.h.deps, { server: POOL, provider: 'github', signal: stop.signal });
    expect(seen.length).toBeGreaterThanOrEqual(15);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0);
  });

  it.each([
    ['a network error', () => HttpResponse.error()],
    ['an HTTP 502', () => HttpResponse.json({ error: 'provider_unavailable', message: 'The provider did not answer the poll.' }, { status: 502 })],
    ['an HTTP 503 with no body', () => new HttpResponse(null, { status: 503 })],
  ])('survives one bad poll (%s): it waits longer, polls again, and signs in', async (_name, bad) => {
    const scene = setting();
    poolAt(scene, { polls: [bad(), authorized()] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(scene.document()).toEqual({ ok: true, server: POOL, account: 'acct_one', expiresAt: LATER });
    // The interval, then the backed-off wait after one failure.
    expect(scene.h.sleeps).toEqual([2000, 4000]);
  });

  it('backs off on each failed poll, caps the wait, and goes back to the interval after an answer', async () => {
    const scene = setting();
    const bad = (): Response => new HttpResponse(null, { status: 503 });
    poolAt(scene, { start: { interval: 20, expiresIn: 1000 }, polls: [bad(), bad(), bad(), state('pending'), bad(), authorized()] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.sleeps).toEqual([20_000, 40_000, 60_000, 60_000, 20_000, 40_000]);
  });

  it('ends a login whose every poll failed only when the code expires, with the last failure', async () => {
    const down = setting();
    poolAt(down, { start: { interval: 4, expiresIn: 12 }, polls: [HttpResponse.json({ error: 'provider_unavailable', message: 'The provider did not answer the poll.' }, { status: 502 })] });
    expect(await down.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.UNREACHABLE);
    expect(down.document()).toMatchObject({ problem: { status: 502, title: 'The provider did not answer the poll.' } });
    expect(down.h.sleeps).toEqual([4000, 8000]);

    const dark = setting();
    poolAt(dark, { start: { interval: 4, expiresIn: 12 }, polls: [HttpResponse.error()] });
    expect(await dark.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNREACHABLE);
  });

  it('does not mistake a bug for a bad minute: a poll that throws something other than a CliError ends the login with it', async () => {
    const scene = setting();
    poolAt(scene, { polls: [authorized()] });
    const stderr = scene.h.deps.io.stderr;
    scene.h.deps.io.stderr = (text) => {
      if (text.includes('/v1/login/poll')) throw new TypeError('a bug in the printer');
      stderr(text);
    };
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--verbose')).toBe(ExitCode.UNEXPECTED);
    expect(scene.h.err.join('')).not.toContain('expired');
  });

  it('adds five seconds on slow_down even after a failed poll', async () => {
    const scene = setting();
    poolAt(scene, { polls: [new HttpResponse(null, { status: 500 }), state('slow_down'), authorized()] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.sleeps).toEqual([2000, 4000, 7000]);
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

  it('says the cause first and prints no request unless --verbose is given', async () => {
    const refused = (): void => {
      server.use(http.post(`${POOL}/v1/login/start`, () => HttpResponse.json({ error: 'no_pseudonym_key', message: 'This pool has no PSEUDONYM_KEY binding.' }, { status: 503 })));
    };
    const quiet = setting();
    refused();
    await quiet.cli('pool', 'login', '--provider', 'github', '--server', POOL);
    expect(quiet.h.err.join('').split('\n')[0]).toBe('This pool has no PSEUDONYM_KEY binding.');
    expect(requestLines(quiet.h.err.join(''))).toEqual([]);

    const loud = setting();
    refused();
    await loud.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--verbose');
    expect(requestLines(loud.h.err.join(''))).toEqual(['POST /v1/login/start HTTP/1.1']);
    expect(loud.h.err.join('').trimEnd().split('\n').at(-1)).toBe('This pool has no PSEUDONYM_KEY binding.');
  });

  it.each(['github', 'google'] as const)('prints every %s request with --verbose, headers and body, before sending it, with the handle masked', async (flavor) => {
    const scene = setting();
    poolAt(scene, { polls: [state('pending'), authorized()] });
    expect(await scene.cli('pool', 'login', '--provider', flavor, '--server', POOL, '--verbose')).toBe(ExitCode.OK);

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

describe('the session-start snapshot stays out of a deposit', () => {
  /** Every key the snapshot, the loaded set, or a status row owns (`skills` is a wire name too, so the byte comparison covers it). */
  const OWNED_KEYS = ['loadedInstructions', 'repoLevels', 'mainLevels', 'mainCheckout', 'instructions', 'hooks', 'levels', 'candidates', 'loadStatus', 'workingKinds', 'dotClaude', 'ancestors', 'local', 'rules', 'files'];
  const SALT = '0123456789abcdef0123456789abcdef';
  /** The harness's record of the instruction files it loaded: the transcript's loaded set comes from it. */
  const INSTRUCTIONS_RECORD = JSON.stringify({
    type: 'attachment',
    uuid: 'errors-a-instructions',
    parentUuid: null,
    timestamp: '2026-05-28T20:26:42.000Z',
    version: '2.1.300',
    attachment: {
      type: 'instructions',
      files: [
        { path: '/work/app/CLAUDE.md', type: 'Project' },
        { path: '/home/u/.claude/CLAUDE.md', type: 'User' },
        { path: '/work/app/CLAUDE.local.md', type: 'Local' },
        { path: '/work/app/.claude/CLAUDE.md', type: 'Project' },
        { path: '/work/app/.claude/rules/style.md', type: 'Project' },
      ],
    },
  });

  /** A store signed in and deposited through the command. Both stores hold the loaded set, since the transcript carries it; only `snapshot` adds `candidates.jsonl`, which names the captured session. */
  const deposited = async (snapshot: boolean): Promise<{ scene: Scene; batches: string[] }> => {
    const scene = setting();
    mkdirSync(scene.staged.storeDir, { recursive: true });
    writeFileSync(join(scene.staged.storeDir, 'salt'), SALT);
    appendFileSync(join(scene.staged.projectsRoot, 'proj', 'errors-a.jsonl'), `${INSTRUCTIONS_RECORD}\n`);
    await capture(scene);
    const held = (await loadStore(scene.staged.storeDir)).sessions.find((one) => one.loadedInstructions !== undefined);
    expect(held?.loadedInstructions, 'the transcript produced a loaded set').toEqual({ user: 1, levels: [0], local: 1, dotClaude: 1, rules: 1 });
    if (snapshot) {
      const shot = { v: 2, session: held?.session, at: '2026-11-09T07:00:00.000Z', harness: 'claude-code', instructions: { working: 3, parent: 2, above: 1, mainCheckout: 5, user: 1 }, workingKinds: { local: 1, dotClaude: 1, rules: 2 }, skills: { project: 4, user: 7 }, hooks: { user: {}, working: { SessionStart: 1 }, ancestors: { Stop: 1 } }, repoLevels: 2, mainLevels: 3 };
      writeFileSync(join(scene.staged.storeDir, 'candidates.jsonl'), `${JSON.stringify(shot)}\n`);
    }
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    return { scene, batches: outboxFiles(scene) };
  };

  it('queues the same batch bytes as a store without a snapshot, and none of the keys the snapshot owns', async () => {
    const control = await deposited(false);
    const held = await deposited(true);
    expect(control.batches.length).toBeGreaterThan(0);
    expect(held.batches).toEqual(control.batches);
    const read = (scene: Scene, name: string): string => readFileSync(join(scene.staged.storeDir, 'pool-outbox', name), 'utf8');
    for (const name of held.batches) {
      expect(read(held.scene, name)).toBe(read(control.scene, name));
      for (const owned of OWNED_KEYS) expect(read(held.scene, name), owned).not.toContain(`"${owned}"`);
    }
    expect(existsSync(join(held.scene.staged.storeDir, 'candidates.jsonl'))).toBe(true);
  });
});

describe('the Codex recording hook rows stay local', () => {
  const SALT = '0123456789abcdef0123456789abcdef';

  /** A store signed in and deposited through the command, optionally holding `hook-rows.jsonl` first. */
  const deposited = async (hookRows: boolean): Promise<{ scene: Scene; batches: string[] }> => {
    const scene = setting();
    mkdirSync(scene.staged.storeDir, { recursive: true });
    writeFileSync(join(scene.staged.storeDir, 'salt'), SALT);
    await capture(scene);
    if (hookRows) {
      const rows = (['SessionStart', 'PostToolUse', 'PostModelRequest'] as const).map((event) => hookRowOf(payloadOf(event, { session_id: 'codex-sess' }), '2026-11-09T12:00:00.000Z', '/home/me', () => null));
      writeFileSync(join(scene.staged.storeDir, 'hook-rows.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
    }
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    return { scene, batches: outboxFiles(scene) };
  };

  it('queues the same batch bytes as a store without them, and no hook row field reaches a batch or a request', async () => {
    const control = await deposited(false);
    const held = await deposited(true);
    expect(control.batches.length).toBeGreaterThan(0);
    expect(existsSync(join(held.scene.staged.storeDir, 'hook-rows.jsonl'))).toBe(true);
    expect(held.batches).toEqual(control.batches);
    const read = (scene: Scene, name: string): string => readFileSync(join(scene.staged.storeDir, 'pool-outbox', name), 'utf8');
    for (const name of held.batches) {
      expect(read(held.scene, name)).toBe(read(control.scene, name));
      expect(read(held.scene, name)).not.toContain('codex-sess');
    }
    expect(held.scene.sent()).not.toContain('codex-sess');
  });
});

// The deposit reads the local recall rows itself (`readRecalls`, then `deriveConsequences` over the store, then `recommendationsOf`), so this goes through the command: a test that calls `recommendationsOf` directly would stay green if the deposit stopped passing its result on.
describe('the recommendations a deposit carries come from the local recall rows', () => {
  const WITH_ROWS = '88888888-8888-4888-8888-888888888888';
  const WITHOUT_ROWS = '99999999-9999-4999-8999-999999999999';
  const VERSION = '2026-05-30T03:00:00.000Z';
  interface Carried {
    reads: number;
    recommendations?: { id: string; arm: string; poolVersion: string; from: number; to: number }[];
  }
  const stamp = (n: number): string => `2026-06-01T00:00:0${String(n)}.000Z`;
  const line = (session: string, n: number): string =>
    JSON.stringify({
      type: n === 0 ? 'user' : 'assistant',
      uuid: `${session}-${String(n)}`,
      parentUuid: n === 0 ? null : `${session}-${String(n - 1)}`,
      isSidechain: false,
      sessionId: session,
      cwd: '/w',
      timestamp: stamp(n),
      version: '2.1.300',
      message: n === 0 ? { role: 'user', content: 'read it' } : { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `t${String(n)}`, name: 'Read', input: { file_path: `/w/${String(n)}.ts` } }] },
    });
  const recall = (arm: 'shown' | 'held', at: string): Recall =>
    makeRecall({ sid: WITH_ROWS, at, frame: null, mode: 'push', query: { form: 'pattern', prefix: [`shape-${arm}`] }, poolVersion: VERSION, arm, reads: ['r1'], rendered: 'advice', names: ['file.read'], evidence: [] });

  /** The first session reads three files and the second two, the recall rows are written to the store folder before the deposit, and the batches the command queued come back by the reads they hold (a batch's id is a keyed hash, not the session's). */
  const deposited = async (rows: readonly Recall[]): Promise<{ [reads: number]: Carried }> => {
    const scene = setting();
    rmSync(join(scene.staged.projectsRoot, 'proj'), { recursive: true, force: true });
    addProject(scene.staged, 'proj', WITH_ROWS, [0, 1, 2, 3].map((n) => line(WITH_ROWS, n)));
    addProject(scene.staged, 'proj', WITHOUT_ROWS, [0, 1, 2].map((n) => line(WITHOUT_ROWS, n)));
    await capture(scene);
    for (const row of rows) await appendRecall(scene.staged.storeDir, row);
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    const batches = batchBytes(scene).map((bytes): Carried => {
      const parsed = parseSkeleton(JSON.parse(bytes));
      if (!parsed.ok) throw new Error(`${parsed.field}: ${parsed.reason}`);
      return { reads: parsed.skeleton.transcripts[0]?.tools.length ?? 0, ...(parsed.skeleton.recommendations === undefined ? {} : { recommendations: parsed.skeleton.recommendations }) };
    });
    return Object.fromEntries(batches.map((batch) => [batch.reads, batch]));
  };

  it('puts one shown and one held row on the session they belong to, with their windows, and nothing on a session with no row', async () => {
    // A row's window opens on the first call stamped after it: the shown row sits before the first read, the held row between the first and the second.
    const shown = recall('shown', '2026-06-01T00:00:00.500Z');
    const held = recall('held', '2026-06-01T00:00:01.500Z');
    const batches = await deposited([held, shown]);
    expect(Object.keys(batches)).toEqual(['2', '3']);
    expect(batches[3]?.recommendations).toEqual([
      { id: shown.id, arm: 'shown', poolVersion: VERSION, from: 0, to: 3 },
      { id: held.id, arm: 'held', poolVersion: VERSION, from: 1, to: 3 },
    ]);
    expect(batches[2]).not.toHaveProperty('recommendations');
  });

  it('puts nothing on any session when the store holds no row, so the pool reads every cell unknown', async () => {
    const batches = await deposited([]);
    expect(Object.keys(batches)).toEqual(['2', '3']);
    for (const batch of Object.values(batches)) expect(batch).not.toHaveProperty('recommendations');
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

/** A stand-in screen under a placeholder version: what the pool serves is its own text, and a test needs only the shape. */
const SCREEN_TEXT = ['FIXTURE COVENANT v1', '', 'This text stands in for a covenant in a test.', '', 'Full text: https://pool.test/covenant/v1', '', 'To accept, type: I AGREE TO THE FIXTURE'].join('\n');
const SCREEN = { text: SCREEN_TEXT, link: 'https://pool.test/covenant/v1', phrase: 'I AGREE TO THE FIXTURE', sha256: createHash('sha256').update(SCREEN_TEXT).digest('hex') };
const UNACCEPTED = answer(200, { version: 'v1', accepted: false, screen: SCREEN });

/** Makes the run a terminal and types each line into it; a run with none of this has stdin that is not a terminal. */
const atTerminal = (scene: Scene, ...lines: string[]): void => {
  Object.assign(scene.staged.stdin, { isTTY: true });
  Object.assign(scene.staged.runtime, { stderr: { isTTY: true } });
  for (const line of lines) scene.staged.stdin.write(`${line}\n`);
};

/** The pool choices as the store reads them now. */
const choicesOf = (scene: Scene): Promise<PoolChoices> => updatePoolChoices(scene.staged.storeDir, () => undefined);

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

    it('with no term file, the deposit says where the file goes and what sets it, and stays fail-closed', async () => {
      const scene = await alone([line('a plain request')]);
      const missing = join(scene.staged.root, 'no-such-terms.txt');
      scene.h.deps.env.OARS_EXCLUSION_TERMS = missing;
      expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
      expect(outboxFiles(scene)).toEqual([]);
      const printed = scene.h.out.join('');
      expect(printed).toContain('Wrote 0 of 1 sessions');
      expect(printed).toContain(`No exclusion terms file at ${missing}`);
      expect(printed).toContain('OARS_EXCLUSION_TERMS');

      const json = await poolDeposit(scene.h.deps, { server: POOL });
      expect(json.document).toMatchObject({ ok: true, termsFile: missing });

      // With the file there, the line is gone.
      writeFileSync(missing, 'zorblax\n');
      scene.h.out.length = 0;
      expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
      expect(scene.h.out.join('')).not.toContain('No exclusion terms file');
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
    const user = (text: string, at = '2026-06-01T00:00:00Z'): string => JSON.stringify({ type: 'user', sessionId: MAIN, cwd: '/w', timestamp: at, message: { role: 'user', content: text } });

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
      // A session's quiet time is its own last line's, so each line is stamped with the clock its capture ran under.
      const stamp = (hours: number): string => new Date(END - hours * HOUR).toISOString();
      addProject(scene.staged, FOLDER, MAIN, [user('a plain request', stamp(mainHours))]);
      const agents = join(scene.staged.projectsRoot, FOLDER, MAIN, 'subagents');
      mkdirSync(agents, { recursive: true });
      const agentFile = join(agents, 'agent-a.jsonl');
      writeFileSync(agentFile, `${user('the subagent starts', stamp(mainHours))}
`);
      await deposit(scene.staged.runtime, { allow: [FOLDER], redactDomains: [], now: () => END - mainHours * HOUR });
      writeFileSync(agentFile, `${user('the subagent starts', stamp(mainHours))}
${user('and goes on', stamp(agentHours))}
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

    it('builds at once from a store captured a minute ago when every transcript last line is two days old', async () => {
      const scene = setting();
      rmSync(join(scene.staged.projectsRoot, 'proj'), { recursive: true, force: true });
      addProject(scene.staged, FOLDER, MAIN, [user('an old request', new Date(END - 48 * HOUR).toISOString())]);
      await deposit(scene.staged.runtime, { allow: [FOLDER], redactDomains: [], now: () => END - 60_000 });
      settle(scene.staged.projectsRoot, END - 49 * HOUR);
      settle(join(scene.staged.storeDir, 'raw'), END - 49 * HOUR);
      await signIn(scene);
      scene.h.deps.now = () => END;
      await deposited(scene);
      expect(scene.document()).toMatchObject({ sessions: 1, batched: 1, notEnded: 0 });
      expect(outboxFiles(scene)).toHaveLength(1);
    });

    it('builds a days-old session captured a minute ago for a person at once, but the sender waits the hold window from capture', async () => {
      const scene = setting();
      rmSync(join(scene.staged.projectsRoot, 'proj'), { recursive: true, force: true });
      addProject(scene.staged, FOLDER, MAIN, [user('an old request', new Date(END - 48 * HOUR).toISOString())]);
      await deposit(scene.staged.runtime, { allow: [FOLDER], redactDomains: [], now: () => END - 60_000 });
      settle(scene.staged.projectsRoot, END - 49 * HOUR);
      settle(join(scene.staged.storeDir, 'raw'), END - 49 * HOUR);
      await signIn(scene);
      scene.h.deps.now = () => END;
      const early = await poolDeposit(scene.h.deps, { server: POOL, covenant: 'v1' });
      expect(early.document).toMatchObject({ sessions: 1, batched: 0, notEnded: 1 });
      expect(outboxFiles(scene)).toEqual([]);
      scene.h.deps.now = () => END - 60_000 + HOUR;
      const later = await poolDeposit(scene.h.deps, { server: POOL, covenant: 'v1' });
      expect(later.document).toMatchObject({ sessions: 1, batched: 1, notEnded: 0 });
    });

    it('counts no session uncaptured and withdraws none when another file replaces the log during the build (poolcompact)', async () => {
      const { scene } = await quiet(7, 7);
      const log = paths(scene.staged.storeDir).observations;
      const rows = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
      // A compaction renames a rewritten log into place; here the rewrite keeps every live row but starts with a long line a reader skips, so each offset the scan recorded now points elsewhere.
      const swap = `${log}.swap`;
      writeFileSync(swap, `${['x'.repeat(200_000), ...rows].join('\n')}\n`);
      let swapped = false;
      // The seam runs right after the build's scan of the log and before any chunk load.
      scene.h.deps.sessions = {
        ...scene.staged.runtime,
        afterScan: () => {
          renameSync(swap, log);
          swapped = true;
          return Promise.resolve();
        },
      };
      await deposited(scene);
      expect(swapped).toBe(true);
      expect(scene.document()).toMatchObject({ sessions: 1, batched: 1, notEnded: 0, uncaptured: 0 });
      expect(outboxFiles(scene)).toHaveLength(1);
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
    expect(JSON.stringify(scene.document())).toContain('--accept-covenant belongs to --send: it names the covenant version expected when a person accepts before a send. Nothing was accepted.');
    expect(scene.seen).toEqual([]);
  });

  it('sends from the command line once the covenant is accepted, and sends nothing before', async () => {
    const scene = await batched();
    const hash = await printedAndHash(scene);
    let accepted = false;
    on(scene, 'get', '/v1/covenant', () => HttpResponse.json({ version: 'v1', accepted, screen: SCREEN }));
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
    atTerminal(scene, SCREEN.phrase);
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--send', hash, '--accept-covenant', 'v1', '--in-eu-eea-uk', 'no', '--json')).toBe(ExitCode.OK);
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

  describe('the covenant is accepted by a person typing its phrase', () => {
    const acceptRoutes = (reply: Reply = UNACCEPTED): { [route: string]: Reply } => ({ 'GET /v1/covenant': reply, 'POST /v1/covenant/accept': answer(200, { ok: true, version: 'v1' }), 'POST /v1/deposits': answer(201) });
    const paths = (pool: { requests: Outgoing[] }): string[] => pool.requests.map((request) => request.url.pathname);

    it('prints the screen in full, then reads the phrase it states, and accepts naming the text it showed', async () => {
      const scene = await batched();
      const hash = await printedAndHash(scene);
      const pool = wire(acceptRoutes());
      atTerminal(scene, SCREEN.phrase, 'no');
      await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
      expect(scene.h.err.join('')).toContain(SCREEN.text);
      const accepted = pool.requests.find((request) => request.url.pathname === '/v1/covenant/accept');
      expect(JSON.parse(accepted?.body ?? '{}')).toEqual({ version: 'v1', textSha256: SCREEN.sha256, input: 'typed', client: `oars/${scene.h.deps.version}`, euEeaUk: 'no' });
      expect(paths(pool)).toEqual(['/v1/covenant', '/v1/covenant/accept', '/v1/deposits']);
    });

    describe('the offer lines around the screen (t1142)', () => {
      /** A sender that notes what had been printed to stderr when each request arrived, then answers as the wire does. */
      const watching = (routes: { [route: string]: Reply | Reply[] }, scene: Awaited<ReturnType<typeof batched>>): { pool: ReturnType<typeof wire>; printedAt: Map<string, string>; via: Sender } => {
        const pool = wire(routes);
        const printedAt = new Map<string, string>();
        const via: Sender = async (request) => {
          printedAt.set(request.url.pathname, scene.h.err.join(''));
          return pool.via(request);
        };
        return { pool, printedAt, via };
      };
      const ALL = [...OFFER_BEFORE, ...OFFER_AFTER];

      it('prints the before lines on stderr immediately ahead of the unchanged blank line and screen', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        atTerminal(scene, SCREEN.phrase, 'no');
        await poolDeposit(scene.h.deps, sendOptions(hash, wire(acceptRoutes()).via));
        const err = scene.h.err.join('');
        expect(err).toContain(`${OFFER_BEFORE.join('\n')}\n\n${SCREEN.text}\n\n> `);
        expect(err.indexOf(OFFER_BEFORE[0] ?? '')).toBeLessThan(err.indexOf(SCREEN.text));
      });

      it('records the hash of the screen text alone, so the lines never reach what was accepted', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const pool = wire(acceptRoutes());
        atTerminal(scene, SCREEN.phrase, 'no');
        await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
        const accepted = pool.requests.find((request) => request.url.pathname === '/v1/covenant/accept');
        const recorded: unknown = JSON.parse(accepted?.body ?? '{}');
        expect(recorded).toMatchObject({ textSha256: createHash('sha256').update(SCREEN_TEXT).digest('hex') });
        expect(recorded).toMatchObject({ textSha256: SCREEN.sha256 });
        expect(scene.h.err.join('')).toContain(OFFER_BEFORE[0] ?? '');
      });

      it('prints the after lines once the acceptance post succeeds, before the batch is sent', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const watched = watching(acceptRoutes(), scene);
        atTerminal(scene, SCREEN.phrase, 'no');
        await poolDeposit(scene.h.deps, sendOptions(hash, watched.via));
        const afterBlock = `${OFFER_AFTER.join('\n')}\n`;
        expect(watched.printedAt.get('/v1/covenant/accept')).not.toContain(OFFER_AFTER[0] ?? '');
        expect(watched.printedAt.get('/v1/deposits')).toContain(afterBlock);
        expect(scene.h.err.join('').split(OFFER_AFTER[0] ?? '').length - 1).toBe(1);
      });

      it('prints no after line on a wrong phrase', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        atTerminal(scene, 'not the phrase');
        await refusalOf(poolDeposit(scene.h.deps, sendOptions(hash, wire(acceptRoutes()).via)));
        const err = scene.h.err.join('');
        for (const line of OFFER_AFTER) expect(err).not.toContain(line);
        expect(err).toContain(OFFER_BEFORE[0] ?? '');
      });

      it('prints no after line when the region is closed', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const pool = wire({ ...acceptRoutes(), 'POST /v1/covenant/accept': answer(403, { error: 'region_closed', message: 'closed' }) });
        atTerminal(scene, SCREEN.phrase, 'yes');
        await refusalOf(poolDeposit(scene.h.deps, sendOptions(hash, pool.via)));
        for (const line of OFFER_AFTER) expect(scene.h.err.join('')).not.toContain(line);
      });

      it('prints no after line when the acceptance post fails', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const pool = wire({ ...acceptRoutes(), 'POST /v1/covenant/accept': answer(500, { error: 'boom', message: 'no' }) });
        atTerminal(scene, SCREEN.phrase, 'no');
        await refusalOf(poolDeposit(scene.h.deps, sendOptions(hash, pool.via)));
        for (const line of OFFER_AFTER) expect(scene.h.err.join('')).not.toContain(line);
      });

      it('prints no line at all off a terminal, or when the account has accepted already', async () => {
        const off = await batched();
        await refusalOf(poolDeposit(off.h.deps, sendOptions(await printedAndHash(off), wire(acceptRoutes()).via)));
        const done = await batched();
        await poolDeposit(done.h.deps, sendOptions(await printedAndHash(done), wire(acceptRoutes(answer(200, { version: 'v1', accepted: true, screen: SCREEN }))).via));
        for (const scene of [off, done]) for (const line of ALL) expect(scene.h.err.join('')).not.toContain(line);
      });

      it('names no money, payment, or price, and no earnings', () => {
        for (const line of ALL) expect(line).not.toMatch(/money|pay|paid|price|\$|earn/i);
      });

      it('names a command that exists: fetch is a pool subcommand and --help is its help', async () => {
        const scene = await batched();
        expect(await scene.cli('pool', 'fetch', '--help')).toBe(ExitCode.OK);
        expect(scene.h.out.join('')).toContain('fetch the signed bundle for one harness version');
        expect(OFFER_AFTER.join(' ')).toContain('oars pool fetch --help');
      });
    });

    it('presents covenant 2.1 as the pool holds it: its id, its text, and the hash of that text', async () => {
      const held = COVENANT_TEXTS.get(COVENANT_VERSION_2_1) ?? '';
      const screen = { text: held, link: `https://manyoars.com/covenant/${COVENANT_VERSION_2_1}`, phrase: 'I AGREE', sha256: createHash('sha256').update(held).digest('hex') };
      const scene = await batched();
      const hash = await printedAndHash(scene);
      const pool = wire({ ...acceptRoutes(answer(200, { version: COVENANT_VERSION_2_1, accepted: false, screen })), 'POST /v1/covenant/accept': answer(200, { ok: true, version: COVENANT_VERSION_2_1 }) });
      atTerminal(scene, 'I AGREE', 'no');
      await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
      expect(scene.h.err.join('')).toContain(`MANY OARS POOL COVENANT 2.1-ec0ca3f6ff73
`);
      const accepted = pool.requests.find((request) => request.url.pathname === '/v1/covenant/accept');
      expect(JSON.parse(accepted?.body ?? '{}')).toMatchObject({ version: '2.1-ec0ca3f6ff73', textSha256: screen.sha256, input: 'typed' });
    });

    describe('the region question', () => {
      const QUESTION = 'Are you in the EU, the EEA, or the UK? (yes/no)';
      const bodyOf = (pool: { requests: Outgoing[] }): unknown => {
        const sent: unknown = JSON.parse(pool.requests.find((request) => request.url.pathname === '/v1/covenant/accept')?.body ?? '{}');
        return sent;
      };

      it('asks after the phrase and before the acceptance call, and sends the answer', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const pool = wire(acceptRoutes());
        atTerminal(scene, SCREEN.phrase, ' No ');
        await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
        const shown = scene.h.err.join('');
        expect(shown.indexOf(QUESTION)).toBeGreaterThan(shown.indexOf(SCREEN.text));
        expect(bodyOf(pool)).toEqual({ version: 'v1', textSha256: SCREEN.sha256, input: 'typed', client: `oars/${scene.h.deps.version}`, euEeaUk: 'no' });
        expect(paths(pool)).toEqual(['/v1/covenant', '/v1/covenant/accept', '/v1/deposits']);
      });

      it('sends a yes as it was typed, for the pool to decide', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const pool = wire(acceptRoutes());
        atTerminal(scene, SCREEN.phrase, 'yes');
        await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
        expect(bodyOf(pool)).toMatchObject({ euEeaUk: 'yes' });
      });

      it('does not ask when the flag gives the answer', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const pool = wire(acceptRoutes());
        atTerminal(scene, SCREEN.phrase);
        await poolDeposit(scene.h.deps, { ...sendOptions(hash, pool.via), acceptCovenant: 'v1', inEuEeaUk: 'No' });
        expect(scene.h.err.join('')).not.toContain(QUESTION);
        expect(bodyOf(pool)).toMatchObject({ euEeaUk: 'no' });
      });

      it('accepts nothing for an answer that is not yes or no, or no answer at all', async () => {
        for (const typed of [['maybe'], [' '], []]) {
          const scene = await batched();
          const hash = await printedAndHash(scene);
          const pool = wire(acceptRoutes());
          atTerminal(scene, SCREEN.phrase, ...typed);
          scene.staged.stdin.end();
          const refused = await refusalOf(poolDeposit(scene.h.deps, sendOptions(hash, pool.via)));
          expect(refused.message).toContain('Answer yes or no');
          expect(refused.message).toContain('Nothing was accepted.');
          expect(paths(pool)).toEqual(['/v1/covenant']);
        }
      });

      it('does not ask when the phrase was wrong', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const pool = wire(acceptRoutes());
        atTerminal(scene, 'nope', 'no');
        await expect(poolDeposit(scene.h.deps, sendOptions(hash, pool.via))).rejects.toMatchObject({ problem: { code: 'covenant_not_accepted' } });
        expect(scene.h.err.join('')).not.toContain(QUESTION);
      });

      it('asks the question when --accept-covenant names the version and no region flag answers it', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const pool = wire(acceptRoutes());
        atTerminal(scene, SCREEN.phrase, 'no');
        await poolDeposit(scene.h.deps, { ...sendOptions(hash, pool.via), acceptCovenant: 'v1' });
        const shown = scene.h.err.join('');
        expect(shown.indexOf(QUESTION)).toBeGreaterThan(shown.indexOf(SCREEN.text));
        expect(bodyOf(pool)).toMatchObject({ euEeaUk: 'no' });
        expect(paths(pool)).toEqual(['/v1/covenant', '/v1/covenant/accept', '/v1/deposits']);
      });

      it('refuses a flag value that is not yes or no', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const pool = wire(acceptRoutes());
        atTerminal(scene, SCREEN.phrase);
        const refused = poolDeposit(scene.h.deps, { ...sendOptions(hash, pool.via), inEuEeaUk: 'maybe' });
        await expect(refused).rejects.toMatchObject({ exitCode: ExitCode.USAGE });
        await expect(refused).rejects.toThrow('--in-eu-eea-uk takes yes or no');
        expect(paths(pool)).toEqual([]);
      });

      it('refuses the flag without --send, as a usage error', async () => {
        const scene = await batched();
        const pool = wire(acceptRoutes());
        const refused = poolDeposit(scene.h.deps, { server: POOL, via: pool.via, inEuEeaUk: 'no' });
        await expect(refused).rejects.toMatchObject({ exitCode: ExitCode.USAGE });
        await expect(refused).rejects.toThrow('--in-eu-eea-uk belongs to --send');
        expect(paths(pool)).toEqual([]);
      });

      it('does not need the answer when the account has accepted already', async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const pool = wire(acceptRoutes(answer(200, { version: 'v1', accepted: true, screen: SCREEN })));
        await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
        expect(paths(pool)).toEqual(['/v1/covenant', '/v1/deposits']);
      });

      it("prints the pool's message and exits nonzero when the region is closed", async () => {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const message = 'Many Oars cannot take deposits from the EU, the EEA, or the UK yet. If you are not there, write to privacy@manyoars.com.';
        const pool = wire({ ...acceptRoutes(), 'POST /v1/covenant/accept': answer(403, { error: 'region_closed', message }) });
        atTerminal(scene, SCREEN.phrase, 'yes');
        const refused = poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
        await expect(refused).rejects.toMatchObject({ message, exitCode: ExitCode.AUTH, problem: { code: 'region_closed', status: 403 } });
        expect(paths(pool)).toEqual(['/v1/covenant', '/v1/covenant/accept']);
      });
    });

    it('asks the raw question again when the covenant accepted is not the one the saved yes was given under', async () => {
      const scene = await batched();
      await updatePoolChoices(scene.staged.storeDir, (choices) => {
        choices.rawConsent = 'granted';
        choices.rawConsentVersion = 'v0';
      });
      const hash = await printedAndHash(scene);
      atTerminal(scene, SCREEN.phrase, 'no');
      await poolDeposit(scene.h.deps, sendOptions(hash, wire(acceptRoutes()).via));
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: null, rawConsentVersion: null });
      expect(scene.h.err.join('')).toContain('no longer applies');
    });

    it('keeps a saved yes that was given under the covenant being accepted', async () => {
      const scene = await batched();
      await updatePoolChoices(scene.staged.storeDir, (choices) => {
        choices.rawConsent = 'granted';
        choices.rawConsentVersion = 'v1';
      });
      const hash = await printedAndHash(scene);
      atTerminal(scene, SCREEN.phrase, 'no');
      await poolDeposit(scene.h.deps, sendOptions(hash, wire(acceptRoutes()).via));
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'granted', rawConsentVersion: 'v1' });
      expect(scene.h.err.join('')).not.toContain('no longer applies');
    });

    it('accepts nothing on any other phrase, and says what to type', async () => {
      for (const typed of ['yes', 'i agree to the fixture', `${SCREEN.phrase} please`, '']) {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const pool = wire(acceptRoutes());
        atTerminal(scene, typed);
        const refusal = await refusalOf(poolDeposit(scene.h.deps, sendOptions(hash, pool.via)));
        expect(refusal.message, typed).toContain(SCREEN.phrase);
        expect(refusal.problem, typed).toMatchObject({ code: 'covenant_not_accepted' });
        expect(paths(pool), typed).toEqual(['/v1/covenant']);
      }
    });

    it('accepts nothing when the terminal ends before a phrase is typed', async () => {
      const scene = await batched();
      const hash = await printedAndHash(scene);
      const pool = wire(acceptRoutes());
      atTerminal(scene);
      scene.staged.stdin.end();
      await expect(poolDeposit(scene.h.deps, sendOptions(hash, pool.via))).rejects.toMatchObject({ problem: { code: 'covenant_not_accepted' } });
      expect(paths(pool)).toEqual(['/v1/covenant']);
    });

    it('accepts nothing off a terminal, even with the phrase on stdin, and says a person at a terminal is needed', async () => {
      const scene = await batched();
      const hash = await printedAndHash(scene);
      const pool = wire(acceptRoutes());
      scene.staged.stdin.write(`${SCREEN.phrase}\n`);
      const refusal = await refusalOf(poolDeposit(scene.h.deps, sendOptions(hash, pool.via)));
      expect(refusal.message).toContain('terminal');
      expect(refusal.problem).toMatchObject({ code: 'covenant_not_accepted' });
      expect(paths(pool)).toEqual(['/v1/covenant']);
      expect(scene.h.err.join('')).not.toContain(SCREEN.text);
    });

    it('refuses --accept-covenant off a terminal, where it would be a script saying yes', async () => {
      const scene = await batched();
      const hash = await printedAndHash(scene);
      const pool = wire(acceptRoutes());
      scene.staged.stdin.write(`${SCREEN.phrase}\n`);
      const refusal = await refusalOf(poolDeposit(scene.h.deps, { ...sendOptions(hash, pool.via), acceptCovenant: 'v1' }));
      expect(refusal.message).toContain('--accept-covenant');
      expect(paths(pool)).toEqual(['/v1/covenant']);
    });

    it('lets --accept-covenant fill the expected version on a terminal but never the phrase', async () => {
      const scene = await batched();
      const hash = await printedAndHash(scene);
      const refused = wire(acceptRoutes());
      atTerminal(scene, 'v1');
      await expect(poolDeposit(scene.h.deps, { ...sendOptions(hash, refused.via), acceptCovenant: 'v1' })).rejects.toMatchObject({ problem: { code: 'covenant_not_accepted' } });
      expect(paths(refused)).toEqual(['/v1/covenant']);
      const taken = wire(acceptRoutes());
      atTerminal(scene, SCREEN.phrase, 'no');
      await poolDeposit(scene.h.deps, { ...sendOptions(hash, taken.via), acceptCovenant: 'v1' });
      expect(paths(taken)).toEqual(['/v1/covenant', '/v1/covenant/accept', '/v1/deposits']);
    });

    it("stops when --accept-covenant names a version other than the pool's, before showing anything", async () => {
      const scene = await batched();
      const hash = await printedAndHash(scene);
      const pool = wire(acceptRoutes());
      atTerminal(scene, SCREEN.phrase);
      const refusal = await refusalOf(poolDeposit(scene.h.deps, { ...sendOptions(hash, pool.via), acceptCovenant: 'v0' }));
      expect(refusal.message).toContain('v1');
      expect(paths(pool)).toEqual(['/v1/covenant']);
      expect(scene.h.err.join('')).not.toContain(SCREEN.text);
    });

    it('refuses to accept when the pool holds no text for its covenant, even on a terminal with a phrase typed', async () => {
      const scene = await batched();
      const hash = await printedAndHash(scene);
      const pool = wire(acceptRoutes(answer(200, { version: 'v1', accepted: false, screen: null })));
      atTerminal(scene, SCREEN.phrase);
      const refusal = await refusalOf(poolDeposit(scene.h.deps, sendOptions(hash, pool.via)));
      expect(refusal.message).toContain('no text');
      expect(refusal.problem).toMatchObject({ code: 'covenant_not_accepted' });
      expect(paths(pool)).toEqual(['/v1/covenant']);
    });

    it('asks for nothing when the account has already accepted, and a flag that names the version then changes nothing', async () => {
      const scene = await batched();
      const hash = await printedAndHash(scene);
      const pool = wire(acceptRoutes(answer(200, { version: 'v1', accepted: true, screen: SCREEN })));
      atTerminal(scene);
      await poolDeposit(scene.h.deps, { ...sendOptions(hash, pool.via), acceptCovenant: 'v1' });
      expect(paths(pool)).toEqual(['/v1/covenant', '/v1/deposits']);
      expect(scene.h.err.join('')).not.toContain(SCREEN.text);
    });

    it('refuses the flag for an account that has already accepted when it is off a terminal or names another version', async () => {
      for (const [terminal, flag, message] of [[false, 'v1', 'not one'], [true, 'v0', 'v1']] as const) {
        const scene = await batched();
        const hash = await printedAndHash(scene);
        const pool = wire(acceptRoutes(answer(200, { version: 'v1', accepted: true, screen: SCREEN })));
        if (terminal) atTerminal(scene);
        const refusal = await refusalOf(poolDeposit(scene.h.deps, { ...sendOptions(hash, pool.via), acceptCovenant: flag }));
        expect(refusal.message).toContain(message);
        expect(paths(pool)).toEqual(['/v1/covenant']);
      }
    });

    it('is not at a terminal when stderr is not one, since the screen is written there: the typed phrase accepts nothing', async () => {
      const scene = await batched();
      const hash = await printedAndHash(scene);
      const pool = wire(acceptRoutes());
      atTerminal(scene, SCREEN.phrase, 'no');
      Object.assign(scene.staged.runtime, { stderr: { isTTY: false } });
      const refusal = await refusalOf(poolDeposit(scene.h.deps, sendOptions(hash, pool.via)));
      expect(refusal.problem).toMatchObject({ code: 'covenant_not_accepted' });
      expect(paths(pool)).toEqual(['/v1/covenant']);
      expect(scene.h.err.join('')).not.toContain(SCREEN.text);
    });

    it('stops if the pool refuses the acceptance, such as text that changed under the version', async () => {
      const scene = await batched();
      const hash = await printedAndHash(scene);
      const pool = wire({ ...acceptRoutes(), 'POST /v1/covenant/accept': answer(409, { error: 'covenant_text', message: 'The text you saw is not the text of covenant v1.' }) });
      atTerminal(scene, SCREEN.phrase, 'no');
      await expect(poolDeposit(scene.h.deps, sendOptions(hash, pool.via))).rejects.toMatchObject({ exitCode: ExitCode.UNEXPECTED });
      expect(paths(pool)).toEqual(['/v1/covenant', '/v1/covenant/accept']);
    });
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

    it.each([0, 1.5, '1'])('refuses a signed bundle whose clear floor is %j, rather than print it', async (clear) => {
      const { scene, sign } = await signedScene();
      on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, await floored(sign, { public: 5, disclosure: 2, clear }));
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.INVALID);
      expect(scene.h.err.join('')).toContain('not a signed bundle this version reads');
    });

    it('reads a bundle with a clear floor of 1 and carries it in --json', async () => {
      const { scene, sign } = await signedScene();
      on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, await floored(sign, { public: 5, disclosure: 2, clear: 1 }));
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      expect(scene.document()).toMatchObject({ floors: { public: 5, disclosure: 2, clear: 1 } });
    });

    it('reads a bundle that states no clear floor, as an older pool states none', async () => {
      const { scene, sign } = await signedScene();
      on(scene, 'get', `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`, await floored(sign, { public: 5, disclosure: 2 }));
      expect(await scene.cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
      expect(scene.document()).toMatchObject({ floors: { public: 5, disclosure: 2 } });
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
    expect(defaultConfigDir(scene.h.deps.env, 'win32', 'C:\\unused-home')).toBe(scene.staged.root);
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

  describe('covenant-shown', () => {
    /** Runs a send against the pool's reply with a person at a terminal who types the wrong thing; `terminal: false` leaves stdin as a script's. */
    const refused = async (reply: Reply, terminal = true): Promise<string> => {
      const scene = await batched();
      const dir = watched(scene);
      const hash = await printedAndHash(scene);
      const pool = wire({ 'GET /v1/covenant': reply, 'POST /v1/covenant/accept': answer(200, { ok: true, version: 'v1' }), 'POST /v1/deposits': answer(201, { ok: true }) });
      if (terminal) atTerminal(scene, 'no');
      await poolDeposit(scene.h.deps, sendOptions(hash, pool.via)).catch(() => undefined);
      return dir;
    };

    it('records the version of the screen the person was shown, and no other field', async () => {
      const dir = await refused(UNACCEPTED);
      expect(spooled(dir, 'covenant-shown').map((event) => event.data)).toEqual([{ version: 'v1' }]);
    });

    it('records nothing when the covenant is already accepted, or the pool is closed', async () => {
      expect(spooled(await refused(answer(200, { version: 'v1', accepted: true, screen: SCREEN })), 'covenant-shown')).toEqual([]);
      expect(spooled(await refused(answer(200, { version: null })), 'covenant-shown')).toEqual([]);
    });

    it('records nothing when no screen was shown: off a terminal, or with no text held for the version', async () => {
      expect(spooled(await refused(UNACCEPTED, false), 'covenant-shown')).toEqual([]);
      expect(spooled(await refused(answer(200, { version: 'v1', accepted: false, screen: null })), 'covenant-shown')).toEqual([]);
    });

    it('records the screen once when the person accepts in the same run', async () => {
      const scene = await batched();
      const dir = watched(scene);
      const hash = await printedAndHash(scene);
      const pool = wire({ 'GET /v1/covenant': UNACCEPTED, 'POST /v1/covenant/accept': answer(200, { ok: true, version: 'v1' }), 'POST /v1/deposits': answer(201, { ok: true }) });
      atTerminal(scene, SCREEN.phrase, 'no');
      await poolDeposit(scene.h.deps, sendOptions(hash, pool.via));
      expect(spooled(dir, 'covenant-shown').map((event) => event.data)).toEqual([{ version: 'v1' }]);
    });

    it('keeps a version text that is not a short word out of the spool', async () => {
      const dir = await refused(answer(200, { version: '/home/someone/private covenant', accepted: false, screen: SCREEN }));
      expect(spooled(dir, 'covenant-shown').map((event) => event.data)).toEqual([{}]);
      expect(readSpool(dir).join('')).not.toContain('someone');
    });
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
      choices.rawConsentVersion = consent === 'granted' ? 'v1' : null;
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

  it('queues no raw copy and prints one line when the yes was given under another covenant than the one in force', async () => {
    const scene = await ready('granted');
    await updatePoolChoices(scene.staged.storeDir, (choices) => {
      choices.rawConsentVersion = 'v0';
    });
    const held = await poolDeposit(scene.h.deps, { server: POOL, covenant: 'v1' });
    expect(rawFiles(scene)).toEqual([]);
    expect(outboxFiles(scene).length).toBeGreaterThan(0);
    expect(held.text.split('\n').filter((line) => line.includes('oars pool raw --consent yes') && line.includes('v0'))).toHaveLength(1);
    await poolDeposit(scene.h.deps, { server: POOL, covenant: 'v0' });
    expect(rawFiles(scene).length).toBeGreaterThan(0);
  });

  it('prints the one line through the deposit action when the pool is at another covenant than the yes was given under', async () => {
    const scene = await ready('granted');
    await updatePoolChoices(scene.staged.storeDir, (choices) => {
      choices.rawConsentVersion = 'v0';
    });
    const askedWith: (string | null)[] = [];
    server.use(
      http.get(`${POOL}/v1/covenant`, ({ request }) => {
        askedWith.push(request.headers.get('authorization'));
        return HttpResponse.json({ version: 'v1', accepted: true, screen: null });
      }),
    );
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(askedWith).toEqual([null]);
    expect(rawFiles(scene)).toEqual([]);
    expect(outboxFiles(scene).length).toBeGreaterThan(0);
    expect(scene.h.out.join('').split('\n').filter((line) => line.includes('oars pool raw --consent yes') && line.includes('v0'))).toHaveLength(1);
  });

  it('builds as before when the pool cannot be asked which covenant is in force', async () => {
    const scene = await ready('granted');
    server.use(http.get(`${POOL}/v1/covenant`, () => HttpResponse.error()));
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(rawFiles(scene).length).toBeGreaterThan(0);
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

  it('clears a Codex session on its rollout alone and queues that redacted rollout as its one raw copy', async () => {
    const scene = setting();
    rmSync(join(scene.staged.projectsRoot, 'proj'), { recursive: true, force: true });
    const id = 'cccc3333-3333-4333-8333-333333333333';
    const call = 'call_9f2e7a41c6b8d305e1a7f482';
    const agents = 'Prefer the amber ledger for every receipt';
    const stamp = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
    const home = stageCodex(scene.staged.root, [
      {
        id,
        lines: [
          rolloutLine(stamp(0), 'session_meta', { session_id: id, id, timestamp: stamp(0), cwd: '/w', originator: 'codex_cli_rs', cli_version: '0.50.0' }),
          rolloutLine(stamp(1), 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: ['<user_instructions>', agents, '</user_instructions>'].join(String.fromCharCode(10)) }] }),
          rolloutLine(stamp(2), 'event_msg', { type: 'user_message', message: 'fix the build' }),
          rolloutLine(stamp(3), 'response_item', { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: call }),
          rolloutLine(stamp(4), 'response_item', { type: 'function_call_output', call_id: call, output: 'README.md' }),
          rolloutLine(stamp(5), 'event_msg', { type: 'agent_message', message: 'fixed' }),
        ],
      },
    ]);
    // The rollout stays where Codex wrote it: oars archives nothing for a source, so the gate and the raw copy both reach it through the Codex source.
    scene.h.deps.sessions = { ...scene.staged.runtime, sourceRoots: { codex: home } };
    await deposit(scene.h.deps.sessions, { allow: [], redactDomains: [], now: () => NOW });
    await signIn(scene);
    await updatePoolChoices(scene.staged.storeDir, (choices) => {
      choices.rawConsent = 'granted';
      choices.rawConsentVersion = 'v1';
    });
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(outboxFiles(scene)).toHaveLength(1);
    const copies = rawFiles(scene);
    expect(copies).toHaveLength(1);
    const body = readFileSync(join(scene.staged.storeDir, 'pool-outbox', copies[0] ?? ''), 'utf8');
    expect(body).toContain('fix the build');
    expect(body).not.toContain(agents);
    expect(body).toMatch(/\[injected user-instructions [0-9a-f]+\]/);
    expect(scene.sent()).not.toContain(agents);
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

  it('marks the same injected block with the same hash in two sessions, keyed by the store salt of this machine', async () => {
    const scene = setting();
    rmSync(join(scene.staged.projectsRoot, 'proj'), { recursive: true, force: true });
    const block = 'Always answer in haiku and keep the blue lamp lit.';
    const sessions = ['66666666-6666-4666-8666-666666666666', '77777777-7777-4777-8777-777777777777'];
    for (const id of sessions) {
      const common = { sessionId: id, cwd: '/w', timestamp: '2026-06-01T00:00:00Z' };
      const lines = [{ ...common, type: 'attachment', attachment: { type: 'instructions', content: block } }, { ...common, type: 'user', message: { role: 'user', content: `typed words for ${id}` } }];
      addProject(scene.staged, 'zz-raw-folder', id, lines.map((entry) => JSON.stringify(entry)));
    }
    await deposit(scene.staged.runtime, { allow: ['zz-raw-folder'], redactDomains: [], now: () => NOW });
    await signIn(scene);
    await updatePoolChoices(scene.staged.storeDir, (choices) => {
      choices.rawConsent = 'granted';
      choices.rawConsentVersion = 'v1';
    });
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    const bodies = rawFiles(scene).map((name) => readFileSync(join(scene.staged.storeDir, 'pool-outbox', name), 'utf8'));
    expect(bodies).toHaveLength(2);
    const { salt } = await localSalt(scene.staged.storeDir);
    const expected = createHmac('sha256', `injected-block:${salt}`).update(block).digest('hex').slice(0, 12);
    for (const body of bodies) {
      expect(body).toContain(`[injected instructions ${expected}]`);
      expect(body).not.toContain('haiku');
    }
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
    const outbox = outboxFolder(scene.staged.storeDir, POOL);
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, 'send.lock'), '');
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
    // The lock's clock is the test's: each pause moves it, so the give-up comes at the wait and no real time passes.
    const clock = drivenLock();
    const failed = await poolDeposit(scene.h.deps, { ...sendOptions(hash, pool.via), lock: clock.lock }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ exitCode: ExitCode.CONFLICT, problem: { code: 'send_locked' } });
    expect(clock.at() - LOCK_FROM).toBe(120_000);
    expect(pool.requests).toEqual([]);
  });
});

describe('oars pool remove <hash> (t1149 item 2)', () => {
  const heldHashes = async (scene: Scene): Promise<string[]> => (await heldAcross(outboxFolder(scene.staged.storeDir, POOL))).batches.map((batch) => batch.hash);

  it('removes the one batch, says what it removed, and sends and changes nothing at the pool', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    expect(await heldHashes(scene)).toContain(hash);
    scene.seen.length = 0;
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'remove', hash, '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain(`Removed batch ${hash} from the outbox for ${POOL}. Nothing was sent, and nothing at the pool changed.`);
    expect(await heldHashes(scene)).not.toContain(hash);
    expect(scene.seen).toEqual([]);
    expect([...(await sentHashes(outboxFolder(scene.staged.storeDir, POOL)))]).not.toContain(hash);
  });

  it('takes the queued raw copies of the same session with it, and keeps those of another session', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    const outbox = outboxFolder(scene.staged.storeDir, POOL);
    const key = (await heldAcross(outbox)).batches.find((batch) => batch.hash === hash)?.key ?? '';
    await writeRaw(outbox, key, 1, 'first part');
    await writeRaw(outbox, key, 2, 'second part');
    const other = await writeRaw(outbox, 'f'.repeat(16), 1, 'another session');
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'remove', hash, '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('2 queued raw copies of the same session went with it.');
    expect((await heldRaw(outbox)).copies.map((copy) => copy.hash)).toEqual([other.hash]);
  });

  it('keeps the session out of the next deposit, says so, and brings it back with --restore', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    const before = await heldHashes(scene);
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'remove', hash, '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain(`stays out of every later oars pool deposit, the background sender's included, until you run oars pool remove ${hash} --restore.`);
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('1 session you removed with oars pool remove: nothing of them is built, queued, or sent.');
    expect(await heldHashes(scene)).toEqual(before.filter((held) => held !== hash));
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'remove', hash, '--restore', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain(`Restored the session of batch ${hash} for ${POOL}. Nothing was sent. A later oars pool deposit builds it again`);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect((await heldHashes(scene)).sort()).toEqual(before.sort());
    expect(scene.seen).toEqual([]);
  });

  it('keeps the session out after a login under another account, because the list holds the session id', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    const outbox = outboxFolder(scene.staged.storeDir, POOL);
    expect(await scene.cli('pool', 'remove', hash, '--server', POOL)).toBe(ExitCode.OK);
    expect(Object.values(await readRemoved(outbox, 'test')).map((entry) => entry.session)).toEqual([expect.any(String)]);
    poolAt(scene, { polls: [HttpResponse.json({ ...okLogin(), account: 'acct_two' })] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('Wrote 3 of 4 sessions');
    expect(scene.h.out.join('')).toContain('1 session you removed with oars pool remove');
  });

  const machineScene = async (): Promise<{ scene: Scene; outbox: string; hash: string }> => {
    const scene = setting({ OARS_HOST_CLASS: 'cloud', OARS_MACHINE: 'm1' });
    await capture(scene);
    const outbox = outboxFolder(scene.staged.storeDir, POOL);
    expect((await poolDeposit(scene.h.deps, { server: POOL })).text).toContain('Wrote 4 of 4 sessions');
    return { scene, outbox, hash: (await heldAcross(outbox)).batches[0]?.hash ?? '' };
  };

  it('keeps a machine session out after the machine settings change', async () => {
    const { scene, hash } = await machineScene();
    expect((await poolRemove(scene.h.deps, hash, { server: POOL })).text).not.toContain('No session in the store matches it');
    scene.h.deps.env.OARS_MACHINE = 'm3';
    const again = (await poolDeposit(scene.h.deps, { server: POOL })).text;
    expect(again).toContain('Wrote 3 of 4 sessions');
    expect(again).toContain('1 session you removed with oars pool remove');
  });

  it('says the exclusion holds for this account and machine settings only when no session in the store matches the batch, and restore clears it', async () => {
    const { scene, outbox, hash } = await machineScene();
    scene.h.deps.env.OARS_MACHINE = 'm2';
    expect((await poolRemove(scene.h.deps, hash, { server: POOL })).text).toContain('No session in the store matches it, so the exclusion holds for this account and machine settings only.');
    expect(Object.values(await readRemoved(outbox, 'test'))).toEqual([{ hash }]);
    expect(await poolRemove(scene.h.deps, hash, { server: POOL, restore: true })).toMatchObject({ document: { restored: true } });
    expect(await readRemoved(outbox, 'test')).toEqual({});
  });

  it('still skips a session by the key alone for an entry that holds no session id', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    const outbox = outboxFolder(scene.staged.storeDir, POOL);
    const before = await heldHashes(scene);
    expect(await scene.cli('pool', 'remove', hash, '--server', POOL)).toBe(ExitCode.OK);
    const [key = ''] = Object.keys(await readRemoved(outbox, 'test'));
    for (const entry of [JSON.stringify(hash), JSON.stringify({ hash })]) {
      writeFileSync(join(outbox, 'removed.json'), `{ "${key}": ${entry} }`);
      scene.h.out.length = 0;
      expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
      expect(scene.h.out.join('')).toContain('1 session you removed with oars pool remove');
      expect(await heldHashes(scene)).toEqual(before.filter((held) => held !== hash));
    }
  });

  it('fails clearly to restore a hash nothing removed', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'remove', 'b'.repeat(64), '--restore', '--server', POOL)).toBe(ExitCode.CONFLICT);
    expect(scene.h.err.join('')).toContain('No removed batch has that hash, so nothing was restored.');
  });

  it('fails clearly on a damaged removed list, in remove, restore, and deposit, and changes nothing', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    const outbox = outboxFolder(scene.staged.storeDir, POOL);
    const before = await heldHashes(scene);
    for (const damaged of ['{ not json', '["a"]', '{"a":1}']) {
      writeFileSync(join(outbox, 'removed.json'), damaged);
      for (const args of [['remove', hash], ['remove', hash, '--restore'], ['deposit']]) {
        scene.h.err.length = 0;
        expect(await scene.cli('pool', ...args, '--server', POOL)).toBe(ExitCode.INVALID);
        expect(scene.h.err.join('')).toContain('is not a list of removed sessions. Move it aside');
      }
    }
    expect(await heldHashes(scene)).toEqual(before);
  });

  it('says so when the batch was already sent, and drops a pulled batch from pulled.json', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    const outbox = outboxFolder(scene.staged.storeDir, POOL);
    const held = (await heldAcross(outbox)).batches.find((batch) => batch.hash === hash);
    await writePulled(outbox, { [held?.key ?? '']: currentStamp() });
    await markSent(outbox, hash, Date.UTC(2026, 10, 11));
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'remove', hash, '--server', POOL)).toBe(ExitCode.OK);
    const printed = scene.h.out.join('');
    expect(printed).toContain('It was already sent at');
    expect(printed).toContain('only oars pool hold pull admits it again');
    expect(await readPulled(outbox, 'test')).toEqual({});
    expect(await heldHashes(scene)).not.toContain(hash);
  });

  it('refuses while a send holds the lock, and removes nothing', async () => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    const outbox = outboxFolder(scene.staged.storeDir, POOL);
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
    const failed = await poolRemove(scene.h.deps, hash, { server: POOL }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ exitCode: ExitCode.CONFLICT, problem: { code: 'send_locked' } });
    expect(await heldHashes(scene)).toContain(hash);
    release();
    await holder;
  });

  it('fails clearly for a hash that is not in the outbox, and for text that is not a hash', async () => {
    const scene = await batched();
    const before = await heldHashes(scene);
    const absent = await scene.cli('pool', 'remove', 'a'.repeat(64), '--server', POOL);
    expect(absent).toBe(ExitCode.CONFLICT);
    expect(scene.h.err.join('')).toContain('No batch with that hash is in the outbox, so nothing was removed.');
    expect(await scene.cli('pool', 'remove', 'not-a-hash', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(await heldHashes(scene)).toEqual(before);
  });
});

/** Where the driven send lock's clock starts, in epoch ms: a lock file is read as last touched then. */
const LOCK_FROM = 1_000_000;
/** A send lock whose clock and pause the test drives: a pause moves the clock by the asked time and tells `onPause` the time it was asked at, so no real time passes. Only the pids in `alive` are running. */
const drivenLock = (onPause: (at: number) => void = () => undefined, alive: number[] = []): { lock: { times: Partial<LockTimes>; fs: LockFs }; at: () => number } => {
  const state = { at: LOCK_FROM };
  return {
    lock: {
      times: { pollMs: 250 },
      fs: {
        stat: () => Promise.resolve({ mtimeMs: LOCK_FROM }),
        running: (pid) => alive.includes(pid),
        clock: {
          now: () => state.at,
          sleep: (ms) => {
            onPause(state.at);
            state.at += ms;
            return Promise.resolve();
          },
        },
      },
    },
    at: () => state.at,
  };
};

describe('oars pool deposit --send says what it is doing and stops when told (t1143)', () => {
  /** What a stopped send tells the person: the batch stays queued and goes automatically once the covenant is accepted, how to keep a folder out, and how to stop this machine sending. */
  const STOPPED = [
    'Stopped. This batch stays queued, and once the covenant is accepted oars sends it automatically in the background.',
    'To keep a folder out, run oars pool raw --folder <folder> --mode off.',
    'To stop this machine sending, run oars pool logout.',
  ].join('\n');
  const STOPPED_AFTER_SENDING = STOPPED.replace('\nTo keep', '\nThe pool may already have received it.\nTo keep');
  const holder = { run: 'r', pid: 4242, host: 'laptop', since: 0 };
  const sendingScene = async (): Promise<{ scene: Scene; hash: string; outbox: string }> => {
    const scene = await batched();
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    const hash = printedHashes(scene)[0] ?? '';
    scene.h.err.length = 0;
    return { scene, hash, outbox: outboxFolder(scene.staged.storeDir, POOL) };
  };
  /** A fetch that answers the covenant as accepted and holds every other request until its signal aborts, as a pool that took the connection and went silent does. Returns a promise the handler resolves when the first held request arrives, so a test goes on exactly when that request is in flight and not after a count of ticks. */
  const stalledPool = (calls: string[], answersCovenant = true): Promise<void> => {
    let arrived: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    vi.stubGlobal('fetch', (url: URL, init?: RequestInit): Promise<Response> => {
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (answersCovenant && url.pathname === '/v1/covenant') return Promise.resolve(new Response(JSON.stringify({ version: 'v1', accepted: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
      arrived();
      return new Promise<Response>((_, reject) => {
        // Like fetch: a signal that already aborted rejects at once.
        const ended = (): void => {
          const reason: unknown = init?.signal?.reason;
          reject(reason instanceof Error ? reason : new Error('aborted'));
        };
        if (init?.signal?.aborted === true) ended();
        init?.signal?.addEventListener('abort', ended);
      });
    });
    return held;
  };
  const resetBy = (cause: Error): void => {
    vi.stubGlobal('fetch', (url: URL): Promise<Response> => (url.pathname === '/v1/covenant' ? Promise.resolve(new Response(JSON.stringify({ version: 'v1', accepted: true }), { status: 200, headers: { 'content-type': 'application/json' } })) : Promise.reject(new TypeError('fetch failed', { cause }))));
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('takes over a lock left by a dead run at once, with no waiting line, and leaves no signal hook behind', async () => {
    const { scene, hash, outbox } = await sendingScene();
    mkdirSync(outbox, { recursive: true });
    // A pid no machine runs: the holder died without releasing the lock.
    writeFileSync(join(outbox, 'send.lock'), JSON.stringify({ ...holder, pid: 2_147_483_646, host: hostname(), since: Date.now() }));
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
    const hooks = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM') + process.listenerCount('SIGHUP');
    expect(await poolDeposit(scene.h.deps, sendOptions(hash, pool.via))).toMatchObject({ document: { ok: true, hash, sent: true } });
    expect(scene.h.err.join('')).toBe(`Sending batch ${hash.slice(0, 12)} to ${POOL}...\n`);
    expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM') + process.listenerCount('SIGHUP')).toBe(hooks);
    expect(existsSync(join(outbox, 'send.lock'))).toBe(false);
  });

  it('prints who holds a live lock within a second, then refuses at the wait with the true condition for a retry', async () => {
    const { scene, hash, outbox } = await sendingScene();
    mkdirSync(outbox, { recursive: true });
    // This process is alive, so the lock is a live holder's: the clock rule never fires for it, because it keeps touching the file.
    writeFileSync(join(outbox, 'send.lock'), JSON.stringify({ ...holder, pid: process.pid, host: hostname(), since: LOCK_FROM - 60_500 }));
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
    let printedAt: number | undefined;
    const clock = drivenLock((at) => {
      if (printedAt === undefined && scene.h.err.length > 0) printedAt = at;
    }, [process.pid]);
    const failed = await poolDeposit(scene.h.deps, { ...sendOptions(hash, pool.via), lock: clock.lock }).catch((error: unknown) => error);
    // The notice comes at the first poll 500 ms into the wait: after the notice time, well within a second, and nowhere near the give-up.
    expect(printedAt).toBeDefined();
    expect((printedAt ?? 0) - LOCK_FROM).toBeGreaterThanOrEqual(500);
    expect((printedAt ?? 0) - LOCK_FROM).toBeLessThan(1000);
    expect(scene.h.err.join('')).toBe(`Another oars run (pid ${String(process.pid)}) took this outbox's send lock 61 seconds ago and is still sending. Waiting up to 2 minutes for it; Ctrl-C stops this run.\n`);
    expect(failed).toMatchObject({
      exitCode: ExitCode.CONFLICT,
      problem: { code: 'send_locked' },
      message: `Another oars run (pid ${String(process.pid)}) has held this outbox's send lock for 3 minutes and was still sending after the 2 minutes this run waited, so nothing was sent. A retry succeeds as soon as pid ${String(process.pid)} ends.`,
    });
    expect(clock.at() - LOCK_FROM).toBe(120_000);
    expect(pool.requests).toEqual([]);
    expect(JSON.parse(readFileSync(join(outbox, 'send.lock'), 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('words the waiting line and the busy refusal from the real constants', () => {
    const named = { run: 'r', pid: 4242, host: 'laptop', since: 0 };
    expect(waitingLine({ holder: named, ageMs: 90_000, waitMs: 120_000 })).toBe("Another oars run (pid 4242) took this outbox's send lock 90 seconds ago and is still sending. Waiting up to 2 minutes for it; Ctrl-C stops this run.");
    expect(waitingLine({ holder: undefined, ageMs: 30_000, waitMs: 120_000 })).toBe("Another oars run holds this outbox's send lock (the lock does not name its process; it was last touched 30 seconds ago). Waiting up to 2 minutes for it; Ctrl-C stops this run.");
    // A live holder on this host keeps the lock fresh, so no clock ever frees it: the only true promise is that its end does.
    expect(busyLine({ holder: named, local: true, ageMs: 180_000, untouchedMs: 1_000, waitedMs: 120_000, staleMs: 600_000 })).toBe(
      "Another oars run (pid 4242) has held this outbox's send lock for 3 minutes and was still sending after the 2 minutes this run waited, so nothing was sent. A retry succeeds as soon as pid 4242 ends.",
    );
    // A holder on another computer, or one the lock does not name, cannot be read: the clock decides, and a retry is certain once the lock has gone untouched for staleMs.
    expect(busyLine({ holder: named, local: false, ageMs: 180_000, untouchedMs: 120_000, waitedMs: 120_000, staleMs: 600_000 })).toBe(
      "Another oars run (pid 4242) has held this outbox's send lock for 3 minutes and was still sending after the 2 minutes this run waited, so nothing was sent. Run the same command again once it ends. If it has hung, oars takes the lock over about 8 minutes from now.",
    );
    expect(busyLine({ holder: undefined, local: false, ageMs: 600_000, untouchedMs: 600_000, waitedMs: 1000, staleMs: 600_000 })).toBe(
      "Another oars run has held this outbox's send lock for 10 minutes and was still sending after the 1 second this run waited, so nothing was sent. Run the same command again once it ends. If it has hung, oars takes the lock over about 1 second from now.",
    );
  });

  it('stops a send waiting for a live holder when the person presses Ctrl-C: nothing is requested, the holder keeps its lock, and no signal hook stays behind', async () => {
    const { scene, hash, outbox } = await sendingScene();
    mkdirSync(outbox, { recursive: true });
    writeFileSync(join(outbox, 'send.lock'), JSON.stringify({ ...holder, pid: process.pid, host: hostname(), since: LOCK_FROM }));
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201, { ok: true }) });
    const hooks = (): number[] => ['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => process.listenerCount(name));
    const before = hooks();
    let pauses = 0;
    // The second poll is where the person presses Ctrl-C: the listener the send installed is the real one.
    const clock = drivenLock(() => {
      pauses += 1;
      if (pauses === 2) process.emit('SIGINT');
    }, [process.pid]);
    expect(hooks()).toEqual(before);
    const failed = await poolDeposit(scene.h.deps, { ...sendOptions(hash, pool.via), lock: clock.lock }).catch((error: unknown) => error);
    expect(failed).toMatchObject({ exitCode: ExitCode.INTERRUPTED, message: STOPPED });
    expect(pauses).toBe(2);
    expect(pool.requests).toEqual([]);
    expect(JSON.parse(readFileSync(join(outbox, 'send.lock'), 'utf8'))).toMatchObject({ pid: process.pid });
    expect(hooks()).toEqual(before);
  });

  it('stops a send waiting on the covenant screen when the person presses Ctrl-C: nothing is accepted or posted, and no signal hook stays behind', async () => {
    const { scene, hash } = await sendingScene();
    // A terminal that has typed nothing: the screen waits for its line.
    atTerminal(scene);
    const pool = wire({ 'GET /v1/covenant': UNACCEPTED, 'POST /v1/covenant/accept': answer(200, { ok: true, version: 'v1' }), 'POST /v1/deposits': answer(201, { ok: true }) });
    const hooks = (): number[] => ['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => process.listenerCount(name));
    const before = hooks();
    // The screen's prompt is written to stderr; the wrapper signals that write, so the test goes on exactly when the screen waits for its line.
    const stderr = scene.h.deps.io.stderr;
    let prompted: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      prompted = resolve;
    });
    scene.h.deps.io.stderr = (text) => {
      stderr(text);
      if (scene.h.err.join('').includes(`${SCREEN.text}\n\n> `)) prompted();
    };
    let ended = false;
    const sending = poolDeposit(scene.h.deps, sendOptions(hash, pool.via)).catch((error: unknown) => error).finally(() => {
      ended = true;
    });
    await waiting;
    expect(ended).toBe(false);
    process.emit('SIGINT');
    // No bound of its own: a red run (the reader never freed) is ended by the suite's test timeout.
    expect(await sending).toMatchObject({ exitCode: ExitCode.INTERRUPTED, message: STOPPED });
    expect(pool.requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual(['GET /v1/covenant']);
    expect(hooks()).toEqual(before);
  });

  it('tells a person who deposits that nothing was sent yet, that the background sender sends once the covenant is accepted, and still points to the outbox', async () => {
    const scene = setting();
    await capture(scene);
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    const lines = scene.h.out.join('').trimEnd().split('\n');
    expect(lines[0]).toMatch(/^Wrote \d+ of \d+ sessions to the outbox for \S+\. Nothing was sent yet\. Once the covenant is accepted, oars sends what is queued automatically, in the background\.$/);
    expect(lines.at(-1)).toBe('Run oars pool outbox to print exactly what would be sent.');
  });

  it("keeps 'Nothing was sent.' for a machine, which the background sender never sends for", async () => {
    const scene = setting({ OARS_HOST_CLASS: 'cloud' });
    const { text } = await poolDeposit(scene.h.deps, { server: POOL });
    expect(text.split('\n')[0]).toMatch(/\. Nothing was sent\.$/);
    expect(text).not.toContain('automatically');
  });

  it('ends a send whose deposit the pool never answers after 30 seconds with a plain sentence that says the pool may have received it, marks nothing sent, and frees the lock', async () => {
    const { scene, hash, outbox } = await sendingScene();
    const calls: string[] = [];
    const held = stalledPool(calls);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let ended = false;
    const sending = poolDeposit(scene.h.deps, sendOptions(hash, undefined)).catch((error: unknown) => error).finally(() => {
      ended = true;
    });
    await held;
    expect(calls).toEqual(['GET /v1/covenant', 'POST /v1/deposits']);
    expect(scene.h.err.join('')).toBe(`Sending batch ${hash.slice(0, 12)} to ${POOL}...\n`);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await sending).toMatchObject({ exitCode: ExitCode.UNREACHABLE, message: `The pool at ${POOL} did not answer within 30 seconds. Nothing was marked sent. The pool may already have received it. Run the same command to try again.` });
    expect([...(await sentHashes(outbox))]).toEqual([]);
    expect(existsSync(join(outbox, 'send.lock'))).toBe(false);
  });

  it('ends a send whose deposit is in flight when the person presses Ctrl-C: says the pool may have received it, marks nothing sent, frees the lock, and leaves no signal hook', async () => {
    const { scene, hash, outbox } = await sendingScene();
    const calls: string[] = [];
    const held = stalledPool(calls);
    const hooks = (): number[] => ['SIGINT', 'SIGTERM', 'SIGHUP'].map((name) => process.listenerCount(name));
    const before = hooks();
    const sending = poolDeposit(scene.h.deps, sendOptions(hash, undefined)).catch((error: unknown) => error);
    await held;
    expect(calls).toEqual(['GET /v1/covenant', 'POST /v1/deposits']);
    process.emit('SIGINT');
    expect(await sending).toMatchObject({ exitCode: ExitCode.INTERRUPTED, message: STOPPED_AFTER_SENDING });
    expect([...(await sentHashes(outbox))]).toEqual([]);
    expect(existsSync(join(outbox, 'send.lock'))).toBe(false);
    expect(hooks()).toEqual(before);
  });

  it('does not say the pool may have received it when the stall came before the deposit went out', async () => {
    const { scene, hash } = await sendingScene();
    const calls: string[] = [];
    const held = stalledPool(calls, false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sending = poolDeposit(scene.h.deps, sendOptions(hash, undefined)).catch((error: unknown) => error);
    await held;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await sending).toMatchObject({ exitCode: ExitCode.UNREACHABLE, message: `The pool at ${POOL} did not answer within 30 seconds. Nothing was marked sent. Run the same command to try again.` });
    expect(calls).toEqual(['GET /v1/covenant']);
  });

  it('says a dropped connection in plain words and keeps the raw reason in parentheses', async () => {
    const { scene, hash } = await sendingScene();
    resetBy(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    expect(await poolDeposit(scene.h.deps, sendOptions(hash, undefined)).catch((error: unknown) => error)).toMatchObject({
      exitCode: ExitCode.UNREACHABLE,
      message: `Cannot reach the pool at ${POOL}: the connection was dropped before the pool answered (read ECONNRESET). Nothing was marked sent. The pool may already have received it. Run the same command to try again.`,
    });
  });

  it('says the pool may have received the batch when the connection drops after the deposit request went out, driven by the handler, and marks nothing sent', async () => {
    const { scene, hash, outbox } = await sendingScene();
    const calls: string[] = [];
    let drop: (cause: Error) => void = () => undefined;
    let arrived: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    vi.stubGlobal('fetch', (url: URL, init?: RequestInit): Promise<Response> => {
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/v1/covenant') return Promise.resolve(new Response(JSON.stringify({ version: 'v1', accepted: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
      arrived();
      return new Promise<Response>((_, reject) => {
        drop = (cause) => {
          reject(new TypeError('fetch failed', { cause }));
        };
      });
    });
    const sending = poolDeposit(scene.h.deps, sendOptions(hash, undefined)).catch((error: unknown) => error);
    await inFlight;
    expect(calls).toEqual(['GET /v1/covenant', 'POST /v1/deposits']);
    drop(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    expect(await sending).toMatchObject({
      exitCode: ExitCode.UNREACHABLE,
      message: `Cannot reach the pool at ${POOL}: the connection was dropped before the pool answered (read ECONNRESET). Nothing was marked sent. The pool may already have received it. Run the same command to try again.`,
    });
    expect([...(await sentHashes(outbox))]).toEqual([]);
    expect(existsSync(join(outbox, 'send.lock'))).toBe(false);
  });

  it('does not say the pool may have received the batch when the connection was refused', async () => {
    const { scene, hash } = await sendingScene();
    resetBy(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }));
    expect(await poolDeposit(scene.h.deps, sendOptions(hash, undefined)).catch((error: unknown) => error)).toMatchObject({
      exitCode: ExitCode.UNREACHABLE,
      message: `Cannot reach the pool at ${POOL}: nothing is listening there (connect ECONNREFUSED 127.0.0.1:1). Nothing was marked sent. Run the same command to try again.`,
    });
  });

  it('says the pool may have received the batch for ETIMEDOUT, which an open socket raises after the body was written', async () => {
    const { scene, hash } = await sendingScene();
    resetBy(Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    expect(await poolDeposit(scene.h.deps, sendOptions(hash, undefined)).catch((error: unknown) => error)).toMatchObject({
      exitCode: ExitCode.UNREACHABLE,
      message: `Cannot reach the pool at ${POOL}: the connection timed out (read ETIMEDOUT). Nothing was marked sent. The pool may already have received it. Run the same command to try again.`,
    });
  });

  it('does not say the pool may have received the batch when the connect itself timed out', async () => {
    const { scene, hash } = await sendingScene();
    resetBy(Object.assign(new Error(''), { code: 'UND_ERR_CONNECT_TIMEOUT' }));
    expect(await poolDeposit(scene.h.deps, sendOptions(hash, undefined)).catch((error: unknown) => error)).toMatchObject({
      exitCode: ExitCode.UNREACHABLE,
      message: `Cannot reach the pool at ${POOL}: the connection timed out (UND_ERR_CONNECT_TIMEOUT). Nothing was marked sent. Run the same command to try again.`,
    });
  });

  it('leaves a reason it has no words for as it was', async () => {
    const { scene, hash } = await sendingScene();
    resetBy(new Error('certificate has expired'));
    expect(await poolDeposit(scene.h.deps, sendOptions(hash, undefined)).catch((error: unknown) => error)).toMatchObject({ exitCode: ExitCode.UNREACHABLE, message: `Cannot reach the server at ${POOL}: certificate has expired` });
  });

  it('ends the request in flight when the run is interrupted, and does not start one on a signal that already fired', async () => {
    const { scene } = await sendingScene();
    const calls: string[] = [];
    const held = stalledPool(calls);
    const stop = new AbortController();
    const sender = networkSender(scene.h.deps, 'deposit', { stallMs: 30_000, signal: stop.signal });
    const headers: Array<[string, string]> = [];
    const request: Outgoing = { method: 'POST', url: new URL('/v1/deposits', POOL), headers };
    const inflight = sender(request).catch((error: unknown) => error);
    await held;
    stop.abort(new SendInterrupted('signal', 'Interrupted by SIGINT.', 'SIGINT'));
    expect(await inflight).toMatchObject({ exitCode: ExitCode.INTERRUPTED, message: STOPPED_AFTER_SENDING });
    expect(await sender(request).catch((error: unknown) => error)).toMatchObject({ message: STOPPED });
  });

  it.each([
    ['a kill (SIGTERM)', new SendInterrupted('signal', 'Interrupted by SIGTERM.', 'SIGTERM')],
    ['a launcher that died', new SendInterrupted('launcher', 'The program that started this send is gone.')],
  ])('keeps the unexpected exit code when the send is ended by %s: only Ctrl-C exits 130', async (_name, interrupt) => {
    const { scene } = await sendingScene();
    const stop = new AbortController();
    stop.abort(interrupt);
    const sender = networkSender(scene.h.deps, 'deposit', { stallMs: 30_000, signal: stop.signal });
    const request: Outgoing = { method: 'POST', url: new URL('/v1/deposits', POOL), headers: [] };
    expect(await sender(request).catch((error: unknown) => error)).toMatchObject({ exitCode: ExitCode.UNEXPECTED, message: STOPPED });
  });
});

describe('oars pool outbox after the nightly send (t884 fix round)', () => {
  const grant = async (scene: Scene): Promise<void> => {
    await capture(scene);
    await signIn(scene);
    await updatePoolChoices(scene.staged.storeDir, (choices) => {
      choices.rawConsent = 'granted';
      choices.rawConsentVersion = 'v1';
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
  const covenantIs = (version: string | null): void => {
    server.use(http.get(`${POOL}/v1/covenant`, () => HttpResponse.json({ version, accepted: false, screen: null })));
  };

  it('states the sale and training use in the prompt it shows', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'raw')).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('Many Oars Co. may sell these copies and use them to train AI models, and it may let anyone it sells them to do the same.');
  });

  it('stores a yes with the covenant version in force, and a no with none', async () => {
    const scene = setting({ OARS_POOL_URL: POOL });
    covenantIs('v1');
    atTerminal(scene, RAW_PHRASE);
    expect(await scene.cli('pool', 'raw', '--consent', 'yes')).toBe(ExitCode.OK);
    expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'granted', rawConsentVersion: 'v1' });
    // This machine holds no sign-in but held the yes, so the pool may still hold it: the no is saved and the command says the pool was not told.
    expect(await scene.cli('pool', 'raw', '--consent', 'no')).toBe(ExitCode.AUTH);
    expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'declined', rawConsentVersion: null });
  });

  it('records no yes while the pool has published no covenant, or cannot say which it is', async () => {
    const scene = setting({ OARS_POOL_URL: POOL });
    atTerminal(scene, RAW_PHRASE);
    covenantIs(null);
    expect(await scene.cli('pool', 'raw', '--consent', 'yes')).toBe(ExitCode.AUTH);
    server.use(http.get(`${POOL}/v1/covenant`, () => new HttpResponse('down', { status: 500 })));
    expect(await scene.cli('pool', 'raw', '--consent', 'yes')).not.toBe(ExitCode.OK);
    expect(await choicesOf(scene)).toMatchObject({ rawConsent: null, rawConsentVersion: null });
  });

  it('reads a saved yes with no version, from before the prompt named the sale, as not asked', async () => {
    const scene = setting();
    mkdirSync(scene.staged.storeDir, { recursive: true });
    writeFileSync(paths(scene.staged.storeDir).state, JSON.stringify({ files: {}, redactDomains: [], allow: [], pool: { rawConsent: 'granted', folders: {} } }));
    expect(await choicesOf(scene)).toMatchObject({ rawConsent: null, rawConsentVersion: null });
    expect(await scene.cli('pool', 'raw')).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('not answered yet: only skeletons go to the pool');
    expect(scene.h.out.join('')).toContain('may sell these copies');
  });

  it('honors a saved yes that carries the covenant version, and a saved no whatever it carries', async () => {
    const scene = setting();
    mkdirSync(scene.staged.storeDir, { recursive: true });
    writeFileSync(paths(scene.staged.storeDir).state, JSON.stringify({ files: {}, redactDomains: [], allow: [], pool: { rawConsent: 'granted', rawConsentVersion: 'v1', folders: {} } }));
    expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'granted', rawConsentVersion: 'v1' });
    writeFileSync(paths(scene.staged.storeDir).state, JSON.stringify({ files: {}, redactDomains: [], allow: [], pool: { rawConsent: 'declined', folders: {} } }));
    expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'declined', rawConsentVersion: null });
  });

  it('shows the prompt until it is answered, records the answer, and can change it', async () => {
    const scene = setting({ OARS_POOL_URL: POOL });
    expect(await scene.cli('pool', 'raw')).toBe(ExitCode.OK);
    const shown = scene.h.out.join('');
    expect(shown).toContain('best effort');
    for (const unsafe of ['a host with no dot', 'quoted file contents and command output', 'a secret split across lines', 'images and attachments', 'a JSON env value', 'a common-word account name is masked everywhere', 'a public host name outside a link', 'your username written another way', 'an IPv6 address with a zone or inside a longer word', "another person's hyphenated name in a project folder path"]) expect(shown).toContain(unsafe);
    expect(shown).toContain('not answered yet: only skeletons go to the pool');
    scene.h.out.length = 0;
    covenantIs('v1');
    atTerminal(scene, RAW_PHRASE);
    expect(await scene.cli('pool', 'raw', '--consent', 'yes')).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('yes, given under covenant v1: redacted raw copies leave while that covenant is in force');
    expect(scene.h.out.join('')).not.toContain('best effort');
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'raw', '--json')).toBe(ExitCode.OK);
    expect(JSON.parse(scene.h.out.join(''))).toMatchObject({ rawConsent: 'granted', rawConsentVersion: 'v1' });
    await signIn(scene);
    server.use(http.delete(`${POOL}/v1/consent/raw`, () => HttpResponse.json({ ok: true })));
    scene.h.out.length = 0;
    expect(await scene.cli('pool', 'raw', '--consent', 'no')).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('no: only skeletons go to the pool');
  });

  it('states both the sale and the special category consent, before the answer', () => {
    const special = 'Yes is also your explicit consent to processing any health, belief, or other special category data about you that a copy holds, for these purposes. You can withdraw it at any time with oars pool raw --consent no, and that reaches copies already sent. Your access does not depend on it.';
    expect(RAW_PROMPT).toContain(special);
    expect(RAW_PROMPT).toContain('Many Oars Co. may sell these copies and use them to train AI models, and it may let anyone it sells them to do the same.');
    expect(RAW_PROMPT.indexOf(special)).toBeLessThan(RAW_PROMPT.indexOf('Say no, or say nothing'));
  });

  describe('a yes is a person typing the phrase (GDPR Articles 7 and 9(2)(a))', () => {
    it('holds the phrase in one constant', () => {
      expect(RAW_PHRASE).toBe('I consent to sending raw copies');
    });

    it('prints the prompt in full and the phrase it asks for, reads the phrase, and records the yes under the covenant in force', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      covenantIs('v1');
      atTerminal(scene, RAW_PHRASE);
      expect(await scene.cli('pool', 'raw', '--consent', 'yes')).toBe(ExitCode.OK);
      expect(scene.h.err.join('')).toContain(RAW_PROMPT);
      expect(scene.h.err.join('')).toContain(`type exactly: ${RAW_PHRASE}`);
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'granted', rawConsentVersion: 'v1' });
    });

    it('records nothing for a wrong phrase, and says why', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      covenantIs('v1');
      atTerminal(scene, 'yes');
      const refused = await refusalOf(poolRaw(scene.h.deps, { consent: 'yes' }));
      expect(refused.message).toContain('That was not the phrase');
      expect(refused.message).toContain(RAW_PHRASE);
      expect(refused.message).toContain('Nothing was recorded');
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: null, rawConsentVersion: null });
    });

    it('records nothing when the terminal ends before a phrase is typed', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      covenantIs('v1');
      atTerminal(scene);
      scene.staged.stdin.end();
      const refused = await refusalOf(poolRaw(scene.h.deps, { consent: 'yes' }));
      expect(refused.message).toContain('No phrase was typed');
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: null });
    });

    it('records nothing off a terminal, even with the phrase on stdin, and asks no one', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      covenantIs('v1');
      scene.staged.stdin.write(`${RAW_PHRASE}
`);
      const refused = await refusalOf(poolRaw(scene.h.deps, { consent: 'yes' }));
      expect(refused.message).toContain('terminal');
      expect(refused.message).toContain('Nothing was recorded');
      expect(scene.h.err.join('')).not.toContain(RAW_PROMPT);
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: null });
    });
  });

  describe('a no reaches the pool (GDPR Article 7(3))', () => {
    const WITHDRAW = `${POOL}/v1/consent/raw`;
    /** The pool's answer to the withdrawal, with the credential it carried and the answer the store held when it arrived. */
    const withdrawing = (scene: Scene, reply: () => Response): { calls: Array<{ authorization: string; stored: string | null }> } => {
      const calls: Array<{ authorization: string; stored: string | null }> = [];
      server.use(
        http.delete(WITHDRAW, async ({ request }) => {
          calls.push({ authorization: request.headers.get('authorization') ?? '', stored: (await choicesOf(scene)).rawConsent });
          return reply();
        }),
      );
      return { calls };
    };
    const yes = async (scene: Scene): Promise<void> => {
      await updatePoolChoices(scene.staged.storeDir, (choices) => {
        choices.rawConsent = 'granted';
        choices.rawConsentVersion = 'v1';
      });
    };

    it('saves the local answer first, then tells the pool with the account credential', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      await signIn(scene);
      await yes(scene);
      const pool = withdrawing(scene, () => HttpResponse.json({ ok: true }));
      expect(await scene.cli('pool', 'raw', '--consent', 'no', '--json')).toBe(ExitCode.OK);
      expect(pool.calls).toEqual([{ authorization: `Bearer ${POOL_TOKEN}`, stored: 'declined' }]);
      expect(scene.document()).toMatchObject({ ok: true, rawConsent: 'declined', pool: 'told' });
    });

    it('keeps the local no, says the pool was not told, and exits nonzero when it cannot be reached, and a rerun tells it', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      await signIn(scene);
      await yes(scene);
      server.use(http.delete(WITHDRAW, () => HttpResponse.error()));
      const refused = await refusalOf(poolRaw(scene.h.deps, { consent: 'no' }));
      expect(refused.message).toContain('was not told');
      expect(refused.message).toContain('again');
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'declined', rawConsentVersion: null });
      expect(await scene.cli('pool', 'raw', '--consent', 'no')).toBe(ExitCode.UNREACHABLE);
      const pool = withdrawing(scene, () => HttpResponse.json({ ok: true }));
      expect(await scene.cli('pool', 'raw', '--consent', 'no')).toBe(ExitCode.OK);
      expect(pool.calls).toHaveLength(1);
      expect(scene.h.out.join('')).toContain('The pool was told');
      expect(scene.h.out.join('')).toContain("starts erasing at the pool's next nightly run; a large account, or a busy night, can take more than one night");
      expect(scene.h.out.join('')).not.toContain('not erased');
      expect(scene.h.out.join('')).not.toContain('within a day');
    });

    it('keeps the local no and exits nonzero when the pool refuses the credential', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      await signIn(scene);
      withdrawing(scene, () => HttpResponse.json({ error: 'unauthorized', message: 'Sign in with oars pool login first.' }, { status: 401 }));
      const refused = await refusalOf(poolRaw(scene.h.deps, { consent: 'no' }));
      expect(refused.message).toContain('was not told');
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'declined' });
      expect(await scene.cli('pool', 'raw', '--consent', 'no')).toBe(ExitCode.AUTH);
    });

    it('keeps the local no and exits nonzero when the sign-in has lapsed, calling nothing', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      await signIn(scene);
      writeFileSync(join(scene.staged.storeDir, 'pool-accounts.json'), JSON.stringify([{ server: POOL, account: 'acct_one', token: POOL_TOKEN, expiresAt: 1, signingKey: FIXED_KEY }]));
      const pool = withdrawing(scene, () => HttpResponse.json({ ok: true }));
      const refused = await refusalOf(poolRaw(scene.h.deps, { consent: 'no' }));
      expect(refused.message).toContain('was not told');
      expect(refused.message).toContain('oars pool login');
      expect(pool.calls).toEqual([]);
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'declined' });
    });

    it('has no account to tell when this machine never signed in, and says so', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      expect(await scene.cli('pool', 'raw', '--consent', 'no', '--json')).toBe(ExitCode.OK);
      expect(scene.document()).toMatchObject({ rawConsent: 'declined', pool: 'no-account' });
    });

    it('sends nothing to the withdrawal route for a yes', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      await signIn(scene);
      covenantIs('v1');
      const pool = withdrawing(scene, () => HttpResponse.json({ ok: true }));
      server.use(http.put(WITHDRAW, () => HttpResponse.json({ ok: true, version: 'v1' })));
      atTerminal(scene, RAW_PHRASE);
      expect(await scene.cli('pool', 'raw', '--consent', 'yes')).toBe(ExitCode.OK);
      expect(pool.calls).toEqual([]);
    });

    it('tells the pool a typed yes with the account credential and the version, after the phrase', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      await signIn(scene);
      covenantIs('v1');
      const calls: Array<{ authorization: string; body: unknown }> = [];
      server.use(
        http.put(WITHDRAW, async ({ request }) => {
          calls.push({ authorization: request.headers.get('authorization') ?? '', body: await request.json() });
          return HttpResponse.json({ ok: true, version: 'v1' });
        }),
      );
      atTerminal(scene, RAW_PHRASE);
      expect(await scene.cli('pool', 'raw', '--consent', 'yes', '--json')).toBe(ExitCode.OK);
      expect(calls).toEqual([{ authorization: `Bearer ${POOL_TOKEN}`, body: { version: 'v1' } }]);
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'granted', rawConsentVersion: 'v1' });
      expect(scene.document()).toMatchObject({ pool: 'told' });
    });

    it('records no yes here when the pool cannot be told one: after a withdrawal it would only be refused', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      await signIn(scene);
      covenantIs('v1');
      server.use(http.put(WITHDRAW, () => HttpResponse.json({ error: 'covenant_version', message: 'The covenant in force is v2, not v1.' }, { status: 409 })));
      atTerminal(scene, RAW_PHRASE);
      const refused = await refusalOf(poolRaw(scene.h.deps, { consent: 'yes' }));
      expect(refused.message).toContain('Nothing was recorded');
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: null });
      server.use(http.put(WITHDRAW, () => HttpResponse.error()));
      atTerminal(scene, RAW_PHRASE);
      expect(await scene.cli('pool', 'raw', '--consent', 'yes')).toBe(ExitCode.UNREACHABLE);
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: null });
    });

    it('saves a yes with no sign-in here and tells the pool nothing', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      covenantIs('v1');
      atTerminal(scene, RAW_PHRASE);
      expect(await scene.cli('pool', 'raw', '--consent', 'yes', '--json')).toBe(ExitCode.OK);
      expect(scene.document()).toMatchObject({ rawConsent: 'granted', pool: 'no-account' });
    });

    it('exits nonzero for a no on a machine that held a yes and signed out, since the pool still holds the yes', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      await signIn(scene);
      await yes(scene);
      expect(await scene.cli('pool', 'logout')).toBe(ExitCode.OK);
      const refused = await refusalOf(poolRaw(scene.h.deps, { consent: 'no' }));
      expect(refused.message).toContain('was not told');
      expect(refused.message).toContain('signed out');
      expect(refused.message).toContain('oars pool login');
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'declined', withdrawalPending: true });
      // The rerun is still signed out and the local answer is already `declined`, yet the pool still holds the yes: the marker keeps it a failure.
      expect(await scene.cli('pool', 'raw', '--consent', 'no')).toBe(ExitCode.AUTH);
      expect(await scene.cli('pool', 'raw', '--consent', 'no')).toBe(ExitCode.AUTH);
    });

    it('clears the marker once the pool is told, so a later no on a signed-out machine is no failure', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      await signIn(scene);
      await yes(scene);
      expect(await scene.cli('pool', 'logout')).toBe(ExitCode.OK);
      expect(await scene.cli('pool', 'raw', '--consent', 'no')).toBe(ExitCode.AUTH);
      await signIn(scene);
      const pool = withdrawing(scene, () => HttpResponse.json({ ok: true }));
      expect(await scene.cli('pool', 'raw', '--consent', 'no')).toBe(ExitCode.OK);
      expect(pool.calls).toHaveLength(1);
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'declined', withdrawalPending: false });
      expect(await scene.cli('pool', 'logout')).toBe(ExitCode.OK);
      expect(await scene.cli('pool', 'raw', '--consent', 'no')).toBe(ExitCode.OK);
    });

    it('clears the marker when a yes follows the withdrawal that was never told', async () => {
      const scene = setting({ OARS_POOL_URL: POOL });
      await signIn(scene);
      await yes(scene);
      expect(await scene.cli('pool', 'logout')).toBe(ExitCode.OK);
      expect(await scene.cli('pool', 'raw', '--consent', 'no')).toBe(ExitCode.AUTH);
      expect(await choicesOf(scene)).toMatchObject({ withdrawalPending: true });
      covenantIs('v1');
      atTerminal(scene, RAW_PHRASE);
      expect(await scene.cli('pool', 'raw', '--consent', 'yes')).toBe(ExitCode.OK);
      expect(await choicesOf(scene)).toMatchObject({ rawConsent: 'granted', withdrawalPending: false });
    });
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
        scene.seen.push({ url: request.url, headers: request.headers.get('authorization') ?? '', body: '', err: scene.h.err.join('') });
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
    expect(scene.seen).toHaveLength(1);
    expect(scene.seen[0]).toMatchObject({ url: `${POOL}/v1/login`, headers: `Bearer ${POOL_TOKEN}` });
    // The request was printed before it was sent, with the credential masked.
    expect(scene.seen[0]?.err).toContain('DELETE ');
    expect(scene.seen[0]?.err).not.toContain(POOL_TOKEN);
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

  posix('a deposit makes the outbox folder 0700 even before any other command has made the data folder', async () => {
    const scene = setting();
    await signIn(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    const root = join(scene.staged.storeDir, 'pool-outbox');
    expect(modeOf(root)).toBe(0o700);
    expect(modeOf(join(root, readdirSync(root)[0] ?? ''))).toBe(0o700);
  });

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

  it('pins the key under the id the pool names (k1 for a pool that names none), refuses a new id and a changed key behind a held one, and keeps what it holds', async () => {
    const scene = setting();
    poolAt(scene, { polls: [HttpResponse.json({ ...okLogin(), kid: 'k1' })] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(pinnedIn(scene)).toEqual({ k1: FIXED_KEY });
    // A server at the same URL that names a new id is refused: a new id enters only in a release of oars (RELEASE_KEYS), never through login.
    const second: PinnedKey = { kty: 'OKP', crv: 'Ed25519', x: 'a-second-key' };
    poolAt(scene, { polls: [HttpResponse.json({ ...okLogin(second), kid: 'k2' })] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(scene.document()).toMatchObject({ problem: { code: 'signing_key_unpinned' } });
    expect(JSON.stringify(at(scene.document(), 'problem'))).toContain('k2');
    expect(pinnedIn(scene)).toEqual({ k1: FIXED_KEY });
    poolAt(scene, { polls: [HttpResponse.json({ ...okLogin({ ...FIXED_KEY, x: 'swapped' }), kid: 'k1' })] });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(scene.document()).toMatchObject({ problem: { code: 'signing_key_changed' } });
    expect(JSON.stringify(at(scene.document(), 'problem'))).toContain('pinned for k1');
    expect(pinnedIn(scene)).toEqual({ k1: FIXED_KEY });
  });

  it('refuses a login whose key id is no key id, as the pool sends them, and saves nothing', async () => {
    const scene = setting();
    for (const kid of ['k 1', 'k1\n', 'x'.repeat(33)]) {
      poolAt(scene, { polls: [HttpResponse.json({ ...okLogin(), kid })] });
      expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).not.toBe(ExitCode.OK);
    }
    expect(existsSync(join(scene.staged.storeDir, 'pool-accounts.json'))).toBe(false);
  });
});

describe('oars pool deposit --send-all (t1199)', () => {
  const key = (n: number): string => n.toString(16).padStart(16, '0');
  /** Writes synthetic batches straight into the current stamp's folder (no store to rebuild), returning their hashes in name order. */
  const plant = (scene: Scene, from: number, to: number): string[] => {
    const folder = join(outboxFolder(scene.staged.storeDir, POOL), currentStamp());
    mkdirSync(folder, { recursive: true });
    const hashes: string[] = [];
    for (let n = from; n <= to; n += 1) {
      const bytes = canonicalBytes({ n, note: 'zorblax-session-content' });
      const hash = batchHash(bytes);
      writeFileSync(join(folder, `${key(n)}.${hash}.jsonl`), bytes);
      hashes.push(hash);
    }
    return hashes;
  };
  const clean = async (): Promise<Scene> => {
    const scene = setting();
    await signIn(scene);
    return scene;
  };
  const show = async (scene: Scene): Promise<void> => {
    expect(await scene.cli('pool', 'outbox', '--server', POOL)).toBe(ExitCode.OK);
    scene.h.out.length = 0;
  };
  const sentLogOf = (scene: Scene): string[] => {
    const file = join(outboxFolder(scene.staged.storeDir, POOL), 'sent.log');
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => line.split(' ')[0] ?? '') : [];
  };
  type Options = { server: string; sendAll: true; via?: Sender; pause?: (ms: number) => Promise<void> };
  const all = (via: Sender | undefined, extra: { pause?: (ms: number) => Promise<void> } = {}): Options => ({ server: POOL, sendAll: true, ...(via === undefined ? {} : { via }), ...extra });

  it('sends each batch that was shown and is unchanged, in order, and skips and counts one never shown and one changed', async () => {
    const scene = await clean();
    const [a, c, d] = [...plant(scene, 1, 1), ...plant(scene, 3, 4)];
    await show(scene);
    const [b] = plant(scene, 2, 2);
    const file = join(outboxFolder(scene.staged.storeDir, POOL), currentStamp(), `${key(3)}.${c ?? ''}.jsonl`);
    writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()} \n`);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201) });
    const outcome = await poolDeposit(scene.h.deps, all(pool.via));
    const posts = pool.requests.filter((request) => request.method === 'POST').map((request) => batchHash(request.body ?? ''));
    expect(posts).toEqual([a, d]);
    expect(posts).not.toContain(b);
    expect(outcome.document).toMatchObject({ ok: true, sent: 2, skipped: 2, alreadySent: 0, failed: 0, left: 0 });
    expect(outcome.text).toBe('Done: 2 sent, 2 skipped, 0 already sent, 0 failed, 0 left.');
    expect(sentLogOf(scene)).toEqual([a, d]);
  });

  it('keeps the covenant rule of --send: never accepted refuses with nothing sent off a terminal, accepted runs off one', async () => {
    const scene = await clean();
    const [first] = plant(scene, 1, 2);
    await show(scene);
    const pool = wire({ 'GET /v1/covenant': UNACCEPTED, 'POST /v1/deposits': answer(201) });
    const refused = poolDeposit(scene.h.deps, all(pool.via));
    await expect(refused).rejects.toMatchObject({ exitCode: ExitCode.AUTH, problem: { code: 'covenant_not_accepted' } });
    // It names the one-batch command that shows the screen: the first batch that was shown and is not sent.
    await expect(refused).rejects.toThrow(`oars pool deposit --send ${first ?? ''}`);
    expect(pool.requests.map((request) => request.method)).toEqual(['GET']);
    expect(sentLogOf(scene)).toEqual([]);
    const open = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201) });
    expect((await poolDeposit(scene.h.deps, all(open.via))).document).toMatchObject({ sent: 2 });
  });

  it('refuses a never-accepted --send-all on a terminal too (sendalltty): no screen, no acceptance, only the GET', async () => {
    const scene = await clean();
    const [first] = plant(scene, 1, 2);
    await show(scene);
    atTerminal(scene, SCREEN.phrase, 'no');
    const pool = wire({ 'GET /v1/covenant': UNACCEPTED, 'POST /v1/covenant/accept': answer(200), 'POST /v1/deposits': answer(201) });
    const refused = poolDeposit(scene.h.deps, all(pool.via));
    await expect(refused).rejects.toMatchObject({ exitCode: ExitCode.AUTH, problem: { code: 'covenant_not_accepted' } });
    await expect(refused).rejects.toThrow(`oars pool deposit --send ${first ?? ''}`);
    expect(pool.requests.map((request) => request.method)).toEqual(['GET']);
    expect(sentLogOf(scene)).toEqual([]);
  });

  it('names the first shown batch that is unchanged, not one that changed since it was shown', async () => {
    const scene = await clean();
    const [first, second] = plant(scene, 1, 2);
    await show(scene);
    const file = join(outboxFolder(scene.staged.storeDir, POOL), currentStamp(), `${key(1)}.${first ?? ''}.jsonl`);
    writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()} 
`);
    const pool = wire({ 'GET /v1/covenant': UNACCEPTED, 'POST /v1/deposits': answer(201) });
    const refused = poolDeposit(scene.h.deps, all(pool.via));
    await expect(refused).rejects.toThrow(`oars pool deposit --send ${second ?? ''}`);
    await expect(refused).rejects.not.toThrow(`oars pool deposit --send ${first ?? ''}`);
  });

  it('is an error together with --send, and the flags that belong to --send belong to it too', async () => {
    const scene = await clean();
    const pool = wire({});
    await expect(poolDeposit(scene.h.deps, { server: POOL, send: 'a'.repeat(64), sendAll: true, via: pool.via })).rejects.toMatchObject({ exitCode: ExitCode.USAGE });
    expect(pool.requests).toEqual([]);
    expect(await scene.cli('pool', 'deposit', '--server', POOL, '--send', 'a'.repeat(64), '--send-all')).toBe(ExitCode.USAGE);
    await expect(poolDeposit(scene.h.deps, { server: POOL, acceptCovenant: 'v1' })).rejects.toThrow('belongs to --send');
    await expect(poolDeposit(scene.h.deps, { server: POOL, inEuEeaUk: 'no' })).rejects.toThrow('belongs to --send');
    // --send-all never accepts: a never-accepted account is refused, so both flags are usage errors that name the one-batch way to accept.
    await expect(poolDeposit(scene.h.deps, { server: POOL, sendAll: true, acceptCovenant: 'v1', via: pool.via })).rejects.toThrow('oars pool deposit --send <hash>');
    await expect(poolDeposit(scene.h.deps, { server: POOL, sendAll: true, inEuEeaUk: 'no', via: pool.via })).rejects.toThrow('oars pool deposit --send <hash>');
    expect(pool.requests).toEqual([]);
  });

  it('stops at the failed batch with the counts and an error, and a second run sends only what is left, each of five once', async () => {
    const scene = await clean();
    const hashes = plant(scene, 1, 5);
    await show(scene);
    // Never shown, so a rerun would skip it too: it is not "left".
    plant(scene, 6, 6);
    let failing = hashes[2] ?? '';
    const landed: string[] = [];
    const via: Sender = (request) => {
      if (request.method === 'GET') return Promise.resolve(OPEN_COVENANT);
      const hash = batchHash(request.body ?? '');
      if (hash === failing) return Promise.resolve(answer(400, { error: 'bad_batch', message: 'The pool refused this batch.' }));
      landed.push(hash);
      return Promise.resolve(answer(201));
    };
    await expect(poolDeposit(scene.h.deps, all(via))).rejects.toMatchObject({ problem: { status: 400 }, details: { tally: { sent: 2, skipped: 0, alreadySent: 0, failed: 1, left: 2 } } });
    expect(scene.h.err.join('')).toContain('Stopped: 2 sent, 0 skipped, 0 already sent, 1 failed, 2 left.');
    expect(landed).toEqual(hashes.slice(0, 2));
    failing = '';
    const outcome = await poolDeposit(scene.h.deps, all(via));
    expect(outcome.document).toMatchObject({ sent: 3, alreadySent: 2, failed: 0, left: 0 });
    expect(landed).toEqual(hashes);
    expect(sentLogOf(scene)).toEqual([...hashes]);
  });

  it('does not count a pulled batch held back for want of exclusion terms as left, since a rerun skips it', async () => {
    const scene = await clean();
    const hashes = plant(scene, 1, 3);
    await show(scene);
    const outbox = outboxFolder(scene.staged.storeDir, POOL);
    const held = (await heldAcross(outbox)).batches.find((batch) => batch.hash === hashes[2]);
    await writePulled(outbox, { [held?.key ?? '']: currentStamp() });
    scene.h.deps.env.OARS_EXCLUSION_TERMS = join(scene.staged.root, 'no-such-terms.txt');
    const via: Sender = (request) => {
      if (request.method === 'GET') return Promise.resolve(OPEN_COVENANT);
      return Promise.resolve(batchHash(request.body ?? '') === hashes[0] ? answer(400, { error: 'bad_batch', message: 'The pool refused this batch.' }) : answer(201));
    };
    await expect(poolDeposit(scene.h.deps, all(via))).rejects.toMatchObject({ details: { tally: { failed: 1, left: 1 } } });
  });

  it('sends through the default network sender against the local test server, with no injected via', async () => {
    const scene = await clean();
    const hashes = plant(scene, 1, 2);
    await show(scene);
    on(scene, 'get', '/v1/covenant', () => HttpResponse.json({ version: 'v1', accepted: true }));
    on(scene, 'post', '/v1/deposits', () => HttpResponse.json({ ok: true }, { status: 201 }));
    const outcome = await poolDeposit(scene.h.deps, { server: POOL, sendAll: true });
    expect(outcome.document).toMatchObject({ sent: 2, failed: 0 });
    expect(scene.seen.filter(({ body }) => body !== '')).toHaveLength(2);
    expect(sentLogOf(scene)).toEqual(hashes);
  });

  it('ends a wait between tries when the signal aborts, and waits the whole time when it does not', async () => {
    const stop = new AbortController();
    await expect(sleeps(5, stop.signal)).resolves.toBeUndefined();
    const waiting = sleeps(60_000, stop.signal);
    stop.abort(new SendInterrupted('signal', 'Interrupted by SIGINT.', 'SIGINT'));
    await expect(waiting).rejects.toBeInstanceOf(SendInterrupted);
    await expect(sleeps(60_000, stop.signal)).rejects.toBeInstanceOf(SendInterrupted);
  });

  it('asks again only after a 429 or a 5xx, at most three tries, waiting the pool\'s retry-after or 1 then 2 seconds', async () => {
    const scene = await clean();
    plant(scene, 1, 1);
    await show(scene);
    const waits: number[] = [];
    const pause = (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    };
    const slow: Reply = { status: 429, body: { error: 'slow_down', message: 'later' }, headers: new Headers({ 'retry-after': '7' }) };
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': [slow, answer(503, { error: 'down', message: 'down' }), answer(201)] });
    expect((await poolDeposit(scene.h.deps, all(pool.via, { pause }))).document).toMatchObject({ sent: 1 });
    expect(pool.requests.filter((request) => request.method === 'POST')).toHaveLength(3);
    expect(waits).toEqual([7000, 2000]);
    // Three tries in all, then the failure: the second wait doubles, and the batch stays unsent.
    forgetSent(scene);
    waits.length = 0;
    const down = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(500, { error: 'boom', message: 'no' }) });
    await expect(poolDeposit(scene.h.deps, all(down.via, { pause }))).rejects.toMatchObject({ problem: { status: 500 } });
    expect(down.requests.filter((request) => request.method === 'POST')).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
    // A 4xx is not asked again.
    const refused = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(422, { error: 'no', message: 'no' }) });
    await expect(poolDeposit(scene.h.deps, all(refused.via, { pause }))).rejects.toMatchObject({ problem: { status: 422 } });
    expect(refused.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('prints one progress line per 100 batches and a final count line, and no session content', async () => {
    const scene = await clean();
    plant(scene, 1, 205);
    await show(scene);
    const pool = wire({ 'GET /v1/covenant': OPEN_COVENANT, 'POST /v1/deposits': answer(201) });
    const outcome = await poolDeposit(scene.h.deps, all(pool.via));
    const lines = scene.h.err.join('').split('\n').filter((line) => /batches handled/.test(line));
    expect(lines).toEqual(['100 batches handled: 100 sent, 0 skipped, 0 already sent, 0 failed, 0 left.', '200 batches handled: 200 sent, 0 skipped, 0 already sent, 0 failed, 0 left.']);
    expect(outcome.text).toBe('Done: 205 sent, 0 skipped, 0 already sent, 0 failed, 0 left.');
    expect(scene.h.err.join('') + scene.h.out.join('') + outcome.text).not.toContain('zorblax-session-content');
  });
});

// The memory proof (t1199 item 4). Opt-in, because it writes hundreds of megabytes and spawns a second vitest over this file; it is not in `npm run test`, `just check`, or CI. Run it with
//   OARS_MEMORY_PROOF=1 npm test -w packages/cli -- src/sessions/pool-command.test.ts -t memory- --silent=false
// Two children, each under a V8 heap too small for the history held whole:
//   outbox: 7,000 batches of 64 KB (448 MB as strings) are shown by `pool outbox` and sent by `--send-all` under --max-old-space-size=192 (V8 adds 192 MB, so the limit is about 384 MB, under the 448 MB the whole outbox held as strings takes);
//   build: 7,000 captured sessions are built by `pool deposit` under --max-old-space-size=BUILD_HEAP_MB (the old build loaded the whole store and failed there).
const MEMORY_CHILD = process.env.OARS_SEND_ALL_MEMORY_CHILD;
const MEMORY_MODE = process.env.OARS_MEMORY_MODE;
const BUILD_HEAP_MB = Number(process.env.OARS_MEMORY_BUILD_HEAP ?? 160);
const memoryChild = (mode: 'outbox' | 'build' | 'refresh', heapMb: number, seed = ''): { limitMb: number; peakRssMb: number; count: number; seconds: number; steps: string } => {
  const report = join(tmpdir(), `oars-memory-${mode}-${String(process.pid)}.json`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', fileURLToPath(import.meta.url), '-t', `child of the memory proof ${mode}`], {
    env: { ...process.env, OARS_SEND_ALL_MEMORY_CHILD: report, OARS_MEMORY_MODE: mode, OARS_MEMORY_SEED: seed, NODE_OPTIONS: `--max-old-space-size=${String(heapMb)}` },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(result.status, `${result.stdout}
${result.stderr}`).toBe(0);
  const parsed: unknown = JSON.parse(readFileSync(report, 'utf8'));
  rmSync(report, { force: true });
  return { limitMb: Number(at(parsed, 'limitMb')), peakRssMb: Number(at(parsed, 'peakRssMb')), count: Number(at(parsed, 'count')), steps: typeof at(parsed, 'steps') === 'string' ? String(at(parsed, 'steps')) : '', seconds: Math.round((Date.now() - started) / 1000) };
};
const finish = (count: number, steps = ''): void => {
  writeFileSync(MEMORY_CHILD ?? '', JSON.stringify({ steps, limitMb: Math.round(getHeapStatistics().heap_size_limit / 1048576), peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024), count }));
};

describe('oars pool outbox, deposit, and deposit --send-all memory (t1199)', () => {
  it.runIf(process.env.OARS_MEMORY_PROOF === '1' && MEMORY_CHILD === undefined)('memory-outbox: show and send 7,000 batches of 64 KB in a 192 MB heap', () => {
    const { limitMb, peakRssMb, count, seconds } = memoryChild('outbox', 192);
    expect(limitMb).toBeLessThan(448);
    expect(count).toBe(7000);
    console.info(`memory proof outbox: peak RSS ${String(peakRssMb)} MB under a ${String(limitMb)} MB heap limit in ${String(seconds)} s`);
  }, 540_000);

  // The shared 7,000-session store: one session an hour, so a delta window holds a bounded few hundred of them, not the history.
  const seedSevenThousand = async (): Promise<ReturnType<typeof setting>> => {
    const scene = setting();
    const template = readFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), 'utf8');
    const first = Date.parse('2026-05-28T20:26:41.000Z');
    for (let n = 1; n <= 7000; n += 1) {
      const shifted = Date.parse('2025-01-01T00:00:00.000Z') + n * 3_600_000 - first;
      writeFileSync(join(scene.staged.projectsRoot, 'proj', `m${String(n)}.jsonl`), template.replaceAll('errors-a', `m${String(n)}`).replace(/"timestamp": "([^"]+)"/g, (_all, ts: string) => `"timestamp": "${new Date(Date.parse(ts) + shifted).toISOString()}"`));
    }
    await capture(scene);
    return scene;
  };

  it.runIf(process.env.OARS_MEMORY_PROOF === '1' && MEMORY_CHILD === undefined)('memory-build: build 7,000 sessions with pool deposit in a small heap', async () => {
    const scene = await seedSevenThousand();
    const { limitMb, peakRssMb, count, seconds } = memoryChild('build', BUILD_HEAP_MB, scene.staged.root);
    expect(count).toBeGreaterThanOrEqual(7000);
    console.info(`memory proof build: peak RSS ${String(peakRssMb)} MB under a ${String(limitMb)} MB heap limit in ${String(seconds)} s`);
  }, 540_000);

  // t1237 item 1: records numbers, asserts none. The steps of `refresh` run one by one over 7,000 sessions in a roomy heap; the reading after each is the live heap once collected and the peak RSS so far, so the step that raises the peak is named.
  it.runIf(process.env.OARS_MEMORY_PROOF === '1' && MEMORY_CHILD === undefined)('memory-refresh: which step of refresh holds the peak over 7,000 sessions', async () => {
    const scene = await seedSevenThousand();
    const { peakRssMb, steps, seconds } = memoryChild('refresh', 8192, scene.staged.root);
    console.info(`memory proof refresh: peak RSS ${String(peakRssMb)} MB in ${String(seconds)} s; ${steps}`);
  }, 540_000);

  it.skipIf(MEMORY_CHILD === undefined || MEMORY_MODE !== 'refresh')('child of the memory proof refresh', async () => {
    const scene = setting();
    cpSync(join(String(process.env.OARS_MEMORY_SEED), 'store'), scene.staged.storeDir, { recursive: true });
    setFlagsFromString('--expose-gc');
    const collect: unknown = runInNewContext('gc');
    const readings: string[] = [];
    const sample = (step: string): void => {
      if (typeof collect === 'function') Reflect.apply(collect, undefined, []);
      readings.push(`${step}: heap ${String(Math.round(process.memoryUsage().heapUsed / 1048576))} MB, peak RSS so far ${String(Math.round(process.resourceUsage().maxRSS / 1024))} MB`);
    };
    sample('start');
    const store = await loadStore(scene.staged.storeDir);
    sample('loadStore');
    // `refresh` keeps `derived` live and serializes it before the index steps, so the reading does too.
    const derived = derive(store, '2026-01-01T00:00:00.000Z');
    const derivedBytes = JSON.stringify(derived).length;
    sample('derive');
    const { currentPool } = await import('./pool.js');
    const current = await currentPool(scene.staged.storeDir, store);
    sample('currentPool');
    const { nextByFrame } = await import('./recall-frames.js');
    const next = current === undefined ? undefined : nextByFrame(current.pool, store);
    sample('nextByFrame');
    const { buildIndex } = await import('./hook-index.js');
    const index = buildIndex(store, [], '2026-01-01T00:00:00.000Z', current?.reads ?? [], next);
    const indexBytes = JSON.stringify(index).length;
    sample('buildIndex');
    // Read after the last sample so `derived` and `index` stay live through every reading, as in `refresh`.
    readings.push(`serialized ${String(derivedBytes + indexBytes)} bytes over ${String(derived.signatures.length)} signatures and ${String(Object.keys(index.signatures).length)} indexed`);
    finish(store.sessions.length, readings.join(' | '));
  }, 540_000);

  it.skipIf(MEMORY_CHILD === undefined || MEMORY_MODE !== 'outbox')('child of the memory proof outbox', async () => {
    const scene = setting();
    await signIn(scene);
    const folder = join(outboxFolder(scene.staged.storeDir, POOL), currentStamp());
    mkdirSync(folder, { recursive: true });
    for (let n = 1; n <= 7000; n += 1) {
      const bytes = canonicalBytes({ n, pad: 'x'.repeat(64 * 1024) });
      writeFileSync(join(folder, `${n.toString(16).padStart(16, '0')}.${batchHash(bytes)}.jsonl`), bytes);
    }
    let chunks = 0;
    await poolOutbox(scene.h.deps, { server: POOL, print: () => { chunks += 1; } });
    expect(chunks).toBeGreaterThan(7000);
    let landed = 0;
    const via: Sender = (request) => {
      if (request.method === 'POST') landed += 1;
      return Promise.resolve(request.method === 'GET' ? OPEN_COVENANT : answer(201));
    };
    const outcome = await poolDeposit(scene.h.deps, { server: POOL, sendAll: true, via });
    expect(outcome.document).toMatchObject({ sent: 7000, failed: 0 });
    finish(landed);
  }, 540_000);

  it.skipIf(MEMORY_CHILD === undefined || MEMORY_MODE !== 'build')('child of the memory proof build', async () => {
    const scene = setting();
    await signIn(scene);
    // The store is captured by the parent in a default heap: the capture's own derive pass (`refresh`, store.ts) reads the whole store and is not what is proved here.
    cpSync(join(String(process.env.OARS_MEMORY_SEED), 'store'), scene.staged.storeDir, { recursive: true });
    cpSync(join(String(process.env.OARS_MEMORY_SEED), 'projects'), scene.staged.projectsRoot, { recursive: true });
    const outcome = await poolDeposit(scene.h.deps, { server: POOL });
    expect(Number(at(outcome.document, 'batched'))).toBeGreaterThanOrEqual(7000);
    finish(Number(at(outcome.document, 'batched')));
  }, 540_000);
});
