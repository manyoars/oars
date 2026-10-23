// Everything that touches money, in one file: the buyer token hash, the billing calls (through the generated client),
// withCredits (reserve, run, commit or release) and the mapping of billing's problems to what a buyer is told.
// The same file ships in every template; charge only through here.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type components, createOarsClient } from '@manyoars/oars-client';

type Schemas = components['schemas'];
export type Reservation = Schemas['ReservationView'];
export type Commit = Schemas['ReservationCommitView'];
export type Balance = Schemas['CreditBalanceView'];

const HOLD_TTL_SECONDS = 45;
const HANDLER_TIMEOUT_MS = 30_000;
const MAX_REPLAYS = 2;
const REPLAY_WINDOW_MS = 10 * 60_000;

// --- buyer identity: a random bearer token, and a customerRef that cannot be turned back into it -------------------------
export const mintToken = (): string => `oc_${randomBytes(32).toString('base64url')}`;
export const customerRefFor = (token: string): string => `cus_${createHash('sha256').update(token).digest('base64url')}`;

/** The reservation's Idempotency-Key: the same for an identical retry, new for a reused buyer key with a new body. */
export const reservationKey = (customerRef: string, buyerKey: string | undefined, body: string): string =>
  buyerKey === undefined ? randomUUID() : createHash('sha256').update(JSON.stringify([customerRef, buyerKey, body])).digest('base64url');

// --- billing problems -------------------------------------------------------------------------------------------------
// `type` supplies the code when billing sent none: the last segment of the type URI.
export interface ProblemInit { status: number; code?: string; type?: string; actionUrl?: string; retryAfterSeconds?: number; detail?: string }

export class BillingProblem extends Error {
  readonly status: number;
  readonly code: string;
  readonly actionUrl?: string;
  readonly retryAfterSeconds?: number;

  constructor(init: ProblemInit) {
    const code = init.code ?? init.type?.split('/').pop()?.toUpperCase().replaceAll('-', '_') ?? 'UNKNOWN';
    super(`billing answered ${String(init.status)} ${code}${init.detail === undefined ? '' : `: ${init.detail}`}`);
    this.status = init.status;
    this.code = code;
    this.actionUrl = init.actionUrl;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

export interface BuyerResponse {
  status: number;
  body: { code: string; message: string; checkoutUrl?: string; recover?: string };
  retryAfter?: number;
}

const BUYER_RULES = new Map<string, { status: number; message: string }>([
  ['INSUFFICIENT_CREDITS', { status: 402, message: 'Not enough credits. Buy a pack, then retry.' }],
  ['CUSTOMER_REGION_NOT_SUPPORTED', { status: 403, message: 'Purchases from your region are not supported.' }],
  ['PRICE_NOT_FOUND', { status: 400, message: 'That price does not exist.' }],
  ['PRICE_INACTIVE', { status: 400, message: 'That price is no longer on sale.' }],
  ['RATE_LIMITED', { status: 429, message: 'Too many requests. Retry after the delay in Retry-After.' }],
  ['CUSTOMER_REVOKED', { status: 401, message: 'This token has been replaced. Get a new one at the recover path to keep your credits.' }],
  ['RESERVATION_EXPIRED', { status: 503, message: 'The call took too long to settle and was not charged. Retry it.' }],
  ['RECOVERY_LINK_INVALID', { status: 410, message: 'That link has expired or was already used.' }],
]);

/** Spec 1 §13 problem type to buyer response. Unlisted codes (a suspended workload, a bad SDK key, ...) get a bare 503. */
export const buyerResponse = (problem: BillingProblem): BuyerResponse => {
  const rule = BUYER_RULES.get(problem.code);
  if (rule === undefined) return { status: 503, body: { code: 'UNAVAILABLE', message: 'This service is not available right now. Try again.' } };
  const response: BuyerResponse = { status: rule.status, body: { code: problem.code, message: rule.message } };
  if (problem.code === 'INSUFFICIENT_CREDITS' && problem.actionUrl !== undefined) response.body.checkoutUrl = problem.actionUrl;
  if (problem.code === 'CUSTOMER_REVOKED') response.body.recover = '/recover';
  if (problem.code === 'RATE_LIMITED' && problem.retryAfterSeconds !== undefined) response.retryAfter = problem.retryAfterSeconds;
  return response;
};

// --- billing calls ----------------------------------------------------------------------------------------------------
export interface Billing {
  upsertCustomer: (customerRef: string, region: { countryCode: string; regionCode?: string }) => Promise<void>;
  checkout: (customerRef: string, priceRef: string) => Promise<{ checkoutUrl: string }>;
  balance: (customerRef: string) => Promise<Balance>;
  reserve: (hold: { customerRef: string; credits: number; ttlSeconds: number; idempotencyKey: string }) => Promise<Reservation>;
  commit: (reservationId: string) => Promise<Commit>;
  release: (reservationId: string) => Promise<void>;
}

// Resolves with the data, or throws the BillingProblem billing answered (status 0 when it never answered).
const settle = async <T>(call: Promise<{ data?: T; error?: Schemas['ProblemDetail']; response: Response }>): Promise<T> => {
  let outcome;
  try {
    outcome = await call;
  } catch (error) {
    throw new BillingProblem({ status: 0, code: 'BILLING_UNREACHABLE', detail: String(error) });
  }
  if (outcome.data !== undefined) return outcome.data;
  const retryAfter = Number(outcome.response.headers.get('Retry-After'));
  throw new BillingProblem({ ...outcome.error, status: outcome.response.status, retryAfterSeconds: retryAfter > 0 ? retryAfter : undefined });
};

export const createBilling = (options: { apiUrl: string; sdkKey: string; fetch?: (request: Request) => Promise<Response> }): Billing => {
  const client = createOarsClient({ version: 'paid-api', baseUrl: options.apiUrl, fetch: options.fetch });
  // The spec declares the SDK key as a header on each call, not as a security scheme.
  const header = { 'X-Agent-SDK-Key': options.sdkKey };
  return {
    upsertCustomer: async (customerRef, region) => {
      await settle(client.POST('/billing/customers', { params: { header }, body: { customerRef, ...region } }));
    },
    checkout: async (customerRef, priceRef) => {
      const params = { header: { ...header, 'Idempotency-Key': randomUUID() } };
      const { checkoutUrl } = await settle(client.POST('/billing/charges', { params, body: { customerRef, priceRef, mode: 'CHECKOUT' } }));
      if (checkoutUrl === undefined) throw new BillingProblem({ status: 502, code: 'CHECKOUT_URL_MISSING' });
      return { checkoutUrl };
    },
    balance: (customerRef) => settle(client.GET('/billing/credits/{customerRef}', { params: { path: { customerRef }, header } })),
    reserve: ({ idempotencyKey, ...body }) =>
      settle(client.POST('/billing/credits/reservations', { params: { header: { ...header, 'Idempotency-Key': idempotencyKey } }, body })),
    commit: (reservationId) =>
      settle(client.POST('/billing/credits/reservations/{reservationId}/commit', { params: { path: { reservationId }, header } })),
    release: async (reservationId) => {
      await settle(client.POST('/billing/credits/reservations/{reservationId}/release', { params: { path: { reservationId }, header } }));
    },
  };
};

// --- withCredits: reserve one credit, run the handler, commit a 2xx or release anything else --------------------------
export interface HandlerResult { status: number; body: unknown }
/** creditsCharged is what billing committed (0 for a failure or a free replay) and absent when billing refused the call. */
export interface CallResult extends HandlerResult { retryAfter?: number; creditsCharged?: number }
/** `key` is the reservation Idempotency-Key from reservationKey(). */
export interface CreditCall { customerRef: string; key: string; now?: () => number; timeoutMs?: number }

const failure = (status: number, code: string, message: string): HandlerResult => ({ status, body: { code, message } });

const toProblem = (error: unknown): BillingProblem =>
  error instanceof BillingProblem ? error : new BillingProblem({ status: 0, code: 'BILLING_UNREACHABLE', detail: String(error) });

// Runs the handler, aborted at the timeout. A throw or a timeout becomes an error result that leaks no detail.
const run = async (handler: (signal: AbortSignal) => Promise<HandlerResult>, timeoutMs: number): Promise<HandlerResult> => {
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = new Promise<HandlerResult>((resolve) => {
    signal.addEventListener('abort', () => {
      resolve(failure(504, 'HANDLER_TIMEOUT', 'The call took too long and was not charged.'));
    });
  });
  try {
    return await Promise.race([handler(signal), timedOut]);
  } catch {
    return failure(500, 'HANDLER_FAILED', 'The call failed and was not charged.');
  }
};

/**
 * Charges one credit per 2xx. Billing replays a reservation under one key (R7): a live hold means the same call is in
 * flight (409, no handler); a committed one means a paid call whose answer may have been lost, so the handler runs
 * again free, at most twice and within ten minutes of the commit.
 */
export const withCredits = async (
  billing: Billing,
  call: CreditCall,
  handler: (signal: AbortSignal) => Promise<HandlerResult>,
): Promise<CallResult> => {
  const now = call.now ?? Date.now;
  const timeoutMs = call.timeoutMs ?? HANDLER_TIMEOUT_MS;
  let hold: Reservation;
  try {
    hold = await billing.reserve({ customerRef: call.customerRef, credits: 1, ttlSeconds: HOLD_TTL_SECONDS, idempotencyKey: call.key });
  } catch (error) {
    return buyerResponse(toProblem(error));
  }
  if (hold.replayed) {
    if (hold.status === 'HELD') {
      const seconds = Math.ceil((Date.parse(hold.expiresAt) - now()) / 1000);
      return { ...failure(409, 'REQUEST_IN_PROGRESS', 'This call is already running. Retry after the delay in Retry-After.'), retryAfter: Math.max(1, seconds) };
    }
    // `!(age <= window)` also rejects a missing or unreadable committedAt.
    const age = now() - Date.parse(hold.committedAt ?? '');
    if (hold.status !== 'COMMITTED' || hold.replayCount > MAX_REPLAYS || !(age <= REPLAY_WINDOW_MS)) {
      return failure(409, 'IDEMPOTENCY_KEY_SPENT', 'This Idempotency-Key was already used. Send a new one.');
    }
    return { ...(await run(handler, timeoutMs)), creditsCharged: 0 };
  }
  const result = await run(handler, timeoutMs);
  if (result.status < 200 || result.status >= 300) {
    try {
      await billing.release(hold.reservationId);
    } catch {
      // The hold lapses on its own and expiry releases it (R7); the handler's error still goes back.
    }
    return { ...result, creditsCharged: 0 };
  }
  try {
    const committed = await billing.commit(hold.reservationId);
    return { ...result, creditsCharged: committed.committedCredits };
  } catch (error) {
    return buyerResponse(toProblem(error));
  }
};
