import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './api.js';
import { ExitCode } from './errors.js';
import { API, harness } from './test-support.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('apiClient', () => {
  it('names the server and the reason the network gave when a request never gets an answer', async () => {
    const cause = new AggregateError([new Error('connect ECONNREFUSED ::1:9')], '');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed', { cause }));
    const { deps, sleeps } = harness();
    const failure = await apiClient(deps, { apiUrl: API, step: 'status' }).GET('/me/api-keys').catch((error: unknown) => error);
    expect(failure).toMatchObject({ exitCode: ExitCode.UNREACHABLE, step: 'status', message: `Cannot reach the server at ${API}: connect ECONNREFUSED ::1:9` });
    expect(sleeps).toHaveLength(3);
  });
});
