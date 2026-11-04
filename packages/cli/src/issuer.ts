import { CliError, ExitCode } from './errors.js';
import type { RunDeps } from './cli.js';

/**
 * The production Keycloak realm (the platform's k8s/configmap.yaml: KEYCLOAK_ISSUER_URI). It ships in the CLI, reviewed with it:
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

/**
 * The built-in issuer is in use only when neither `--issuer-url` nor `OARS_ISSUER_URL` named one. If the flag is on but that
 * issuer does not answer discovery (no answer, an error status, or a body that is not discovery JSON), the platform is not
 * really open yet, so say what `login` says before launch (exit 2). An issuer the developer named keeps its own error.
 */
export const discoverIssuer = async <T>(deps: RunDeps, flag: string | undefined, discover: () => Promise<T>): Promise<T> => {
  try {
    return await discover();
  } catch (error) {
    const named = flag !== undefined || (deps.env.OARS_ISSUER_URL !== undefined && deps.env.OARS_ISSUER_URL !== '');
    const unanswered = error instanceof CliError && (error.exitCode === ExitCode.UNREACHABLE || error.exitCode === ExitCode.UNEXPECTED);
    if (!named && unanswered) throw new CliError(NOT_LAUNCHED, ExitCode.USAGE, 'usage');
    throw error;
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

const PURCHASING_CLOSED = 'Paid agents are not open yet, so `oars purchasing` is off. Set OARS_ISSUER_URL to use a platform of your own.';

/**
 * `oars purchasing` is closed to the public: the launch rule holds that nothing is sold before business verification, and the launch flag
 * is already true, so it cannot be the gate. Only `OARS_ISSUER_URL` (dev, staging, tests) opens it, with no network call.
 * Opening paid agents removes this gate.
 */
export const requirePurchasingOpen = (deps: RunDeps): void => {
  const fromEnv = deps.env.OARS_ISSUER_URL;
  if (fromEnv !== undefined && fromEnv !== '') return;
  throw new CliError(PURCHASING_CLOSED, ExitCode.USAGE, 'usage');
};
