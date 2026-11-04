import { createHash } from 'node:crypto';
import type { components } from '@manyoars/oars-client';
import { apiClient, unwrap } from '../api.js';
import { CliError, ExitCode } from '../errors.js';
import { resolveAuthToken } from '../session.js';
import type { Outcome, RunDeps } from '../cli.js';

type Key = components['schemas']['DeveloperApiKeyResponse'];

/** One step's `Idempotency-Key`: the lowercase SHA-256 hex of `<base>:<step>`, the 64-hex form every platform interceptor accepts. */
export const stepKey = (base: string, step: string): string => createHash('sha256').update(`${base}:${step}`).digest('hex');

const CREATE_STEP = 'keys-create';
const LIST_STEP = 'keys-list';
const REVOKE_STEP = 'keys-revoke';

// A developer's keys fit one request nearly always; the loop below only covers one that outgrows it.
const PAGE_SIZE = 100;

/** The only authorities a key scoped to one workload may carry; the platform answers 400 API_KEY_WORKLOAD_SCOPE_EXCEEDS_CAP for more. */
export const SCOPED_AUTHORITIES = ['AGENT_OPERATE', 'AGENT_READ'];

export interface KeysCreateOptions {
  apiUrl: string;
  name: string;
  /** Scopes the key to this one workload; absent for an ordinary key. */
  workloadId?: string;
  authorities: string[];
  expiresInDays?: number;
  /** The base of the step key, so a retry of this command replays the same answer (and, by design, no secret). */
  idempotencyKey: string;
}

export interface KeysListOptions {
  apiUrl: string;
}

export interface KeysRevokeOptions {
  apiUrl: string;
  keyId: string;
}

const describeKey = (key: Key): string =>
  [
    key.keyId,
    key.name,
    key.status,
    `${key.prefix}...`,
    key.workloadId === undefined ? 'all workloads' : `workload ${key.workloadId}`,
    key.authorities.join(','),
    key.expiresAt === undefined ? 'no expiry' : `expires ${key.expiresAt}`,
  ].join('  ');

/**
 * `POST /me/api-keys`: with `--workload` the key works on that one workload only. The secret prints once, here; the platform never
 * stores it, and a replay of the same request returns no secret.
 */
export const keysCreate = async (deps: RunDeps, options: KeysCreateOptions): Promise<Outcome> => {
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: CREATE_STEP, token: await resolveAuthToken(deps, options.apiUrl) });
  const issued = unwrap(
    CREATE_STEP,
    await client.POST('/me/api-keys', {
      params: { header: { 'Idempotency-Key': stepKey(options.idempotencyKey, CREATE_STEP) } },
      body: {
        name: options.name,
        authorities: options.authorities,
        ...(options.workloadId === undefined ? {} : { workloadId: options.workloadId }),
        ...(options.expiresInDays === undefined ? {} : { expiresInDays: options.expiresInDays }),
      },
    }),
  );
  if (issued.secret === undefined) {
    throw new CliError(
      `Key ${issued.key.keyId} was already created and its secret was shown once; the platform keeps no copy. Revoke it and create another.`,
      ExitCode.CONFLICT,
      CREATE_STEP,
    );
  }
  return {
    document: { ok: true, key: issued.key, secret: issued.secret },
    text: [`Created key: ${describeKey(issued.key)}.`, `Secret (shown once; save it now): ${issued.secret}`].join('\n'),
  };
};

/** `GET /me/api-keys`: the secrets never come back, only the prefix. */
export const keysList = async (deps: RunDeps, options: KeysListOptions): Promise<Outcome> => {
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: LIST_STEP, token: await resolveAuthToken(deps, options.apiUrl) });
  const keys: Key[] = [];
  for (let page = 0; ; page += 1) {
    const result = unwrap(LIST_STEP, await client.GET('/me/api-keys', { params: { query: { page, size: PAGE_SIZE } } }));
    keys.push(...result.content);
    if (result.last) break;
  }
  return { document: { ok: true, keys }, text: keys.length === 0 ? 'You have no API keys.' : keys.map(describeKey).join('\n') };
};

/** `DELETE /me/api-keys/{keyId}`: a bodyless 204; the key stops working at once. */
export const keysRevoke = async (deps: RunDeps, options: KeysRevokeOptions): Promise<Outcome> => {
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: REVOKE_STEP, token: await resolveAuthToken(deps, options.apiUrl) });
  const { response, error } = await client.DELETE('/me/api-keys/{keyId}', { params: { path: { keyId: options.keyId } } });
  if (!response.ok) unwrap(REVOKE_STEP, { error, response });
  return { document: { ok: true, keyId: options.keyId, revoked: true }, text: `Revoked key ${options.keyId}.` };
};
