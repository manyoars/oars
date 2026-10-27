import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { BillingProblem, customerRefFor, mintToken } from '../src/billing.js';
import { createFakeBilling, createFakeRecovery } from '../src/fake-billing.js';
import { createIpLimiter, RECOVERY_ENDPOINTS, RECOVERY_SENTENCE, recoveryRoutes } from '../src/recovery.js';
import { bodyOf, createClock } from './support.js';

const EMAIL = 'buyer@example.com';
const IP = '203.0.113.7';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const setup = (credits = 99) => {
  const clock = createClock();
  const billing = createFakeBilling({ now: clock.now });
  const recovery = createFakeRecovery({ billing, now: clock.now });
  const app = new Hono();
  app.route('/', recoveryRoutes({ recovery, now: clock.now }));
  const token = mintToken();
  const customerRef = customerRefFor(token);
  billing.grant(customerRef, credits);
  recovery.bind(customerRef, EMAIL);
  const send = (path: string, body: unknown, ip: string = IP): Promise<Response> =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const mailedLink = (): string => recovery.outbox.at(-1)?.token ?? '';
  return { app, clock, billing, recovery, token, customerRef, send, mailedLink };
};

describe('POST /v1/recover', () => {
  it('answers the same 202 body for an email that holds credits and one that does not, and mails only the first', async () => {
    const { send, recovery } = setup();

    const known = await send('/v1/recover', { email: EMAIL });
    const unknown = await send('/v1/recover', { email: 'nobody@example.com' });

    expect([known.status, unknown.status]).toEqual([202, 202]);
    const knownBody = await known.text();
    expect(knownBody).toBe(await unknown.text());
    expect(JSON.parse(knownBody)).toMatchObject({ accepted: true });
    expect(recovery.outbox).toEqual([{ email: EMAIL, token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }]);
  });

  it('sends billing the trimmed email and nothing else', async () => {
    const { send, recovery } = setup();
    const request = vi.spyOn(recovery, 'request');

    await send('/v1/recover', { email: `  ${EMAIL} ` });

    expect(request).toHaveBeenCalledExactlyOnceWith(EMAIL);
  });

  it.each([[{}], [{ email: 7 }], [{ email: 'not-an-email' }], [{ email: `${'a'.repeat(250)}@example.com` }], ['not json']])(
    'answers 400 for the body %j and asks billing nothing',
    async (body) => {
      const { send, recovery } = setup();
      const request = vi.spyOn(recovery, 'request');

      const response = await send('/v1/recover', body);

      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ code: 'INVALID_REQUEST' });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('lets one client IP ask 5 times a minute, then answers 429 with Retry-After and asks billing nothing', async () => {
    const { send, recovery, clock } = setup();
    const request = vi.spyOn(recovery, 'request');
    for (let asked = 0; asked < 5; asked += 1) {
      clock.advance(1_000);
      expect((await send('/v1/recover', { email: `buyer${String(asked)}@example.com` })).status).toBe(202);
    }

    const limited = await send('/v1/recover', { email: 'buyer6@example.com' });

    expect(limited.status).toBe(429);
    expect(await bodyOf(limited)).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited.headers.get('Retry-After')).toBe('56');
    expect(request).toHaveBeenCalledTimes(5);
    clock.advance(56_000);
    expect((await send('/v1/recover', { email: EMAIL })).status).toBe(202);
  });

  it('keeps a count per IP, so another address is not limited', async () => {
    const { send } = setup();
    for (let asked = 0; asked < 5; asked += 1) await send('/v1/recover', { email: EMAIL });

    expect((await send('/v1/recover', { email: EMAIL })).status).toBe(429);
    expect((await send('/v1/recover', { email: EMAIL }, '198.51.100.2')).status).toBe(202);
  });

  it('counts a request without a client-IP header against the socket address', async () => {
    const { app } = setup();
    const ask = (address: string): Promise<Response> =>
      app.request(
        '/v1/recover',
        { method: 'POST', body: JSON.stringify({ email: EMAIL }) },
        { incoming: { socket: { remoteAddress: address } } },
      );
    for (let asked = 0; asked < 5; asked += 1) await ask('192.0.2.10');

    expect((await ask('192.0.2.10')).status).toBe(429);
    expect((await ask('192.0.2.11')).status).toBe(202);
  });

  it("passes billing's 429 on with its Retry-After: a fourth request for one email in the hour", async () => {
    const { send, clock } = setup();
    for (let asked = 0; asked < 3; asked += 1) {
      clock.advance(60_000);
      expect((await send('/v1/recover', { email: EMAIL })).status).toBe(202);
    }

    const fourth = await send('/v1/recover', { email: EMAIL });

    expect(fourth.status).toBe(429);
    expect(await bodyOf(fourth)).toMatchObject({ code: 'RATE_LIMITED' });
    expect(fourth.headers.get('Retry-After')).toBe('3480');
  });

  it.each([
    [new BillingProblem({ status: 401, code: 'SDK_KEY_INVALID' })],
    [new BillingProblem({ status: 409, code: 'WORKLOAD_NOT_ACTIVE' })],
    [new BillingProblem({ status: 0, code: 'BILLING_UNREACHABLE', detail: 'connect ECONNREFUSED 10.0.0.7' })],
  ])('answers a bare 503 for %s, so a stopped workload says nothing about the buyer', async (problem) => {
    const { send, recovery } = setup();
    vi.spyOn(recovery, 'request').mockRejectedValue(problem);

    const response = await send('/v1/recover', { email: EMAIL });

    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({ code: 'UNAVAILABLE', message: 'This service is not available right now. Try again.' });
  });
});

describe('POST /v1/recover/redeem', () => {
  it('mints a token, sends billing only its hash as newCustomerRef and returns the token once', async () => {
    const { send, recovery, billing, mailedLink } = setup();
    await send('/v1/recover', { email: EMAIL });
    const redeem = vi.spyOn(recovery, 'redeem');
    const link = mailedLink();

    const response = await send('/v1/recover/redeem', { recoveryToken: link });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await bodyOf(response);
    const token = String(body['token']);
    expect(token).toMatch(/^oc_[A-Za-z0-9_-]{43}$/);
    expect(body).toEqual({ token, customerRef: customerRefFor(token), creditsRemaining: 99 });
    expect(redeem).toHaveBeenCalledExactlyOnceWith({ recoveryToken: link, newCustomerRef: customerRefFor(token), idempotencyKey: expect.stringMatching(UUID) });
    expect(JSON.stringify(redeem.mock.calls)).not.toContain(token);
    expect((await billing.balance(customerRefFor(token))).creditsRemaining).toBe(99);

    const again = await send('/v1/recover/redeem', { recoveryToken: link });
    expect(again.status).toBe(410);
    expect(JSON.stringify(await bodyOf(again))).not.toContain(token);
  });

  it('retires the old token at once: billing refuses its customerRef', async () => {
    const { send, billing, customerRef, mailedLink } = setup();
    await send('/v1/recover', { email: EMAIL });

    await send('/v1/recover/redeem', { recoveryToken: mailedLink() });

    await expect(billing.balance(customerRef)).rejects.toMatchObject({ status: 410, code: 'CUSTOMER_REVOKED' });
  });

  it('mints a different token for each redemption', async () => {
    const { send, mailedLink } = setup();
    await send('/v1/recover', { email: EMAIL });
    const first = await bodyOf(await send('/v1/recover/redeem', { recoveryToken: mailedLink() }));
    await send('/v1/recover', { email: EMAIL });

    const second = await bodyOf(await send('/v1/recover/redeem', { recoveryToken: mailedLink() }));

    expect(second['token']).not.toBe(first['token']);
    expect(second['creditsRemaining']).toBe(99);
  });

  it('answers 410 RECOVERY_LINK_INVALID for a link billing never mailed', async () => {
    const { send } = setup();

    const response = await send('/v1/recover/redeem', { recoveryToken: 'A'.repeat(43) });

    expect(response.status).toBe(410);
    expect(await bodyOf(response)).toEqual({ code: 'RECOVERY_LINK_INVALID', message: 'That link has expired or was already used.' });
  });

  it('answers 410 for a link older than 15 minutes, and moves no credits', async () => {
    const { send, clock, billing, customerRef, mailedLink } = setup();
    await send('/v1/recover', { email: EMAIL });
    const link = mailedLink();
    clock.advance(15 * 60_000);

    const response = await send('/v1/recover/redeem', { recoveryToken: link });

    expect(response.status).toBe(410);
    expect((await billing.balance(customerRef)).creditsRemaining).toBe(99);
  });

  it('answers 410 for a link a newer one voided', async () => {
    const { send, mailedLink } = setup();
    await send('/v1/recover', { email: EMAIL });
    const older = mailedLink();
    await send('/v1/recover', { email: EMAIL });

    expect((await send('/v1/recover/redeem', { recoveryToken: older })).status).toBe(410);
    expect((await send('/v1/recover/redeem', { recoveryToken: mailedLink() })).status).toBe(200);
  });

  it('answers 401 with a pointer to /recover when billing says CUSTOMER_REVOKED', async () => {
    const { send, recovery } = setup();
    vi.spyOn(recovery, 'redeem').mockRejectedValue(new BillingProblem({ status: 410, code: 'CUSTOMER_REVOKED' }));

    const response = await send('/v1/recover/redeem', { recoveryToken: 'x'.repeat(43) });

    expect(response.status).toBe(401);
    expect(await bodyOf(response)).toMatchObject({ code: 'CUSTOMER_REVOKED', recover: '/recover' });
  });

  it("passes billing's 429 on with Retry-After", async () => {
    const { send, recovery } = setup();
    vi.spyOn(recovery, 'redeem').mockRejectedValue(new BillingProblem({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 12 }));

    const response = await send('/v1/recover/redeem', { recoveryToken: 'x'.repeat(43) });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('12');
  });

  it.each([[{}], [{ recoveryToken: 5 }], [{ recoveryToken: '' }], [{ recoveryToken: 'a b' }], [{ recoveryToken: 'a'.repeat(129) }], ['not json']])(
    'answers 400 for the body %j and mints and asks nothing',
    async (body) => {
      const { send, recovery } = setup();
      const redeem = vi.spyOn(recovery, 'redeem');

      const response = await send('/v1/recover/redeem', body);

      expect(response.status).toBe(400);
      expect(redeem).not.toHaveBeenCalled();
    },
  );

  it('does not count against the per-IP request limit', async () => {
    const { send } = setup();
    for (let asked = 0; asked < 8; asked += 1) expect((await send('/v1/recover/redeem', { recoveryToken: 'A'.repeat(43) })).status).toBe(410);
  });
});

describe('GET /recover', () => {
  it('serves public/recover.html as a page that is never cached and sends no Referer', async () => {
    const { app } = setup();

    const response = await app.request('/recover');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toMatch(/^text\/html/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    expect(await response.text()).toBe(readFileSync(new URL('../public/recover.html', import.meta.url), 'utf8'));
  });
});

describe('createIpLimiter', () => {
  it('counts a request only inside its window', () => {
    const clock = createClock();
    const limiter = createIpLimiter({ requests: 2, windowMs: 10_000, now: clock.now });

    expect(limiter.check('a')).toBeUndefined();
    clock.advance(4_000);
    expect(limiter.check('a')).toBeUndefined();
    expect(limiter.check('a')).toBe(6);
    clock.advance(6_000);
    expect(limiter.check('a')).toBeUndefined();
  });

  it('forgets an address once its window has passed, so the table does not grow with the traffic', () => {
    const clock = createClock();
    const limiter = createIpLimiter({ requests: 1, windowMs: 1_000, trackedIps: 2, now: clock.now });
    limiter.check('a');
    limiter.check('b');
    clock.advance(1_000);

    expect(limiter.check('c')).toBeUndefined();
    expect(limiter.check('d')).toBeUndefined();
  });

  it('refuses a new address while the table is full of live ones, since the key comes from the caller', () => {
    const clock = createClock();
    const limiter = createIpLimiter({ requests: 1, windowMs: 60_000, trackedIps: 2, now: clock.now });
    limiter.check('a');
    limiter.check('b');

    expect(limiter.check('c')).toBe(60);
    expect(limiter.check('a')).toBe(60);
  });
});

describe('what buyers are told', () => {
  it('says it in the words the design fixes', () => {
    expect(RECOVERY_SENTENCE).toBe(
      'Keep your token secret. If you lose it, POST /v1/recover with the email you used at checkout (or open /recover), and the emailed link gives you a new token with the same credits and stops the old one. If you never bought credits you hold none: just mint a new token.',
    );
  });

  it('lists the three calls and the page for GET /', () => {
    expect(RECOVERY_ENDPOINTS.map(({ method, path, auth }) => `${method} ${path} ${auth}`)).toEqual([
      'POST /v1/recover none',
      'GET /recover none',
      'POST /v1/recover/redeem none',
    ]);
  });
});
