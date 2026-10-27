// Token recovery (design 1T minimum §2.1): a buyer who lost their token asks for a link by email and trades it for a new
// token that holds the same credits. Billing owns the email, the link and the credit move; this file is the agent's side.
// The same file ships in every template.
import { Hono } from 'hono';

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

export const RECOVERY_SENTENCE = '';

export const RECOVERY_ENDPOINTS: { method: string; path: string; auth: string; description: string }[] = [];

export interface IpLimiter {
  /** Seconds to wait when `ip` is over the limit, or undefined when the request may go on (and is counted). */
  check: (ip: string) => number | undefined;
}

export const createIpLimiter = (_options: { requests: number; windowMs: number; trackedIps?: number; now: () => number }): IpLimiter => ({
  check: () => undefined,
});

export interface RecoveryRoutesOptions {
  recovery: Recovery;
  now?: () => number;
  /** The page `GET /recover` serves; the default is public/recover.html. */
  page?: string;
}

export const recoveryRoutes = (_options: RecoveryRoutesOptions): Hono => new Hono();
