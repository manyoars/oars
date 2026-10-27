// Token recovery (design 1T minimum §2.1): a buyer who lost their token asks for a link by email and trades it for a new
// token that holds the same credits. Billing owns the email, the link and the credit move; this file is the agent's side.
// The same file ships in every template.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createOarsClient } from '@manyoars/oars-client';
import { Hono } from 'hono';
import { BillingProblem, buyerResponse, customerRefFor, mintToken, settle } from './billing.js';

export interface Redemption {
  customerRef: string;
  creditsRemaining: number;
}

export interface Recovery {
  /** Asks billing to email a recovery link; billing answers the same whether or not the email holds credits. */
  request: (email: string) => Promise<void>;
  /** Trades a link token for the credits of the buyer it was mailed to, moved to `newCustomerRef`. */
  redeem: (redemption: { recoveryToken: string; newCustomerRef: string; idempotencyKey: string }) => Promise<Redemption>;
}

export const RECOVERY_SENTENCE =
  'Keep your token secret. If you lose it, POST /v1/recover with the email you used at checkout (or open /recover), and the emailed link gives you a new token with the same credits and stops the old one. If you never bought credits you hold none: just mint a new token.';

/** The calls GET / lists for recovery, after the paid ones. */
export const RECOVERY_ENDPOINTS: { method: string; path: string; auth: string; description: string }[] = [
  { method: 'POST', path: '/v1/recover', auth: 'none', description: 'Lost your token? Body: {email}, the one you used at checkout. Always answers 202; if it holds credits a link is emailed.' },
  { method: 'GET', path: '/recover', auth: 'none', description: 'The page the emailed link opens: one click trades the link for a new token with your credits.' },
  { method: 'POST', path: '/v1/recover/redeem', auth: 'none', description: 'What that page calls. Body: {recoveryToken}. Returns your new token once; the old one stops working.' },
];

// --- billing calls ----------------------------------------------------------------------------------------------------
export const createRecovery = (options: { apiUrl: string; sdkKey: string; fetch?: (request: Request) => Promise<Response> }): Recovery => {
  const client = createOarsClient({ version: 'paid-api', baseUrl: options.apiUrl, fetch: options.fetch });
  // The spec declares the SDK key as a header on each call, not as a security scheme.
  const header = { 'X-Agent-SDK-Key': options.sdkKey };
  return {
    request: async (email) => {
      await settle(client.POST('/billing/customers/recovery-requests', { params: { header }, body: { email } }));
    },
    redeem: async ({ recoveryToken, newCustomerRef, idempotencyKey }) => {
      const { customerRef, creditsRemaining } = await settle(
        client.POST('/billing/customers/recovery-redemptions', {
          params: { header: { ...header, 'Idempotency-Key': idempotencyKey } },
          body: { recoveryToken, newCustomerRef },
        }),
      );
      return { customerRef, creditsRemaining };
    },
  };
};

// --- the per-IP limit -------------------------------------------------------------------------------------------------
export interface IpLimiter {
  /** Seconds to wait when `ip` is over the limit, or undefined when the request may go on (and is counted). */
  check: (ip: string) => number | undefined;
}

/**
 * A sliding window per client address, in memory. The address comes from the caller, so the table is bounded: when it is
 * full of live addresses a new one is refused until the soonest entry expires, instead of growing without end.
 */
export const createIpLimiter = (options: { requests: number; windowMs: number; trackedIps?: number; now: () => number }): IpLimiter => {
  const { requests, windowMs, now } = options;
  const trackedIps = options.trackedIps ?? 10_000;
  const hits = new Map<string, number[]>();
  const waitFor = (oldest: number): number => Math.max(1, Math.ceil((oldest + windowMs - now()) / 1000));
  // Drops every timestamp that has left the window and every address left with none.
  const sweep = (): void => {
    for (const [ip, stamps] of hits) {
      const live = stamps.filter((at) => at > now() - windowMs);
      if (live.length === 0) hits.delete(ip);
      else hits.set(ip, live);
    }
  };

  return {
    check: (ip) => {
      if (!hits.has(ip) && hits.size >= trackedIps) {
        sweep();
        if (hits.size >= trackedIps) return waitFor(Math.min(...[...hits.values()].map(([oldest]) => oldest ?? Infinity)));
      }
      const live = (hits.get(ip) ?? []).filter((at) => at > now() - windowMs);
      const [oldest] = live;
      if (oldest !== undefined && live.length >= requests) return waitFor(oldest);
      hits.set(ip, [...live, now()]);
      return undefined;
    },
  };
};

// --- the routes -------------------------------------------------------------------------------------------------------
const REQUESTS_PER_IP_PER_MINUTE = 5;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
// What billing mails is 32 random bytes in base64url (43 characters); the bound only keeps junk away from billing.
const LINK_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const ACCEPTED_MESSAGE = 'If that email holds credits here, a link is on its way. It works once, for 15 minutes.';

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const send = (result: { status: number; body: unknown; retryAfter?: number }): Response => {
  // A recovery answer is for one buyer and may carry their new token: never cached.
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  if (result.retryAfter !== undefined) headers.set('Retry-After', String(result.retryAfter));
  return Response.json(result.body, { status: result.status, headers });
};

const invalid = (message: string): Response => send({ status: 400, body: { code: 'INVALID_REQUEST', message } });

/** A billing failure answers through the buyer mapping (a bare 503 for anything that is not the buyer's business). */
const refused = (error: unknown): Response => {
  if (!(error instanceof BillingProblem)) throw error;
  return send(buyerResponse(error));
};

export interface RecoveryRoutesOptions {
  recovery: Recovery;
  now?: () => number;
}

export const recoveryRoutes = (options: RecoveryRoutesOptions): Hono => {
  const { recovery } = options;
  const routes = new Hono();
  const limiter = createIpLimiter({ requests: REQUESTS_PER_IP_PER_MINUTE, windowMs: 60_000, now: options.now ?? Date.now });
  const page = readFileSync(new URL('../public/recover.html', import.meta.url), 'utf8');
  // The page's one inline script is the only script the browser may run, so a token shown on it cannot be read by another.
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
  const policy = [
    "default-src 'none'",
    `script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');

  routes.get('/recover', (c) =>
    c.html(page, 200, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': policy }),
  );

  routes.post('/v1/recover', async (c) => {
    // Behind the edge proxy every socket is the proxy's, so the header it sets names the client; without one, the socket does.
    const ip = c.req.header('CF-Connecting-IP') ?? getConnInfo(c).remote.address ?? 'unknown';
    const wait = limiter.check(ip);
    if (wait !== undefined) return send(buyerResponse(new BillingProblem({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: wait })));
    const body = parseJson(await c.req.text());
    const email = isRecord(body) && typeof body['email'] === 'string' ? body['email'].trim() : '';
    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) return invalid('email must be the address you used at checkout.');
    try {
      await recovery.request(email);
    } catch (error) {
      return refused(error);
    }
    // The same body whether or not the email holds credits, so this endpoint never says who has any.
    return send({ status: 202, body: { accepted: true, message: ACCEPTED_MESSAGE } });
  });

  routes.post('/v1/recover/redeem', async (c) => {
    const body = parseJson(await c.req.text());
    const recoveryToken = isRecord(body) ? body['recoveryToken'] : undefined;
    if (typeof recoveryToken !== 'string' || !LINK_PATTERN.test(recoveryToken)) return invalid('recoveryToken must be the token from the emailed link.');
    // The new token is minted here and billing gets only its hash, so billing can never spend it. A fresh key per attempt:
    // a replayed key would answer the first newCustomerRef while this attempt minted a different token.
    const token = mintToken();
    const newCustomerRef = customerRefFor(token);
    try {
      const { creditsRemaining } = await recovery.redeem({ recoveryToken, newCustomerRef, idempotencyKey: randomUUID() });
      return send({ status: 200, body: { token, customerRef: newCustomerRef, creditsRemaining } });
    } catch (error) {
      return refused(error);
    }
  });

  return routes;
};
