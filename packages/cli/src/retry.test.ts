import { describe, expect, it } from 'vitest';
import { retryingFetch } from './retry.js';

const run = async (answers: Array<Response | Error>, random = 0.5) => {
  const sent: Request[] = [];
  const send = (request: Request): Promise<Response> => {
    sent.push(request);
    const answer = answers[Math.min(sent.length - 1, answers.length - 1)];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer?.clone() ?? new Response(null, { status: 200 }));
  };
  const sleeps: number[] = [];
  const fetchWithRetry = retryingFetch(send, {
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => random,
  });
  const request = new Request('https://api.test/x', { method: 'POST', body: '{"a":1}', headers: { 'Idempotency-Key': 'k1' } });
  const outcome = await fetchWithRetry(request).catch((error: unknown) => error);
  return { outcome, sent, sleeps };
};
const status = (code: number, headers: HeadersInit = {}) => new Response('{}', { status: code, headers });

describe('retryingFetch', () => {
  it.each([502, 503, 504])('retries %i three times, then returns the last response', async (code) => {
    const { outcome, sent, sleeps } = await run([status(code)]);
    expect(sent).toHaveLength(4);
    expect(sleeps).toHaveLength(3);
    expect(outcome).toBeInstanceOf(Response);
  });

  it('retries a network error three times, then rethrows it', async () => {
    const failure = new TypeError('fetch failed');
    const { outcome, sent } = await run([failure]);
    expect(sent).toHaveLength(4);
    expect(outcome).toBe(failure);
  });

  it('retries a 429 that carries Retry-After and waits at least that long', async () => {
    const { outcome, sent, sleeps } = await run([status(429, { 'Retry-After': '7' }), status(200)]);
    expect(sent).toHaveLength(2);
    expect(outcome).toBeInstanceOf(Response);
    expect(sleeps[0]).toBeGreaterThanOrEqual(7000);
  });

  it.each([429, 500, 400, 401, 404, 409, 422])('does not retry %i without a reason', async (code) => {
    const { sent } = await run([status(code)]);
    expect(sent).toHaveLength(1);
  });

  it('resends the same body and Idempotency-Key on every attempt', async () => {
    const { sent } = await run([status(503), status(503), status(200)]);
    expect(await Promise.all(sent.map((request) => request.text()))).toEqual(['{"a":1}', '{"a":1}', '{"a":1}']);
    expect(sent.map((request) => request.headers.get('Idempotency-Key'))).toEqual(['k1', 'k1', 'k1']);
  });

  it('jitters the backoff and grows it with each attempt', async () => {
    const low = await run([status(503)], 0);
    const high = await run([status(503)], 1);
    expect(high.sleeps[0]).toBeGreaterThan(low.sleeps[0] ?? Infinity);
    expect(low.sleeps[1]).toBeGreaterThan(low.sleeps[0] ?? Infinity);
  });
});
