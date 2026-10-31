import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createFakeBilling, createFakeRecovery } from '../src/fake-billing.js';
import { bodyOf, createClock } from './support.js';

const CHECKOUT_URLS = { successUrl: 'https://agent.test/?checkout=success', cancelUrl: 'https://agent.test/?checkout=cancel' };
const MINT = JSON.stringify({ countryCode: 'US', regionCode: 'NY' });

const setup = (options: { customersPerMinute?: number; trustProxy?: boolean } = {}) => {
  const clock = createClock();
  const fake = createFakeBilling({ now: clock.now });
  const recovery = createFakeRecovery({ billing: fake, now: clock.now });
  const app = createApp({ billing: fake, recovery, priceRefs: ['calls-100'], checkoutUrls: CHECKOUT_URLS, now: clock.now, ...options });
  const upsert = vi.spyOn(fake, 'upsertCustomer');
  /** One anonymous mint as the node server delivers it: the socket's address in the bindings, and a forwarded header if the caller sets one. */
  const mint = async (socket: string, forwarded?: string, body = MINT): Promise<Response> =>
    await app.request(
      '/v1/customers',
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...(forwarded === undefined ? {} : { 'CF-Connecting-IP': forwarded }) }, body },
      { incoming: { socket: { remoteAddress: socket } } },
    );
  const mintMany = async (count: number, socket: string, forwarded?: (index: number) => string | undefined): Promise<Response[]> => {
    const responses: Response[] = [];
    for (let index = 0; index < count; index += 1) responses.push(await mint(socket, forwarded?.(index)));
    return responses;
  };
  return { app, clock, upsert, mint, mintMany };
};

describe('POST /v1/customers rate limit', () => {
  it('lets one address mint 5 customers a minute and answers the sixth 429 with Retry-After', async () => {
    const { mint, mintMany } = setup();
    const first = await mintMany(5, '192.0.2.10');

    const sixth = await mint('192.0.2.10');

    expect(first.map((response) => response.status)).toEqual([201, 201, 201, 201, 201]);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('Retry-After')).toBe('60');
    expect(await bodyOf(sixth)).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('never reaches billing for the refused request', async () => {
    const { upsert, mint, mintMany } = setup();
    await mintMany(5, '192.0.2.10');

    await mint('192.0.2.10');

    expect(upsert).toHaveBeenCalledTimes(5);
  });

  it('counts a request the route would refuse as invalid, so a flood of bad bodies is bounded too', async () => {
    const { mint } = setup({ customersPerMinute: 2 });
    expect((await mint('192.0.2.10', undefined, 'not json')).status).toBe(400);
    expect((await mint('192.0.2.10', undefined, 'not json')).status).toBe(400);

    expect((await mint('192.0.2.10')).status).toBe(429);
  });

  it('still lets a second address through while the first is refused', async () => {
    const { mint, mintMany } = setup();
    await mintMany(5, '192.0.2.10');
    expect((await mint('192.0.2.10')).status).toBe(429);

    expect((await mint('192.0.2.11')).status).toBe(201);
  });

  it('lets the address mint again once the Retry-After has passed', async () => {
    const { clock, mint, mintMany } = setup();
    await mintMany(5, '192.0.2.10');
    const refused = await mint('192.0.2.10');
    expect(refused.status).toBe(429);

    clock.advance(Number(refused.headers.get('Retry-After')) * 1000);

    expect((await mint('192.0.2.10')).status).toBe(201);
  });

  it('takes the limit from the customersPerMinute option', async () => {
    const { mint } = setup({ customersPerMinute: 2 });

    expect([(await mint('192.0.2.10')).status, (await mint('192.0.2.10')).status, (await mint('192.0.2.10')).status]).toEqual([201, 201, 429]);
  });

  it('keeps its own count, apart from the token-recovery limit', async () => {
    const { app, mint } = setup();
    for (let asked = 0; asked < 5; asked += 1) {
      await app.request('/v1/recover', { method: 'POST', body: JSON.stringify({ email: `buyer${String(asked)}@example.com` }) }, { incoming: { socket: { remoteAddress: '192.0.2.10' } } });
    }

    expect((await mint('192.0.2.10')).status).toBe(201);
  });
});

describe('POST /v1/customers client address', () => {
  it('ignores a spoofed CF-Connecting-IP while the proxy setting is off: a new header value does not buy a new allowance', async () => {
    const { mint, mintMany } = setup();
    await mintMany(5, '192.0.2.10', (index) => `203.0.113.${String(index)}`);

    const spoofed = await mint('192.0.2.10', '203.0.113.99');

    expect(spoofed.status).toBe(429);
  });

  it('ignores a spoofed header by the same rule when the proxy setting is explicitly false', async () => {
    const { mint, mintMany } = setup({ trustProxy: false });
    await mintMany(5, '192.0.2.10');

    expect((await mint('192.0.2.10', '203.0.113.99')).status).toBe(429);
  });

  it('counts each CF-Connecting-IP apart when the proxy setting is on, though every socket is the proxy', async () => {
    const { mint, mintMany } = setup({ trustProxy: true });
    await mintMany(5, '172.16.0.1', () => '203.0.113.7');

    expect((await mint('172.16.0.1', '203.0.113.7')).status).toBe(429);
    expect((await mint('172.16.0.1', '203.0.113.8')).status).toBe(201);
  });

  it('falls back to the socket address when the proxy setting is on but a request carries no header', async () => {
    const { mint, mintMany } = setup({ trustProxy: true });
    await mintMany(5, '172.16.0.1');

    expect((await mint('172.16.0.1')).status).toBe(429);
    expect((await mint('172.16.0.2')).status).toBe(201);
  });

  it('counts a request with no socket bindings at all against one shared address instead of failing', async () => {
    const { app } = setup({ customersPerMinute: 1 });

    const statuses = [(await app.request('/v1/customers', { method: 'POST', body: MINT })).status, (await app.request('/v1/customers', { method: 'POST', body: MINT })).status];

    expect(statuses).toEqual([201, 429]);
  });
});
