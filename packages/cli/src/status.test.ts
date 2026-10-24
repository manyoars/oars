import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { ExitCode } from './errors.js';
import { fakePlatform, WORKLOAD_ID, workloadView } from './fake-platform.js';
import { API, harness, server, useServer } from './test-support.js';

useServer();

describe('oars status', () => {
  it('--json: the workload and its billing mode, from GET workload then GET mode', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    const platform = fakePlatform({ billingMode: 'LIVE' });
    expect(await run(['status', WORKLOAD_ID, '--json'], h.deps)).toBe(ExitCode.OK);
    expect(platform.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`GET /agents/workloads/${WORKLOAD_ID}`, `GET /billing/agents/${WORKLOAD_ID}/mode`]);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] ?? '')).toEqual({ ok: true, workload: workloadView(), billingMode: 'LIVE' });
  });

  it('--json on an unknown workload: the whole failure document on stdout, exit 1, nothing on stderr', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    const problem = { code: 'WORKLOAD_NOT_FOUND', title: 'Workload not found', detail: `No workload ${WORKLOAD_ID}` };
    server.use(http.get(`${API}/agents/workloads/${WORKLOAD_ID}`, () => HttpResponse.json(problem, { status: 404, headers: { 'Content-Type': 'application/problem+json' } })));
    expect(await run(['status', WORKLOAD_ID, '--json'], h.deps)).toBe(ExitCode.UNEXPECTED);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] ?? '')).toEqual({ ok: false, step: 'status', problem: { ...problem, status: 404 } });
    expect(h.err).toEqual([]);
  });

  it('prints the name, the state and the billing mode for a human', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    fakePlatform();
    expect(await run(['status', WORKLOAD_ID], h.deps)).toBe(ExitCode.OK);
    const text = h.out.join('');
    for (const part of ['Paid API', 'RUNNING', 'TEST']) expect(text).toContain(part);
  });

  it('needs a workload id', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    expect(await run(['status'], h.deps)).toBe(ExitCode.USAGE);
  });
});
