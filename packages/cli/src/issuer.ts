import { CliError, ExitCode } from './errors.js';
import type { RunDeps } from './cli.js';

/**
 * The production Keycloak realm (the platform's k8s/configmap.yaml: KEYCLOAK_ISSUER_URI). It ships in the CLI, reviewed with it,
 * and is the default for `oars login`: no site or file can send a login anywhere else.
 */
export const PRODUCTION_ISSUER_URL = 'https://login.manyoars.com/realms/aor';

const UNAVAILABLE =
  'Cannot reach Many Oars sign-in at login.manyoars.com (it may not be deployed yet). Pass --issuer-url or set OARS_ISSUER_URL to use another issuer.';

/**
 * The built-in issuer is in use only when neither `--issuer-url` nor `OARS_ISSUER_URL` named one. If that issuer does not answer
 * discovery (no answer, an error status, or a body that is not discovery JSON), the platform is not up yet, so say so (exit 2) and
 * name the pool. An issuer the developer named keeps its own error.
 */
export const discoverIssuer = async <T>(deps: RunDeps, flag: string | undefined, discover: () => Promise<T>): Promise<T> => {
  try {
    return await discover();
  } catch (error) {
    const named = flag !== undefined || (deps.env.OARS_ISSUER_URL !== undefined && deps.env.OARS_ISSUER_URL !== '');
    const unanswered = error instanceof CliError && (error.exitCode === ExitCode.UNREACHABLE || error.exitCode === ExitCode.UNEXPECTED);
    if (!named && unanswered) throw new CliError(UNAVAILABLE, ExitCode.USAGE, 'usage');
    throw error;
  }
};

/** `--issuer-url`, else `OARS_ISSUER_URL`, else the built-in production issuer. */
export const resolveIssuerUrl = (deps: RunDeps, flag?: string): string => {
  if (flag !== undefined) return flag;
  const fromEnv = deps.env.OARS_ISSUER_URL;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return PRODUCTION_ISSUER_URL;
};
