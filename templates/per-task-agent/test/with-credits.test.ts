import { describe, expect, it, vi } from 'vitest';
import { type Billing, type HandlerResult, withCredits } from '../src/billing.js';
import { createFakeBilling } from '../src/fake-billing.js';
import { createClock, flush } from './support.js';

const CUSTOMER = 'cus_buyer';

const setup = (credits = 5) => {
  const clock = createClock();
  const fake = createFakeBilling({ now: clock.now });
  fake.grant(CUSTOMER, credits);
  return { clock, fake };
};

// A handler that counts its runs and answers with the given result.
const counting = (result: HandlerResult) => {
  const handler = vi.fn((): Promise<HandlerResult> => Promise.resolve(result));
  return handler;
};

const ok: HandlerResult = { status: 200, body: { words: 2 } };

const position = async (billing: Billing) => {
  const { creditsRemaining, creditsHeld } = await billing.balance(CUSTOMER);
  return { creditsRemaining, creditsHeld };
};

describe('withCredits: reserve, run, commit or release', () => {
  it('holds one credit for 45 seconds under the call key before it runs the handler', async () => {
    const { clock, fake } = setup();
    const reserve = vi.spyOn(fake, 'reserve');

    await withCredits(fake, { customerRef: CUSTOMER, key: 'k-1', now: clock.now }, counting(ok));

    expect(reserve).toHaveBeenCalledExactlyOnceWith({ customerRef: CUSTOMER, credits: 1, ttlSeconds: 45, idempotencyKey: 'k-1' });
  });

  it('holds for the ttlSeconds a template asks for, such as a long task needing more than the default', async () => {
    const { clock, fake } = setup();
    const reserve = vi.spyOn(fake, 'reserve');

    await withCredits(fake, { customerRef: CUSTOMER, key: 'k-1', now: clock.now, ttlSeconds: 60 }, counting(ok));

    expect(reserve).toHaveBeenCalledExactlyOnceWith({ customerRef: CUSTOMER, credits: 1, ttlSeconds: 60, idempotencyKey: 'k-1' });
  });

  it('commits a 2xx and answers with the handler result and the credits charged', async () => {
    const { clock, fake } = setup();

    const result = await withCredits(fake, { customerRef: CUSTOMER, key: 'k-1', now: clock.now }, counting(ok));

    expect(result).toMatchObject({ status: 200, body: { words: 2 }, creditsCharged: 1 });
    expect(await position(fake)).toEqual({ creditsRemaining: 4, creditsHeld: 0 });
  });

  it('reports the credits billing committed, not the one it reserved, after a clawback', async () => {
    const { clock, fake } = setup(1);
    const handler = vi.fn((): Promise<HandlerResult> => {
      fake.clawback(CUSTOMER, 1);
      return Promise.resolve(ok);
    });

    const result = await withCredits(fake, { customerRef: CUSTOMER, key: 'k-1', now: clock.now }, handler);

    expect(result).toMatchObject({ status: 200, creditsCharged: 0 });
  });

  it('answers only after the commit succeeds', async () => {
    const { clock, fake } = setup();
    const gate = Promise.withResolvers<undefined>();
    const slowCommit: Billing = { ...fake, commit: async (id) => (await gate.promise, fake.commit(id)) };
    const handler = counting(ok);
    let settled = false;

    const pending = withCredits(slowCommit, { customerRef: CUSTOMER, key: 'k-1', now: clock.now }, handler).then((result) => {
      settled = true;
      return result;
    });
    await flush();

    expect(handler).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    gate.resolve(undefined);
    expect((await pending).status).toBe(200);
  });

  it('never runs the handler after a refused reservation, and answers 402 with the checkout URL at once', async () => {
    const { clock, fake } = setup(0);
    const handler = counting(ok);

    const result = await withCredits(fake, { customerRef: CUSTOMER, key: 'k-1', now: clock.now }, handler);

    expect(handler).not.toHaveBeenCalled();
    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    expect(JSON.stringify(result.body)).toMatch(/"checkoutUrl":"https:\/\//);
  });

  it('gives two concurrent calls on one credit one 200 and one 402, and runs the handler once', async () => {
    const { clock, fake } = setup(1);
    const gate = Promise.withResolvers<undefined>();
    const handler = vi.fn(async (): Promise<HandlerResult> => (await gate.promise, ok));

    const first = withCredits(fake, { customerRef: CUSTOMER, key: 'k-1', now: clock.now }, handler);
    const second = withCredits(fake, { customerRef: CUSTOMER, key: 'k-2', now: clock.now }, handler);
    const refused = await second;
    gate.resolve(undefined);

    expect(refused.status).toBe(402);
    expect((await first).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(await position(fake)).toEqual({ creditsRemaining: 0, creditsHeld: 0 });
  });
});

describe('withCredits: a failed call is free', () => {
  it.each([
    ['a 4xx', () => Promise.resolve({ status: 422, body: { error: 'bad text' } }), 422],
    ['a 5xx', () => Promise.resolve({ status: 502, body: { error: 'upstream' } }), 502],
    ['a thrown error', () => Promise.reject(new Error('boom with internal detail')), 500],
    ['a timeout', () => new Promise<HandlerResult>(() => undefined), 504],
  ])('releases and commits nothing on %s', async (_name, run, status) => {
    const { clock, fake } = setup();
    const commit = vi.spyOn(fake, 'commit');
    const release = vi.spyOn(fake, 'release');

    const result = await withCredits(fake, { customerRef: CUSTOMER, key: 'k-1', now: clock.now, timeoutMs: 20 }, run);

    expect(result.status).toBe(status);
    expect(JSON.stringify(result.body)).not.toContain('internal detail');
    expect(commit).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(await position(fake)).toEqual({ creditsRemaining: 5, creditsHeld: 0 });
  });

  it('aborts the handler at the timeout', async () => {
    const { clock, fake } = setup();
    let aborted = false;
    const handler = (signal: AbortSignal) =>
      new Promise<HandlerResult>(() => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
      });

    await withCredits(fake, { customerRef: CUSTOMER, key: 'k-1', now: clock.now, timeoutMs: 20 }, handler);

    expect(aborted).toBe(true);
  });

  it('after a 5xx, a retry under the same key succeeds and charges once', async () => {
    const { clock, fake } = setup();
    const call = { customerRef: CUSTOMER, key: 'k-1', now: clock.now };

    const failed = await withCredits(fake, call, counting({ status: 500, body: { error: 'down' } }));
    const retried = await withCredits(fake, call, counting(ok));

    expect([failed.status, retried.status]).toEqual([500, 200]);
    expect(await position(fake)).toEqual({ creditsRemaining: 4, creditsHeld: 0 });
  });

  it('after a crash that leaves the hold to expire, a retry under the same key succeeds and charges once', async () => {
    const { clock, fake } = setup();
    const call = { customerRef: CUSTOMER, key: 'k-1', now: clock.now };
    await fake.reserve({ customerRef: CUSTOMER, credits: 1, ttlSeconds: 45, idempotencyKey: 'k-1' });
    clock.advance(46_000);

    const retried = await withCredits(fake, call, counting(ok));

    expect(retried.status).toBe(200);
    expect(await position(fake)).toEqual({ creditsRemaining: 4, creditsHeld: 0 });
  });

  it('returns no result when the commit fails because the hold expired during the handler', async () => {
    const { clock, fake } = setup();
    const slow = vi.fn((): Promise<HandlerResult> => {
      clock.advance(46_000);
      return Promise.resolve(ok);
    });

    const result = await withCredits(fake, { customerRef: CUSTOMER, key: 'k-1', now: clock.now }, slow);

    expect(result.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain('words');
    expect(await position(fake)).toEqual({ creditsRemaining: 5, creditsHeld: 0 });
  });
});

describe('withCredits: replays under one Idempotency-Key', () => {
  it('answers a live hold with 409 REQUEST_IN_PROGRESS and Retry-After, and runs one handler for two identical calls', async () => {
    const { clock, fake } = setup();
    const call = { customerRef: CUSTOMER, key: 'k-1', now: clock.now };
    const gate = Promise.withResolvers<undefined>();
    const handler = vi.fn(async (): Promise<HandlerResult> => (await gate.promise, ok));

    const first = withCredits(fake, call, handler);
    clock.advance(10_000);
    const second = await withCredits(fake, call, handler);
    gate.resolve(undefined);

    expect(second).toMatchObject({ status: 409, body: { code: 'REQUEST_IN_PROGRESS' }, retryAfter: 35 });
    expect((await first).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(await position(fake)).toEqual({ creditsRemaining: 4, creditsHeld: 0 });
  });

  it('runs the handler again after a commit, with no second charge, twice', async () => {
    const { clock, fake } = setup();
    const call = { customerRef: CUSTOMER, key: 'k-1', now: clock.now };
    const handler = counting(ok);

    const results = [await withCredits(fake, call, handler), await withCredits(fake, call, handler), await withCredits(fake, call, handler)];

    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    expect(results.map((result) => result.creditsCharged)).toEqual([1, 0, 0]);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(await position(fake)).toEqual({ creditsRemaining: 4, creditsHeld: 0 });
  });

  it('answers the third replay with 409 IDEMPOTENCY_KEY_SPENT and runs no handler', async () => {
    const { clock, fake } = setup();
    const call = { customerRef: CUSTOMER, key: 'k-1', now: clock.now };
    const handler = counting(ok);
    for (let run = 0; run < 3; run += 1) await withCredits(fake, call, handler);

    const spent = await withCredits(fake, call, handler);

    expect(spent).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_KEY_SPENT' } });
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('answers a replay 10 minutes after the commit with 409 IDEMPOTENCY_KEY_SPENT', async () => {
    const { clock, fake } = setup();
    const call = { customerRef: CUSTOMER, key: 'k-1', now: clock.now };
    const handler = counting(ok);
    await withCredits(fake, call, handler);
    clock.advance(10 * 60_000 + 1_000);

    const spent = await withCredits(fake, call, handler);

    expect(spent).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_KEY_SPENT' } });
    expect(handler).toHaveBeenCalledOnce();
  });
});
