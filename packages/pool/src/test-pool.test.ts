// The pool harness itself: its requests share a keep-alive undici Agent the pool owns, which is what keeps a full `vitest run` from leaving thousands of loopback sockets in TIME_WAIT.
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPool, workerError, type TestPool } from './test-pool.js';

// This file reads connect events on the real loopback transport, which is what it tests.
// A connection serves one request at a time, so what keep-alive bounds is the connections opened against the most requests in flight at once, not a fixed number: Miniflare releases the
// handles `getBindings` returns in a batched DELETE it sends 100 ms after a garbage collection, and that request can overlap the next call the test makes and need a connection of its
// own (1 to 5 connects on a loaded CI runner). Without the keep-alive sender every request resets its connection: one connect per request, far above any overlap.
const requestOf = (message: unknown): object | null => (typeof message === 'object' && message !== null && 'request' in message && typeof message.request === 'object' ? message.request : null);

const watchConnections = (): { connects: () => number; peak: () => number; stop: () => void } => {
  const open = new Set<object | null>();
  let connects = 0;
  let peak = 0;
  const connected = (): void => {
    connects += 1;
  };
  const created = (message: unknown): void => {
    open.add(requestOf(message));
    peak = Math.max(peak, open.size);
  };
  const finished = (message: unknown): void => {
    open.delete(requestOf(message));
  };
  subscribe('undici:client:connected', connected);
  subscribe('undici:request:create', created);
  subscribe('undici:request:trailers', finished);
  subscribe('undici:request:error', finished);
  return {
    connects: () => connects,
    peak: () => peak,
    stop: () => {
      unsubscribe('undici:client:connected', connected);
      unsubscribe('undici:request:create', created);
      unsubscribe('undici:request:trailers', finished);
      unsubscribe('undici:request:error', finished);
    },
  };
};

describe('the pool harness reuses its connections', () => {
  let pool: TestPool;
  beforeAll(async () => {
    pool = await startPool();
  });
  afterAll(() => pool.dispose());

  it('opens no more connections than it has requests in flight at once, for twenty requests and twenty D1 calls', async () => {
    const watch = watchConnections();
    try {
      for (let at = 0; at < 20; at += 1) {
        expect((await pool.post('/v1/deposits', '{}')).status).toBe(401);
        expect(await (await pool.db()).prepare('select 1 as one').first('one')).toBe(1);
      }
    } finally {
      watch.stop();
    }
    expect(watch.connects()).toBeLessThanOrEqual(watch.peak());
  });

  // A test process starved by a loaded box can sit idle longer than undici's default keep-alive timeout (4 s) between two calls, which closes the socket and costs a reconnect. The pause is
  // made here, so the case does not wait for a load to make it. An overlapping release request may need one connection of its own, which is why the bound is one below the peak.
  it('keeps its connection across a pause longer than the default keep-alive timeout', async () => {
    await pool.post('/v1/deposits', '{}');
    const watch = watchConnections();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 4_500));
      expect((await pool.post('/v1/deposits', '{}')).status).toBe(401);
    } finally {
      watch.stop();
    }
    expect(watch.connects()).toBeLessThanOrEqual(watch.peak() - 1);
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
