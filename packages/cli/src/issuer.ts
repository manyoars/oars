import { CliError, ExitCode } from './errors.js';
import type { RunDeps } from './cli.js';

/**
 * The production Keycloak realm (aor-platform/k8s/configmap.yaml: KEYCLOAK_ISSUER_URI). It ships in the CLI, reviewed with it:
 * the launch flag below only switches it on, so a compromised site cannot send logins anywhere else.
 */
export const PRODUCTION_ISSUER_URL = 'https://login.manyoars.com/realms/aor';

/** The marketing site serves `{"launched": true}` here from launch day. */
export const LAUNCH_FLAG_URL = 'https://manyoars.com/.well-known/oars.json';

const FLAG_TIMEOUT_MS = 5000;

const NOT_LAUNCHED = 'Many Oars has not launched yet: pass --issuer-url or set OARS_ISSUER_URL.';

/** True only for a 200 answer whose JSON is an object with `launched: true`; every other answer, or none, means not launched. */
const hasLaunched = async (deps: RunDeps): Promise<boolean> => {
  try {
    const response = await fetch(LAUNCH_FLAG_URL, {
      headers: { 'User-Agent': `oars/${deps.version}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(FLAG_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && Reflect.get(body, 'launched') === true;
  } catch {
    return false;
  }
};

/** `--issuer-url`, else `OARS_ISSUER_URL`, else the built-in production issuer once the launch flag is on. */
export const resolveIssuerUrl = async (deps: RunDeps, flag?: string): Promise<string> => {
  if (flag !== undefined) return flag;
  const fromEnv = deps.env.OARS_ISSUER_URL;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  if (await hasLaunched(deps)) return PRODUCTION_ISSUER_URL;
  throw new CliError(NOT_LAUNCHED, ExitCode.USAGE, 'usage');
};
