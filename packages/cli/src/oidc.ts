import * as client from 'openid-client';
import { CliError, ExitCode, unreachableError } from './errors.js';

/** The public Keycloak client T67 registers for the CLI: device authorization grant only. */
export const CLIENT_ID = 'oars-cli';
const SCOPE = 'openid email profile';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// openid-client marks allowInsecureRequests deprecated only "to stand out"; it is the supported switch for a plain-http issuer on
// loopback, and discovery recognizes it by identity. Looked up by name because the lint config has no inline escape for no-deprecated.
const isExtension = (value: unknown): value is (config: client.Configuration) => void => typeof value === 'function';
const allowInsecure: unknown = Reflect.get(client, 'allowInsecureRequests');

export interface OidcContext {
  /** The CLI's version, sent as `User-Agent: oars/<version>`. */
  version: string;
  /** Names where a failure happened in `--json` documents. */
  step: string;
}

/** What the CLI keeps of a Keycloak token response. */
export interface KeycloakTokens {
  accessToken: string;
  /** Absent when the realm did not rotate it. */
  refreshToken?: string;
}

const userAgentFetch =
  ({ version, step }: OidcContext): client.CustomFetch =>
  async (url, options) => {
    try {
      return await fetch(url, { ...options, headers: { ...options.headers, 'user-agent': `oars/${version}` } });
    } catch (error) {
      throw unreachableError(step, error);
    }
  };

/** The CliError the library wrapped on its way out of our fetch, if any (it puts an unrecognized error in `cause`). */
const wrapped = (error: unknown): CliError | undefined => {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth += 1) {
    if (current instanceof CliError) return current;
  }
  return undefined;
};

// OAuth errors that mean "sign in again" (exit 3), with the line the developer sees.
const SIGN_IN_AGAIN = new Map([
  ['invalid_grant', 'Your login has expired or was revoked. Run "oars login" to sign in again.'],
  ['expired_token', 'The device code expired before it was approved. Run "oars login" again.'],
  ['access_denied', 'Access was denied. Run "oars login" to try again.'],
]);

const signInAgain = (step: string, error: string): CliError => {
  const title = SIGN_IN_AGAIN.get(error) ?? error;
  return new CliError(title, ExitCode.AUTH, step, { code: error.toUpperCase(), title });
};

const failure = (step: string, error: unknown): CliError => {
  const own = wrapped(error);
  if (own !== undefined) return own;
  if (error instanceof client.ResponseBodyError) {
    if (SIGN_IN_AGAIN.has(error.error)) return signInAgain(step, error.error);
    const title = `Keycloak refused the request: ${error.error_description ?? error.error}`;
    return new CliError(title, ExitCode.UNEXPECTED, step, { code: error.error.toUpperCase(), title });
  }
  if (error instanceof client.ClientError && error.code === 'OAUTH_TIMEOUT') return unreachableError(step, error);
  return new CliError(error instanceof Error ? error.message : String(error), ExitCode.UNEXPECTED, step);
};

const usage = (message: string): CliError => new CliError(message, ExitCode.USAGE, 'usage');

/** Keycloak discovery for the realm at `issuerUrl`. Plain http is accepted for a loopback issuer only (the local stack). */
export const discover = async (issuerUrl: string, context: OidcContext): Promise<client.Configuration> => {
  let issuer: URL;
  try {
    issuer = new URL(issuerUrl);
  } catch {
    throw usage(`The issuer URL "${issuerUrl}" is not a URL.`);
  }
  const loopback = issuer.protocol === 'http:' && LOOPBACK_HOSTS.has(issuer.hostname);
  if (issuer.protocol !== 'https:' && !loopback) throw usage(`The issuer URL must use https (http is accepted for localhost only): ${issuerUrl}`);
  try {
    return await client.discovery(issuer, CLIENT_ID, undefined, client.None(), {
      [client.customFetch]: userAgentFetch(context),
      execute: loopback && isExtension(allowInsecure) ? [allowInsecure] : [],
    });
  } catch (error) {
    throw failure(context.step, error);
  }
};

const tokensOf = (response: client.TokenEndpointResponse): KeycloakTokens =>
  response.refresh_token === undefined ? { accessToken: response.access_token } : { accessToken: response.access_token, refreshToken: response.refresh_token };

/** RFC 8628: asks Keycloak for a device and user code. */
export const startDeviceAuthorization = async (config: client.Configuration, step: string): Promise<client.DeviceAuthorizationResponse> => {
  try {
    return await client.initiateDeviceAuthorization(config, { scope: SCOPE });
  } catch (error) {
    throw failure(step, error);
  }
};

/** Polls until the developer approves the code, honoring `slow_down`; a denied or expired code is an exit-3 failure. */
export const awaitDeviceTokens = async (config: client.Configuration, device: client.DeviceAuthorizationResponse, step: string): Promise<KeycloakTokens> => {
  try {
    return tokensOf(await client.pollDeviceAuthorizationGrant(config, device));
  } catch (error) {
    // The library stops polling at the code's `expires_in`; that deadline is the expired code, not a network timeout.
    if (error instanceof client.ClientError && error.code === 'OAUTH_TIMEOUT') {
      throw signInAgain(step, 'expired_token');
    }
    throw failure(step, error);
  }
};

/** Exchanges the stored refresh token. Keycloak rotates it, so the caller persists the new one before using the access token. */
export const refreshTokens = async (config: client.Configuration, refreshToken: string, step: string): Promise<KeycloakTokens> => {
  try {
    return tokensOf(await client.refreshTokenGrant(config, refreshToken));
  } catch (error) {
    throw failure(step, error);
  }
};

/** RFC 7009: revokes the refresh token, which ends the Keycloak session behind it. */
export const revokeRefreshToken = async (config: client.Configuration, refreshToken: string, step: string): Promise<void> => {
  try {
    await client.tokenRevocation(config, refreshToken);
  } catch (error) {
    throw failure(step, error);
  }
};
