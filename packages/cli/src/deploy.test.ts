import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { ExitCode } from './errors.js';
import { fakePlatform, SDK_KEY, WORKLOAD_ID } from './fake-platform.js';
import { API, harness, server, useServer, type Harness } from './test-support.js';

useServer();

const DIGEST = `sha256:${'a'.repeat(64)}`;
const IMAGE = `ghcr.io/manyoars/paid-api@${DIGEST}`;
const MANIFEST = { name: 'Paid API', services: [{ name: 'api', image: IMAGE, port: 8080, public: true, cpuMillicores: 250, memoryMib: 256 }] };
const PRICES = [
  { priceRef: 'calls-100', displayName: '100 calls', amountUsd: '5.00', kind: 'CREDIT_PACK', credits: 100 },
  { priceRef: 'calls-1000', displayName: '1,000 calls', amountUsd: '40.00', kind: 'CREDIT_PACK', credits: 1000 },
];
const REGISTER = { method: 'POST', path: '/agents/workloads', body: MANIFEST };
const PRICE_PATH = '/billing/agents/{workloadId}/prices';
const DEPLOY = { method: 'POST', path: '/agents/workloads/{workloadId}/deploy', body: null };
/** The calls of a template-less deploy with its defaults: the order the web deploy page makes them in. */
const PLAN = [REGISTER, { method: 'POST', path: PRICE_PATH, body: PRICES[0] }, { method: 'POST', path: PRICE_PATH, body: PRICES[1] }, DEPLOY];

// stepKey('K', step): the lowercase SHA-256 hex of `K:<step>`, the only form the platform's interceptor accepts besides a UUID.
const KEYS = {
  register: '6b18a43fe3ae4d0f343321e01ab154b26fdd0b32f7aacf4f1c9d3f197974b59c',
  first: '264747aef940d2654c5d43b4560a04c6089322bf15423e77e44f13a63c58c083',
  second: '40485fdc7f86e251a798d32cee2af00d36dfedaa56c443582931d582df06346a',
  deploy: '78413f283e0efd102f9c5950800ce2d37fd4e0f526592b3414ba552458a008b5',
};

const setup = (env: NodeJS.ProcessEnv = {}) => {
  const h = harness({ OARS_API_KEY: 'key-123', ...env });
  const file = (name: string, content: unknown): string => {
    const path = join(h.configDir, name);
    writeFileSync(path, JSON.stringify(content));
    return path;
  };
  const manifest = file('manifest.json', MANIFEST);
  const prices = file('prices.json', PRICES);
  return { h, file, manifest, prices, args: ['--manifest', manifest, '--price-file', prices] };
};

const stdout = (h: Harness): string => h.out.join('');
const stderr = (h: Harness): string => h.err.join('');
const lastJson = (h: Harness): unknown => JSON.parse(h.out[h.out.length - 1] ?? 'null');
const field = (document: unknown, key: string): unknown => (typeof document === 'object' && document !== null ? Reflect.get(document, key) : undefined);
const filesUnder = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((entry) => join(dir, entry)).filter((path) => statSync(path).isFile());

describe('oars deploy: the sequence and its idempotency keys', () => {
  it('registers, creates each price, then deploys, each call with its own 64-hex key derived from --idempotency-key', async () => {
    const { h, args } = setup();
    const platform = fakePlatform();
    expect(await run(['deploy', ...args, '--idempotency-key', 'K'], h.deps)).toBe(ExitCode.OK);
    expect(platform.plan()).toEqual(PLAN);
    expect(platform.calls.map((call) => call.key)).toEqual([KEYS.register, KEYS.first, KEYS.second, KEYS.deploy]);
    expect(platform.calls.map((call) => call.status)).toEqual([201, 201, 201, 200]);
  });

  it('makes a fresh base key when none is given, so two runs never share keys', async () => {
    const { h, args } = setup();
    const platform = fakePlatform();
    expect(await run(['deploy', ...args], h.deps)).toBe(ExitCode.OK);
    expect(await run(['deploy', ...args], h.deps)).toBe(ExitCode.OK);
    const keys = platform.calls.map((call) => call.key ?? '');
    expect(keys.every((key) => /^[0-9a-f]{64}$/.test(key))).toBe(true);
    expect(new Set(keys).size).toBe(8);
    expect(platform.calls.map((call) => call.status)).toEqual([201, 201, 201, 200, 201, 201, 201, 200]);
  });

  it('prints the SDK key once on stdout and never writes it to disk', async () => {
    const { h, args } = setup();
    fakePlatform();
    expect(await run(['deploy', ...args, '--idempotency-key', 'K'], h.deps)).toBe(ExitCode.OK);
    expect(stdout(h).split(SDK_KEY)).toHaveLength(2);
    expect(stderr(h)).not.toContain(SDK_KEY);
    for (const path of filesUnder(h.configDir)) expect(readFileSync(path, 'utf8'), path).not.toContain(SDK_KEY);
  });

  it('--json: one document with the workload, the one-time key, the prices and what to run next', async () => {
    const { h, args } = setup();
    fakePlatform();
    expect(await run(['deploy', ...args, '--json'], h.deps)).toBe(ExitCode.OK);
    expect(h.out).toHaveLength(1);
    expect(lastJson(h)).toEqual({
      ok: true,
      workloadId: WORKLOAD_ID,
      sdkKey: SDK_KEY,
      prices: ['calls-100', 'calls-1000'],
      started: true,
      nextSteps: [`oars status ${WORKLOAD_ID}`, `oars test-charge ${WORKLOAD_ID} --price calls-100`],
    });
  });

  it('--no-start makes no deploy call and reports started: false', async () => {
    const { h, args } = setup();
    const platform = fakePlatform();
    expect(await run(['deploy', ...args, '--no-start', '--json'], h.deps)).toBe(ExitCode.OK);
    expect(platform.plan()).toEqual(PLAN.slice(0, 3));
    expect(lastJson(h)).toMatchObject({ ok: true, started: false });
  });

  it('without --price-file there are no prices, and the test-charge hint drops --price', async () => {
    const { h, manifest } = setup();
    const platform = fakePlatform();
    expect(await run(['deploy', '--manifest', manifest, '--json'], h.deps)).toBe(ExitCode.OK);
    expect(platform.plan()).toEqual([REGISTER, DEPLOY]);
    expect(lastJson(h)).toMatchObject({ prices: [], nextSteps: [`oars status ${WORKLOAD_ID}`, `oars test-charge ${WORKLOAD_ID}`] });
  });
});

describe('oars deploy: a failed step stops the sequence (exit 9)', () => {
  it('a second price that fails makes no deploy call, exits 9, prints the rerun line, and the plan ends at the failed price', async () => {
    const { h, args } = setup();
    const platform = fakePlatform({ failPrice: 'calls-1000' });
    expect(await run(['deploy', ...args, '--idempotency-key', 'K'], h.deps)).toBe(ExitCode.PARTIAL);
    expect(platform.plan()).toEqual(PLAN.slice(0, 3));
    expect(platform.calls.map((call) => call.status)).toEqual([201, 201, 422]);
    expect(stderr(h)).toContain('The price is inactive');
    expect(stderr(h)).toMatch(/oars deploy .*--idempotency-key K\n/);
    expect(await h.deps.journal.read('K')).toEqual({
      base: 'K',
      steps: [
        { step: 'register', status: 201 },
        { step: 'price:calls-100', status: 201 },
      ],
    });
  });

  it('prints the one-time SDK key on stdout when the run that failed minted it, since no rerun can show it again', async () => {
    const { h, args } = setup();
    fakePlatform({ failPrice: 'calls-1000' });
    await run(['deploy', ...args, '--idempotency-key', 'K'], h.deps);
    expect(stdout(h)).toContain(SDK_KEY);
    expect(stderr(h)).not.toContain(SDK_KEY);
    for (const path of filesUnder(h.configDir)) expect(readFileSync(path, 'utf8'), path).not.toContain(SDK_KEY);
  });

  it('--json adds the workload id, the key and the rerun line to the failure document', async () => {
    const { h, args } = setup();
    fakePlatform({ failPrice: 'calls-1000' });
    expect(await run(['deploy', ...args, '--json', '--idempotency-key', 'K'], h.deps)).toBe(ExitCode.PARTIAL);
    expect(h.out).toHaveLength(1);
    expect(lastJson(h)).toMatchObject({
      ok: false,
      step: 'price:calls-1000',
      problem: { code: 'PRICE_INACTIVE', title: 'The price is inactive', status: 422 },
      workloadId: WORKLOAD_ID,
      sdkKey: SDK_KEY,
    });
    expect(field(lastJson(h), 'rerun')).toEqual(expect.stringMatching(/^oars deploy .*--json .*--idempotency-key K$/));
  });

  it('the rerun with the printed key replays register and the first price (200) and finishes', async () => {
    const { h, args } = setup();
    const platform = fakePlatform({ failPrice: 'calls-1000' });
    await run(['deploy', ...args, '--idempotency-key', 'K'], h.deps);
    const before = platform.calls.length;
    h.out.length = 0;
    h.err.length = 0;
    expect(await run(['deploy', ...args, '--idempotency-key', 'K', '--json'], h.deps)).toBe(ExitCode.OK);
    const rerun = platform.calls.slice(before);
    expect(rerun.map((call) => call.status)).toEqual([200, 200, 201, 200]);
    expect(rerun.map((call) => call.key)).toEqual([KEYS.register, KEYS.first, KEYS.second, KEYS.deploy]);
    expect(stderr(h)).toContain('Resuming');
    expect(lastJson(h)).toMatchObject({ ok: true, workloadId: WORKLOAD_ID, prices: ['calls-100', 'calls-1000'], started: true });
    expect(field(lastJson(h), 'sdkKey')).toBeUndefined();
    expect(await h.deps.journal.read('K')).toBeUndefined();
  });

  it('the same key with a changed manifest is IDEMPOTENCY_CONFLICT: exit 5 at register, nothing after', async () => {
    const { h, args, file, prices } = setup();
    const platform = fakePlatform({ failPrice: 'calls-1000' });
    await run(['deploy', ...args, '--idempotency-key', 'K'], h.deps);
    const before = platform.calls.length;
    const changed = file('changed.json', { ...MANIFEST, name: 'Another name' });
    expect(await run(['deploy', '--manifest', changed, '--price-file', prices, '--idempotency-key', 'K'], h.deps)).toBe(ExitCode.CONFLICT);
    expect(platform.calls.slice(before).map((call) => call.status)).toEqual([409]);
  });

  it('a deploy call that fails exits 9 at step deploy and prints the problem and its URL', async () => {
    const { h, args } = setup();
    const platform = fakePlatform({ failDeploy: true });
    expect(await run(['deploy', ...args, '--idempotency-key', 'K'], h.deps)).toBe(ExitCode.PARTIAL);
    expect(platform.plan()).toEqual(PLAN);
    expect(stderr(h)).toContain('The compute cap is reached');
    expect(stderr(h)).toContain('https://app.test/credits');
    expect(stderr(h)).toMatch(/--idempotency-key K\n/);
    expect((await h.deps.journal.read('K'))?.steps.map((step) => step.step)).toEqual(['register', 'price:calls-100', 'price:calls-1000']);
  });

  it('a platform that goes away after register is exit 9, not 8: the workload exists and the rerun resumes', async () => {
    const { h, args } = setup();
    fakePlatform();
    server.use(http.post(`${API}/billing/agents/${WORKLOAD_ID}/prices`, () => HttpResponse.error()));
    expect(await run(['deploy', ...args, '--idempotency-key', 'K'], h.deps)).toBe(ExitCode.PARTIAL);
    expect(stderr(h)).toContain('Cannot reach the server');
  });

  it('a register that fails exits by its problem and leaves no journal to resume', async () => {
    const { h, args } = setup();
    fakePlatform();
    server.use(http.post(`${API}/agents/workloads`, () => HttpResponse.json({ code: 'WORKLOAD_FINGERPRINT_EXISTS', title: 'This manifest is already registered' }, { status: 409 })));
    expect(await run(['deploy', ...args, '--idempotency-key', 'K'], h.deps)).toBe(ExitCode.CONFLICT);
    expect(stderr(h)).toContain('This manifest is already registered');
    expect(stderr(h)).not.toContain('Rerun');
    expect(await h.deps.journal.read('K')).toBeUndefined();
  });
});

describe('oars deploy: secrets', () => {
  it('sends --secret and --secret-from-env values in the register body and never echoes them, even in the rerun line', async () => {
    const { h, args } = setup({ DB_URL: 'postgres://db' });
    const platform = fakePlatform({ failPrice: 'calls-1000' });
    expect(await run(['deploy', ...args, '--secret', 'API_TOKEN=hunter2', '--secret-from-env', 'DB_URL', '--json', '--idempotency-key', 'K'], h.deps)).toBe(ExitCode.PARTIAL);
    expect(platform.plan()[0]?.body).toEqual({
      ...MANIFEST,
      secrets: [
        { name: 'API_TOKEN', value: 'hunter2' },
        { name: 'DB_URL', value: 'postgres://db' },
      ],
    });
    const printed = `${stdout(h)}${stderr(h)}`;
    expect(printed).not.toContain('hunter2');
    expect(printed).not.toContain('postgres://db');
    expect(field(lastJson(h), 'rerun')).toEqual(expect.stringContaining('--secret-from-env API_TOKEN'));
    expect(field(lastJson(h), 'rerun')).toEqual(expect.stringContaining('--secret-from-env DB_URL'));
  });

  it('--secret-from-env for a variable that is not set is exit 2 and sends nothing', async () => {
    const { h, args } = setup();
    const platform = fakePlatform();
    expect(await run(['deploy', ...args, '--secret-from-env', 'MISSING'], h.deps)).toBe(ExitCode.USAGE);
    expect(stderr(h)).toContain('MISSING');
    expect(platform.calls).toEqual([]);
  });

  it('--secret without NAME=value is exit 2', async () => {
    const { h, args } = setup();
    expect(await run(['deploy', ...args, '--secret', 'no-equals-sign'], h.deps)).toBe(ExitCode.USAGE);
  });
});

describe('oars deploy --image', () => {
  const image = (extra: string[] = []) => ['deploy', '--image', IMAGE, '--name', 'Paid API', ...extra];

  it('builds a one-service manifest from the flags', async () => {
    const { h } = setup();
    const platform = fakePlatform();
    expect(await run(image(['--port', '9000', '--public', '--cpu-millicores', '500', '--memory-mib', '512', '--always-on']), h.deps)).toBe(ExitCode.OK);
    expect(platform.plan()[0]?.body).toEqual({
      name: 'Paid API',
      alwaysOn: true,
      services: [{ name: 'app', image: IMAGE, port: 9000, public: true, cpuMillicores: 500, memoryMib: 512 }],
    });
  });

  it('defaults to port 8080, not public, 250 millicores and 256 MiB, and takes prices from --price-file', async () => {
    const { h, prices } = setup();
    const platform = fakePlatform();
    expect(await run(image(['--price-file', prices]), h.deps)).toBe(ExitCode.OK);
    expect(platform.plan()[0]?.body).toEqual({ name: 'Paid API', services: [{ name: 'app', image: IMAGE, port: 8080, public: false, cpuMillicores: 250, memoryMib: 256 }] });
    expect(platform.plan().slice(1, 3)).toEqual([
      { method: 'POST', path: PRICE_PATH, body: PRICES[0] },
      { method: 'POST', path: PRICE_PATH, body: PRICES[1] },
    ]);
  });

  it('refuses an image without a digest: exit 2, the docker line that prints one, no request', async () => {
    const { h } = setup();
    const platform = fakePlatform();
    expect(await run(['deploy', '--image', 'ghcr.io/manyoars/paid-api:latest', '--name', 'Paid API'], h.deps)).toBe(ExitCode.USAGE);
    expect(stderr(h)).toContain('docker buildx imagetools inspect ghcr.io/manyoars/paid-api:latest');
    expect(platform.calls).toEqual([]);
  });

  it('--manifest refuses a service whose image has no digest', async () => {
    const { h, file } = setup();
    const platform = fakePlatform();
    const loose = file('loose.json', { name: 'x', services: [{ ...MANIFEST.services[0], image: 'ghcr.io/manyoars/paid-api:1.0' }] });
    expect(await run(['deploy', '--manifest', loose], h.deps)).toBe(ExitCode.USAGE);
    expect(stderr(h)).toContain('docker buildx imagetools inspect ghcr.io/manyoars/paid-api:1.0');
    expect(platform.calls).toEqual([]);
  });

  it('--image needs --name', async () => {
    const { h } = setup();
    expect(await run(['deploy', '--image', IMAGE], h.deps)).toBe(ExitCode.USAGE);
    expect(stderr(h)).toContain('--name');
  });
});

describe('oars deploy: usage', () => {
  it.each([
    ['no source', ['deploy']],
    ['two sources', ['deploy', '--image', IMAGE, '--name', 'x', '--manifest', 'm.json']],
    ['--price with --image', ['deploy', '--image', IMAGE, '--name', 'x', '--price', 'calls-100']],
    ['--port with --manifest', ['deploy', '--manifest', 'm.json', '--port', '9000']],
    ['a port that is not a number', ['deploy', '--image', IMAGE, '--name', 'x', '--port', 'eighty']],
  ])('%s is exit 2 and sends nothing', async (_label, argv) => {
    const { h } = setup();
    const platform = fakePlatform();
    expect(await run(argv, h.deps)).toBe(ExitCode.USAGE);
    expect(platform.calls).toEqual([]);
  });

  it('an unreadable or malformed file is exit 2 naming the file', async () => {
    const { h, file } = setup();
    const platform = fakePlatform();
    const missing = join(h.configDir, 'nope.json');
    expect(await run(['deploy', '--manifest', missing], h.deps)).toBe(ExitCode.USAGE);
    expect(stderr(h)).toContain(missing);
    const notPrices = file('not-prices.json', { priceRef: 'x' });
    expect(await run(['deploy', '--image', IMAGE, '--name', 'x', '--price-file', notPrices], h.deps)).toBe(ExitCode.USAGE);
    expect(stderr(h)).toContain(notPrices);
    expect(platform.calls).toEqual([]);
  });

  it('--template is exit 2 until the public API publishes the template catalog', async () => {
    const { h } = setup();
    const platform = fakePlatform();
    expect(await run(['deploy', '--template', 'paid-api'], h.deps)).toBe(ExitCode.USAGE);
    expect(stderr(h)).toContain('--image');
    expect(platform.calls).toEqual([]);
  });

  it('refuses an --api-url other than the stored login before any call', async () => {
    const { h, args } = setup();
    const platform = fakePlatform();
    const stored = { issuerUrl: 'http://localhost:8180/realms/aor', apiUrl: API, email: 'a@b.c', refreshToken: 'r', accessToken: 'a', expiresAt: '2099-01-01T00:00:00Z' };
    await h.deps.store.write(stored);
    const loggedIn = { ...h.deps, env: { ...h.deps.env, OARS_API_KEY: '' } };
    expect(await run(['deploy', ...args, '--api-url', 'https://other.test'], loggedIn)).toBe(ExitCode.USAGE);
    expect(stderr(h)).toContain('not logged in to https://other.test');
    expect(platform.calls).toEqual([]);
  });
});
