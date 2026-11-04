import { describe, expect, it } from 'vitest';
import { ExitCode, exitCodeForProblem, unreachableError } from './errors.js';

// One row per line of design §3.2's exit-code table, keyed on the problem's code (or type), never on its text.
const ROWS: Array<[string, number, string, number]> = [
  ['401', 401, '', ExitCode.AUTH],
  ['403', 403, '', ExitCode.AUTH],
  ['SDK_KEY_INVALID', 401, 'SDK_KEY_INVALID', ExitCode.AUTH],
  ['MANIFEST_INVALID', 400, 'MANIFEST_INVALID', ExitCode.INVALID],
  ['MULTI_SERVICE_DISABLED', 400, 'MULTI_SERVICE_DISABLED', ExitCode.INVALID],
  ['PRICE_NOT_FOUND', 404, 'PRICE_NOT_FOUND', ExitCode.INVALID],
  ['PRICE_INACTIVE', 409, 'PRICE_INACTIVE', ExitCode.INVALID],
  ['FEE_POLICY_INVALID', 422, 'FEE_POLICY_INVALID', ExitCode.INVALID],
  ['LIVE_MODE_REQUIRED', 409, 'LIVE_MODE_REQUIRED', ExitCode.INVALID],
  ['TEST_MODE_ONLY', 409, 'TEST_MODE_ONLY', ExitCode.INVALID],
  ['other 400', 400, '', ExitCode.INVALID],
  ['other 422', 422, '', ExitCode.INVALID],
  ['IDEMPOTENCY_CONFLICT', 409, 'IDEMPOTENCY_CONFLICT', ExitCode.CONFLICT],
  ['WORKLOAD_FINGERPRINT_EXISTS', 409, 'WORKLOAD_FINGERPRINT_EXISTS', ExitCode.CONFLICT],
  ['ACCOUNT_NOT_READY', 409, 'ACCOUNT_NOT_READY', ExitCode.HUMAN],
  ['PAYMENT_METHOD_REQUIRED', 402, 'PAYMENT_METHOD_REQUIRED', ExitCode.HUMAN],
  ['INSUFFICIENT_CREDITS', 402, 'INSUFFICIENT_CREDITS', ExitCode.HUMAN],
  ['COMPUTE_CAP_REACHED', 409, 'COMPUTE_CAP_REACHED', ExitCode.HUMAN],
  ['RATE_LIMITED', 429, 'RATE_LIMITED', ExitCode.RATE_LIMITED],
  ['502', 502, '', ExitCode.UNREACHABLE],
  ['503', 503, '', ExitCode.UNREACHABLE],
  ['504', 504, '', ExitCode.UNREACHABLE],
  ['unknown type on a 5xx', 500, 'SOMETHING_NEW', ExitCode.UNEXPECTED],
  ['anything unmapped', 418, 'TEAPOT', ExitCode.UNEXPECTED],
];

describe('exitCodeForProblem', () => {
  it.each(ROWS)('%s -> status %i, code %s -> exit %i', (_name, status, code, exit) => {
    const problem = code === '' ? { title: 'x', detail: 'y' } : { code, title: 'a different title' };
    expect(exitCodeForProblem(status, problem)).toBe(exit);
  });

  it('reads the type when there is no code, and ignores the title and detail text', () => {
    expect(exitCodeForProblem(409, { type: 'IDEMPOTENCY_CONFLICT', title: 'Insufficient credits' })).toBe(ExitCode.CONFLICT);
    expect(exitCodeForProblem(400, { detail: 'PAYMENT_METHOD_REQUIRED' })).toBe(ExitCode.INVALID);
  });

  it('maps a response that has no problem body by status alone', () => {
    expect(exitCodeForProblem(503, undefined)).toBe(ExitCode.UNREACHABLE);
  });
});

describe('unreachableError', () => {
  it('names the server and the reason the network gave, not just undici\'s "fetch failed"', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.manyoars.com'), { code: 'ENOTFOUND' });
    const failure = unreachableError('api', new TypeError('fetch failed', { cause }), 'https://api.manyoars.com');
    expect(failure).toMatchObject({ exitCode: ExitCode.UNREACHABLE, step: 'api', message: 'Cannot reach the server at https://api.manyoars.com: getaddrinfo ENOTFOUND api.manyoars.com' });
  });

  it('keeps the error\'s own message when it has no cause, and a string as it is', () => {
    expect(unreachableError('api', new Error('socket hang up'), 'http://localhost:1').message).toBe('Cannot reach the server at http://localhost:1: socket hang up');
    expect(unreachableError('api', 'boom', 'http://localhost:1').message).toBe('Cannot reach the server at http://localhost:1: boom');
  });

  it('reads the failure of the first address when every address of a dual-stack host failed (Node 24: an AggregateError with an empty message)', () => {
    const cause = new AggregateError([new Error('connect ECONNREFUSED ::1:9'), new Error('connect ECONNREFUSED 127.0.0.1:9')], '');
    expect(unreachableError('api', new TypeError('fetch failed', { cause }), 'http://localhost:9').message).toBe('Cannot reach the server at http://localhost:9: connect ECONNREFUSED ::1:9');
  });

  it('falls back to the cause code, then the error message, whenever a message is empty', () => {
    const coded = Object.assign(new Error(''), { code: 'ECONNREFUSED' });
    expect(unreachableError('api', new TypeError('fetch failed', { cause: coded }), 'http://localhost:9').message).toBe('Cannot reach the server at http://localhost:9: ECONNREFUSED');
    expect(unreachableError('api', new TypeError('fetch failed', { cause: new AggregateError([], '') }), 'http://localhost:9').message).toBe('Cannot reach the server at http://localhost:9: fetch failed');
    expect(unreachableError('api', new TypeError('fetch failed', { cause: new Error('') }), 'http://localhost:9').message).toBe('Cannot reach the server at http://localhost:9: fetch failed');
    expect(unreachableError('api', new Error(''), 'http://localhost:9').message).toBe('Cannot reach the server at http://localhost:9: no reason given');
    expect(unreachableError('api', new Error('', { cause: new Error('') }), 'http://localhost:9').message).toBe('Cannot reach the server at http://localhost:9: no reason given');
  });

  it('leaves the server out when the caller names none (the sign-in flow reports Keycloak\'s answer)', () => {
    expect(unreachableError('login', new Error('Keycloak answered HTTP 503')).message).toBe('Cannot reach the server: Keycloak answered HTTP 503');
  });
});
