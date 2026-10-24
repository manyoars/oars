import { http, HttpResponse } from 'msw';
import { API, server } from './test-support.js';

export const WORKLOAD_ID = '11111111-2222-4333-8444-555555555555';
export const SDK_KEY = 'aorsk_test_0123456789abcdef';

/** One request the fake platform answered. `key` is the `Idempotency-Key` header, `status` what the platform replied. */
export interface PlatformCall {
  method: string;
  path: string;
  body: unknown;
  key: string | null;
  status: number;
}

/** A call as a deploy plan holds it: the workload id replaced, no key, no status (design §6, `parity/deploy-plans`). */
export interface PlanCall {
  method: string;
  path: string;
  body: unknown;
}

interface Reply {
  status: number;
  body: object;
  /** What a replay of this request answers with, when that differs from `body` (a replayed register carries no SDK key). */
  replay?: object;
}

export interface PlatformOptions {
  /** This price's create is refused once (422 PRICE_INACTIVE); a rerun's second try succeeds. */
  failPrice?: string;
  /** The first deploy call is refused once (402 COMPUTE_CAP_REACHED). */
  failDeploy?: boolean;
  /** What `GET /billing/agents/{id}/prices` lists. */
  prices?: Array<{ priceRef: string; active: boolean }>;
  /** Whether that listing says there are more pages. */
  morePrices?: boolean;
  billingMode?: 'TEST' | 'LIVE';
}

export const workloadView = (extra: object = {}): object => ({
  id: WORKLOAD_ID,
  name: 'Paid API',
  slug: 'paid-api',
  status: 'REGISTERED',
  alwaysOn: false,
  autoRestartOnCredit: true,
  createdAt: '2026-10-24T00:00:00Z',
  creatorUserId: '99999999-8888-4777-8666-555555555555',
  deployment: { agentId: WORKLOAD_ID, desiredState: 'RUNNING', health: 'HEALTHY', hostScope: 'aor-test', platformStewarded: true, services: [], status: 'RUNNING' },
  egressHosts: [],
  fingerprint: 'abc123',
  hasImagePullSecret: false,
  monthlyReservedCostUsd: '1.00',
  secretNames: [],
  services: [],
  suspended: false,
  updatedAt: '2026-10-24T00:00:00Z',
  ...extra,
});

const priceView = (input: object, active = true): object => ({
  active,
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T00:00:00Z',
  amountUsd: '5.00',
  displayName: 'Price',
  kind: 'CREDIT_PACK',
  priceRef: 'price',
  ...input,
});

const parse = (text: string): unknown => (text === '' ? null : JSON.parse(text));

/**
 * msw handlers standing in for the platform's deploy, status and test-charge endpoints, with the idempotency the real
 * interceptor has: the same `Idempotency-Key` and body replays the first answer as 200, the same key with another body is
 * 409 `IDEMPOTENCY_CONFLICT`. `calls` is every request in order; `plan()` is the mutating ones in plan form.
 */
export const fakePlatform = (options: PlatformOptions = {}) => {
  const calls: PlatformCall[] = [];
  const answered = new Map<string, { text: string; replay: object }>();
  let priceFailures = options.failPrice === undefined ? 0 : 1;
  let deployFailures = options.failDeploy === true ? 1 : 0;

  const answer = async (request: Request, create: (body: unknown) => Reply): Promise<Response> => {
    const text = await request.text();
    const key = request.headers.get('Idempotency-Key');
    const prior = key === null ? undefined : answered.get(key);
    let reply: Reply;
    if (prior !== undefined && prior.text !== text) {
      reply = { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT', title: 'The Idempotency-Key was used with a different request body' } };
    } else if (prior !== undefined) {
      reply = { status: 200, body: prior.replay };
    } else {
      reply = create(parse(text));
      if (reply.status < 300 && key !== null) answered.set(key, { text, replay: reply.replay ?? reply.body });
    }
    calls.push({ method: request.method, path: new URL(request.url).pathname, body: parse(text), key, status: reply.status });
    return HttpResponse.json(reply.body, { status: reply.status });
  };

  const record = (request: Request, status: number): void => {
    calls.push({ method: request.method, path: new URL(request.url).pathname, body: null, key: null, status });
  };

  server.use(
    http.post(`${API}/agents/workloads`, ({ request }) =>
      answer(request, () => ({ status: 201, body: workloadView({ sdkKey: SDK_KEY }), replay: workloadView() })),
    ),
    http.post(`${API}/billing/agents/${WORKLOAD_ID}/prices`, ({ request }) =>
      answer(request, (body) => {
        const priceRef: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'priceRef') : undefined;
        if (priceFailures > 0 && priceRef === options.failPrice) {
          priceFailures -= 1;
          return { status: 422, body: { code: 'PRICE_INACTIVE', title: 'The price is inactive' } };
        }
        return { status: 201, body: priceView(typeof body === 'object' && body !== null ? body : {}) };
      }),
    ),
    http.post(`${API}/agents/workloads/${WORKLOAD_ID}/deploy`, ({ request }) =>
      answer(request, () => {
        if (deployFailures > 0) {
          deployFailures -= 1;
          return { status: 402, body: { code: 'COMPUTE_CAP_REACHED', title: 'The compute cap is reached', actionUrl: 'https://app.test/credits' } };
        }
        return { status: 200, body: workloadView({ status: 'REGISTERED' }) };
      }),
    ),
    http.get(`${API}/agents/workloads/${WORKLOAD_ID}`, ({ request }) => {
      record(request, 200);
      return HttpResponse.json(workloadView());
    }),
    http.get(`${API}/billing/agents/${WORKLOAD_ID}/mode`, ({ request }) => {
      record(request, 200);
      return HttpResponse.json({ billingMode: options.billingMode ?? 'TEST', workloadId: WORKLOAD_ID });
    }),
    http.get(`${API}/billing/agents/${WORKLOAD_ID}/prices`, ({ request }) => {
      record(request, 200);
      const content = (options.prices ?? []).map((price) => priceView({ priceRef: price.priceRef }, price.active));
      return HttpResponse.json({ content, last: options.morePrices !== true });
    }),
    http.post(`${API}/billing/agents/${WORKLOAD_ID}/test-charges`, ({ request }) =>
      answer(request, () => ({
        status: 201,
        body: { chargeId: 'cccccccc-dddd-4eee-8fff-000000000000', createdAt: '2026-10-24T00:00:00Z', grossUsd: '5.00', kind: 'CHARGE', livemode: false, mode: 'TEST', platformFeeUsd: '0.50', refundedUsd: '0.00', status: 'SUCCEEDED' },
      })),
    ),
  );

  return {
    calls,
    /** The calls that change something, in the order made, as a deploy plan holds them. */
    plan: (): PlanCall[] =>
      calls.filter((call) => call.method !== 'GET').map((call) => ({ method: call.method, path: call.path.replaceAll(WORKLOAD_ID, '{workloadId}'), body: call.body })),
  };
};
