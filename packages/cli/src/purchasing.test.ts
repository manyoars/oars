import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { ExitCode } from './errors.js';
import { API, harness, server, useServer } from './test-support.js';

useServer();

const OFFER = 'po_Zm9vYmFy';
const PURCHASE = '3f6c1a52-8d0e-4f55-9a53-6f0d3b1d2c11';
const SDK_KEY = 'aorsk_buyer_fixture';
const problemJson = { 'Content-Type': 'application/problem+json' };

const offerDetail = {
  offerId: OFFER,
  mode: 'TEST',
  sellerName: 'Fixture Seller',
  sellerSlug: 'fixture-seller',
  expiresAt: '2099-01-01T00:00:00Z',
  packs: [{ priceRef: 'pack-3', displayName: 'Three credits', credits: 3, amountUsd: '3.0000' }],
};

const buyer = () => harness({ OARS_SDK_KEY: SDK_KEY });

interface Seen {
  body: unknown;
  sdkKey: string | null;
  idempotencyKey: string | null;
}

describe('oars purchasing offer', () => {
  it('prints the offer and each pack, sending the buyer SDK key', async () => {
    const h = buyer();
    const seen: Array<string | null> = [];
    server.use(
      http.get(`${API}/billing/offers/${OFFER}`, ({ request }) => {
        seen.push(request.headers.get('X-Agent-SDK-Key'));
        return HttpResponse.json(offerDetail);
      }),
    );

    expect(await run(['purchasing', 'offer', OFFER], h.deps)).toBe(ExitCode.OK);

    expect(seen).toEqual([SDK_KEY]);
    const lines = h.out.join('').trim().split('\n');
    expect(lines[0]).toBe(`Offer ${OFFER} from Fixture Seller (fixture-seller), TEST, expires 2099-01-01T00:00:00Z`);
    expect(lines[1]).toBe('pack-3  Three credits  3 credits  $3.00');
  });

  it('--json prints the offer document', async () => {
    const h = buyer();
    server.use(http.get(`${API}/billing/offers/${OFFER}`, () => HttpResponse.json(offerDetail)));

    expect(await run(['purchasing', 'offer', OFFER, '--json'], h.deps)).toBe(ExitCode.OK);

    expect(JSON.parse(h.out.join(''))).toEqual({ ok: true, offer: offerDetail });
  });

  it('refuses an unknown offer with a non-zero exit and one line on stderr', async () => {
    const h = buyer();
    server.use(
      http.get(`${API}/billing/offers/po_nope`, () => HttpResponse.json({ code: 'OFFER_NOT_FOUND', title: 'No such offer' }, { status: 404, headers: problemJson })),
    );

    const code = await run(['purchasing', 'offer', 'po_nope'], h.deps);

    expect(code).not.toBe(ExitCode.OK);
    expect(h.err.join('').trim().split('\n')).toEqual(['No such offer']);
  });

  it('reads the SDK key from --sdk-key-file, and exits 2 naming a file it cannot read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oars-purchasing-test-'));
    const file = join(dir, 'sdk-key.txt');
    writeFileSync(file, `${SDK_KEY}\n`);
    const seen: Array<string | null> = [];
    server.use(
      http.get(`${API}/billing/offers/${OFFER}`, ({ request }) => {
        seen.push(request.headers.get('X-Agent-SDK-Key'));
        return HttpResponse.json(offerDetail);
      }),
    );
    const h = harness();

    expect(await run(['purchasing', 'offer', OFFER, '--sdk-key-file', file], h.deps)).toBe(ExitCode.OK);
    expect(seen).toEqual([SDK_KEY]);

    const missing = harness();
    expect(await run(['purchasing', 'offer', OFFER, '--sdk-key-file', join(dir, 'absent.txt')], missing.deps)).toBe(ExitCode.USAGE);
    expect(missing.err.join('')).toContain('Cannot read an SDK key from');
  });

  it('exits 2 without a request when no SDK key is given', async () => {
    const h = harness();

    expect(await run(['purchasing', 'offer', OFFER], h.deps)).toBe(ExitCode.USAGE);

    expect(h.err.join('').trim()).toBe('The buying agent needs its SDK key: set OARS_SDK_KEY or pass --sdk-key-file.');
  });
});

describe('oars purchasing buy', () => {
  const answer = (seen: Seen[]) =>
    http.post(`${API}/billing/purchases`, async ({ request }) => {
      seen.push({ body: await request.json(), sdkKey: request.headers.get('X-Agent-SDK-Key'), idempotencyKey: request.headers.get('Idempotency-Key') });
      return HttpResponse.json({ purchaseId: PURCHASE, status: 'PENDING', credits: 3 }, { status: 201 });
    });

  it('buys the named pack with the buyer key and a 64-hex Idempotency-Key, and names the poll command', async () => {
    const h = buyer();
    const seen: Seen[] = [];
    server.use(answer(seen));

    expect(await run(['purchasing', 'buy', OFFER, '--pack', 'pack-3'], h.deps)).toBe(ExitCode.OK);

    expect(seen[0]?.body).toEqual({ offerId: OFFER, priceRef: 'pack-3' });
    expect(seen[0]?.sdkKey).toBe(SDK_KEY);
    expect(seen[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(h.out.join('').trim()).toBe(`Purchase ${PURCHASE}: PENDING, 3 credits. Poll it with \`oars purchasing get ${PURCHASE}\`.`);
  });

  it('sends the same Idempotency-Key for the same --idempotency-key, so a retry is one purchase', async () => {
    const seen: Seen[] = [];
    server.use(answer(seen));

    await run(['purchasing', 'buy', OFFER, '--pack', 'pack-3', '--idempotency-key', 'retry-1'], buyer().deps);
    await run(['purchasing', 'buy', OFFER, '--pack', 'pack-3', '--idempotency-key', 'retry-1'], buyer().deps);

    expect(seen[0]?.idempotencyKey).toBe(seen[1]?.idempotencyKey);
  });

  it('prints a failed purchase with its code', async () => {
    const h = buyer();
    server.use(http.post(`${API}/billing/purchases`, () => HttpResponse.json({ purchaseId: PURCHASE, status: 'FAILED', failureCode: 'PURCHASE_DECLINED', credits: 3 }, { status: 201 })));

    expect(await run(['purchasing', 'buy', OFFER, '--pack', 'pack-3'], h.deps)).toBe(ExitCode.OK);

    expect(h.out.join('')).toContain('FAILED (PURCHASE_DECLINED)');
  });

  it('refuses an unknown offer with a non-zero exit and one line on stderr', async () => {
    const h = buyer();
    server.use(http.post(`${API}/billing/purchases`, () => HttpResponse.json({ code: 'OFFER_NOT_FOUND', title: 'No such offer' }, { status: 404, headers: problemJson })));

    expect(await run(['purchasing', 'buy', 'po_nope', '--pack', 'pack-3'], h.deps)).not.toBe(ExitCode.OK);

    expect(h.err.join('').trim().split('\n')).toEqual(['No such offer']);
  });

  it('requires --pack', async () => {
    const h = buyer();

    expect(await run(['purchasing', 'buy', OFFER], h.deps)).toBe(ExitCode.USAGE);
  });
});

describe('oars purchasing get', () => {
  it('prints where the purchase stands, sending the buyer key', async () => {
    const h = buyer();
    const seen: Array<string | null> = [];
    server.use(
      http.get(`${API}/billing/purchases/${PURCHASE}`, ({ request }) => {
        seen.push(request.headers.get('X-Agent-SDK-Key'));
        return HttpResponse.json({ purchaseId: PURCHASE, status: 'SUCCEEDED', credits: 3 });
      }),
    );

    expect(await run(['purchasing', 'get', PURCHASE], h.deps)).toBe(ExitCode.OK);

    expect(seen).toEqual([SDK_KEY]);
    expect(h.out.join('').trim()).toBe(`Purchase ${PURCHASE}: SUCCEEDED, 3 credits.`);
  });

  it('refuses an unknown purchase with a non-zero exit and one line on stderr', async () => {
    const h = buyer();
    server.use(http.get(`${API}/billing/purchases/${PURCHASE}`, () => HttpResponse.json({ code: 'PURCHASE_NOT_FOUND', title: 'No such purchase' }, { status: 404, headers: problemJson })));

    expect(await run(['purchasing', 'get', PURCHASE], h.deps)).not.toBe(ExitCode.OK);

    expect(h.err.join('').trim().split('\n')).toEqual(['No such purchase']);
  });
});
