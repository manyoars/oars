// Container smoke test (design 1T minimum §6): the built image runs with Prism standing in for billing and answers
// /healthz, GET /, a 402 with a checkout URL for a buyer with no credits, then a 200 once billing holds and commits.
//
// Not a `.test.ts` on purpose: the monorepo's root run and `npm run test:monorepo` skip it. The release workflow runs
//   OARS_SMOKE_IMAGE=<image> npm run test:smoke -w templates/paid-api
// after `docker build`, and so can you. Without OARS_SMOKE_IMAGE it fails; it never skips.
//
// The container cannot send Prism a `Prefer: code=409` header, so each Prism serves a copy of the spec with the reserve
// (and commit) responses pinned: one refuses the hold with a 409, the other holds and commits one credit.
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
const COMMIT_PATH = '/billing/credits/reservations/{reservationId}/commit';

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
const committedOne: Pin = {
  path: COMMIT_PATH,
  status: '200',
  schema: 'ReservationCommitView',
  example: { reservationId: RESERVATION_ID, status: 'COMMITTED', committedCredits: 1, creditsRemaining: 99, replayed: false },
};
const noCredits: Pin = {
  path: RESERVE_PATH,
  status: '409',
  schema: 'ProblemDetail',
  example: { status: 409, code: 'INSUFFICIENT_CREDITS', actionUrl: CHECKOUT_URL },
};

const image = process.env['OARS_SMOKE_IMAGE'] ?? '';

// Prism and the container live and die together.
interface Stack {
  prism: PrismServer;
  container: Container;
}

const startStack = async (edit?: (text: string) => string): Promise<Stack> => {
  if (image === '') {
    throw new Error('Set OARS_SMOKE_IMAGE to the built image: docker build -f templates/paid-api/Dockerfile -t paid-api . then OARS_SMOKE_IMAGE=paid-api');
  }
  const prism = await startPrism({ host: '0.0.0.0', edit });
  try {
    const container = await startContainer(image, {
      AOR_SDK_KEY: 'sdk_smoke',
      OARS_PUBLIC_URL: 'https://agent.smoke.test',
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
  const response = await fetch(`${url}/v1/customers`, { method: 'POST', body: JSON.stringify({ countryCode: 'US', regionCode: 'NY' }) });
  expect(response.status).toBe(201);
  const { token } = await json(response);
  if (typeof token !== 'string') throw new Error('POST /v1/customers returned no token');
  return token;
};

const transform = (url: string, token: string): Promise<Response> =>
  fetch(`${url}/v1/transform`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ text: 'smoke' }) });

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
    expect(root['priceRefs']).toEqual(['calls-100', 'calls-1000']);
  });

  it('answers a buyer with no credits 402 with the checkout URL', async () => {
    const url = stack?.container.url ?? '';

    const response = await transform(url, await mintToken(url));

    expect(response.status).toBe(402);
    expect((await json(response))['checkoutUrl']).toBe(CHECKOUT_URL);
  });
});

describe('the image, billing holding and committing', () => {
  let stack: Stack | undefined;
  beforeAll(async () => {
    stack = await startStack(pinned(heldNow, committedOne));
  }, 120_000);
  afterAll(async () => {
    await stopStack(stack);
  });

  it('reads a balance, then answers a call 200', async () => {
    const url = stack?.container.url ?? '';
    const token = await mintToken(url);

    const balance = await fetch(`${url}/v1/credits`, { headers: { Authorization: `Bearer ${token}` } });
    const call = await transform(url, token);

    expect(balance.status).toBe(200);
    expect(call.status).toBe(200);
    expect(call.headers.get('X-Credits-Charged')).toBe('1');
  });
});
