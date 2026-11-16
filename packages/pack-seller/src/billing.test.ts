import { http, HttpResponse } from 'msw';
import { createOarsClient } from '@manyoars/oars-client';
import { describe, expect, it } from 'vitest';
import { createBilling, RESERVE_CREDITS, RESERVE_TTL_SECONDS } from './billing.js';
import { API, platform, SDK_KEY, server, useServer } from './test-support.js';

useServer();

const REF = 'c_0123456789abcdef0123456789abcdef';
const billing = () => createBilling(createOarsClient({ version: 'test', baseUrl: API }), SDK_KEY);

describe('reserve, commit, and release (the seam for the download route)', () => {
  it('reserves one credit for 300 seconds under the given idempotency key, and generates one when absent', async () => {
    const seen: { body: unknown; key: string | null; sdk: string | null }[] = [];
    server.use(
      http.post(`${API}/billing/credits/reservations`, async ({ request }) => {
        seen.push({ body: await request.json(), key: request.headers.get('Idempotency-Key'), sdk: request.headers.get('X-Agent-SDK-Key') });
        return HttpResponse.json({ credits: 1, expiresAt: 't', replayCount: 0, replayed: false, reservationId: 'rv_1', status: 'HELD' });
      }),
    );
    const given = '3f6c1b1e-0d7a-4c55-9d6e-2a1b4c5d6e7f';
    expect(await billing().reserve(REF, given)).toMatchObject({ ok: true, value: { reservationId: 'rv_1' } });
    expect((await billing().reserve(REF)).ok).toBe(true);
    expect(seen[0]).toEqual({ body: { customerRef: REF, credits: RESERVE_CREDITS, ttlSeconds: RESERVE_TTL_SECONDS }, key: given, sdk: SDK_KEY });
    expect(seen[1]?.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('commits and releases a reservation, and returns a refusal for a platform refusal', async () => {
    server.use(
      platform('/billing/credits/reservations/rv_1/commit', 200, { committedCredits: 1, creditsRemaining: 2, replayed: false, reservationId: 'rv_1', status: 'COMMITTED' }),
      platform('/billing/credits/reservations/rv_1/release', 200, { replayed: false, reservationId: 'rv_1', status: 'RELEASED' }),
      platform('/billing/credits/reservations/rv_2/commit', 410, {}),
      platform('/billing/credits/reservations/rv_2/release', 429, {}),
    );
    expect(await billing().commit('rv_1')).toMatchObject({ ok: true, value: { status: 'COMMITTED' } });
    expect(await billing().release('rv_1')).toMatchObject({ ok: true, value: { status: 'RELEASED' } });
    expect((await billing().commit('rv_2')).ok).toBe(false);
    expect((await billing().release('rv_2')).ok).toBe(false);
  });
});
