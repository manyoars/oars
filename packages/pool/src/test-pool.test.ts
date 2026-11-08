// The pool harness itself: its requests share Node's keep-alive pool, which is what keeps a full `vitest run` from leaving thousands of loopback sockets in TIME_WAIT (t930).
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPool, workerError, type TestPool } from './test-pool.js';

// This file reads connect events on the real loopback transport, which is what it tests.
describe('the pool harness reuses its connections', () => {
  let pool: TestPool;
  beforeAll(async () => {
    pool = await startPool();
  });
  afterAll(() => pool.dispose());

  it('opens at most two connections for twenty requests and twenty D1 calls', async () => {
    let connects = 0;
    const count = (): void => {
      connects += 1;
    };
    subscribe('undici:client:connected', count);
    try {
      for (let at = 0; at < 20; at += 1) {
        expect((await pool.post('/v1/deposits', '{}')).status).toBe(401);
        expect(await (await pool.db()).prepare('select 1 as one').first('one')).toBe(1);
      }
    } finally {
      unsubscribe('undici:client:connected', count);
    }
    // Without the keep-alive sender Miniflare resets every connection: one connect per call, 40 here.
    expect(connects).toBeLessThanOrEqual(2);
  });

  // A test process starved by a loaded box can sit idle longer than undici's default keep-alive timeout (4 s) between two calls, which closes the socket and costs a reconnect. The pause is
  // made here, so the case does not wait for a load to make it.
  it('keeps its connection across a pause longer than the default keep-alive timeout', async () => {
    await pool.post('/v1/deposits', '{}');
    let connects = 0;
    const count = (): void => {
      connects += 1;
    };
    subscribe('undici:client:connected', count);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 4_500));
      expect((await pool.post('/v1/deposits', '{}')).status).toBe(401);
    } finally {
      unsubscribe('undici:client:connected', count);
    }
    expect(connects).toBe(0);
  });
});

describe('a Worker exception reads as the Worker\'s own error', () => {
  const thrown = { name: 'TypeError', message: 'x is not a function', stack: 'TypeError: x is not a function\n    at handler (worker.ts:12:3)' };
  const failure = (body: string, headers: { [name: string]: string } = {}): Response => new Response(body, { status: 500, headers: { 'MF-Experimental-Error-Stack': 'true', ...headers } });

  it('takes the message and stack from the body', async () => {
    const error = await workerError(failure(JSON.stringify(thrown)));
    expect(error.message).toBe(thrown.message);
    expect(error.stack).toBe(thrown.stack);
  });

  it('falls back to the payload header when the body is empty', async () => {
    const error = await workerError(failure('', { 'MF-Experimental-Error-Stack-Payload': encodeURIComponent(JSON.stringify(thrown)) }));
    expect(error.message).toBe(thrown.message);
    expect(error.stack).toBe(thrown.stack);
  });

  it('keeps the raw text when it is not the expected JSON, and says so when there is none', async () => {
    expect((await workerError(failure(JSON.stringify({ code: 7 })))).message).toBe('{"code":7}');
    expect((await workerError(failure('boom'))).message).toBe('the Worker threw a non-JSON error: boom');
    expect((await workerError(failure(''))).message).toBe('the Worker threw a non-JSON error: (empty)');
  });

  it('reads a malformed payload header as no payload, not as a URIError', async () => {
    const error = await workerError(failure('', { 'MF-Experimental-Error-Stack-Payload': '%E0%A4%A' }));
    expect(error.message).toBe('the Worker threw a non-JSON error: (empty)');
  });
});
