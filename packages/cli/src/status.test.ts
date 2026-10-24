import { describe, expect, it } from 'vitest';
import { run } from './cli.js';
import { ExitCode } from './errors.js';
import { fakePlatform, WORKLOAD_ID } from './fake-platform.js';
import { harness, useServer } from './test-support.js';

useServer();

describe('oars status', () => {
  it('--json: the workload and its billing mode, from GET workload then GET mode', async () => {
    const h = harness({ OARS_API_KEY: 'key-123' });
    const platform = fakePlatform({ billingMode: 'LIVE' });
    expect(await run(['status', WORKLOAD_ID, '--json'], h.deps)).toBe(ExitCode.OK);
    expect(platform.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`GET /agents/workloads/${WORKLOAD_ID}`, `GET /billing/agents/${WORKLOAD_ID}/mode`]);
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0] ?? '')).toMatchObject({ ok: true, workload: { id: WORKLOAD_ID, name: 'Paid API' }, billingMode: 'LIVE' });
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
