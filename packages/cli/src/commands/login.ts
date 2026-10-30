import { CliError, ExitCode } from '../errors.js';
import { resolveIssuerUrl } from '../issuer.js';
import { awaitDeviceTokens, discover, startDeviceAuthorization } from '../oidc.js';
import { exchangeKeycloakToken } from '../session.js';
import type { Outcome, RunDeps } from '../cli.js';

export interface LoginOptions {
  apiUrl: string;
  /** `--issuer-url`; `OARS_ISSUER_URL` when absent, then the built-in production issuer once Many Oars has launched (issuer.ts). */
  issuerUrl?: string;
  /** False for `--no-browser`. */
  browser: boolean;
}

const STEP = 'login';

/** RFC 8628 device flow on Keycloak, then the exchange; stores the credentials. */
export const login = async (deps: RunDeps, options: LoginOptions): Promise<Outcome> => {
  const issuerUrl = await resolveIssuerUrl(deps, options.issuerUrl);
  const config = await discover(issuerUrl, { ...deps, step: STEP });
  const device = await startDeviceAuthorization(config, STEP);
  const url = device.verification_uri_complete ?? device.verification_uri;
  deps.io.stderr(`To sign in, open ${url}\nand confirm the code ${device.user_code}\n`);
  if (options.browser) {
    await deps.openBrowser(url).catch(() => {
      deps.io.stderr('Could not open a browser; open the link above yourself.\n');
    });
  }
  const tokens = await awaitDeviceTokens(config, device, STEP);
  if (tokens.refreshToken === undefined) {
    throw new CliError('Keycloak returned no refresh token, so the login could not be kept.', ExitCode.UNEXPECTED, STEP);
  }
  const session = await exchangeKeycloakToken(deps, options.apiUrl, tokens.accessToken, STEP);
  const email = session.user.email;
  await deps.store.write({
    issuerUrl,
    apiUrl: options.apiUrl,
    email,
    refreshToken: tokens.refreshToken,
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
  });
  return { document: { ok: true, email }, text: `Logged in as ${email}` };
};
