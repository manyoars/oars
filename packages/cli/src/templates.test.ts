import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import type { AgentTemplate } from './commands/templates.js';
import { ExitCode } from './errors.js';
import { fakePlatform } from './fake-platform.js';
import { API, harness, server, useServer } from './test-support.js';

useServer();

const service = (name: string) => ({ name, image: `ghcr.io/manyoars/${name}@sha256:${'a'.repeat(64)}`, port: 8080, public: true, cpuMillicores: 250, memoryMib: 256 });
const PAID_API: AgentTemplate = {
  templateId: 'paid-api',
  name: 'Paid API',
  description: 'An HTTP API that charges per call through credit packs',
  manifest: { name: 'Paid API', services: [service('paid-api')] },
  starterPrices: [
    { priceRef: 'calls-100', displayName: '100 calls', amountUsd: '5.00', kind: 'CREDIT_PACK', credits: 100 },
    { priceRef: 'calls-1000', displayName: '1,000 calls', amountUsd: '40.00', kind: 'CREDIT_PACK', credits: 1000 },
  ],
};
const PER_TASK: AgentTemplate = {
  templateId: 'per-task-agent',
  name: 'Per-task agent',
  description: 'A job your customers pay for per finished task',
  manifest: { name: 'Per-task agent', services: [service('per-task-agent')] },
  starterPrices: [],
};

const setup = () => harness({ OARS_API_KEY: 'key-123' });
const single = (text: string[]): unknown => JSON.parse(text.join(''));

describe('oars templates', () => {
  it('lists each template with its id, description and starter prices, then the deploy hint', async () => {
    const h = setup();
    const platform = fakePlatform({ templates: [PAID_API, PER_TASK] });

    expect(await run(['templates'], h.deps)).toBe(ExitCode.OK);

    expect(h.out.join('')).toBe(
      [
        'paid-api: Paid API',
        '  An HTTP API that charges per call through credit packs',
        '  Prices: calls-100 ($5.00, 100 credits), calls-1000 ($40.00, 1000 credits)',
        'per-task-agent: Per-task agent',
        '  A job your customers pay for per finished task',
        'Deploy one with: oars deploy --template <id>',
        '',
      ].join('\n'),
    );
    expect(platform.calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /agents/templates']);
  });

  it('--json prints {ok, templates} with the entries as the API serves them', async () => {
    const h = setup();
    fakePlatform({ templates: [PAID_API, PER_TASK] });

    expect(await run(['templates', '--json'], h.deps)).toBe(ExitCode.OK);

    expect(single(h.out)).toEqual({ ok: true, templates: [PAID_API, PER_TASK] });
  });

  it('says so, and exits 0, when the catalog is empty', async () => {
    const h = setup();
    fakePlatform();

    expect(await run(['templates'], h.deps)).toBe(ExitCode.OK);
    expect(h.out.join('')).toBe('No starter templates are available.\n');

    const json = setup();
    expect(await run(['templates', '--json'], json.deps)).toBe(ExitCode.OK);
    expect(single(json.out)).toEqual({ ok: true, templates: [] });
  });

  it('follows the pages until the last one', async () => {
    const h = setup();
    const platform = fakePlatform({ templates: [PAID_API, PER_TASK], templatesPerPage: 1 });

    expect(await run(['templates', '--json'], h.deps)).toBe(ExitCode.OK);

    expect(single(h.out)).toEqual({ ok: true, templates: [PAID_API, PER_TASK] });
    expect(platform.calls).toHaveLength(2);
  });

  it.each([
    [401, ExitCode.AUTH],
    [429, ExitCode.RATE_LIMITED],
    [500, ExitCode.UNEXPECTED],
  ])('an API error of %i is exit %i with the {ok: false, step, problem} document', async (status, exit) => {
    const h = setup();
    server.use(http.get(`${API}/agents/templates`, () => HttpResponse.json({ title: 'Nope', status }, { status })));

    expect(await run(['templates', '--json'], h.deps)).toBe(exit);

    expect(single(h.out)).toMatchObject({ ok: false, step: 'templates', problem: { title: 'Nope', status } });
  });

  it('exits 8 when the platform cannot be reached', async () => {
    const h = setup();
    server.use(http.get(`${API}/agents/templates`, () => HttpResponse.error()));

    expect(await run(['templates'], h.deps)).toBe(ExitCode.UNREACHABLE);
  });
});
