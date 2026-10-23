import { Hono } from 'hono';
import { type Audit, auditPage } from './audit.js';
import {
  type Billing,
  BillingProblem,
  buyerResponse,
  type CallResult,
  customerRefFor,
  type HandlerResult,
  mintToken,
  reservationKey,
  withCredits,
} from './billing.js';
import { FetchFailed, type FetchFailedCode, FetchRefused, type FetchRefusedCode, type Page } from './fetch-page.js';
import type { Summarizer } from './summary.js';

export const CHARGING_SENTENCE =
  'You pay only for successful calls: a credit is held when your call starts, spent when it succeeds, and returned when it fails or times out.';

/** The hold outlasts the task budget, so a task that runs to its limit is still settled before the hold lapses. */
export const HOLD_TTL_SECONDS = 60;
/** Well inside the edge proxy's idle limit, since the request is synchronous. */
export const TASK_BUDGET_MS = 45_000;
const SUMMARY_BUDGET_MS = 15_000;

/** What the agent's log gets for a task that failed: the cause stays here and never reaches the buyer. */
export interface TaskLogEntry { event: 'task-failed'; code: string; cause: string }

export interface AppOptions {
  billing: Billing;
  priceRefs: string[];
  now?: () => number;
  fetchPage: (url: string, signal: AbortSignal) => Promise<Page>;
  /** Present only when the developer set ANTHROPIC_API_KEY. */
  summarize?: Summarizer;
  taskBudgetMs?: number;
  /** The model call's own budget, inside the task budget. */
  summaryBudgetMs?: number;
  log?: (entry: TaskLogEntry) => void;
}

// What a buyer is told when the page could not be fetched; the guard's own message (it can name an address) stays in the log.
const FETCH_ANSWERS = new Map<FetchRefusedCode | FetchFailedCode, { status: number; code: string; message: string }>([
  ['URL_NOT_ALLOWED', { status: 422, code: 'URL_NOT_ALLOWED', message: 'That address cannot be audited. Send a public http or https page.' }],
  ['TOO_MANY_REDIRECTS', { status: 422, code: 'TOO_MANY_REDIRECTS', message: 'The page redirected too many times.' }],
  ['UNREACHABLE', { status: 502, code: 'PAGE_UNREACHABLE', message: 'The page could not be reached.' }],
  ['PAGE_TOO_LARGE', { status: 422, code: 'PAGE_TOO_LARGE', message: 'The page is too large to audit.' }],
  ['TIMED_OUT', { status: 504, code: 'HANDLER_TIMEOUT', message: 'The task took too long and was not charged.' }],
]);

const TOKEN_PATTERN = /^oc_[A-Za-z0-9_-]{43}$/;

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const isWebUrl = (value: string): boolean => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol);

const isHtml = (contentType: string): boolean => {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === '' || type === 'text/html' || type === 'application/xhtml+xml';
};

const reply = (result: CallResult): Response => {
  const headers = new Headers();
  if (result.retryAfter !== undefined) headers.set('Retry-After', String(result.retryAfter));
  if (result.creditsCharged !== undefined) headers.set('X-Credits-Charged', String(result.creditsCharged));
  return Response.json(result.body, { status: result.status, headers });
};

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
      name: 'Per-task agent',
      description: 'A job that audits a landing page and charges per finished task through prepaid credits.',
      charging: CHARGING_SENTENCE,
      priceRefs: options.priceRefs,
      endpoints: [
        { method: 'POST', path: '/v1/customers', auth: 'none', description: 'Mint your bearer token (shown once). Body: {countryCode, regionCode?}. Keep it secret.' },
        { method: 'POST', path: '/v1/credits/checkout', auth: 'bearer', description: 'Buy credits. Body: {priceRef}. Returns {checkoutUrl}.' },
        { method: 'GET', path: '/v1/credits', auth: 'bearer', description: 'Your credit balance.' },
        { method: 'POST', path: '/v1/tasks', auth: 'bearer', description: 'One credit per finished task. Body: {url}. Audits the page and returns the findings. Send an Idempotency-Key to retry safely.' },
      ],
    }),
  );

  app.post('/v1/customers', async (c) => {
    const body = parseJson(await c.req.text());
    const countryCode = isRecord(body) ? body['countryCode'] : undefined;
    const regionCode = isRecord(body) ? body['regionCode'] : undefined;
    if (typeof countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(countryCode)) return invalid('countryCode must be a two-letter ISO country code.');
    if (regionCode !== undefined && (typeof regionCode !== 'string' || regionCode.length > 3)) return invalid('regionCode must be a short region code.');
    const token = mintToken();
    const customerRef = customerRefFor(token);
    await billing.upsertCustomer(customerRef, { countryCode: countryCode.toUpperCase(), ...(regionCode === undefined ? {} : { regionCode }) });
    return reply({ status: 201, body: { token, customerRef } });
  });

  app.post('/v1/credits/checkout', async (c) => {
    const customerRef = customerRefOf(c.req.header('Authorization'));
    if (customerRef === undefined) return unauthorized();
    const body = parseJson(await c.req.text());
    const priceRef = isRecord(body) ? body['priceRef'] : undefined;
    if (typeof priceRef !== 'string' || priceRef === '') return invalid('priceRef is required.');
    return reply({ status: 200, body: await billing.checkout(customerRef, priceRef) });
  });

  app.get('/v1/credits', async (c) => {
    const customerRef = customerRefOf(c.req.header('Authorization'));
    if (customerRef === undefined) return unauthorized();
    return reply({ status: 200, body: await billing.balance(customerRef) });
  });

  // A failed task: logged with its cause, answered with a fixed message. withCredits releases the hold on any non-2xx.
  const failed = (status: number, code: string, message: string, cause: unknown): HandlerResult => {
    options.log?.({ event: 'task-failed', code, cause: String(cause) });
    return { status, body: { code, message } };
  };

  // The handler to replace: fetch the page, audit it, and (with a key) have a model summarize the audit.
  const task = async (url: string, signal: AbortSignal): Promise<HandlerResult> => {
    let page: Page;
    try {
      page = await options.fetchPage(url, signal);
    } catch (error) {
      const answer = error instanceof FetchRefused || error instanceof FetchFailed ? FETCH_ANSWERS.get(error.code) : undefined;
      return answer === undefined
        ? failed(500, 'HANDLER_FAILED', 'The task failed and was not charged.', error)
        : failed(answer.status, answer.code, answer.message, error);
    }
    if (page.status < 200 || page.status >= 300) {
      return failed(422, 'PAGE_NOT_AUDITABLE', 'The page answered with an error, so there was nothing to audit.', `status ${String(page.status)}`);
    }
    if (!isHtml(page.contentType)) return failed(422, 'NOT_HTML', 'The address is not an HTML page.', page.contentType);
    const audit = auditPage({ requestedUrl: url, finalUrl: page.finalUrl, html: page.html, bytes: page.bytes, responseTimeMs: page.elapsedMs });
    if (options.summarize === undefined) return { status: 200, body: audit };
    // A buyer pays for the whole result, so a model that fails fails the task and the credit goes back.
    let summary: string;
    try {
      summary = await options.summarize(audit, AbortSignal.any([signal, AbortSignal.timeout(options.summaryBudgetMs ?? SUMMARY_BUDGET_MS)]));
    } catch (error) {
      return failed(502, 'SUMMARY_FAILED', 'The summary could not be written and the task was not charged. Retry it.', error);
    }
    const body: Audit & { summary: string } = { ...audit, summary };
    return { status: 200, body };
  };

  app.post('/v1/tasks', async (c) => {
    const customerRef = customerRefOf(c.req.header('Authorization'));
    if (customerRef === undefined) return unauthorized();
    const raw = await c.req.text();
    const body = parseJson(raw);
    const url = isRecord(body) ? body['url'] : undefined;
    if (typeof url !== 'string' || !isWebUrl(url)) return invalid('url must be an http or https address.');
    const key = reservationKey(customerRef, c.req.header('Idempotency-Key'), raw);
    // The line that charges: one credit per finished task, held first and returned on any failure.
    const call = { customerRef, key, now: options.now, timeoutMs: options.taskBudgetMs ?? TASK_BUDGET_MS, ttlSeconds: HOLD_TTL_SECONDS };
    return reply(await withCredits(billing, call, (signal) => task(url, signal)));
  });

  app.notFound(() => reply({ status: 404, body: { code: 'NOT_FOUND', message: 'No such endpoint. GET / lists them.' } }));

  // A billing failure reaches the buyer only through the mapping; anything else is a bare 500 with no detail.
  app.onError((error) =>
    error instanceof BillingProblem
      ? reply(buyerResponse(error))
      : reply({ status: 500, body: { code: 'INTERNAL', message: 'Something went wrong on our side. Try again.' } }),
  );

  return app;
};
