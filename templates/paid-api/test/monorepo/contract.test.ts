// Contract: every billing call the template makes runs against Prism serving openapi/public.json (strict mode), so a
// request that does not match spec 1's schema fails here. Prism answers a request that violates the spec with 422 and
// names the violation in the `sl-violations` header; createBilling surfaces that as a BillingProblem with status 422.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Billing, createBilling } from '../../src/billing.js';
import { type PrismServer, startPrism } from './prism.js';

const RESERVATION_ID = randomUUID();
const SDK_KEY = 'sdk_contract_test';

let prism: PrismServer;
let billing: Billing;

beforeAll(async () => {
  prism = await startPrism();
  billing = createBilling({ apiUrl: prism.url, sdkKey: SDK_KEY });
}, 60_000);

afterAll(async () => {
  await prism.stop();
});

describe('billing calls against Prism serving openapi/public.json', () => {
  it('upsertCustomer sends a body and headers the spec accepts', async () => {
    await expect(billing.upsertCustomer('cus_contract', { countryCode: 'US', regionCode: 'NY' })).resolves.toBeUndefined();
  });

  it('checkout creates a CHECKOUT charge and returns the checkout URL', async () => {
    const { checkoutUrl } = await billing.checkout('cus_contract', 'calls-100');

    expect(checkoutUrl).toEqual(expect.any(String));
  });

  it('balance reads the credit balance by customerRef', async () => {
    const balance = await billing.balance('cus_contract');

    expect(balance.customerRef).toEqual(expect.any(String));
    expect(balance.creditsAvailable).toEqual(expect.any(Number));
  });

  it('reserve sends customerRef, credits, ttlSeconds and the Idempotency-Key', async () => {
    const hold = await billing.reserve({ customerRef: 'cus_contract', credits: 1, ttlSeconds: 45, idempotencyKey: randomUUID() });

    expect(hold.reservationId).toEqual(expect.any(String));
  });

  it('commit and release address the reservation by id', async () => {
    const committed = await billing.commit(RESERVATION_ID);

    expect(committed.committedCredits).toEqual(expect.any(Number));
    await expect(billing.release(RESERVATION_ID)).resolves.toBeUndefined();
  });
});

describe('the harness itself', () => {
  // Without this, a Prism that waved everything through would make the tests above prove nothing.
  const reserve = (body: object): Promise<Response> =>
    fetch(`${prism.url}/billing/credits/reservations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Agent-SDK-Key': SDK_KEY, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(body),
    });

  it('answers 422 naming the field when a reserve body has a wrong field', async () => {
    const response = await reserve({ customerRef: 'cus_contract', credit: 1, ttlSeconds: 45 });

    expect(response.status).toBe(422);
    expect(response.headers.get('sl-violations')).toContain("required property 'credits'");
  });

  it('answers 422 when the SDK key header is missing', async () => {
    const response = await fetch(`${prism.url}/billing/credits/reservations/${RESERVATION_ID}/commit`, { method: 'POST' });

    expect(response.status).toBe(422);
    expect(response.headers.get('sl-violations')).toContain('x-agent-sdk-key');
  });

  it('answers 422 when a reservation id is not a UUID', async () => {
    const response = await fetch(`${prism.url}/billing/credits/reservations/not-a-uuid/commit`, {
      method: 'POST',
      headers: { 'X-Agent-SDK-Key': SDK_KEY },
    });

    expect(response.status).toBe(422);
  });

  it('turns a 422 into a BillingProblem with that status', async () => {
    await expect(billing.commit('not-a-uuid')).rejects.toMatchObject({ status: 422 });
  });
});
