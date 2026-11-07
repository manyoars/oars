// The nightly send (t884 Item 4): after the covenant is accepted the nightly task builds the outbox and sends new batches and, with its own yes, the redacted raw parts. Acceptance is the consent, so with none (or no server, or no sign-in) it sends nothing.
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { harness } from '../test-support.js';
import { nightlyPoolDeps } from './pool-nightly-deps.js';
import { nightlyPoolSend } from './pool-nightly.js';
import type { Reply, Sender } from './pool-command.js';
import type { Outgoing } from './pool-print.js';
import { batchHash, outboxFolder } from './pool-outbox.js';
import { SendLockBusy, withSendLock } from './pool-send-lock.js';
import { deposit, updatePoolChoices } from './store.js';
import { cleanup, NOW, settledClock, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const POOL = 'https://pool.test';
const LATER = Date.parse('2099-01-01T00:00:00Z');

const answer = (status: number, body: unknown = {}): Reply => ({ status, body, headers: new Headers() });
const OPEN = answer(200, { version: 'v1', accepted: true });

interface Pool {
  requests: Outgoing[];
  via: Sender;
}

/** Stands in for the pool: records each request and answers from `routes` (a list is spent in order, the last standing). */
const wire = (routes: { [route: string]: Reply | Reply[] }): Pool => {
  const requests: Outgoing[] = [];
  return {
    requests,
    via: (request) => {
      requests.push(request);
      const route = routes[`${request.method} ${request.url.pathname}`] ?? (request.url.pathname.startsWith('/v1/raw/') ? routes[`${request.method} /v1/raw`] : undefined);
      const reply = Array.isArray(route) ? (route.length > 1 ? route.shift() : route[0]) : route;
      return Promise.resolve(reply ?? answer(404, { error: 'not_found', message: 'No such route.' }));
    },
  };
};

const OK_RAW = { 'GET /v1/covenant': OPEN, 'POST /v1/deposits': answer(201, { ok: true }), 'PUT /v1/raw': answer(200, { ok: true }), 'POST /v1/raw': answer(201, { ok: true }) };

interface Scene {
  staged: Staged;
  deps: ReturnType<typeof harness>['deps'];
}

const scene = async (consent: 'granted' | 'declined' | null, env: NodeJS.ProcessEnv = { OARS_POOL_URL: POOL }, signedIn = true): Promise<Scene> => {
  const staged = stage();
  const termsFile = join(staged.root, 'terms.txt');
  writeFileSync(termsFile, 'zorblax\n');
  const h = harness({ OARS_EXCLUSION_TERMS: termsFile, ...env });
  h.deps.sessions = staged.runtime;
  h.deps.now = settledClock;
  await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
  await updatePoolChoices(staged.storeDir, (choices) => {
    choices.rawConsent = consent;
  });
  if (signedIn) writeFileSync(join(staged.storeDir, 'pool-accounts.json'), JSON.stringify([{ server: POOL, account: 'acct_one', token: 'a-pool-token', expiresAt: LATER, signingKey: { kty: 'OKP', crv: 'Ed25519', x: 'k' } }]));
  return { staged, deps: h.deps };
};

const paths = (pool: Pool, method: string): string[] => pool.requests.filter((request) => request.method === method).map((request) => request.url.pathname);
const rawPuts = (pool: Pool): Outgoing[] => pool.requests.filter((request) => request.method === 'PUT');
const outboxFiles = (staged: Staged, suffix: string): string[] => {
  const root = join(staged.storeDir, 'pool-outbox');
  return existsSync(root) ? readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith(suffix)) : [];
};
const header = (request: Outgoing, name: string): string | undefined => request.headers.find(([key]) => key === name)?.[1];

describe('the nightly pool send', () => {
  it('sends new batches and the redacted raw parts once the covenant is accepted and raw consent is granted', async () => {
    const here = await scene('granted');
    const pool = wire(OK_RAW);
    const result = await nightlyPoolSend(here.deps, pool.via);
    expect(result.outcome).toBe('sent');
    const batches = outboxFiles(here.staged, '.jsonl');
    expect(batches.length).toBeGreaterThan(0);
    expect(paths(pool, 'POST').filter((path) => path === '/v1/deposits')).toHaveLength(batches.length);
    const puts = rawPuts(pool);
    expect(puts.length).toBeGreaterThan(0);
    for (const put of puts) {
      expect(header(put, 'oars-raw-consent')).toBe('granted');
      expect(header(put, 'oars-redaction-version')).toBeDefined();
      expect(header(put, 'oars-capture-version')).toBeDefined();
    }
    // The hash in the path is the SHA-256 of the whole redacted copy, which is the one file on disk (a single part here).
    const copies = outboxFiles(here.staged, '.redacted');
    for (const put of puts) {
      const hash = /\/v1\/raw\/([0-9a-f]{64})\/parts\/1$/.exec(put.url.pathname)?.[1] ?? '';
      expect(batchHash(put.body ?? '')).toBe(hash);
      expect(copies.some((name) => name.includes(hash))).toBe(true);
    }
    const completes = paths(pool, 'POST').filter((path) => path.endsWith('/complete'));
    expect(completes).toHaveLength(puts.length);
    expect(pool.requests.find((request) => request.url.pathname.endsWith('/complete'))?.body).toMatch(/"bytes":\d+/);
  });

  it('sends skeletons only, and no raw part, after a no or no answer to the raw prompt', async () => {
    for (const consent of ['declined', null] as const) {
      const here = await scene(consent);
      const pool = wire(OK_RAW);
      const result = await nightlyPoolSend(here.deps, pool.via);
      expect(result.outcome).toBe('sent');
      expect(paths(pool, 'POST').filter((path) => path === '/v1/deposits').length).toBeGreaterThan(0);
      expect(rawPuts(pool)).toEqual([]);
      expect(paths(pool, 'POST').some((path) => path.startsWith('/v1/raw/'))).toBe(false);
    }
  });

  it('sends no raw part for a folder at skeleton only, and nothing at all for one that is off', async () => {
    const skeleton = await scene('granted');
    await updatePoolChoices(skeleton.staged.storeDir, (choices) => {
      choices.folders.proj = 'skeleton';
    });
    const first = wire(OK_RAW);
    await nightlyPoolSend(skeleton.deps, first.via);
    expect(paths(first, 'POST').filter((path) => path === '/v1/deposits').length).toBeGreaterThan(0);
    expect(rawPuts(first)).toEqual([]);

    const off = await scene('granted');
    await updatePoolChoices(off.staged.storeDir, (choices) => {
      choices.folders.proj = 'off';
    });
    const second = wire(OK_RAW);
    await nightlyPoolSend(off.deps, second.via);
    expect(second.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('turning a folder off after a send stops future sends and sends nothing again', async () => {
    const here = await scene('granted');
    const first = wire(OK_RAW);
    await nightlyPoolSend(here.deps, first.via);
    const sentBefore = first.requests.filter((request) => request.method !== 'GET').length;
    expect(sentBefore).toBeGreaterThan(0);
    await updatePoolChoices(here.staged.storeDir, (choices) => {
      choices.folders.proj = 'off';
    });
    const second = wire(OK_RAW);
    await nightlyPoolSend(here.deps, second.via);
    expect(second.requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('sends nothing when the covenant is not accepted, and builds nothing', async () => {
    for (const covenant of [answer(200, { version: 'v1', accepted: false }), answer(200, { accepted: true }), answer(403, { error: 'deposits_closed', message: 'closed' })]) {
      const here = await scene('granted');
      const pool = wire({ ...OK_RAW, 'GET /v1/covenant': covenant });
      const result = await nightlyPoolSend(here.deps, pool.via);
      expect(result.outcome).toBe('not-accepted');
      expect(pool.requests.filter((request) => request.method !== 'GET')).toEqual([]);
      expect(outboxFiles(here.staged, '.jsonl')).toEqual([]);
    }
  });

  it('never accepts the covenant itself', async () => {
    const here = await scene('granted');
    const pool = wire({ ...OK_RAW, 'GET /v1/covenant': answer(200, { version: 'v1', accepted: false }) });
    await nightlyPoolSend(here.deps, pool.via);
    expect(pool.requests.some((request) => request.url.pathname === '/v1/covenant/accept')).toBe(false);
  });

  it('exits quietly with no request when the server is not a URL oars may use, when not signed in (the default pool included), or when the sign-in has expired', async () => {
    for (const [env, signedIn, outcome] of [
      // No OARS_POOL_URL means the Many Oars pool (t896); a sign-in saved for another server does not carry over to it.
      [{}, true, 'not-signed-in'],
      [{ OARS_POOL_URL: '' }, true, 'not-signed-in'],
      [{ OARS_POOL_URL: 'http://not-local.test' }, true, 'no-server'],
      [{ OARS_POOL_URL: POOL }, false, 'not-signed-in'],
    ] as const) {
      const here = await scene('granted', env, signedIn);
      const pool = wire(OK_RAW);
      expect((await nightlyPoolSend(here.deps, pool.via)).outcome).toBe(outcome);
      expect(pool.requests).toEqual([]);
    }
    const expired = await scene('granted');
    expired.deps.now = () => LATER + 1;
    const pool = wire(OK_RAW);
    expect((await nightlyPoolSend(expired.deps, pool.via)).outcome).toBe('not-signed-in');
    expect(pool.requests).toEqual([]);
  });

  it('resumes after a failure: what was not taken is sent the next night, and what was taken is not sent again', async () => {
    const here = await scene('granted');
    const failing = wire({ ...OK_RAW, 'POST /v1/raw': answer(500, { error: 'boom', message: 'down' }) });
    const first = await nightlyPoolSend(here.deps, failing.via);
    expect(first.outcome).toBe('failed');
    const second = wire(OK_RAW);
    expect((await nightlyPoolSend(here.deps, second.via)).outcome).toBe('sent');
    // The skeletons went on the first night, so only the raw copies come again.
    expect(paths(second, 'POST').filter((path) => path === '/v1/deposits')).toEqual([]);
    expect(rawPuts(second).length).toBeGreaterThan(0);
    const third = wire(OK_RAW);
    expect((await nightlyPoolSend(here.deps, third.via)).outcome).toBe('sent');
    expect(third.requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(readFileSync(join(here.staged.storeDir, 'pool-nightly.json'), 'utf8')).toContain('"outcome":"sent"');
  });

  it('records a failed night without ever throwing, and counts only', async () => {
    const here = await scene('granted');
    const unreachable: Sender = () => Promise.reject(new Error('connect ECONNREFUSED'));
    expect((await nightlyPoolSend(here.deps, unreachable)).outcome).toBe('failed');
    const note = readFileSync(join(here.staged.storeDir, 'pool-nightly.json'), 'utf8');
    expect(note).toContain('"outcome":"failed"');
    expect(note).not.toContain('ECONNREFUSED');
  });
});

describe('the nightly send dependencies', () => {
  it('print nothing, hold no credentials, and open no browser', async () => {
    const staged = stage();
    const deps = nightlyPoolDeps({ OARS_POOL_URL: POOL }, staged.runtime, '9.9.9', () => 5);
    expect(deps.version).toBe('9.9.9');
    expect(deps.now()).toBe(5);
    deps.io.stdout('x');
    deps.io.stderr('x');
    expect(await deps.store.read()).toBeUndefined();
    await expect(Promise.all([deps.store.write({ issuerUrl: '', apiUrl: '', email: '', refreshToken: '', accessToken: '', expiresAt: '' }), deps.store.delete(), deps.sleep(1), deps.openBrowser('https://x.test')])).resolves.toBeDefined();
    expect(deps.random()).toBe(0);
  });
});

describe('the nightly send takes the send lock (t884 fix round)', () => {
  it('two nightly sends at once post each batch and each raw copy once', async () => {
    const here = await scene('granted');
    const pool = wire(OK_RAW);
    // A slow pool, so the two runs would interleave if nothing held them apart.
    const slow: Sender = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return pool.via(request);
    };
    const [one, two] = await Promise.all([nightlyPoolSend(here.deps, slow), nightlyPoolSend(here.deps, slow)]);
    expect([one.outcome, two.outcome]).toEqual(['sent', 'sent']);
    const batches = outboxFiles(here.staged, '.jsonl').length;
    const copies = outboxFiles(here.staged, '.redacted').length;
    expect(batches).toBeGreaterThan(0);
    expect(paths(pool, 'POST').filter((path) => path === '/v1/deposits')).toHaveLength(batches);
    expect(rawPuts(pool)).toHaveLength(copies);
    expect(one.batches + two.batches).toBe(batches);
    expect(one.raw + two.raw).toBe(copies);
  });

  it('waits while `deposit --send` holds the lock, and releases it afterwards', async () => {
    const here = await scene('granted');
    const outbox = outboxFolder(here.staged.storeDir, POOL);
    const pool = wire(OK_RAW);
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const taken = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holder = withSendLock(outbox, () => new Promise<void>((resolve) => {
      release = resolve;
      held();
    }));
    await taken;
    const night = nightlyPoolSend(here.deps, pool.via);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(paths(pool, 'POST').filter((path) => path === '/v1/deposits')).toEqual([]);
    release();
    await holder;
    expect((await night).outcome).toBe('sent');
    expect(existsSync(join(outbox, 'send.lock'))).toBe(false);
  });
});

describe('withSendLock', () => {
  const folder = (): string => join(stage().root, 'outbox');

  it('runs one holder at a time and removes the lock file when the holder throws', async () => {
    const outbox = folder();
    const order: string[] = [];
    const first = withSendLock(outbox, async () => {
      order.push('first in');
      await new Promise((resolve) => setTimeout(resolve, 60));
      order.push('first out');
    });
    const second = withSendLock(outbox, () => {
      order.push('second in');
      return Promise.resolve();
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'first out', 'second in']);
    await expect(withSendLock(outbox, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(existsSync(join(outbox, 'send.lock'))).toBe(false);
  });

  it('takes over a lock older than staleMs, and gives up on a fresh one after waitMs', async () => {
    const outbox = folder();
    mkdirSync(outbox, { recursive: true });
    const lock = join(outbox, 'send.lock');
    writeFileSync(lock, '');
    await expect(withSendLock(outbox, () => Promise.resolve('ran'), { waitMs: 30, pollMs: 5 })).rejects.toBeInstanceOf(SendLockBusy);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(await withSendLock(outbox, () => Promise.resolve('ran'), { staleMs: 1000, waitMs: 30, pollMs: 5 })).toBe('ran');
  });

  it('passes on an error other than a held lock', async () => {
    const root = stage().root;
    writeFileSync(join(root, 'file'), '');
    await expect(withSendLock(join(root, 'file', 'below'), () => Promise.resolve(1))).rejects.toThrow();
  });
});
