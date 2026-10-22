import { randomUUID } from 'node:crypto';
import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { paths } from './generated/schema.js';

export const DEFAULT_API_URL = 'https://api.manyoars.com';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface OarsClientOptions {
  /** The caller's own version (the CLI's, a template's), sent as `User-Agent: oars/<version>`. */
  version: string;
  /** A developer API key, an access token or an SDK key, sent as `Authorization: Bearer <token>`; no header when unset. */
  token?: string;
  /** Defaults to the production API. */
  baseUrl?: string;
  /** Replaces the global fetch; the tests inject theirs. */
  fetch?: (request: Request) => Promise<Response>;
}

export type OarsClient = Client<paths>;

/**
 * The typed openapi-fetch client plus the three headers every call carries. A mutation without an `Idempotency-Key` gets a
 * fresh UUID; a caller that retries (the CLI's deploy steps, a template's reservation) passes its own key so the platform
 * can replay.
 */
export const createOarsClient = (options: OarsClientOptions): OarsClient => {
  const client = createClient<paths>({ baseUrl: options.baseUrl ?? DEFAULT_API_URL, fetch: options.fetch });
  const middleware: Middleware = {
    onRequest: ({ request }) => {
      request.headers.set('User-Agent', `oars/${options.version}`);
      if (options.token !== undefined) request.headers.set('Authorization', `Bearer ${options.token}`);
      if (MUTATING_METHODS.has(request.method) && !request.headers.has('Idempotency-Key')) {
        request.headers.set('Idempotency-Key', randomUUID());
      }
      return request;
    },
  };
  client.use(middleware);
  return client;
};
