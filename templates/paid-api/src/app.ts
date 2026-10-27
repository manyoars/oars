import { Hono } from 'hono';
import {
  type Billing,
  BillingProblem,
  buyerResponse,
  type CallResult,
  type CheckoutUrls,
  customerRefFor,
  mintToken,
  reservationKey,
  withCredits,
} from './billing.js';
import { RECOVERY_ENDPOINTS, RECOVERY_SENTENCE, type Recovery, recoveryRoutes } from './recovery.js';
import { transform } from './transform.js';

export const CHARGING_SENTENCE =
  'You pay only for successful calls: a credit is held when your call starts, spent when it succeeds, and returned when it fails or times out.';

export interface AppOptions {
  billing: Billing;
  recovery: Recovery;
  priceRefs: string[];
  checkoutUrls: CheckoutUrls;
  now?: () => number;
  /** Handler timeout for the paid call; the default is withCredits' 30 seconds. */
  timeoutMs?: number;
}

const TOKEN_PATTERN = /^oc_[A-Za-z0-9_-]{43}$/;

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const reply = (result: CallResult): Response => {
  const headers = new Headers();
  if (result.retryAfter !== undefined) headers.set('Retry-After', String(result.retryAfter));
  if (result.creditsCharged !== undefined) headers.set('X-Credits-Charged', String(result.creditsCharged));
  return Response.json(result.body, { status: result.status, headers });
};

// The 50 states and DC, as billing's RegionPolicy takes them; a territory or military code is not a state.
const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '),
);

const invalid = (message: string): Response => reply({ status: 400, body: { code: 'INVALID_REQUEST', message } });

const unauthorized = (): Response =>
  reply({ status: 401, body: { code: 'INVALID_TOKEN', message: 'Send "Authorization: Bearer <token>". POST /v1/customers mints a token.' } });

/** The buyer's customerRef from a well-formed bearer token; the token itself goes no further. */
const customerRefOf = (authorization: string | undefined): string | undefined => {
  const token = authorization?.startsWith('Bearer ') === true ? authorization.slice('Bearer '.length) : '';
  return TOKEN_PATTERN.test(token) ? customerRefFor(token) : undefined;
};

export const createApp = (options: AppOptions): Hono => {
  const { billing } = options;
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/', (c) =>
    c.json({
      name: 'Paid API',
      description: 'A JSON API that charges per successful call through prepaid credits.',
      charging: CHARGING_SENTENCE,
      recovery: RECOVERY_SENTENCE,
      priceRefs: options.priceRefs,
      endpoints: [
        { method: 'POST', path: '/v1/customers', auth: 'none', description: 'Mint your bearer token (shown once). Body: {countryCode, regionCode (required for US: the two-letter state, DC included)}. Keep it secret.' },
        { method: 'POST', path: '/v1/credits/checkout', auth: 'bearer', description: 'Buy credits. Body: {priceRef}. Returns {checkoutUrl}.' },
        { method: 'GET', path: '/v1/credits', auth: 'bearer', description: 'Your credit balance.' },
        { method: 'POST', path: '/v1/transform', auth: 'bearer', description: 'One credit per call. Body: {text}. Send an Idempotency-Key to retry safely.' },
        ...RECOVERY_ENDPOINTS,
      ],
    }),
  );

  app.post('/v1/customers', async (c) => {
    const body = parseJson(await c.req.text());
    const countryCode = isRecord(body) ? body['countryCode'] : undefined;
    const regionCode = isRecord(body) ? body['regionCode'] : undefined;
    if (typeof countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(countryCode)) return invalid('countryCode must be a two-letter ISO country code.');
    if (regionCode !== undefined && (typeof regionCode !== 'string' || regionCode.length > 3)) return invalid('regionCode must be a short region code.');
    // Billing answers a US customer with no valid state 403 "region not supported"; say what is wrong before calling it.
    const state = typeof regionCode === 'string' ? regionCode.trim().toUpperCase() : undefined;
    if (countryCode.toUpperCase() === 'US' && (state === undefined || !US_STATES.has(state))) {
      return invalid('regionCode is required for a US customer: send the two-letter state, for example "NY".');
    }
    const token = mintToken();
    const customerRef = customerRefFor(token);
    await billing.upsertCustomer(customerRef, { countryCode: countryCode.toUpperCase(), ...(state === undefined ? {} : { regionCode: state }) });
    return reply({ status: 201, body: { token, customerRef } });
  });

  app.post('/v1/credits/checkout', async (c) => {
    const customerRef = customerRefOf(c.req.header('Authorization'));
    if (customerRef === undefined) return unauthorized();
    const body = parseJson(await c.req.text());
    const priceRef = isRecord(body) ? body['priceRef'] : undefined;
    if (typeof priceRef !== 'string' || priceRef === '') return invalid('priceRef is required.');
    return reply({ status: 200, body: await billing.checkout(customerRef, priceRef, options.checkoutUrls) });
  });

  app.get('/v1/credits', async (c) => {
    const customerRef = customerRefOf(c.req.header('Authorization'));
    if (customerRef === undefined) return unauthorized();
    return reply({ status: 200, body: await billing.balance(customerRef) });
  });

  app.post('/v1/transform', async (c) => {
    const customerRef = customerRefOf(c.req.header('Authorization'));
    if (customerRef === undefined) return unauthorized();
    const raw = await c.req.text();
    const body = parseJson(raw);
    const text = isRecord(body) ? body['text'] : undefined;
    if (typeof text !== 'string') return invalid('text must be a string.');
    const key = reservationKey(customerRef, c.req.header('Idempotency-Key'), raw);
    // The line that charges: one credit per 2xx, held first and returned on any failure.
    return reply(
      await withCredits(billing, { customerRef, key, now: options.now, timeoutMs: options.timeoutMs }, () => Promise.resolve({ status: 200, body: transform(text) })),
    );
  });

  app.route('/', recoveryRoutes({ recovery: options.recovery, now: options.now }));

  app.notFound(() => reply({ status: 404, body: { code: 'NOT_FOUND', message: 'No such endpoint. GET / lists them.' } }));

  // A billing failure reaches the buyer only through the mapping; anything else is a bare 500 with no detail.
  app.onError((error) =>
    error instanceof BillingProblem
      ? reply(buyerResponse(error))
      : reply({ status: 500, body: { code: 'INTERNAL', message: 'Something went wrong on our side. Try again.' } }),
  );

  return app;
};
