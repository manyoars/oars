import type { components } from '@manyoars/oars-client';
import { apiClient, unwrap } from './api.js';
import { CliError, ExitCode } from './errors.js';
import { discover, refreshTokens } from './oidc.js';
import type { RunDeps } from './cli.js';
import type { StoredCredentials } from './credentials.js';

export type LoginSuccess = components['schemas']['LoginSuccess'];

/** Treat a token that expires within this window as expired, so it cannot lapse between the check and the call. */
const EXPIRY_SKEW_MS = 30_000;

/** `POST /auth/oidc/exchange`: the platform session for a Keycloak access token. The first exchange provisions DEVELOPER (T60). */
export const exchangeKeycloakToken = async (deps: RunDeps, apiUrl: string, keycloakAccessToken: string, step: string): Promise<LoginSuccess> => {
  const client = apiClient(deps, { apiUrl, step });
  return unwrap(step, await client.POST('/auth/oidc/exchange', { body: { accessToken: keycloakAccessToken } }));
};

const refreshLogin = async (deps: RunDeps, stored: StoredCredentials): Promise<string> => {
  const step = 'auth';
  const config = await discover(stored.issuerUrl, { version: deps.version, step });
  const tokens = await refreshTokens(config, stored.refreshToken, step);
  // Keycloak rotates the refresh token on every use, so the old one is already dead: save the new one before anything can fail.
  const rotated: StoredCredentials = { ...stored, refreshToken: tokens.refreshToken ?? stored.refreshToken };
  await deps.store.write(rotated);
  const session = await exchangeKeycloakToken(deps, stored.apiUrl, tokens.accessToken, step);
  await deps.store.write({ ...rotated, accessToken: session.accessToken, expiresAt: session.expiresAt });
  return session.accessToken;
};

/**
 * The bearer token for an API call. `OARS_API_KEY` wins over a stored login and touches no network; otherwise the stored
 * access token while it is valid, else one refreshed through Keycloak and exchanged.
 */
export const resolveAuthToken = async (deps: RunDeps): Promise<string> => {
  const key = deps.env.OARS_API_KEY;
  if (key !== undefined && key !== '') return key;
  const stored = await deps.store.read();
  if (stored === undefined) throw new CliError('Not logged in. Run "oars login", or set OARS_API_KEY.', ExitCode.AUTH, 'auth');
  if (Date.parse(stored.expiresAt) - EXPIRY_SKEW_MS > deps.now()) return stored.accessToken;
  return refreshLogin(deps, stored);
};
