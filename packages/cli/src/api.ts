import { createOarsClient, DEFAULT_API_URL, type OarsClient } from '@manyoars/oars-client';
import { problemError, unreachableError } from './errors.js';
import { retryingFetch } from './retry.js';
import type { RunDeps } from './cli.js';

/** `--api-url`, else `OARS_API_URL`, else production. */
export const resolveApiUrl = (deps: RunDeps, flag?: string): string => flag ?? (deps.env.OARS_API_URL === undefined || deps.env.OARS_API_URL === '' ? DEFAULT_API_URL : deps.env.OARS_API_URL);

/**
 * The generated client with design §3.2's retries underneath it. A request that never gets an answer, even after the
 * retries, surfaces as an exit-8 CliError; `step` names where in `--json` documents.
 */
export const apiClient = (deps: RunDeps, options: { apiUrl: string; step: string; token?: string }): OarsClient => {
  const send = retryingFetch((request) => fetch(request), deps);
  return createOarsClient({
    version: deps.version,
    baseUrl: options.apiUrl,
    ...(options.token === undefined ? {} : { token: options.token }),
    fetch: async (request) => {
      try {
        return await send(request);
      } catch (error) {
        throw unreachableError(options.step, error);
      }
    },
  });
};

/** What openapi-fetch returns for any call: `data` on a 2xx with a body, else `error` (the parsed body, or text). */
interface ApiResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** The body of a successful call; a non-2xx answer becomes the CliError its problem maps to. */
export const unwrap = <T>(step: string, result: ApiResult<T>): T => {
  if (result.response.ok && result.data !== undefined) return result.data;
  throw problemError(step, result.response.status, result.error);
};
