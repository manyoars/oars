import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { ExitCode } from './errors.js';
import { LAUNCH_FLAG_URL } from './issuer.js';
import { stepKey } from './journal.js';
import { API, harness, server, useServer } from './test-support.js';

useServer();

const AGENT = '8a2f6a0e-3c1d-4b57-9d7e-0c5b2f4e6a11';
const SETUP_URL = 'https://app.test/purchasing/setup/abc';
const APPROVAL_URL = 'https://app.test/purchasing/approve/xyz';
const problemJson = { 'Content-Type': 'application/problem+json' };

interface Seen {
  method: string;
  path: string;
  body: unknown;
  key: string | null;
  authorization: string | null;
}

// Answers one route and records what the CLI sent to it.
const route = (method: 'get' | 'post' | 'put', path: string, answer: () => Response) => {
  const seen: Seen[] = [];
  server.use(
    http[method](`${API}${path}`, async ({ request }) => {
      const text = await request.text();
      const body: unknown = text === '' ? null : JSON.parse(text);
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body,
        key: request.headers.get('Idempotency-Key'),
        authorization: request.headers.get('Authorization'),
      });
      return answer();
    }),
  );
  return seen;
};

const PAYMENT_METHOD = '/billing/purchasing/payment-method';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const view = (fields: object) => ({ createdAt: '2026-10-23T00:00:00Z', ...fields });

// The command reads the card first (GET), then starts a setup (POST) only when no card is active.
const cardRead = (answer: () => Response) => route('get', PAYMENT_METHOD, answer);
const noCard = () => cardRead(() => HttpResponse.json({ code: 'PURCHASING_METHOD_NOT_FOUND', title: 'No card' }, { status: 404, headers: problemJson }));
const cardStart = (fields: object) => route('post', PAYMENT_METHOD, () => HttpResponse.json(view(fields)));
const cap = (fields: object) => route('put', `/billing/agents/${AGENT}/purchasing`, () => HttpResponse.json({ workloadId: AGENT, ...fields }));

describe('oars purchasing card', () => {
  it('--mode TEST with no card starts a setup and prints the setup URL, exit 6 (a person saves the card)', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    const read = noCard();
    const seen = cardStart({ mode: 'TEST', status: 'PENDING', setupUrl: SETUP_URL, setupExpiresAt: '2026-10-23T01:00:00Z' });

    expect(await run(['purchasing', 'card', '--mode', 'TEST'], h.deps)).toBe(ExitCode.HUMAN);

    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ method: 'GET', path: PAYMENT_METHOD, authorization: 'Bearer key-123' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', path: PAYMENT_METHOD, body: { mode: 'TEST' }, authorization: 'Bearer key-123' });
    expect(seen[0]?.key).toMatch(UUID);
    expect(h.err.join('')).toContain('Needs you: open https://app.test/purchasing/setup/abc');
    expect(h.out).toEqual([]);
  });

  it('reads the card of the mode asked: GET ?mode=LIVE', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    let query = '';
    server.use(
      http.get(`${API}${PAYMENT_METHOD}`, ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json({ code: 'PURCHASING_METHOD_NOT_FOUND', title: 'No card' }, { status: 404, headers: problemJson });
      }),
    );
    cardStart({ mode: 'LIVE', status: 'PENDING', setupUrl: SETUP_URL });

    await run(['purchasing', 'card', '--mode', 'live'], h.deps);

    expect(query).toBe('?mode=LIVE');
  });

  it('--json prints the failure document with the URL as problem.actionUrl on stdout', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    noCard();
    cardStart({ mode: 'LIVE', status: 'PENDING', setupUrl: SETUP_URL });

    expect(await run(['purchasing', 'card', '--mode', 'live', '--json'], h.deps)).toBe(ExitCode.HUMAN);

    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] ?? '')).toMatchObject({ ok: false, step: 'purchasing-card', problem: { actionUrl: SETUP_URL } });
    expect(h.err).toEqual([]);
  });

  it('an active card is nothing to do: exit 0, its brand and last four, and no POST', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    cardRead(() => HttpResponse.json(view({ mode: 'TEST', status: 'ACTIVE', brand: 'visa', last4: '4242' })));
    const started = cardStart({ mode: 'TEST', status: 'PENDING', setupUrl: SETUP_URL });

    expect(await run(['purchasing', 'card', '--mode', 'TEST', '--json'], h.deps)).toBe(ExitCode.OK);

    expect(JSON.parse(h.out[0] ?? '')).toEqual({ ok: true, mode: 'TEST', status: 'ACTIVE', brand: 'visa', last4: '4242' });
    expect(started).toEqual([]);
  });

  it('an active card prints a sentence for a person', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    cardRead(() => HttpResponse.json(view({ mode: 'TEST', status: 'ACTIVE', brand: 'visa', last4: '4242' })));

    expect(await run(['purchasing', 'card', '--mode', 'TEST'], h.deps)).toBe(ExitCode.OK);

    expect(h.out.join('')).toBe('TEST purchasing card: visa ending 4242 is saved.\n');
  });

  it('an active card without a brand or last four still reads as saved', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    cardRead(() => HttpResponse.json(view({ mode: 'TEST', status: 'ACTIVE' })));

    expect(await run(['purchasing', 'card', '--mode', 'TEST'], h.deps)).toBe(ExitCode.OK);

    expect(h.out.join('')).toBe('TEST purchasing card: a card ending ???? is saved.\n');
  });

  it('a setup still pending (a person has not saved the card yet) starts via POST and prints its URL, exit 6', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    cardRead(() => HttpResponse.json(view({ mode: 'TEST', status: 'PENDING', setupUrl: SETUP_URL })));
    const started = cardStart({ mode: 'TEST', status: 'PENDING', setupUrl: SETUP_URL });

    expect(await run(['purchasing', 'card', '--mode', 'TEST'], h.deps)).toBe(ExitCode.HUMAN);

    expect(started).toHaveLength(1);
    expect(h.err.join('')).toContain(SETUP_URL);
  });

  it('a card the platform refused (no setup URL) exits 4 and names why', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    noCard();
    cardStart({ mode: 'TEST', status: 'DETACHED', failureCode: 'CUSTOMER_REGION_NOT_SUPPORTED' });

    expect(await run(['purchasing', 'card', '--mode', 'TEST'], h.deps)).toBe(ExitCode.INVALID);

    expect(h.err.join('')).toContain('CUSTOMER_REGION_NOT_SUPPORTED');
  });

  it('a card with no setup URL and no failure code names its status', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    noCard();
    cardStart({ mode: 'TEST', status: 'REPLACED' });

    expect(await run(['purchasing', 'card', '--mode', 'TEST'], h.deps)).toBe(ExitCode.INVALID);

    expect(h.err.join('')).toContain('REPLACED');
  });

  it('without --mode is a usage error, exit 2, from the parser', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });

    expect(await run(['purchasing', 'card'], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toContain("required option '--mode <mode>' not specified");
  });

  it('a mode that is neither TEST nor LIVE is a usage error, exit 2', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });

    expect(await run(['purchasing', 'card', '--mode', 'staging'], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toContain('TEST or LIVE');
  });
});

describe('oars purchasing cap', () => {
  it('a new or higher cap is PROPOSED: it prints the approval URL and exits 6', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    const seen = cap({ mode: 'TEST', status: 'PROPOSED', monthlyCapUsd: '0.0000', proposedCapUsd: '100.0000', approvalUrl: APPROVAL_URL, proposalExpiresAt: '2026-10-30T00:00:00Z' });

    expect(await run(['purchasing', 'cap', AGENT, '--mode', 'TEST', '--usd', '100', '--idempotency-key', 'K'], h.deps)).toBe(ExitCode.HUMAN);

    expect(seen).toEqual([
      { method: 'PUT', path: `/billing/agents/${AGENT}/purchasing`, body: { mode: 'TEST', monthlyCapUsd: '100' }, key: stepKey('K', 'purchasing-cap'), authorization: 'Bearer key-123' },
    ]);
    expect(h.err.join('')).toContain('Needs you: open https://app.test/purchasing/approve/xyz');
    expect(h.err.join('')).toContain('Approve a TEST purchasing cap of $100.00 a month');
  });

  it('--json on a proposal carries the approval URL in problem.actionUrl', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    cap({ mode: 'TEST', status: 'PROPOSED', monthlyCapUsd: '0.0000', proposedCapUsd: '100.0000', approvalUrl: APPROVAL_URL });

    expect(await run(['purchasing', 'cap', AGENT, '--mode', 'TEST', '--usd', '100.00', '--json'], h.deps)).toBe(ExitCode.HUMAN);

    expect(JSON.parse(h.out[0] ?? '')).toMatchObject({ ok: false, step: 'purchasing-cap', problem: { actionUrl: APPROVAL_URL } });
  });

  it('a lower cap applies at once: exit 0 and the new cap', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    cap({ mode: 'TEST', status: 'ACTIVE', monthlyCapUsd: '20.0000' });

    expect(await run(['purchasing', 'cap', AGENT, '--mode', 'TEST', '--usd', '20', '--json'], h.deps)).toBe(ExitCode.OK);

    expect(JSON.parse(h.out[0] ?? '')).toEqual({ ok: true, workloadId: AGENT, mode: 'TEST', status: 'ACTIVE', monthlyCapUsd: '20.0000' });
  });

  it('an applied cap prints a sentence for a person', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    cap({ mode: 'TEST', status: 'ACTIVE', monthlyCapUsd: '20.0000' });

    await run(['purchasing', 'cap', AGENT, '--mode', 'TEST', '--usd', '20'], h.deps);

    expect(h.out.join('')).toBe('TEST purchasing cap for 8a2f6a0e-3c1d-4b57-9d7e-0c5b2f4e6a11: $20.00 a month, in force now.\n');
  });

  it('a cap of 0 turns purchasing off at once and says so', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    const seen = cap({ mode: 'LIVE', status: 'OFF', monthlyCapUsd: '0.0000' });

    expect(await run(['purchasing', 'cap', AGENT, '--mode', 'LIVE', '--usd', '0'], h.deps)).toBe(ExitCode.OK);

    expect(seen[0]?.body).toEqual({ mode: 'LIVE', monthlyCapUsd: '0' });
    expect(h.out.join('')).toBe('LIVE purchasing for 8a2f6a0e-3c1d-4b57-9d7e-0c5b2f4e6a11 is off.\n');
  });

  it('a replayed proposal has no URL: exit 6 and the way to a fresh link', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    cap({ mode: 'TEST', status: 'PROPOSED', monthlyCapUsd: '0.0000', proposedCapUsd: '100.0000' });

    expect(await run(['purchasing', 'cap', AGENT, '--mode', 'TEST', '--usd', '100', '--idempotency-key', 'K'], h.deps)).toBe(ExitCode.HUMAN);

    expect(h.err.join('')).toContain('This key already proposed this cap and the first run showed its link; pass a new --idempotency-key to get the current state or a fresh link.');
  });

  it.each(['abc', '-5', '1.234', '', '1e3'])('--usd %j is a usage error, exit 2', async (usd) => {
    const h = harness({ OARS_API_KEY: 'key-123' });

    expect(await run(['purchasing', 'cap', AGENT, '--mode', 'TEST', '--usd', usd], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toContain('whole cents');
  });

  it('without --usd is a usage error, exit 2', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });

    expect(await run(['purchasing', 'cap', AGENT, '--mode', 'TEST'], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toContain("required option '--usd <amount>' not specified");
  });

  it("another developer's agent: the platform's 403 is exit 3, as for every command", async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    route('put', `/billing/agents/${AGENT}/purchasing`, () => HttpResponse.json({ code: 'WORKLOAD_NOT_OWNED', title: 'Not your agent' }, { status: 403, headers: problemJson }));

    expect(await run(['purchasing', 'cap', AGENT, '--mode', 'TEST', '--usd', '5'], h.deps)).toBe(ExitCode.AUTH);
  });
});

describe('oars purchasing list', () => {
  const FIRST = 'aaaaaaaa-0000-4000-8000-000000000001';
  const SECOND = 'aaaaaaaa-0000-4000-8000-000000000002';
  const item = (purchaseId: string, status: string) => ({
    purchaseId,
    status,
    priceRef: 'pack-500',
    packName: '500 credits',
    credits: 500,
    amountUsd: '5.0000',
    livemode: false,
    sellerSlug: 'acme',
    sellerWorkloadId: '11111111-2222-4333-8444-555555555555',
    createdAt: '2026-10-22T12:00:00Z',
  });
  const listing = (content: object[]): void => {
    server.use(http.get(`${API}/billing/agents/${AGENT}/purchases`, () => HttpResponse.json({ content, last: true })));
  };

  it('lists the agent purchases through GET /billing/agents/{id}/purchases, following the pages', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    const seen: string[] = [];
    server.use(
      http.get(`${API}/billing/agents/${AGENT}/purchases`, ({ request }) => {
        const url = new URL(request.url);
        seen.push(url.search);
        return HttpResponse.json(url.searchParams.get('page') === '0' ? { content: [item(FIRST, 'SUCCEEDED')], last: false } : { content: [item(SECOND, 'FAILED')], last: true });
      }),
    );

    expect(await run(['purchasing', 'list', AGENT, '--json'], h.deps)).toBe(ExitCode.OK);

    expect(seen).toEqual(['?page=0&size=100', '?page=1&size=100']);
    const document: unknown = JSON.parse(h.out[0] ?? '');
    expect(document).toMatchObject({ ok: true, purchases: [{ purchaseId: FIRST }, { purchaseId: SECOND }] });
  });

  it('prints one line per purchase for a person', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    listing([item(FIRST, 'SUCCEEDED')]);

    expect(await run(['purchasing', 'list', AGENT], h.deps)).toBe(ExitCode.OK);

    expect(h.out.join('')).toBe(`${FIRST}  SUCCEEDED  $5.00  500 credits  acme  pack-500  TEST  2026-10-22T12:00:00Z\n`);
  });

  it('says so when the agent has bought nothing', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    listing([]);

    expect(await run(['purchasing', 'list', AGENT], h.deps)).toBe(ExitCode.OK);

    expect(h.out.join('')).toBe('This agent has made no purchases.\n');
  });

  it('shows the failure code of a failed purchase and the LIVE mode', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    listing([{ ...item(FIRST, 'FAILED'), failureCode: 'PURCHASE_DECLINED', livemode: true }]);

    await run(['purchasing', 'list', AGENT], h.deps);

    expect(h.out.join('')).toContain('FAILED (PURCHASE_DECLINED)');
    expect(h.out.join('')).toContain('  LIVE  ');
  });
});

describe('oars purchasing is closed until t465 opens it (V13: nothing is sold before business verification)', () => {
  it('is not listed in oars --help', async () => {
    const h = harness();
    await expect(run(['--help'], h.deps)).resolves.toBe(ExitCode.OK);
    expect(h.out.join('')).toContain('templates');
    expect(h.out.join('')).not.toContain('purchasing');
  });

  it.each([[], ['card', '--mode', 'TEST'], ['cap', AGENT, '--mode', 'TEST', '--usd', '5'], ['list', AGENT]])('refuses `purchasing %s` (bare included) even when the launch flag says launched, with no flag call and no API call', async (...args) => {
    const h = harness({ OARS_ISSUER_URL: '' });
    let flagCalls = 0;
    server.use(http.get(LAUNCH_FLAG_URL, () => { flagCalls += 1; return HttpResponse.json({ launched: true }); }));
    const seen = route('get', PAYMENT_METHOD, () => HttpResponse.json({}));
    expect(await run(['purchasing', ...args, '--json'], h.deps)).toBe(ExitCode.USAGE);
    expect(JSON.parse(h.out[0] ?? '')).toMatchObject({ ok: false, step: 'usage' });
    expect(h.out.join('')).toContain('Paid agents are not open yet');
    expect(flagCalls).toBe(0);
    expect(seen).toEqual([]);
  });

  it('bare `purchasing` with the gate open prints its subcommands to stderr and exits 2 (usage)', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    expect(await run(['purchasing'], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toMatch(/card/);
    expect(h.err.join('')).toMatch(/list/);
  });

  it('runs when OARS_ISSUER_URL names a platform of your own', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    cardRead(() => HttpResponse.json(view({ mode: 'TEST', status: 'ACTIVE', brand: 'visa', last4: '4242' })));
    expect(await run(['purchasing', 'card', '--mode', 'TEST'], h.deps)).toBe(ExitCode.OK);
  });
});
