// Token recovery on the e2e stack (design 1T minimum §6, slice 10's e2e line): a buyer who holds credits loses their token, asks
// for a link at /recover, reads the email from the stack's mail catcher, redeems the link, and ends up with a new token that
// holds the old token's credits, while the old token answers 401 CUSTOMER_REVOKED.
//
// Not a `.test.ts` on purpose: the monorepo's root run and `npm run test:monorepo` skip it, as they skip the container smoke
// test. It needs the aor-platform e2e stack (billing, the notification service and Mailpit) and this template running against it
// with the workload's SDK key, in non-dev mode, with its public URL registered as the template's address. The buyer is set up
// by hand: one `calls-100` test-mode purchase made with a token and an email. Then
//   OARS_E2E_BUYER_TOKEN=<that token> OARS_E2E_BUYER_EMAIL=<that email> npm run test:e2e -w templates/paid-api
// OARS_E2E_AGENT_URL (default http://127.0.0.1:8090) is the template, OARS_E2E_MAIL_URL (default http://127.0.0.1:8025) is
// Mailpit. Without a stack it fails at its first request, naming the address it could not reach; it never skips. A token is
// never printed. The link's expiry (15 minutes) and billing's 3-requests-an-hour limit are not exercised: each would spend the
// buyer's email for the rest of the hour or wait out the clock.
import { beforeAll, describe, expect, it } from 'vitest';

const agentUrl = process.env['OARS_E2E_AGENT_URL'] ?? 'http://127.0.0.1:8090';
const mailUrl = process.env['OARS_E2E_MAIL_URL'] ?? 'http://127.0.0.1:8025';

const REQUEST_TIMEOUT_MS = 15_000;
const MAIL_TIMEOUT_MS = 90_000;

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const reasonOf = (error: unknown): string => {
  const cause = error instanceof Error ? error.cause : undefined;
  if (isRecord(cause) && typeof cause['code'] === 'string') return cause['code'];
  return error instanceof Error ? error.message : 'unknown error';
};

/** Every request of this file goes through here, so a stack that is down reads as that and not as a timeout. */
const reach = async (url: string, init: RequestInit = {}): Promise<Response> => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`stack not reachable: ${url} (${reasonOf(error)}). Start the e2e stack and the template against it first; see the top of recovery-e2e.spec.ts.`, { cause: error });
  }
};

const json = async (response: Response): Promise<{ [key: string]: unknown }> => {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('expected a JSON object');
  return body;
};

const required = (name: string): string => {
  const value = process.env[name]?.trim() ?? '';
  if (value === '') throw new Error(`Set ${name}: the buyer's ${name === 'OARS_E2E_BUYER_TOKEN' ? 'old bearer token (oc_...), from a calls-100 test purchase' : 'checkout email'}.`);
  return value;
};

const bearer = (token: string): { Authorization: string } => ({ Authorization: `Bearer ${token}` });

const post = (path: string, body: unknown): Promise<Response> => reach(`${agentUrl}${path}`, { method: 'POST', body: JSON.stringify(body) });

const credits = (token: string): Promise<Response> => reach(`${agentUrl}/v1/credits`, { headers: bearer(token) });

const balanceOf = async (token: string): Promise<number> => {
  const response = await credits(token);
  expect(response.status, 'GET /v1/credits').toBe(200);
  const { creditsRemaining } = await json(response);
  if (typeof creditsRemaining !== 'number') throw new Error('GET /v1/credits returned no creditsRemaining');
  return creditsRemaining;
};

// --- Mailpit ----------------------------------------------------------------------------------------------------------
/** The ids of the messages in the mail catcher addressed to `email`, newest first. */
const mailIdsTo = async (email: string): Promise<string[]> => {
  const response = await reach(`${mailUrl}/api/v1/messages?limit=100`);
  expect(response.status, 'Mailpit GET /api/v1/messages').toBe(200);
  const { messages } = await json(response);
  if (!Array.isArray(messages)) throw new Error('Mailpit returned no messages list');
  const ids: string[] = [];
  for (const message of messages as unknown[]) {
    if (!isRecord(message) || typeof message['ID'] !== 'string') continue;
    const recipients: unknown = message['To'];
    const addressed = Array.isArray(recipients) && recipients.some((to) => isRecord(to) && String(to['Address']).toLowerCase() === email.toLowerCase());
    if (addressed) ids.push(message['ID']);
  }
  return ids;
};

const LINK = /\/recover#([A-Za-z0-9_-]{1,128})/;

/** The link token in the first mail to `email` that was not there before the request. Waits: billing mails through Kafka. */
const linkTokenAfter = async (email: string, seen: ReadonlySet<string>): Promise<string> => {
  const deadline = Date.now() + MAIL_TIMEOUT_MS;
  for (;;) {
    const fresh = (await mailIdsTo(email)).filter((id) => !seen.has(id));
    for (const id of fresh) {
      const mail = await json(await reach(`${mailUrl}/api/v1/message/${id}`));
      const found = LINK.exec(`${String(mail['Text'])}\n${String(mail['HTML'])}`)?.[1];
      if (found !== undefined) return found;
    }
    if (Date.now() > deadline) throw new Error(`no recovery mail with a /recover# link reached Mailpit for the buyer's email within ${String(MAIL_TIMEOUT_MS)} ms (${String(fresh.length)} new mails)`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

describe('token recovery on the e2e stack', () => {
  beforeAll(async () => {
    // The first requests: the template, then the mail catcher. Neither needs the buyer yet.
    expect((await reach(`${agentUrl}/healthz`)).status, `${agentUrl}/healthz`).toBe(200);
    expect((await reach(`${mailUrl}/api/v1/info`)).status, `${mailUrl}/api/v1/info`).toBe(200);
  });

  it('moves a buyer\'s credits to a new token from the emailed link and stops the old token', async () => {
    const oldToken = required('OARS_E2E_BUYER_TOKEN');
    const email = required('OARS_E2E_BUYER_EMAIL');
    const before = await balanceOf(oldToken);
    expect(before, 'the old token holds credits (buy calls-100 first)').toBeGreaterThan(0);

    const seen = new Set(await mailIdsTo(email));
    const requested = await post('/v1/recover', { email });
    expect(requested.status, 'POST /v1/recover').toBe(202);
    const linkToken = await linkTokenAfter(email, seen);

    const redeemed = await post('/v1/recover/redeem', { recoveryToken: linkToken });
    expect(redeemed.status, 'POST /v1/recover/redeem').toBe(200);
    const { token: newToken, creditsRemaining } = await json(redeemed);
    if (typeof newToken !== 'string') throw new Error('the redemption returned no token');
    expect(creditsRemaining, 'the redemption reports the moved credits').toBe(before);

    const after = await balanceOf(newToken);
    console.info(`recovery e2e: old token balance ${String(before)}, new token balance ${String(after)}`);
    expect(after, 'the new token holds the old token\'s credits').toBe(before);

    const revoked = await credits(oldToken);
    expect(revoked.status, 'the old token').toBe(401);
    const problem = await json(revoked);
    expect(problem['code']).toBe('CUSTOMER_REVOKED');
    expect(problem['recover']).toBe('/recover');

    // The link is single use.
    const again = await post('/v1/recover/redeem', { recoveryToken: linkToken });
    expect(again.status, 'the link\'s second use').toBe(410);
    expect((await json(again))['code']).toBe('RECOVERY_LINK_INVALID');
  }, 150_000);
});
