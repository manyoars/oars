import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { ExitCode } from './errors.js';
import { API, harness, server, useServer, type Harness } from './test-support.js';

useServer();

const POOL = 'https://pool.test';
const TOKEN = 'pool-token-fixture';
const SDK_KEY = 'aorsk_buyer_fixture';
const LISTING = '0b6c1f0e-2d4f-4f9a-8a53-5f0d3b1d2c99';
const PRICE_REF = 'pack-100';
const OFFER = 'po_Zm9vYmFy';
const PURCHASE = '3f6c1a52-8d0e-4f55-9a53-6f0d3b1d2c11';
const FETCH_ID = 'f-1';
const problemJson = { 'Content-Type': 'application/problem+json' };

const listing = {
  listingId: LISTING,
  sellerDisplayName: 'Fixture Seller',
  priceRef: PRICE_REF,
  displayName: 'Rust sessions',
  amountUsd: '10.0000',
  fetches: 5,
  pricePerFetchUsd: '2.0000',
  summary: 'a summary',
  harnesses: ['claude-code'],
  sessionCount: 40,
  permittedUses: ['evaluation'],
  training: 'not-offered',
  redactionVersion: '7',
  termsUrl: 'https://t.test',
  cardUrl: 'https://c.test',
  fetchUrl: 'https://f.test',
  updatedAt: '2026-11-01T00:00:00Z',
};

const page = (content: object[]) => ({ content, empty: content.length === 0, first: true, last: true, number: 0, numberOfElements: content.length, size: 20, totalElements: content.length, totalPages: 1 });

// ---- a ustar archive builder, so a test can craft each hostile archive ----
interface Entry {
  name: string;
  data?: string;
  type?: string;
  link?: string;
}

const block = (entry: Entry): Buffer => {
  const header = Buffer.alloc(512);
  const data = Buffer.from(entry.data ?? '');
  header.write(entry.name, 0, 100);
  header.write('0000644\0', 100);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write(entry.type ?? '0', 156);
  header.write(entry.link ?? '', 157, 100);
  header.write('ustar\0', 257);
  return header;
};

const tar = (entries: Entry[], end = true): Buffer =>
  Buffer.concat([
    ...entries.flatMap((entry) => {
      const data = Buffer.from(entry.data ?? '');
      return [block(entry), data, Buffer.alloc((512 - (data.length % 512)) % 512)];
    }),
    ...(end ? [Buffer.alloc(1024)] : []),
  ]);

const goodPack = (): Entry[] => [
  { name: 'sessions/abc/main.jsonl', data: '{"a":1}\n' },
  { name: 'manifest.jsonl', data: '{"matchId":"abc"}\n' },
];

// ---- the scene: a signed-in buyer, a fake platform and a fake pool ----
interface Scene {
  h: Harness;
  out: string;
  storeDir: string;
  calls: string[];
}

const scene = (env: NodeJS.ProcessEnv = {}, stdin: string[] = []): Scene => {
  const h = harness({ OARS_POOL_URL: POOL, OARS_SDK_KEY: SDK_KEY, ...env });
  const storeDir = join(h.configDir, 'store');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(
    join(storeDir, 'pool-accounts.json'),
    JSON.stringify([{ server: POOL, account: 'acct', token: TOKEN, expiresAt: Date.parse('2099-01-01T00:00:00Z'), signingKey: { kty: 'OKP', crv: 'Ed25519', x: 'AAAA' } }]),
  );
  h.deps.sessions = { storeDir, projectsRoot: storeDir, stdin: Readable.from(stdin), stdout: { write: () => true } };
  return { h, out: join(h.configDir, 'packs'), storeDir, calls: [] };
};

const platform = (s: Scene) =>
  server.use(
    http.get(`${API}/billing/datasets/${LISTING}`, () => {
      s.calls.push('listing');
      return HttpResponse.json(listing);
    }),
  );

const startAnswer = (s: Scene, answers: Array<() => Response>) =>
  server.use(
    http.post(`${POOL}/v1/packs/${PRICE_REF}/fetches`, async ({ request }) => {
      s.calls.push(`start ${request.headers.get('authorization') ?? ''} ${JSON.stringify(await request.json())}`.replace(/"buyerKey":"[0-9a-f]+"/, '"buyerKey":"<key>"'));
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      return answer?.() ?? new Response(null, { status: 500 });
    }),
  );

const downloadAnswer = (s: Scene, answers: Array<() => Response>) =>
  server.use(
    http.get(`${POOL}/v1/packs/fetches/${FETCH_ID}`, () => {
      s.calls.push('download');
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      return answer?.() ?? new Response(null, { status: 500 });
    }),
  );

const queued = () => HttpResponse.json({ fetchId: FETCH_ID, state: 'queued', priceRef: PRICE_REF }, { status: 202 });
const pending = () => HttpResponse.json({ state: 'pending' }, { status: 202 });
const pack = (entries: Entry[] = goodPack(), end = true) => () => new HttpResponse(tar(entries, end), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
const poolError = (status: number, error: string, message: string) => () => HttpResponse.json({ error, message }, { status });
const paymentRequired = () => HttpResponse.json({ error: 'payment_required', message: 'Buy a credit.', offerId: OFFER, priceRefs: [PRICE_REF], balance: { credits: 0 } }, { status: 402 });

const buyEndpoints = (s: Scene, statuses: string[] = ['SUCCEEDED']) => {
  const queue = [...statuses];
  server.use(
    http.post(`${API}/billing/purchases`, async ({ request }) => {
      s.calls.push(`buy ${request.headers.get('X-Agent-SDK-Key') ?? ''} ${JSON.stringify(await request.json())}`);
      const status = queue.length > 1 ? 'PENDING' : (queue[0] ?? 'SUCCEEDED');
      return HttpResponse.json({ purchaseId: PURCHASE, status, credits: 5, ...(status === 'FAILED' ? { failureCode: 'PURCHASE_DECLINED' } : {}) }, { status: 201 });
    }),
    http.get(`${API}/billing/purchases/${PURCHASE}`, () => {
      s.calls.push('purchase get');
      const status = queue.length > 1 ? queue.shift() : queue[0];
      return HttpResponse.json({ purchaseId: PURCHASE, status, credits: 5, ...(status === 'FAILED' ? { failureCode: 'PURCHASE_DECLINED' } : {}) });
    }),
  );
};

const fetchArgs = (s: Scene, ...more: string[]): string[] => ['data', 'fetch', LISTING, '--state', 'CA', '--out', s.out, ...more];
const bought = (s: Scene): boolean => s.calls.some((call) => call.startsWith('buy '));
const errText = (s: Scene): string => s.h.err.join('');

describe('oars data search', () => {
  it('lists each listing with seller, price, fetches, price per fetch, sessions, and redaction version', async () => {
    const h = harness();
    server.use(http.get(`${API}/billing/datasets`, () => HttpResponse.json(page([listing]))));

    expect(await run(['data', 'search'], h.deps)).toBe(ExitCode.OK);

    expect(h.out.join('').trim()).toBe(`${LISTING}  Fixture Seller  Rust sessions  $10.00  5 fetches  $2.0000/fetch  40 sessions  redaction 7`);
  });

  it('sends the query and each filter, and needs no credential', async () => {
    const h = harness();
    const seen: URL[] = [];
    let auth: string | null = 'unset';
    server.use(
      http.get(`${API}/billing/datasets`, ({ request }) => {
        seen.push(new URL(request.url));
        auth = request.headers.get('authorization');
        return HttpResponse.json(page([listing]));
      }),
    );

    await run(['data', 'search', 'rust', '--harness', 'claude-code', '--permitted-use', 'evaluation', '--training', 'included', '--max-price-per-fetch', '2.5'], h.deps);

    expect(Object.fromEntries(seen[0]?.searchParams ?? [])).toEqual({ q: 'rust', harness: 'claude-code', permittedUse: 'evaluation', training: 'included', maxPricePerFetchUsd: '2.5' });
    expect(auth).toBeNull();
  });

  it('says so on an empty page', async () => {
    const h = harness();
    server.use(http.get(`${API}/billing/datasets`, () => HttpResponse.json(page([]))));

    expect(await run(['data', 'search', 'nothing'], h.deps)).toBe(ExitCode.OK);

    expect(h.out.join('').trim()).toBe('No datasets match.');
  });

  it('--json prints the listings', async () => {
    const h = harness();
    server.use(http.get(`${API}/billing/datasets`, () => HttpResponse.json(page([listing]))));

    await run(['data', 'search', '--json'], h.deps);

    expect(JSON.parse(h.out.join(''))).toEqual({ ok: true, datasets: [listing] });
  });

  it('exits 8 with the platform unreachable after a 5xx', async () => {
    const h = harness();
    server.use(http.get(`${API}/billing/datasets`, () => HttpResponse.json({ title: 'down' }, { status: 503, headers: problemJson })));

    expect(await run(['data', 'search'], h.deps)).toBe(ExitCode.UNREACHABLE);
  });

  it('rejects a negative --max-price-per-fetch', async () => {
    const h = harness();

    expect(await run(['data', 'search', '--max-price-per-fetch', '-1'], h.deps)).toBe(ExitCode.USAGE);
  });
});

describe('oars data fetch', () => {
  it('buys the offer on a 402 under the SDK key, polls the purchase, starts again, polls the fetch, and unpacks a valid pack', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [paymentRequired, queued]);
    buyEndpoints(s, ['PENDING', 'SUCCEEDED']);
    downloadAnswer(s, [pending, pack()]);

    expect(await run(fetchArgs(s, '--yes'), s.h.deps)).toBe(ExitCode.OK);

    expect(s.calls).toEqual([
      'listing',
      `start Bearer ${TOKEN} {"buyerKey":"<key>","state":"CA"}`,
      `buy ${SDK_KEY} {"offerId":"${OFFER}","priceRef":"${PRICE_REF}"}`,
      'purchase get',
      'purchase get',
      `start Bearer ${TOKEN} {"buyerKey":"<key>","state":"CA"}`,
      'download',
      'download',
    ]);
    const folder = join(s.out, `pack-${FETCH_ID}`);
    expect(readFileSync(join(folder, 'manifest.jsonl'), 'utf8')).toBe('{"matchId":"abc"}\n');
    expect(readFileSync(join(folder, 'sessions', 'abc', 'main.jsonl'), 'utf8')).toBe('{"a":1}\n');
    expect(s.h.out.join('')).toContain(folder);
    expect(s.h.sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the same buyer key for the next pack', async () => {
    const s = scene();
    platform(s);
    const keys: string[] = [];
    server.use(
      http.post(`${POOL}/v1/packs/${PRICE_REF}/fetches`, async ({ request }) => {
        keys.push(String(Reflect.get((await request.json()) as object, 'buyerKey')));
        return queued();
      }),
    );
    downloadAnswer(s, [() => pack()().clone()]);

    await run(fetchArgs(s), s.h.deps);
    await run(['data', 'fetch', LISTING, '--state', 'ca', '--out', join(s.out, 'second')], s.h.deps);

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(readFileSync(join(s.storeDir, 'buyer-key'), 'utf8').trim()).toBe(keys[0]);
  });

  it('does not buy when a credit is already held', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [queued]);
    buyEndpoints(s);
    downloadAnswer(s, [pack()]);

    expect(await run(fetchArgs(s), s.h.deps)).toBe(ExitCode.OK);

    expect(bought(s)).toBe(false);
    expect(s.h.out.join('')).not.toContain('bought one credit');
  });

  it('makes no buy call when the price is over the cap', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [paymentRequired]);
    buyEndpoints(s);

    expect(await run(fetchArgs(s, '--yes', '--max-usd', '5'), s.h.deps)).toBe(ExitCode.CONFLICT);

    expect(bought(s)).toBe(false);
    expect(errText(s)).toContain('over the $5.00 cap');
  });

  it('takes the cap from OARS_BUY_CAP_USD', async () => {
    const s = scene({ OARS_BUY_CAP_USD: '9.99' });
    platform(s);
    startAnswer(s, [paymentRequired]);
    buyEndpoints(s);

    expect(await run(fetchArgs(s, '--yes'), s.h.deps)).toBe(ExitCode.CONFLICT);

    expect(bought(s)).toBe(false);
  });

  it('refuses a bad OARS_BUY_CAP_USD before anything is called', async () => {
    const s = scene({ OARS_BUY_CAP_USD: 'lots' });

    expect(await run(fetchArgs(s, '--yes'), s.h.deps)).toBe(ExitCode.USAGE);

    expect(s.calls).toEqual([]);
  });

  it('does not buy without --yes when no person is at a terminal, and says how to', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [paymentRequired]);
    buyEndpoints(s);

    expect(await run(fetchArgs(s), s.h.deps)).toBe(ExitCode.USAGE);

    expect(bought(s)).toBe(false);
    expect(errText(s)).toContain('run again with --yes');
  });

  it('buys after a typed yes at a terminal, and not after anything else', async () => {
    const yes = scene({}, ['yes\n']);
    Reflect.set(yes.h.deps.sessions ?? {}, 'stderr', { isTTY: true });
    Reflect.set(yes.h.deps.sessions?.stdin ?? {}, 'isTTY', true);
    platform(yes);
    startAnswer(yes, [paymentRequired, queued]);
    buyEndpoints(yes);
    downloadAnswer(yes, [pack()]);

    expect(await run(fetchArgs(yes), yes.h.deps)).toBe(ExitCode.OK);
    expect(bought(yes)).toBe(true);

    const no = scene({}, ['no\n']);
    Reflect.set(no.h.deps.sessions ?? {}, 'stderr', { isTTY: true });
    Reflect.set(no.h.deps.sessions?.stdin ?? {}, 'isTTY', true);
    platform(no);
    startAnswer(no, [paymentRequired]);
    buyEndpoints(no);

    expect(await run(fetchArgs(no), no.h.deps)).toBe(ExitCode.USAGE);
    expect(bought(no)).toBe(false);
  });

  it('stops when the purchase fails, and starts no second fetch', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [paymentRequired]);
    buyEndpoints(s, ['FAILED']);

    expect(await run(fetchArgs(s, '--yes'), s.h.deps)).toBe(ExitCode.CONFLICT);

    expect(errText(s)).toContain('FAILED (PURCHASE_DECLINED)');
    expect(s.calls.filter((call) => call.startsWith('start'))).toHaveLength(1);
  });

  it('stops when the purchase stays pending past the time limit', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [paymentRequired]);
    buyEndpoints(s, ['PENDING']);

    expect(await run(fetchArgs(s, '--yes'), s.h.deps)).toBe(ExitCode.UNREACHABLE);

    expect(errText(s)).toContain('still pending');
  });

  it('needs the SDK key to buy', async () => {
    const s = scene({ OARS_SDK_KEY: '' });
    platform(s);
    startAnswer(s, [paymentRequired]);
    buyEndpoints(s);

    expect(await run(fetchArgs(s, '--yes'), s.h.deps)).toBe(ExitCode.USAGE);

    expect(bought(s)).toBe(false);
  });

  it('reads the SDK key from --sdk-key-file', async () => {
    const s = scene({ OARS_SDK_KEY: '' });
    const file = join(s.h.configDir, 'sdk-key');
    writeFileSync(file, 'aorsk_from_file\n');
    platform(s);
    startAnswer(s, [paymentRequired, queued]);
    buyEndpoints(s);
    downloadAnswer(s, [pack()]);

    expect(await run(fetchArgs(s, '--yes', '--sdk-key-file', file), s.h.deps)).toBe(ExitCode.OK);

    expect(s.calls.find((call) => call.startsWith('buy '))).toContain('aorsk_from_file');
  });

  it('stops when the pool still asks for payment after the purchase settled', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [paymentRequired]);
    buyEndpoints(s);

    expect(await run(fetchArgs(s, '--yes'), s.h.deps)).toBe(ExitCode.CONFLICT);
  });

  it('refuses a 402 that names no pack for this listing, without buying', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [() => HttpResponse.json({ error: 'payment_required', offerId: OFFER, priceRefs: ['other'], balance: {} }, { status: 402 })]);
    buyEndpoints(s);

    expect(await run(fetchArgs(s, '--yes'), s.h.deps)).toBe(ExitCode.UNEXPECTED);

    expect(bought(s)).toBe(false);
  });

  it('refuses a 402 that names no offer', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [() => HttpResponse.json({ error: 'payment_required' }, { status: 402 })]);

    expect(await run(fetchArgs(s, '--yes'), s.h.deps)).toBe(ExitCode.UNEXPECTED);
  });

  it.each([
    ['buyer_refused', 403, ExitCode.AUTH, 'This buyer cannot buy.'],
    ['account_restricted', 403, ExitCode.AUTH, 'This account is restricted.'],
    ['region_not_supported', 400, ExitCode.INVALID, 'Only US buyers.'],
    ['state_invalid', 400, ExitCode.INVALID, 'That is not a US state.'],
    ['state_required', 400, ExitCode.INVALID, 'Say your state.'],
    ['billing_unavailable', 502, ExitCode.UNREACHABLE, 'Billing is down.'],
  ])('shows the pool refusal %s and fetches nothing', async (code, status, exit, message) => {
    const s = scene();
    platform(s);
    startAnswer(s, [poolError(status, code, message)]);
    buyEndpoints(s);

    expect(await run(fetchArgs(s, '--yes'), s.h.deps)).toBe(exit);

    expect(errText(s)).toContain(message);
    expect(bought(s)).toBe(false);
    expect(s.calls).not.toContain('download');
  });

  it('refuses a state that is not two letters before any call', async () => {
    const s = scene();

    expect(await run(['data', 'fetch', LISTING, '--state', 'Texas', '--out', s.out], s.h.deps)).toBe(ExitCode.USAGE);

    expect(s.calls).toEqual([]);
  });

  it('refuses when not signed in to the pool', async () => {
    const s = scene();
    writeFileSync(join(s.storeDir, 'pool-accounts.json'), '[]');

    expect(await run(fetchArgs(s), s.h.deps)).toBe(ExitCode.AUTH);

    expect(errText(s)).toContain('oars pool login');
  });

  it('exits with the platform problem when the listing is not found', async () => {
    const s = scene();
    server.use(http.get(`${API}/billing/datasets/${LISTING}`, () => HttpResponse.json({ code: 'DATASET_NOT_FOUND', title: 'No such dataset' }, { status: 404, headers: problemJson })));

    expect(await run(fetchArgs(s), s.h.deps)).not.toBe(ExitCode.OK);

    expect(errText(s)).toContain('No such dataset');
  });

  it('reports a failed fetch (409 fetch_failed) and writes nothing', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [queued]);
    downloadAnswer(s, [poolError(409, 'fetch_failed', 'The pack could not be built.')]);

    expect(await run(fetchArgs(s), s.h.deps)).toBe(ExitCode.UNEXPECTED);

    expect(errText(s)).toContain('The pack could not be built.');
    expect(existsSync(s.out)).toBe(false);
  });

  it('reports an expired fetch (410 gone) and writes nothing', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [queued]);
    downloadAnswer(s, [poolError(410, 'gone', 'The pack is gone.')]);

    expect(await run(fetchArgs(s), s.h.deps)).toBe(ExitCode.UNEXPECTED);

    expect(errText(s)).toContain('The pack is gone.');
    expect(existsSync(s.out)).toBe(false);
  });

  it('gives up with a way to resume when the pack is never ready', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [queued]);
    downloadAnswer(s, [pending]);

    expect(await run(fetchArgs(s), s.h.deps)).toBe(ExitCode.UNREACHABLE);

    expect(errText(s)).toContain('not ready yet');
    expect(s.h.sleeps.at(-1)).toBeLessThanOrEqual(15_000);
  });

  it('keeps a pack that fails validation, exits non-zero, and says so', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [queued]);
    downloadAnswer(s, [pack([{ name: 'manifest.jsonl', data: '{"matchId":"abc"}\nnot json\n{"x":1}\n' }])]);

    expect(await run(fetchArgs(s), s.h.deps)).toBe(ExitCode.INVALID);

    const folder = join(s.out, `pack-${FETCH_ID}`);
    expect(existsSync(join(folder, 'manifest.jsonl'))).toBe(true);
    expect(errText(s)).toContain('failed validation');
    expect(errText(s)).toContain(folder);
  });

  it('flags a session folder no manifest row names', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [queued]);
    downloadAnswer(s, [pack([{ name: 'sessions/zzz/main.jsonl', data: '{}\n' }, { name: 'manifest.jsonl', data: '{"matchId":"abc"}\n' }])]);

    expect(await run(fetchArgs(s), s.h.deps)).toBe(ExitCode.INVALID);

    expect(errText(s)).toContain('failed validation (2 found');
  });

  it('refuses an empty manifest', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [queued]);
    downloadAnswer(s, [pack([{ name: 'manifest.jsonl', data: '' }])]);

    expect(await run(fetchArgs(s), s.h.deps)).toBe(ExitCode.INVALID);
  });

  it('unpacks into a fresh temporary folder when --out is not given', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [queued]);
    downloadAnswer(s, [pack()]);

    expect(await run(['data', 'fetch', LISTING, '--state', 'CA', '--json'], s.h.deps)).toBe(ExitCode.OK);

    const folder = String(Reflect.get(JSON.parse(s.h.out.join('')) as object, 'folder'));
    expect(folder).toContain('oars-pack-');
    expect(existsSync(join(folder, 'manifest.jsonl'))).toBe(true);
  });

  it('will not reuse a pack folder that exists', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [queued]);
    downloadAnswer(s, [pack()]);
    mkdirSync(join(s.out, `pack-${FETCH_ID}`), { recursive: true });

    expect(await run(fetchArgs(s), s.h.deps)).toBe(ExitCode.USAGE);

    expect(readdirSync(join(s.out, `pack-${FETCH_ID}`))).toEqual([]);
  });
});

describe('oars data fetch refuses an unsafe archive and writes nothing', () => {
  const refused = async (entries: Entry[], message: string, end = true) => {
    const s = scene();
    platform(s);
    startAnswer(s, [queued]);
    downloadAnswer(s, [pack(entries, end)]);

    expect(await run(fetchArgs(s), s.h.deps)).toBe(ExitCode.INVALID);

    expect(errText(s)).toContain(message);
    expect(existsSync(s.out)).toBe(false);
    expect(existsSync(join(s.h.configDir, 'escaped'))).toBe(false);
  };
  const manifest: Entry = { name: 'manifest.jsonl', data: '{"matchId":"abc"}\n' };

  it('an entry with ..', () => refused([{ name: '../escaped', data: 'x' }, manifest], 'climbs out'));
  it('an entry with .. in the middle', () => refused([{ name: 'sessions/../../escaped', data: 'x' }, manifest], 'climbs out'));
  it('an absolute path', () => refused([{ name: '/tmp/escaped', data: 'x' }, manifest], 'absolute or drive path'));
  it('a drive path', () => refused([{ name: 'C:/escaped', data: 'x' }, manifest], 'absolute or drive path'));
  it('a backslash path', () => refused([{ name: 'a' + String.fromCharCode(92) + 'escaped', data: 'x' }, manifest], 'absolute or drive path'));
  it('a symbolic link', () => refused([{ name: 'link', type: '2', link: '/etc/passwd' }, manifest], 'link entry'));
  it('a hard link', () => refused([{ name: 'link', type: '1', link: 'manifest.jsonl' }, manifest], 'link entry'));
  it('a device or extended header', () => refused([{ name: 'dev', type: '3' }, manifest], 'kind this command does not unpack'));
  it('an archive cut before its end blocks', () => refused(goodPack(), 'cut short', false));
  it('an archive whose manifest is not last', () => refused([manifest, { name: 'sessions/abc/main.jsonl', data: '{}\n' }], 'does not end with manifest.jsonl'));
  it('an archive cut inside a file', async () => {
    const s = scene();
    platform(s);
    startAnswer(s, [queued]);
    const whole = tar(goodPack());
    downloadAnswer(s, [() => new HttpResponse(whole.subarray(0, 512 + 3), { status: 200 })]);

    expect(await run(fetchArgs(s), s.h.deps)).toBe(ExitCode.INVALID);

    expect(errText(s)).toContain('cut short');
    expect(existsSync(s.out)).toBe(false);
  });
});
