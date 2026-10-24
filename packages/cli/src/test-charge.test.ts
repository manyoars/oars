import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { ExitCode } from './errors.js';
import { fakePlatform, WORKLOAD_ID } from './fake-platform.js';
import { harness, useServer } from './test-support.js';

useServer();

// stepKey('K', 'test-charge')
const KEY = '13269db166e56861b9a6cd0594d841fe275d9cf01b0c4772fc9d1f0406527c24';

describe('oars test-charge', () => {
  it('--price: POSTs the price ref with the derived key and prints the charge', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    const platform = fakePlatform();
    expect(await run(['test-charge', WORKLOAD_ID, '--price', 'calls-100', '--idempotency-key', 'K', '--json'], h.deps)).toBe(ExitCode.OK);
    expect(platform.calls).toEqual([{ method: 'POST', path: `/billing/agents/${WORKLOAD_ID}/test-charges`, body: { priceRef: 'calls-100' }, key: KEY, status: 201 }]);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] ?? '')).toEqual({ ok: true, chargeId: 'cccccccc-dddd-4eee-8fff-000000000000', status: 'SUCCEEDED' });
  });

  it('without --price uses the one active price', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    const platform = fakePlatform({
      prices: [
        { priceRef: 'old', active: false },
        { priceRef: 'calls-100', active: true },
      ],
    });
    expect(await run(['test-charge', WORKLOAD_ID], h.deps)).toBe(ExitCode.OK);
    expect(platform.plan()[0]?.body).toEqual({ priceRef: 'calls-100' });
  });

  it.each([
    ['none', [{ priceRef: 'old', active: false }], false],
    [
      'several',
      [
        { priceRef: 'a', active: true },
        { priceRef: 'b', active: true },
      ],
      false,
    ],
    ['more pages than one request holds', [{ priceRef: 'a', active: true }], true],
  ])('without --price and %s active prices is exit 2 asking for --price, and no charge', async (_label, prices, morePrices) => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    const platform = fakePlatform({ prices, morePrices });
    expect(await run(['test-charge', WORKLOAD_ID], h.deps)).toBe(ExitCode.USAGE);
    expect(h.err.join('')).toContain('--price');
    expect(platform.plan()).toEqual([]);
  });

  it('names the active prices when there are several', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    fakePlatform({
      prices: [
        { priceRef: 'alpha', active: true },
        { priceRef: 'beta', active: true },
      ],
    });
    await run(['test-charge', WORKLOAD_ID], h.deps);
    expect(h.err.join('')).toContain('alpha');
    expect(h.err.join('')).toContain('beta');
  });
});
