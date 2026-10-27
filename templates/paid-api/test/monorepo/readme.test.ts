import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createFakeBilling, createFakeRecovery } from '../../src/fake-billing.js';

describe('the charging sentence', () => {
  it('reads the same in README.md and in the GET / body', async () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    const billing = createFakeBilling({ now: Date.now });
    const app = createApp({ billing, recovery: createFakeRecovery({ billing, now: Date.now }), priceRefs: ['calls-100'], checkoutUrls: { successUrl: 'https://agent.test/?checkout=success', cancelUrl: 'https://agent.test/?checkout=cancel' } });

    const body: unknown = await (await app.request('/')).json();

    const charging = typeof body === 'object' && body !== null && 'charging' in body ? body.charging : undefined;
    expect(typeof charging).toBe('string');
    expect(readme).toContain(String(charging));
  });

  it('is followed in the README by the replay rules, including that a failed replay does not refund', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');

    expect(readme).toContain('a replay re-runs the call free; a failed replay does not refund the original charge');
  });
});
