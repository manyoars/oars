import { afterEach, describe, expect, it, vi } from 'vitest';
import { BillingProblem, buyerResponse, checkoutUrlsFor, createBilling, customerRefFor, mintToken, reservationKey } from '../src/billing.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const CHECKOUT = 'https://checkout.example/pack/abc';

const problem = (code: string, init: { status?: number; actionUrl?: string; retryAfterSeconds?: number; detail?: string } = {}) =>
  new BillingProblem({ status: init.status ?? 409, code, ...init });

describe('customerRefFor', () => {
  it('is cus_ plus the base64url SHA-256 of the token (a known vector)', () => {
    expect(customerRefFor('oc_dGVzdC10b2tlbi1mb3Itb2Fycy1wYWlkLWFwaQ')).toBe('cus_s810oz1jvnt_V59eIqe5lSbt9Qqe_JPCuu59hMHPHes');
  });

  it('never contains the token, and differs per token', () => {
    const token = mintToken();
    const ref = customerRefFor(token);

    expect(ref).not.toContain(token);
    expect(ref).not.toContain(token.slice(3));
    expect(customerRefFor(mintToken())).not.toBe(ref);
  });
});

describe('mintToken', () => {
  it('is oc_ plus 32 random bytes as base64url, new every time', () => {
    const token = mintToken();

    expect(token).toMatch(/^oc_[A-Za-z0-9_-]{43}$/);
    expect(mintToken()).not.toBe(token);
  });
});

describe('reservationKey', () => {
  const body = '{"text":"hello"}';

  it('is the same for an identical retry', () => {
    expect(reservationKey('cus_a', 'buyer-1', body)).toBe(reservationKey('cus_a', 'buyer-1', body));
  });

  it('is SHA-256 over the customerRef, the buyer key and the body (a known vector)', () => {
    expect(reservationKey('cus_abc', 'buyer-key-1', body)).toBe('1PzlF3kXH2z0ifq5h4oM2T2v0KK0fVTIw4br3NqsfME');
  });

  it('differs when the buyer reuses a key with a new body, so the new call is not free', () => {
    expect(reservationKey('cus_a', 'buyer-1', '{"text":"other"}')).not.toBe(reservationKey('cus_a', 'buyer-1', body));
  });

  it('differs per customer and per buyer key', () => {
    const base = reservationKey('cus_a', 'buyer-1', body);

    expect(reservationKey('cus_b', 'buyer-1', body)).not.toBe(base);
    expect(reservationKey('cus_a', 'buyer-2', body)).not.toBe(base);
  });

  it('does not let a field boundary move: ("a", "bc") and ("ab", "c") are different calls', () => {
    expect(reservationKey('a', 'bc', body)).not.toBe(reservationKey('ab', 'c', body));
  });

  it('is fresh for every call when the buyer sends no key', () => {
    expect(reservationKey('cus_a', undefined, body)).not.toBe(reservationKey('cus_a', undefined, body));
  });
});

describe('buyerResponse', () => {
  it('maps INSUFFICIENT_CREDITS to 402 and passes the problem checkout URL through', () => {
    const response = buyerResponse(problem('INSUFFICIENT_CREDITS', { actionUrl: CHECKOUT }));

    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({ code: 'INSUFFICIENT_CREDITS', checkoutUrl: CHECKOUT });
  });

  it('maps INSUFFICIENT_CREDITS without a checkout URL to 402 with none', () => {
    const response = buyerResponse(problem('INSUFFICIENT_CREDITS'));

    expect(response.status).toBe(402);
    expect(JSON.stringify(response.body)).not.toContain('checkoutUrl');
  });

  it.each([
    ['CUSTOMER_REGION_NOT_SUPPORTED', 403],
    ['PRICE_NOT_FOUND', 400],
    ['PRICE_INACTIVE', 400],
    ['RECOVERY_LINK_INVALID', 410],
    ['RESERVATION_EXPIRED', 503],
  ])('maps %s to %i', (code, status) => {
    expect(buyerResponse(problem(code)).status).toBe(status);
  });

  it('maps RATE_LIMITED to 429 and carries Retry-After', () => {
    const response = buyerResponse(problem('RATE_LIMITED', { status: 429, retryAfterSeconds: 12 }));

    expect(response.status).toBe(429);
    expect(response.retryAfter).toBe(12);
  });

  it('maps CUSTOMER_REVOKED to 401 with a pointer to /recover', () => {
    const response = buyerResponse(problem('CUSTOMER_REVOKED', { status: 401 }));

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'CUSTOMER_REVOKED', recover: '/recover' });
  });

  it('reads the code from the type URI when the problem carries no code member', () => {
    const response = buyerResponse(
      new BillingProblem({ status: 409, type: 'https://api.tradeaor.com/problems/customer-region-not-supported' }),
    );

    expect(response.status).toBe(403);
  });

  it.each([
    ['BILLING_UNREACHABLE', 0],
    ['SOMETHING_NEW', 500],
    ['BAD_GATEWAY', 502],
  ])('maps %s (status %i) to a bare 503 UNAVAILABLE with no internal detail and no /recover pointer', (code, status) => {
    const response = buyerResponse(problem(code, { status, detail: 'workload w-123 is suspended for non-payment', actionUrl: CHECKOUT }));

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('UNAVAILABLE');
    const text = JSON.stringify(response.body);
    expect(text).not.toContain('recover');
    expect(text).not.toContain('w-123');
    expect(text).not.toContain(CHECKOUT);
  });

  it.each([
    ['WORKLOAD_NOT_ACTIVE', 409],
    ['SDK_KEY_INVALID', 401],
    ['ACCOUNT_NOT_READY', 409],
    ['RESERVATION_NOT_FOUND', 404],
    ['VALIDATION_ERROR', 400],
  ])('maps the unlisted 4xx %s (%i) to 502 UPSTREAM_REJECTED, logs it, and leaks no detail', (code, status) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const response = buyerResponse(problem(code, { status, detail: 'workload w-123 is suspended for non-payment', actionUrl: CHECKOUT }));

    expect(response.status).toBe(502);
    expect(response.body.code).toBe('UPSTREAM_REJECTED');
    const text = JSON.stringify(response.body);
    expect(text).not.toContain('recover');
    expect(text).not.toContain('w-123');
    expect(text).not.toContain(CHECKOUT);
    expect(warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'billing-rejected', status, code, detail: 'workload w-123 is suspended for non-payment' }));
  });

  it.each([
    ['BILLING_UNREACHABLE', 0],
    ['SOMETHING_NEW', 500],
    ['BAD_GATEWAY', 502],
  ])('logs the code and status of %s (status %i) when it hides it as a bare 503, and nothing else', (code, status) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    buyerResponse(problem(code, { status, detail: 'connect ECONNREFUSED 10.0.0.7', actionUrl: CHECKOUT }));

    expect(warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'billing-unavailable', status, code }));
  });

  it('logs nothing for a listed code', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    buyerResponse(problem('PRICE_NOT_FOUND', { status: 404 }));

    expect(warn).not.toHaveBeenCalled();
  });

  it('points only CUSTOMER_REVOKED at /recover', () => {
    const codes = [
      'INSUFFICIENT_CREDITS',
      'CUSTOMER_REGION_NOT_SUPPORTED',
      'PRICE_NOT_FOUND',
      'PRICE_INACTIVE',
      'RATE_LIMITED',
      'RESERVATION_EXPIRED',
      'RECOVERY_LINK_INVALID',
      'WORKLOAD_NOT_ACTIVE',
      'SDK_KEY_INVALID',
      'ACCOUNT_NOT_READY',
      'UNKNOWN',
    ];

    const pointing = codes.filter((code) => JSON.stringify(buyerResponse(problem(code)).body).includes('/recover'));

    expect(pointing).toEqual([]);
  });

  it('answers a billing call that never got a response (network failure) with a bare 503', () => {
    const response = buyerResponse(new BillingProblem({ status: 0, code: 'BILLING_UNREACHABLE', detail: 'connect ECONNREFUSED 10.0.0.1:443' }));

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain('10.0.0.1');
  });
});

describe('checkoutUrlsFor', () => {
  it('builds both URLs from the configured public URL', () => {
    expect(checkoutUrlsFor('https://agent.example')).toEqual({
      successUrl: 'https://agent.example/?checkout=success',
      cancelUrl: 'https://agent.example/?checkout=cancel',
    });
  });
});

describe('createBilling checkout', () => {
  it('sends successUrl and cancelUrl with the CHECKOUT charge', async () => {
    const bodies: unknown[] = [];
    const billing = createBilling({
      apiUrl: 'https://billing.test',
      sdkKey: 'aorsk_test',
      fetch: async (request) => {
        bodies.push(await request.json());
        return Response.json({ checkoutUrl: CHECKOUT });
      },
    });

    const result = await billing.checkout('cus_a', 'calls-100', { successUrl: 'https://agent.test/?checkout=success', cancelUrl: 'https://agent.test/?checkout=cancel' });

    expect(result).toEqual({ checkoutUrl: CHECKOUT });
    expect(bodies).toEqual([
      { customerRef: 'cus_a', priceRef: 'calls-100', mode: 'CHECKOUT', successUrl: 'https://agent.test/?checkout=success', cancelUrl: 'https://agent.test/?checkout=cancel' },
    ]);
  });
});
