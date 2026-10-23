import { describe, expect, it, vi } from 'vitest';
import { CHARGING_SENTENCE, createApp, HOLD_TTL_SECONDS, TASK_BUDGET_MS, type TaskLogEntry } from '../src/app.js';
import { type Audit } from '../src/audit.js';
import { BillingProblem, customerRefFor, mintToken, reservationKey } from '../src/billing.js';
import { createFakeBilling } from '../src/fake-billing.js';
import { FetchFailed, FetchRefused, type Page } from '../src/fetch-page.js';
import { type Summarizer } from '../src/summary.js';
import { createClock, flush } from './support.js';

const PRICE_REFS = ['task-1', 'tasks-5'];

const HTML = '<html><head><title>Acme Widgets: handmade widgets for everyone</title></head><body><h1>Widgets</h1></body></html>';

const aPage = (overrides: Partial<Page> = {}): Page => ({
  finalUrl: 'https://acme.example/',
  status: 200,
  contentType: 'text/html; charset=utf-8',
  html: HTML,
  bytes: HTML.length,
  elapsedMs: 120,
  ...overrides,
});

type Fetch = (url: string, signal: AbortSignal) => Promise<Page>;

const setup = (credits = 3, extra: { fetchPage?: Fetch; summarize?: (audit: Audit, signal: AbortSignal) => Promise<string>; taskBudgetMs?: number; summaryBudgetMs?: number; log?: (entry: TaskLogEntry) => void } = {}) => {
  const clock = createClock();
  const fake = createFakeBilling({ now: clock.now });
  const fetchPage = vi.fn<Fetch>(extra.fetchPage ?? (() => Promise.resolve(aPage())));
  const app = createApp({ billing: fake, priceRefs: PRICE_REFS, now: clock.now, fetchPage, summarize: extra.summarize, taskBudgetMs: extra.taskBudgetMs, summaryBudgetMs: extra.summaryBudgetMs, log: extra.log });
  const token = mintToken();
  const customerRef = customerRefFor(token);
  fake.grant(customerRef, credits);
  return { app, clock, fake, token, customerRef, fetchPage };
};

const authorization = (token: string) => ({ Authorization: `Bearer ${token}` });

const post = (body: unknown, headers: { [name: string]: string } = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('GET /healthz', () => {
  it('is free and answers 200 without a token or a billing call', async () => {
    const { app, fake } = setup();
    const balance = vi.spyOn(fake, 'balance');

    const response = await app.request('/healthz');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(balance).not.toHaveBeenCalled();
  });
});

describe('GET /', () => {
  it('describes the endpoints, the price refs and the charging sentence, free', async () => {
    const { app } = setup();

    const response = await app.request('/');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ priceRefs: PRICE_REFS, charging: CHARGING_SENTENCE });
    expect(body).toMatchObject({ name: 'Per-task agent' });
    const paths = JSON.stringify(body);
    for (const path of ['/v1/customers', '/v1/credits/checkout', '/v1/credits', '/v1/tasks']) expect(paths).toContain(path);
  });

  it('says it in the words the design fixes', () => {
    expect(CHARGING_SENTENCE).toBe(
      'You pay only for successful calls: a credit is held when your call starts, spent when it succeeds, and returned when it fails or times out.',
    );
  });
});

describe('POST /v1/customers', () => {
  it('mints a token, upserts the hashed customerRef and returns the token once', async () => {
    const { app, fake } = setup();
    const upsert = vi.spyOn(fake, 'upsertCustomer');

    const response = await app.request('/v1/customers', post({ countryCode: 'US', regionCode: 'CA' }));

    expect(response.status).toBe(201);
    const body: unknown = await response.json();
    const token = typeof body === 'object' && body !== null && 'token' in body ? String(body.token) : '';
    expect(token).toMatch(/^oc_[A-Za-z0-9_-]{43}$/);
    expect(body).toMatchObject({ customerRef: customerRefFor(token) });
    expect(upsert).toHaveBeenCalledExactlyOnceWith(customerRefFor(token), { countryCode: 'US', regionCode: 'CA' });
    expect(JSON.stringify(upsert.mock.calls)).not.toContain(token);
  });

  it.each([[{}], [{ countryCode: 'USA' }], [{ countryCode: 'US', regionCode: 7 }], ['not json']])('answers 400 for the body %j and mints nothing', async (body) => {
    const { app, fake } = setup();
    const upsert = vi.spyOn(fake, 'upsertCustomer');

    const response = await app.request('/v1/customers', post(body));

    expect(response.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('passes a billing refusal through the buyer mapping', async () => {
    const { app, fake } = setup();
    vi.spyOn(fake, 'upsertCustomer').mockRejectedValue(new BillingProblem({ status: 422, code: 'CUSTOMER_REGION_NOT_SUPPORTED' }));

    const response = await app.request('/v1/customers', post({ countryCode: 'DE' }));

    expect(response.status).toBe(403);
  });
});

describe('bearer authentication', () => {
  it.each([
    ['GET', '/v1/credits'],
    ['POST', '/v1/credits/checkout'],
    ['POST', '/v1/tasks'],
  ])('%s %s refuses a missing, malformed or non-bearer credential with 401 and no pointer to /recover', async (method, path) => {
    const { app } = setup();
    const headers: Array<{ [name: string]: string }> = [{}, authorization('oc_short'), authorization('not-a-token'), { Authorization: 'Basic abc' }];

    for (const extra of headers) {
      const response = await app.request(path, { method, headers: { 'Content-Type': 'application/json', ...extra }, body: method === 'POST' ? '{}' : undefined });

      expect(response.status).toBe(401);
      expect(JSON.stringify(await response.json())).not.toContain('/recover');
    }
  });
});

describe('POST /v1/credits/checkout', () => {
  it('returns the checkout URL billing made for the buyer and a price ref', async () => {
    const { app, fake, token, customerRef } = setup(0);
    const checkout = vi.spyOn(fake, 'checkout');

    const response = await app.request('/v1/credits/checkout', post({ priceRef: 'task-1' }, authorization(token)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ checkoutUrl: 'https://checkout.example/fake/task-1' });
    expect(checkout).toHaveBeenCalledExactlyOnceWith(customerRef, 'task-1');
  });

  it('maps an unknown price to 400', async () => {
    const { app, token } = setup(0);

    const response = await app.request('/v1/credits/checkout', post({ priceRef: 'nope' }, authorization(token)));

    expect(response.status).toBe(400);
  });

  it.each([[{}], [{ priceRef: 5 }], [{ priceRef: '' }]])('answers 400 for %j without calling billing', async (body) => {
    const { app, fake, token } = setup(0);
    const checkout = vi.spyOn(fake, 'checkout');

    const response = await app.request('/v1/credits/checkout', post(body, authorization(token)));

    expect(response.status).toBe(400);
    expect(checkout).not.toHaveBeenCalled();
  });
});

describe('GET /v1/credits', () => {
  it('returns the buyer balance with the credits held by calls in flight', async () => {
    const { app, token } = setup(3);

    const response = await app.request('/v1/credits', { headers: authorization(token) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ creditsRemaining: 3, creditsHeld: 0, creditsAvailable: 3 });
  });
});

describe('POST /v1/tasks', () => {
  const url = 'https://acme.example/';
  const submit = (app: ReturnType<typeof setup>['app'], token: string, body: unknown = { url }, headers: { [name: string]: string } = {}) =>
    app.request('/v1/tasks', post(body, { ...authorization(token), ...headers }));
  const expectPosition = async (app: ReturnType<typeof setup>['app'], token: string, creditsRemaining: number, creditsHeld = 0) => {
    const balance = await app.request('/v1/credits', { headers: authorization(token) });
    expect(await balance.json()).toMatchObject({ creditsRemaining, creditsHeld });
  };

  it('charges one credit and answers the findings, with the credits charged in a header', async () => {
    const { app, token, fetchPage } = setup(3);

    const response = await submit(app, token);

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Credits-Charged')).toBe('1');
    const body: unknown = await response.json();
    expect(body).toMatchObject({
      url,
      finalUrl: 'https://acme.example/',
      https: true,
      title: 'Acme Widgets: handmade widgets for everyone',
      h1: ['Widgets'],
    });
    expect(JSON.stringify(body)).toContain('"check":"title","result":"pass"');
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith(url, expect.any(AbortSignal));
    await expectPosition(app, token, 2);
  });

  it('measures the page weight and response time the fetch reported', async () => {
    const { app, token } = setup(3, { fetchPage: () => Promise.resolve(aPage({ bytes: 4321, elapsedMs: 777.4 })) });

    expect(await (await submit(app, token)).json()).toMatchObject({ pageWeightBytes: 4321, responseTimeMs: 777 });
  });

  it('holds the credit for 60 seconds, longer than the 45-second task budget it runs under', async () => {
    const { app, token, fake, customerRef } = setup(3);
    const reserve = vi.spyOn(fake, 'reserve');
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const body = JSON.stringify({ url });

    await app.request('/v1/tasks', post(body, { ...authorization(token), 'Idempotency-Key': 'buyer-1' }));

    expect(reserve).toHaveBeenCalledExactlyOnceWith({ customerRef, credits: 1, ttlSeconds: 60, idempotencyKey: reservationKey(customerRef, 'buyer-1', body) });
    expect(timeout).toHaveBeenCalledWith(45_000);
    expect([HOLD_TTL_SECONDS, TASK_BUDGET_MS]).toEqual([60, 45_000]);
  });

  it('answers 402 with the checkout URL for a buyer with no credits, and fetches nothing', async () => {
    const { app, token, customerRef, fetchPage } = setup(0);

    const response = await submit(app, token);

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: 'INSUFFICIENT_CREDITS', checkoutUrl: `https://checkout.example/packs/${customerRef}` });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ url: 5 }], [{ url: '' }], [{ url: 'not a url' }], [{ url: 'ftp://acme.example/' }], [{ url: 'file:///etc/passwd' }], ['not json'], [[]]])(
    'answers 400 for the body %j without touching billing or the network',
    async (body) => {
      const { app, fake, token, fetchPage } = setup(3);
      const reserve = vi.spyOn(fake, 'reserve');

      const response = await submit(app, token, body);

      expect(response.status).toBe(400);
      expect(reserve).not.toHaveBeenCalled();
      expect(fetchPage).not.toHaveBeenCalled();
    },
  );

  it('keys the reservation on the customerRef, the buyer Idempotency-Key and the exact body', async () => {
    const { app, fake, token, customerRef } = setup(3);
    const reserve = vi.spyOn(fake, 'reserve');
    const body = JSON.stringify({ url });

    await app.request('/v1/tasks', post(body, { ...authorization(token), 'Idempotency-Key': 'buyer-1' }));

    expect(reserve.mock.calls[0]?.[0].idempotencyKey).toBe(reservationKey(customerRef, 'buyer-1', body));
  });

  it('replays a paid task free under the same key and body, and charges again for a new URL', async () => {
    const { app, token } = setup(3);
    const headers = { 'Idempotency-Key': 'buyer-1' };

    const first = await submit(app, token, { url }, headers);
    const replay = await submit(app, token, { url }, headers);
    const changed = await submit(app, token, { url: 'https://other.example/' }, headers);

    expect([first, replay, changed].map((response) => response.headers.get('X-Credits-Charged'))).toEqual(['1', '0', '1']);
    await expectPosition(app, token, 1);
  });

  it('answers 409 with Retry-After for a task already running under the same key, and runs no second audit', async () => {
    const { app, token, fake, customerRef, fetchPage } = setup(3);
    const body = JSON.stringify({ url });
    await fake.reserve({ customerRef, credits: 1, ttlSeconds: 60, idempotencyKey: reservationKey(customerRef, 'buyer-1', body) });

    const response = await app.request('/v1/tasks', post(body, { ...authorization(token), 'Idempotency-Key': 'buyer-1' }));

    expect(response.status).toBe(409);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toMatchObject({ code: 'REQUEST_IN_PROGRESS' });
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('gives two concurrent tasks racing for the last credit one hold and one immediate 402, and runs one audit', async () => {
    const gate = Promise.withResolvers<undefined>();
    const { app, token, customerRef, fetchPage } = setup(1, {
      fetchPage: async () => {
        await gate.promise;
        return aPage();
      },
    });

    const winner = submit(app, token);
    await flush();
    const loser = await submit(app, token);

    expect(loser.status).toBe(402);
    expect(await loser.json()).toMatchObject({ checkoutUrl: `https://checkout.example/packs/${customerRef}` });
    gate.resolve(undefined);
    expect((await winner).status).toBe(200);
    expect(fetchPage).toHaveBeenCalledOnce();
    await expectPosition(app, token, 0);
  });

  describe('a task that fails costs the buyer nothing', () => {
    it.each([
      ['a refused address', () => Promise.reject(new FetchRefused('URL_NOT_ALLOWED', 'resolved to 10.0.0.1')), 422, 'URL_NOT_ALLOWED'],
      ['too many redirects', () => Promise.reject(new FetchRefused('TOO_MANY_REDIRECTS', 'six hops')), 422, 'TOO_MANY_REDIRECTS'],
      ['an unreachable page', () => Promise.reject(new FetchFailed('UNREACHABLE', 'ECONNREFUSED 10.0.0.1:80')), 502, 'PAGE_UNREACHABLE'],
      ['a page past the size cap', () => Promise.reject(new FetchFailed('PAGE_TOO_LARGE', 'over 5 MiB')), 422, 'PAGE_TOO_LARGE'],
      ['a fetch that ran out of time', () => Promise.reject(new FetchFailed('TIMED_OUT', 'aborted')), 504, 'HANDLER_TIMEOUT'],
      ['an unexpected error', () => Promise.reject(new Error('secret internals')), 500, 'HANDLER_FAILED'],
      ['a 404 page', () => Promise.resolve(aPage({ status: 404 })), 422, 'PAGE_NOT_AUDITABLE'],
      ['a 500 page', () => Promise.resolve(aPage({ status: 500 })), 422, 'PAGE_NOT_AUDITABLE'],
      ['a redirect with no Location', () => Promise.resolve(aPage({ status: 301 })), 422, 'PAGE_NOT_AUDITABLE'],
      ['a PDF', () => Promise.resolve(aPage({ contentType: 'application/pdf' })), 422, 'NOT_HTML'],
    ])('for %s: releases the hold and commits nothing', async (_name, fetchPage, status, code) => {
      const { app, token, fake } = setup(3, { fetchPage });
      const commit = vi.spyOn(fake, 'commit');

      const response = await submit(app, token);

      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(response.headers.get('X-Credits-Charged')).toBe('0');
      expect(commit).not.toHaveBeenCalled();
      await expectPosition(app, token, 3);
    });

    it('and never tells the buyer an address or an internal message', async () => {
      const { app, token } = setup(3, { fetchPage: () => Promise.reject(new FetchRefused('URL_NOT_ALLOWED', 'acme.example resolved to 10.0.0.1')) });

      const text = JSON.stringify(await (await submit(app, token)).json());

      expect(text).not.toContain('10.0.0.1');
    });

    it('also audits a page with no content type, and an XHTML one', async () => {
      for (const contentType of ['', 'application/xhtml+xml', 'text/html']) {
        const { app, token } = setup(3, { fetchPage: () => Promise.resolve(aPage({ contentType })) });

        expect((await submit(app, token)).status).toBe(200);
      }
    });

    it('aborts at the 45-second budget through the signal, answers 504 and returns the held credit', async () => {
      const { app, token, fetchPage } = setup(3, {
        taskBudgetMs: 30,
        fetchPage: (_url, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      });

      const response = await submit(app, token);

      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ code: 'HANDLER_TIMEOUT' });
      expect(response.headers.get('X-Credits-Charged')).toBe('0');
      expect(fetchPage.mock.calls[0]?.[1].aborted).toBe(true);
      await expectPosition(app, token, 3);
    });

    it('does not wait for a fetch that ignores the budget', async () => {
      const { app, token } = setup(3, { taskBudgetMs: 30, fetchPage: () => new Promise<Page>(() => undefined) });

      const response = await submit(app, token);

      expect(response.status).toBe(504);
      await expectPosition(app, token, 3);
    });
  });

  describe('the optional model summary', () => {
    it('is absent when no summarizer is configured', async () => {
      const { app, token } = setup(3);

      expect(await (await submit(app, token)).json()).not.toHaveProperty('summary');
    });

    it('is written on top of the findings, from the same audit and the task budget signal', async () => {
      const summarize = vi.fn<Summarizer>(() => Promise.resolve('A solid page.'));
      const { app, token, fetchPage } = setup(3, { summarize });

      const body = await (await submit(app, token)).json();

      expect(body).toMatchObject({ summary: 'A solid page.', title: 'Acme Widgets: handmade widgets for everyone' });
      expect(summarize.mock.calls[0]?.[0]).toMatchObject({ title: 'Acme Widgets: handmade widgets for everyone' });
      expect(summarize.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
      expect(fetchPage).toHaveBeenCalledOnce();
    });

    it('fails the task when the model call fails: 502, the credit goes back, the cause is logged and not told to the buyer', async () => {
      const log = vi.fn<(entry: TaskLogEntry) => void>();
      const { app, token, fake } = setup(3, { summarize: () => Promise.reject(new Error('529 overloaded')), log });
      const commit = vi.spyOn(fake, 'commit');

      const response = await submit(app, token);

      expect(response.status).toBe(502);
      expect(response.headers.get('X-Credits-Charged')).toBe('0');
      const text = JSON.stringify(await response.json());
      expect(text).toContain('SUMMARY_FAILED');
      expect(text).not.toContain('529');
      expect(commit).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledExactlyOnceWith({ event: 'task-failed', code: 'SUMMARY_FAILED', cause: 'Error: 529 overloaded' });
      await expectPosition(app, token, 3);
    });

    it('gives up on a slow model after its own short budget, and that fails the task the same way', async () => {
      const { app, token } = setup(3, {
        summaryBudgetMs: 20,
        summarize: (_audit, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      });

      const response = await submit(app, token);

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ code: 'SUMMARY_FAILED' });
      expect(response.headers.get('X-Credits-Charged')).toBe('0');
      await expectPosition(app, token, 3);
    });

    it('is never called for a task that failed', async () => {
      const summarize = vi.fn<Summarizer>(() => Promise.resolve('unused'));
      const { app, token } = setup(3, { summarize, fetchPage: () => Promise.resolve(aPage({ status: 404 })) });

      await submit(app, token);

      expect(summarize).not.toHaveBeenCalled();
    });
  });
});

describe('errors', () => {
  it('answers a billing problem that is not a buyer matter with a bare 503', async () => {
    const { app, fake, token } = setup();
    vi.spyOn(fake, 'balance').mockRejectedValue(new BillingProblem({ status: 409, code: 'WORKLOAD_NOT_ACTIVE', detail: 'workload w-1 suspended' }));

    const response = await app.request('/v1/credits', { headers: authorization(token) });

    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('w-1');
  });

  it('answers any other failure with a generic 500 that leaks nothing', async () => {
    const { app, fake, token } = setup();
    vi.spyOn(fake, 'balance').mockRejectedValue(new Error('secret internals'));

    const response = await app.request('/v1/credits', { headers: authorization(token) });

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('secret');
  });

  it('answers an unknown path with 404 JSON', async () => {
    const { app } = setup();

    const response = await app.request('/v2/nothing');

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});
