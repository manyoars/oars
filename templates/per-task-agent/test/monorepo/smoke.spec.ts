// Container smoke test (design 1T minimum §6): the built image runs with Prism standing in for billing and answers
// /healthz, GET /, a 402 with a checkout URL for a buyer with no credits, then a 200 once Prism returns a balance.
// A finished audit needs a public page, which a CI run should not depend on, so the paid path is checked through the
// refusal instead: the image's real DNS and socket code turns away a link-local address, the buyer pays nothing, and the
// agent's log names why.
//
// Not a `.test.ts` on purpose: the monorepo's root run and `npm run test:monorepo` skip it. The release workflow runs
//   OARS_SMOKE_IMAGE=<image> npm run test:smoke -w templates/per-task-agent
// after `docker build`, and so can you. Without OARS_SMOKE_IMAGE it fails; it never skips.
//
// The container cannot send Prism a `Prefer: code=402` header, so each Prism serves a copy of the spec with the reserve
// responses pinned: one refuses the hold with a 402, the other holds one credit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHARGING_SENTENCE } from '../../src/app.js';
import { type Container, startContainer } from './container.js';
import { type PrismServer, startPrism } from './prism.js';

const CHECKOUT_URL = 'https://checkout.example/packs/smoke';
const RESERVATION_ID = '7b0f1a52-6a43-4d3c-9d1e-0c2f6a1d9e11';

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One operation answered with one fixed response, as Prism would serve it. */
interface Pin {
  path: string;
  status: string;
  schema: string;
  example: unknown;
}

const RESERVE_PATH = '/billing/credits/reservations';

// Prism's generated examples are not billing's: a boolean comes out `true`, so a first reserve would read as a replay.
const pinned =
  (...pins: Pin[]) =>
  (text: string): string => {
    const spec: unknown = JSON.parse(text);
    const paths = isRecord(spec) ? spec['paths'] : undefined;
    for (const pin of pins) {
      const path = isRecord(paths) ? paths[pin.path] : undefined;
      const operation = isRecord(path) ? path['post'] : undefined;
      if (!isRecord(operation)) throw new Error(`public.json has no POST ${pin.path} to pin`);
      operation['responses'] = {
        [pin.status]: {
          description: 'Pinned by the smoke test',
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${pin.schema}` }, example: pin.example } },
        },
      };
    }
    return JSON.stringify(spec);
  };

const heldNow: Pin = {
  path: RESERVE_PATH,
  status: '200',
  schema: 'ReservationView',
  example: { reservationId: RESERVATION_ID, credits: 1, status: 'HELD', expiresAt: '2099-01-01T00:00:00Z', replayCount: 0, replayed: false },
};
const noCredits: Pin = {
  path: RESERVE_PATH,
  status: '402',
  schema: 'ProblemDetail',
  example: { status: 402, code: 'INSUFFICIENT_CREDITS', actionUrl: CHECKOUT_URL },
};

const image = process.env['OARS_SMOKE_IMAGE'] ?? '';

// Prism and the container live and die together.
interface Stack {
  prism: PrismServer;
  container: Container;
}

const startStack = async (edit?: (text: string) => string): Promise<Stack> => {
  if (image === '') {
    throw new Error('Set OARS_SMOKE_IMAGE to the built image: docker build -f templates/per-task-agent/Dockerfile -t per-task-agent . then OARS_SMOKE_IMAGE=per-task-agent');
  }
  const prism = await startPrism({ host: '0.0.0.0', edit });
  try {
    const container = await startContainer(image, {
      AOR_SDK_KEY: 'sdk_smoke',
      OARS_API_URL: `http://host.docker.internal:${new URL(prism.url).port}`,
    });
    return { prism, container };
  } catch (error) {
    await prism.stop();
    throw error;
  }
};

const stopStack = async (stack: Stack | undefined): Promise<void> => {
  if (stack === undefined) return;
  await stack.container.stop();
  await stack.prism.stop();
};

const json = async (response: Response): Promise<{ [key: string]: unknown }> => {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('expected a JSON object');
  return body;
};

const mintToken = async (url: string): Promise<string> => {
  const response = await fetch(`${url}/v1/customers`, { method: 'POST', body: JSON.stringify({ countryCode: 'US' }) });
  expect(response.status).toBe(201);
  const { token } = await json(response);
  if (typeof token !== 'string') throw new Error('POST /v1/customers returned no token');
  return token;
};

// The cloud metadata address: link-local, so the guard refuses it before any socket opens.
const METADATA_URL = 'http://169.254.169.254/latest/meta-data/';

const task = (url: string, token: string): Promise<Response> =>
  fetch(`${url}/v1/tasks`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ url: METADATA_URL }) });

describe('the image, billing refusing the hold (no credits)', () => {
  let stack: Stack | undefined;
  beforeAll(async () => {
    stack = await startStack(pinned(noCredits));
  }, 120_000);
  afterAll(async () => {
    await stopStack(stack);
  });

  it('answers /healthz and describes itself on GET / with the charging sentence and the starter price refs', async () => {
    const url = stack?.container.url ?? '';

    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    const root = await json(await fetch(`${url}/`));
    expect(root['charging']).toBe(CHARGING_SENTENCE);
    expect(root['priceRefs']).toEqual(['task-1', 'tasks-5']);
  });

  it('answers a buyer with no credits 402 with the checkout URL', async () => {
    const url = stack?.container.url ?? '';

    const response = await task(url, await mintToken(url));

    expect(response.status).toBe(402);
    expect((await json(response))['checkoutUrl']).toBe(CHECKOUT_URL);
  });
});

describe('the image, billing holding the credit', () => {
  let stack: Stack | undefined;
  beforeAll(async () => {
    stack = await startStack(pinned(heldNow));
  }, 120_000);
  afterAll(async () => {
    await stopStack(stack);
  });

  it('reads a balance and answers 200', async () => {
    const url = stack?.container.url ?? '';
    const token = await mintToken(url);

    const balance = await fetch(`${url}/v1/credits`, { headers: { Authorization: `Bearer ${token}` } });

    expect(balance.status).toBe(200);
    expect(typeof (await json(balance))['creditsAvailable']).toBe('number');
  });

  it('refuses a link-local address with 422, charges nothing and logs the reason for the developer, not the buyer', async () => {
    const url = stack?.container.url ?? '';

    const response = await task(url, await mintToken(url));

    expect(response.status).toBe(422);
    expect(response.headers.get('X-Credits-Charged')).toBeNull();
    expect((await json(response))['code']).toBe('URL_NOT_ALLOWED');
    expect(await stack?.container.logs()).toContain('"event":"task-failed","code":"URL_NOT_ALLOWED"');
  });
});
