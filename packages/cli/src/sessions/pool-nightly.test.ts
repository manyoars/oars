// The nightly send (t884 Item 4): after the covenant is accepted the nightly task builds the outbox and sends new batches and, with its own yes, the redacted raw parts. Acceptance is the consent, so with none (or no server, or no sign-in) it sends nothing.
import { tmpdir } from 'node:os';
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { harness } from '../test-support.js';
import { nightlyPoolDeps } from './pool-nightly-deps.js';
import { nightlyPoolSend } from './pool-nightly.js';
import type { Reply, Sender } from './pool-command.js';
import type { Outgoing } from './pool-print.js';
import { batchHash, outboxFolder } from './pool-outbox.js';
import { SendLockBusy, withSendLock, type LockFs } from './pool-send-lock.js';
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
    choices.rawConsentVersion = consent === 'granted' ? 'v1' : null;
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
      expect(header(put, 'oars-raw-consent-version')).toBe('v1');
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

  it('holds back raw when the yes was given under another covenant than the one in force, and sends it when the versions match', async () => {
    const old = await scene('granted');
    await updatePoolChoices(old.staged.storeDir, (choices) => {
      choices.rawConsentVersion = 'v0';
    });
    const held = wire(OK_RAW);
    const night = await nightlyPoolSend(old.deps, held.via);
    expect(night).toMatchObject({ outcome: 'sent', rawHeld: true });
    expect(JSON.parse(readFileSync(join(old.staged.storeDir, 'pool-nightly.json'), 'utf8'))).toMatchObject({ rawHeld: true });
    expect(paths(held, 'POST').filter((path) => path === '/v1/deposits').length).toBeGreaterThan(0);
    expect(rawPuts(held)).toEqual([]);
    expect(outboxFiles(old.staged, '.redacted')).toEqual([]);
    const current = await scene('granted');
    const sent = wire(OK_RAW);
    expect(await nightlyPoolSend(current.deps, sent.via)).not.toHaveProperty('rawHeld');
    expect(rawPuts(sent).length).toBeGreaterThan(0);
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

  it('sends nothing on a machine, whatever the sign-in and the covenant say, and leaves the outbox as it was', async () => {
    // A person's night first leaves a held batch behind (the pool refuses it), so a machine night that sent would have something to send.
    const person = await scene('granted');
    const refusing = wire({ ...OK_RAW, 'POST /v1/deposits': answer(500, { error: 'boom', message: 'down' }) });
    expect((await nightlyPoolSend(person.deps, refusing.via)).outcome).toBe('failed');
    const held = outboxFiles(person.staged, '');
    expect(held.some((name) => name.endsWith('.jsonl'))).toBe(true);
    const bytes = (staged: Staged): string[] => outboxFiles(staged, '.jsonl').map((name) => readFileSync(join(staged.storeDir, 'pool-outbox', name), 'utf8'));
    const before = bytes(person.staged);

    // The same store as the person's, so the held batch is there, signed in, with the covenant accepted: only the machine setting differs.
    const machine = harness({ OARS_EXCLUSION_TERMS: join(person.staged.root, 'terms.txt'), OARS_POOL_URL: POOL, OARS_HOST_CLASS: 'vps', APPDATA: person.staged.root });
    // The machine night must not reach a real store: the store is a temp folder.
    if (!person.staged.storeDir.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
    machine.deps.sessions = person.staged.runtime;
    machine.deps.now = settledClock;
    const pool = wire(OK_RAW);
    const result = await nightlyPoolSend(machine.deps, pool.via);
    expect(result).toEqual({ outcome: 'machine', batches: 0, raw: 0 });
    expect(pool.requests).toEqual([]);
    expect(outboxFiles(person.staged, '')).toEqual(held);
    expect(bytes(person.staged)).toEqual(before);
    expect(readFileSync(join(person.staged.storeDir, 'pool-nightly.json'), 'utf8')).toContain('"outcome":"machine"');
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
    // The lock promises one holder at a time, not first come first served: either holder may win the race, so the test asserts only that each holder's `out` follows its own `in` before the other `in`.
    const holder = (name: string, ms: number) => async (): Promise<void> => {
      order.push(`${name} in`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name} out`);
    };
    await Promise.all([withSendLock(outbox, holder('first', 60)), withSendLock(outbox, holder('second', 1))]);
    const a = order[0]?.split(' ')[0];
    const b = order[2]?.split(' ')[0];
    expect(a).not.toBe(b);
    expect(order).toEqual([`${String(a)} in`, `${String(a)} out`, `${String(b)} in`, `${String(b)} out`]);
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

  it('keeps the lock for a holder that outlives staleMs while it keeps refreshing, and a second run does not get in', async () => {
    // The clock is moved by hand, so a loaded runner cannot starve the holder's refresh timer past staleMs and make the lock look dead: only Date and the refresh interval are faked, the files and the waiter's poll stay real.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const outbox = folder();
      const lock = join(outbox, 'send.lock');
      const times = { staleMs: 120, waitMs: 400, pollMs: 1 };
      const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));
      let inside = 0;
      let overlapped = false;
      let release = (): void => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const body = async (until: Promise<void>): Promise<void> => {
        inside += 1;
        overlapped ||= inside > 1;
        await until;
        inside -= 1;
      };
      const first = withSendLock(outbox, () => body(hold), times);
      // The holder's refresh timer exists once its body runs.
      while (inside === 0) await pause();
      const started = Date.now();
      const outcome: { settled: boolean; error: unknown } = { settled: false, error: undefined };
      const settled = (): boolean => outcome.settled;
      const second = withSendLock(outbox, () => body(Promise.resolve()), times).then(
        () => {
          outcome.settled = true;
        },
        (error: unknown) => {
          outcome.settled = true;
          outcome.error = error;
        },
      );
      // One refresh interval (a quarter of staleMs) per step; wait for each refresh to land before the next step, so only the fake clock decides how old the lock looks.
      for (let step = 0; step < 100 && !settled(); step += 1) {
        const before = statSync(lock).mtimeMs;
        await vi.advanceTimersByTimeAsync(times.staleMs / 4);
        // Bounded, so a refresh that never lands (the red this test guards) fails the assertion below instead of polling until the test timeout and leaving the fake clock installed.
        for (let pauses = 0; pauses < 50 && !settled() && statSync(lock).mtimeMs === before; pauses += 1) await pause();
      }
      await second;
      expect(Date.now() - started).toBeGreaterThan(times.staleMs);
      expect(outcome.error).toBeInstanceOf(SendLockBusy);
      release();
      await first;
      expect(overlapped).toBe(false);
      expect(existsSync(lock)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the lock a first waiter took when a second still reads the old one as stale', async () => {
    const outbox = folder();
    mkdirSync(outbox, { recursive: true });
    const lock = join(outbox, 'send.lock');
    writeFileSync(lock, 'dead-run');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    let inside = 0;
    let overlapped = false;
    // The second waiter's first look at the lock reports it stale only after the first waiter has taken the lock and is running, and the first holder stays inside until that stale look has been answered: a
    // takeover that removes the file by path would delete the first waiter's fresh lock and let the second in beside it. Each waiter has its own LockFs, so which waiter looks first (a loaded runner may
    // schedule either) cannot move the stale look onto the wrong waiter, and signals replace sleeps.
    let firstRunning = (): void => undefined;
    const running = new Promise<void>((resolve) => {
      firstRunning = resolve;
    });
    let looked = (): void => undefined;
    const staleLookAnswered = new Promise<void>((resolve) => {
      looked = resolve;
    });
    const onceStale = (before: () => Promise<void>, afterCreate: () => void): LockFs => {
      let first = true;
      let lookedStale = false;
      return {
        stat: async (path) => {
          if (first && path === lock) {
            first = false;
            await before();
            lookedStale = true;
            return { mtimeMs: Date.now() - 60_000 };
          }
          return { mtimeMs: statSync(path).mtimeMs };
        },
        // After its stale look the late waiter's next create decides the takeover: EEXIST means its lock was rightly kept, so the first holder may leave. A product that removed the lock lets the create succeed and the body runs beside the holder.
        open: async (path, flags) => {
          try {
            return await open(path, flags);
          } catch (error) {
            if (lookedStale) afterCreate();
            throw error;
          }
        },
      };
    };
    const quick = onceStale(() => Promise.resolve(), () => undefined);
    const late = onceStale(() => running, looked);
    const body = async (): Promise<void> => {
      inside += 1;
      overlapped ||= inside > 1;
      if (inside > 1) looked();
      firstRunning();
      await staleLookAnswered;
      inside -= 1;
    };
    const times = { staleMs: 1000, waitMs: 2000, pollMs: 5 };
    await Promise.all([withSendLock(outbox, body, times, quick), withSendLock(outbox, body, times, late)]);
    expect(overlapped).toBe(false);
    expect(readdirSync(outbox)).toEqual([]);
  });

  it('lets three waiters take over a stale lock one at a time', async () => {
    const outbox = folder();
    mkdirSync(outbox, { recursive: true });
    const lock = join(outbox, 'send.lock');
    writeFileSync(lock, 'dead-run');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    let inside = 0;
    let overlapped = false;
    const body = async (): Promise<void> => {
      inside += 1;
      overlapped ||= inside > 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      inside -= 1;
    };
    const times = { staleMs: 1000, waitMs: 2000, pollMs: 5 };
    await Promise.all([withSendLock(outbox, body, times), withSendLock(outbox, body, times), withSendLock(outbox, body, times)]);
    expect(overlapped).toBe(false);
    expect(readdirSync(outbox)).toEqual([]);
  });

  it('never lets a second sender in beside a live holder when a waiter reads its lock as stale and a third takes the path', async () => {
    const outbox = folder();
    const lock = join(outbox, 'send.lock');
    const times = { staleMs: 1000, waitMs: 3000, pollMs: 5 };
    let inside = 0;
    let overlapped = false;
    const body = async (ms: number): Promise<void> => {
      inside += 1;
      overlapped ||= inside > 1;
      await new Promise((resolve) => setTimeout(resolve, ms));
      inside -= 1;
    };
    // A is a live holder. B reads A's lock as stale (a stale clock for B's first look only). A takeover that moved the lock aside would be held at its next look until C has taken the free path and is running, so two senders would overlap; the guard takeover never moves it.
    const live = withSendLock(outbox, () => body(300), times);
    while (inside === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    const real = await import('node:fs/promises');
    let lookedAtLock = 0;
    const second: LockFs = {
      stat: async (path) => {
        const { mtimeMs } = await real.stat(path);
        if (path === lock && lookedAtLock === 0) {
          lookedAtLock += 1;
          return { mtimeMs: mtimeMs - 60_000 };
        }
        if (path !== lock) while (inside < 2) await new Promise((resolve) => setTimeout(resolve, 2));
        return { mtimeMs };
      },
    };
    const third = (async () => {
      while (lookedAtLock === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      while (existsSync(lock)) await new Promise((resolve) => setTimeout(resolve, 1));
      await withSendLock(outbox, () => body(100), times);
    })();
    await Promise.all([live, withSendLock(outbox, () => body(1), times, second).catch(() => undefined), third]);
    expect(overlapped).toBe(false);
  });

  it('waits while another waiter holds the takeover guard, and removes a guard a dead taker left', async () => {
    const outbox = folder();
    mkdirSync(outbox, { recursive: true });
    const lock = join(outbox, 'send.lock');
    const guard = join(outbox, 'send.lock.takeover');
    writeFileSync(lock, 'dead-run');
    writeFileSync(guard, 'dead-taker');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    // A fresh guard is another waiter mid-takeover: this run waits and gives up, leaving both files.
    await expect(withSendLock(outbox, () => Promise.resolve(1), { staleMs: 1000, waitMs: 30, pollMs: 5 })).rejects.toBeInstanceOf(SendLockBusy);
    expect(existsSync(guard)).toBe(true);
    // A guard older than staleMs was left by a taker that died: it is removed, then the stale lock is taken over.
    utimesSync(guard, old, old);
    await expect(withSendLock(outbox, () => Promise.resolve('ran'), { staleMs: 1000, waitMs: 2000, pollMs: 5 })).resolves.toBe('ran');
    expect(readdirSync(outbox)).toEqual([]);
  });

  it('removes only its own lock: a lock another run took over is left alone', async () => {
    const outbox = folder();
    const lock = join(outbox, 'send.lock');
    await withSendLock(outbox, () => {
      writeFileSync(lock, 'another-run');
      return Promise.resolve();
    });
    expect(readFileSync(lock, 'utf8')).toBe('another-run');
  });

  // Windows answers EPERM (or EACCES) to an open while another handle's delete of the same file is pending; that is contention, like EEXIST, not a failure.
  const refusing = (code: string, platform: NodeJS.Platform, times: { refuse: number }): LockFs => ({
    stat,
    platform,
    open: async (path, flags) => {
      if (times.refuse > 0) {
        times.refuse -= 1;
        throw Object.assign(new Error(`${code}: operation not permitted, open '${path}'`), { code });
      }
      return open(path, flags);
    },
  });

  it.each(['EPERM', 'EACCES'])('retries an open that Windows refuses with %s while a delete is pending', async (code) => {
    const outbox = folder();
    const refuse = { refuse: 1 };
    expect(await withSendLock(outbox, () => Promise.resolve('ran'), { waitMs: 2000, pollMs: 5 }, refusing(code, 'win32', refuse))).toBe('ran');
    expect(refuse.refuse).toBe(0);
    expect(existsSync(join(outbox, 'send.lock'))).toBe(false);
  });

  it('gives up with SendLockBusy when Windows keeps refusing the open past waitMs', async () => {
    const outbox = folder();
    await expect(withSendLock(outbox, () => Promise.resolve('ran'), { waitMs: 30, pollMs: 5 }, refusing('EPERM', 'win32', { refuse: Infinity }))).rejects.toBeInstanceOf(SendLockBusy);
  });

  it('still throws EPERM off Windows, where it means a real permission problem', async () => {
    const outbox = folder();
    await expect(withSendLock(outbox, () => Promise.resolve('ran'), { waitMs: 2000, pollMs: 5 }, refusing('EPERM', 'linux', { refuse: 1 }))).rejects.toThrow('EPERM');
  });

  it('leaves a lock that reads fresh when it is looked at again under the guard', async () => {
    const outbox = folder();
    mkdirSync(outbox, { recursive: true });
    const lock = join(outbox, 'send.lock');
    writeFileSync(lock, 'live-run');
    // The first stat reads the lock as stale; by the time it is moved, its holder has refreshed it.
    const real = await import('node:fs/promises');
    let first = true;
    const seen = { stat: async (path: string) => {
      const { mtimeMs } = await real.stat(path);
      const skew = first ? 60_000 : 0;
      first = false;
      return { mtimeMs: mtimeMs - skew };
    } };
    await expect(withSendLock(outbox, () => Promise.resolve('ran'), { staleMs: 1000, waitMs: 30, pollMs: 5 }, seen)).rejects.toBeInstanceOf(SendLockBusy);
    expect(readFileSync(lock, 'utf8')).toBe('live-run');
    expect(readdirSync(outbox)).toEqual(['send.lock']);
  });
});
