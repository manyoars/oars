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

/** Records every request the CLI makes, then answers it. */
const on = (scene: Scene, method: 'get' | 'post', path: string, reply: () => Response): void => {
  server.use(
    http[method](`${POOL}${path}`, async ({ request }) => {
      const body = await request.text();
      scene.seen.push({ url: request.url, headers: JSON.stringify([...request.headers.entries()]), body });
      return reply();
    }),
  );
};

const startRoute = (scene: Scene, overrides: object = {}): void => {
  on(scene, 'post', '/v1/login/start', () => HttpResponse.json({ deviceCode: 'device-1', userCode: 'USER-1', verificationUri: 'https://provider.test/device', interval: 2, expiresIn: 10, ...overrides }));
};

const okLogin = (signingKey: PinnedKey = FIXED_KEY): object => ({ status: 'ok', token: 'a-pool-token', account: 'acct_one', expiresAt: LATER, signingKey });

/** The login routes answer one sign-in at once. */
const signIn = async (scene: Scene, signingKey: PinnedKey = FIXED_KEY): Promise<void> => {
  startRoute(scene);
  on(scene, 'post', '/v1/login/poll', () => HttpResponse.json(okLogin(signingKey)));
  expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
  scene.seen.length = 0;
  scene.h.out.length = 0;
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
    expect(await scene.cli('pool', 'pull')).toBe(ExitCode.USAGE);
    expect(scene.seen).toEqual([]);
  });

  it('a run with no session store says so', async () => {
    const scene = setting();
    delete scene.h.deps.sessions;
    expect(await scene.cli('pool', 'pull', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
    expect(scene.h.err.join('')).toContain('not configured');
  });
});

describe('oars pool login', () => {
  it.each(['github', 'google'])('signs in by %s, pins the key, and keeps the token out of what it prints', async (provider) => {
    const scene = setting();
    startRoute(scene);
    const polls = [HttpResponse.json({ status: 'pending' }), HttpResponse.json({ status: 'pending', slowDown: true }), HttpResponse.json(okLogin())];
    on(scene, 'post', '/v1/login/poll', () => polls.shift() ?? HttpResponse.json({ error: 'over' }, { status: 500 }));
    expect(await scene.cli('pool', 'login', '--provider', provider, '--server', POOL, '--json')).toBe(ExitCode.OK);
    expect(scene.document()).toEqual({ ok: true, server: POOL, account: 'acct_one', expiresAt: LATER });
    expect(scene.h.err.join('')).toContain('https://provider.test/device');
    expect(scene.h.err.join('')).toContain('USER-1');
    expect(scene.h.opened).toEqual(['https://provider.test/device']);
    // The interval it was told, then five more seconds from the slow_down.
    expect(scene.h.sleeps).toEqual([2000, 2000, 7000]);
    expect(scene.seen[0]?.body).toBe(JSON.stringify({ provider }));
    expect(scene.h.out.join('') + scene.h.err.join('')).not.toContain('a-pool-token');
    const saved = join(scene.staged.storeDir, 'pool-accounts.json');
    expect(readFileSync(saved, 'utf8')).toContain('a-pool-token');
    if (process.platform !== 'win32') expect(statSync(saved).mode & 0o777).toBe(0o600);
  });

  it('says signed in, in words, without --json', async () => {
    const scene = setting();
    startRoute(scene);
    on(scene, 'post', '/v1/login/poll', () => HttpResponse.json(okLogin()));
    expect(await scene.cli('pool', 'login', '--provider', 'google', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toBe(`Signed in to ${POOL} as acct_one.\n`);
  });

  it('goes on with a printed link when no browser opens', async () => {
    const scene = setting();
    scene.h.deps.openBrowser = () => Promise.reject(new Error('no browser'));
    startRoute(scene);
    on(scene, 'post', '/v1/login/poll', () => HttpResponse.json(okLogin()));
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
    startRoute(scene, { verificationUri: 'not a url' });
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
    expect(scene.h.err.join('')).toContain('The pool did not start a sign-in.');
    expect(opened).toBe(false);
  });

  it('polls on the defaults when the pool names no interval', async () => {
    const scene = setting();
    startRoute(scene, { interval: undefined, expiresIn: undefined });
    on(scene, 'post', '/v1/login/poll', () => HttpResponse.json(okLogin()));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.sleeps).toEqual([5000]);
  });

  it('refuses a provider it does not know, before asking the server', async () => {
    const scene = setting();
    expect(await scene.cli('pool', 'login', '--provider', 'facebook', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(await scene.cli('pool', 'login', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(scene.seen).toEqual([]);
  });

  it('a second login to the same server keeps one entry and the same pin; another server gets its own', async () => {
    const scene = setting();
    await signIn(scene);
    await signIn(scene);
    const other = 'https://other.test';
    server.use(
      http.post(`${other}/v1/login/start`, () => HttpResponse.json({ deviceCode: 'd', userCode: 'u', verificationUri: 'https://provider.test/device' })),
      http.post(`${other}/v1/login/poll`, () => HttpResponse.json(okLogin())),
    );
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', other)).toBe(ExitCode.OK);
    const saved: unknown = JSON.parse(readFileSync(join(scene.staged.storeDir, 'pool-accounts.json'), 'utf8'));
    expect(saved).toHaveLength(2);
  });

  it('refuses a login whose signing key differs from the pin, and saves nothing', async () => {
    const scene = setting();
    await signIn(scene);
    const file = join(scene.staged.storeDir, 'pool-accounts.json');
    const before = readFileSync(file, 'utf8');
    startRoute(scene);
    on(scene, 'post', '/v1/login/poll', () => HttpResponse.json({ ...okLogin(), token: 'a-swapped-token', signingKey: { ...FIXED_KEY, x: 'another-key' } }));
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
    expect(await scene.cli('pool', 'pull', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
  });

  it('names the refusal when the provider denies, and when the pool will not start', async () => {
    const scene = setting();
    startRoute(scene);
    on(scene, 'post', '/v1/login/poll', () => HttpResponse.json({ error: 'login_refused', message: 'The provider refused the sign-in: access_denied.' }, { status: 401 }));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(scene.document()).toMatchObject({ problem: { code: 'login_refused', status: 401 } });

    const closed = setting();
    on(closed, 'post', '/v1/login/start', () => HttpResponse.json({ error: 'not_configured', message: 'This pool has no GITHUB_CLIENT_ID binding.' }, { status: 503 }));
    expect(await closed.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNREACHABLE);
    expect(closed.h.err.join('')).toContain('GITHUB_CLIENT_ID');
  });

  it('stops when the code expires', async () => {
    const scene = setting();
    startRoute(scene, { interval: 4, expiresIn: 8 });
    on(scene, 'post', '/v1/login/poll', () => HttpResponse.json({ status: 'pending' }));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL, '--json')).toBe(ExitCode.AUTH);
    expect(scene.document()).toMatchObject({ problem: { code: 'EXPIRED_TOKEN' } });
    expect(scene.h.sleeps).toEqual([4000, 4000]);
  });

  it('treats a malformed answer as a failure, not a sign-in', async () => {
    const noStart = setting();
    on(noStart, 'post', '/v1/login/start', () => HttpResponse.json({ deviceCode: 'only' }));
    expect(await noStart.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);

    const notObject = setting();
    on(notObject, 'post', '/v1/login/start', () => HttpResponse.json('nope'));
    expect(await notObject.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);

    const emptyPoll = setting();
    startRoute(emptyPoll);
    on(emptyPoll, 'post', '/v1/login/poll', () => new HttpResponse('not json', { status: 200 }));
    expect(await emptyPoll.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);

    for (const signingKey of [{ kty: 'RSA', crv: 'Ed25519', x: 'x' }, 'text', null]) {
      const badKey = setting();
      startRoute(badKey);
      on(badKey, 'post', '/v1/login/poll', () => HttpResponse.json({ ...okLogin(), signingKey }));
      expect(await badKey.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
      expect(existsSync(join(badKey.staged.storeDir, 'pool-accounts.json'))).toBe(false);
    }
  });

  it('a pool that cannot be reached, or answers with no message, still gets a plain failure', async () => {
    const scene = setting();
    server.use(http.post(`${POOL}/v1/login/start`, () => HttpResponse.error()));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNREACHABLE);

    const bare = setting();
    on(bare, 'post', '/v1/login/start', () => new HttpResponse('oops', { status: 500 }));
    expect(await bare.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNEXPECTED);
    expect(bare.h.err.join('')).toContain('HTTP 500');
  });

  it('will not follow a redirect with a token or a skeleton', async () => {
    const scene = setting();
    server.use(http.post(`${POOL}/v1/login/start`, () => new HttpResponse(null, { status: 307, headers: { location: 'https://elsewhere.test/v1/login/start' } })));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.UNREACHABLE);
  });
});

describe('no harness token is ever read', () => {
  it('a token planted in the harness config and environment appears in no request across login, deposit, and pull', async () => {
    const scene = setting({ ANTHROPIC_API_KEY: HARNESS_SECRET, CLAUDE_CODE_OAUTH_TOKEN: HARNESS_SECRET });
    writeFileSync(join(scene.staged.projectsRoot, '..', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: HARNESS_SECRET } }));
    await capture(scene);
    startRoute(scene);
    on(scene, 'post', '/v1/login/poll', () => HttpResponse.json(okLogin()));
    expect(await scene.cli('pool', 'login', '--provider', 'github', '--server', POOL)).toBe(ExitCode.OK);
    openPool(scene);
    expect(await scene.cli('pool', 'deposit', '--server', POOL)).toBe(ExitCode.OK);
    on(scene, 'get', '/bundle/2.1.314/0', () => HttpResponse.json({ error: 'fetch_cap', message: 'capped' }, { status: 429 }));
    await scene.cli('pool', 'pull', '--harness-version', '2.1.314', '--server', POOL);
    expect(scene.seen.length).toBeGreaterThan(3);
    expect(scene.sent()).not.toContain(HARNESS_SECRET);
    expect(scene.sent()).toContain('a-pool-token');
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

describe('oars pool pull', () => {
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
    expect(await scene.cli('pool', 'pull', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.OK);
    const answer = scene.document();
    expect(answer).toMatchObject({ ok: true, harnessVersion: '2.1.314', reads: 2, cells: 1, motifs: 0 });
    expect(scene.seen[0]?.headers).toContain('a-pool-token');
    expect(JSON.parse(readFileSync(String(at(answer, 'file')), 'utf8'))).toEqual({ payload, signature });
  });

  it('names the version it pulled', async () => {
    const { scene, sign } = await signedScene();
    const payload = bundleBody('2.1.9');
    const signature = await sign(payload);
    on(scene, 'get', '/bundle/2.1.9/0', () => HttpResponse.json({ payload, signature }));
    expect(await scene.cli('pool', 'pull', '--harness-version', '2.1.9', '--server', POOL)).toBe(ExitCode.OK);
    expect(scene.h.out.join('')).toContain('Pulled 2.1.9: 2 reads');
  });

  it('refuses a tampered bundle and a bundle of another harness version, and keeps neither', async () => {
    const { scene, sign } = await signedScene();
    const payload = bundleBody('2.1.314');
    const signature = await sign(payload);
    on(scene, 'get', '/bundle/2.1.314/0', () => HttpResponse.json({ payload: payload.replace('"cells":[{}]', '"cells":[{},{}]'), signature }));
    expect(await scene.cli('pool', 'pull', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.INVALID);
    expect(scene.document()).toMatchObject({ problem: { code: 'bundle_unverified' } });
    expect(replicas(scene)).toEqual([]);

    on(scene, 'get', '/bundle/2.1.9/0', () => HttpResponse.json({ payload, signature }));
    expect(await scene.cli('pool', 'pull', '--harness-version', '2.1.9', '--server', POOL)).toBe(ExitCode.INVALID);
    expect(replicas(scene)).toEqual([]);
  });

  it('refuses a harness version the vocabulary does not hold before asking, asks for a sign-in, and passes on a named refusal', async () => {
    const { scene } = await signedScene();
    expect(await scene.cli('pool', 'pull', '--harness-version', '../secret', '--server', POOL)).toBe(ExitCode.USAGE);
    expect(scene.seen).toEqual([]);

    on(scene, 'get', '/bundle/2.1.314/0', () => HttpResponse.json({ error: 'fetch_cap', message: 'An account without access may fetch 1 per ISO week.' }, { status: 429 }));
    expect(await scene.cli('pool', 'pull', '--harness-version', '2.1.314', '--server', POOL, '--json')).toBe(ExitCode.RATE_LIMITED);
    expect(scene.document()).toMatchObject({ problem: { code: 'fetch_cap' } });

    const anon = setting();
    expect(await anon.cli('pool', 'pull', '--harness-version', '2.1.314', '--server', POOL)).toBe(ExitCode.AUTH);
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
