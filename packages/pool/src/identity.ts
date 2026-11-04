// Sign-in (recall spec Section 5): GitHub or Google device flow, run from the server because Google's token route takes a client secret. The provider's access token is used once,
// to learn the stable user id, and dropped. That id is hashed under a key the database never holds, so a read of the database names nobody: no email, login, or provider id is kept.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { answer, bodyOf, bound, fieldOf, notConfigured, refuse, textField, type Env } from './http.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

interface Provider {
  deviceUrl: string;
  tokenUrl: string;
  userUrl: string;
  /** The least that names the user: GitHub's public profile needs no scope, and Google's `openid` gives only `sub`. */
  scope: string;
  clientBinding: 'GITHUB_CLIENT_ID' | 'GOOGLE_CLIENT_ID';
  /** Google's device flow requires its client secret at the token route; GitHub's refuses nothing without one. */
  secretBinding?: 'GOOGLE_CLIENT_SECRET';
  userIdOf: (user: unknown) => string | undefined;
}

const PROVIDERS = new Map<string, Provider>([
  [
    'github',
    {
      deviceUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      userUrl: 'https://api.github.com/user',
      scope: '',
      clientBinding: 'GITHUB_CLIENT_ID',
      userIdOf: (user) => {
        const id = fieldOf(user, 'id');
        return typeof id === 'number' ? String(id) : undefined;
      },
    },
  ],
  [
    'google',
    {
      deviceUrl: 'https://oauth2.googleapis.com/device/code',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scope: 'openid',
      clientBinding: 'GOOGLE_CLIENT_ID',
      secretBinding: 'GOOGLE_CLIENT_SECRET',
      userIdOf: (user) => textField(user, 'sub'),
    },
  ],
]);

const unknownProvider = (): Response => refuse(400, 'unknown_provider', 'The provider is github or google.', 'provider');

/** Both providers answer JSON on the status they choose (Google's pending poll is a 428), so the body decides and the status does not. Undefined when the body is not JSON or the provider cannot be reached, and the route refuses by the field it needed. */
const providerBody = async (url: string, init: RequestInit): Promise<unknown> => {
  try {
    return await bodyOf(await fetch(url, init));
  } catch {
    return undefined;
  }
};

const askProvider = (url: string, form: URLSearchParams): Promise<unknown> => providerBody(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });

export const loginStart = async (request: Request, env: Env): Promise<Response> => {
  const provider = PROVIDERS.get(textField(await bodyOf(request), 'provider') ?? '');
  if (provider === undefined) return unknownProvider();
  const clientId = bound(env[provider.clientBinding]);
  if (clientId === undefined) return notConfigured(provider.clientBinding);
  const device = await askProvider(provider.deviceUrl, new URLSearchParams({ client_id: clientId, scope: provider.scope }));
  const deviceCode = textField(device, 'device_code');
  const userCode = textField(device, 'user_code');
  // Google names this `verification_url`, against the RFC's `verification_uri`.
  const verificationUri = textField(device, 'verification_uri') ?? textField(device, 'verification_url');
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) return refuse(502, 'provider_error', 'The provider did not start a device flow.');
  return answer(200, { deviceCode, userCode, verificationUri, interval: fieldOf(device, 'interval') ?? 5, expiresIn: fieldOf(device, 'expires_in') ?? 900 });
};

/** The same person on the same provider is always this account; the same id on another provider is not, since nothing joins them. */
const pseudonymOf = (key: string, provider: string, userId: string): string => `acct_${createHmac('sha256', key).update(`${provider}:${userId}`).digest('hex').slice(0, 32)}`;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const hasAccount = (row: unknown): row is { account: string } => textField(row, 'account') !== undefined;

/** The account a bearer token belongs to. Only the token's hash is stored, so a read of the database signs nobody in. */
export const accountOf = async (request: Request, env: Env): Promise<string | undefined> => {
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (token === undefined) return undefined;
  const row = await env.DB.prepare('SELECT account FROM tokens WHERE hash = ? AND expires_at > ?').bind(hashToken(token), Date.now()).first();
  return hasAccount(row) ? row.account : undefined;
};

/** The half of the signing key a client pins at login. */
export const publicKeyOf = (privateJwk: string): { kty: unknown; crv: unknown; x: unknown } => {
  const parsed: unknown = JSON.parse(privateJwk);
  return { kty: fieldOf(parsed, 'kty'), crv: fieldOf(parsed, 'crv'), x: fieldOf(parsed, 'x') };
};

const PENDING = new Set(['authorization_pending', 'slow_down']);

export const loginPoll = async (request: Request, env: Env): Promise<Response> => {
  const body = await bodyOf(request);
  const name = textField(body, 'provider') ?? '';
  const provider = PROVIDERS.get(name);
  if (provider === undefined) return unknownProvider();
  const deviceCode = textField(body, 'deviceCode');
  if (deviceCode === undefined) return refuse(400, 'missing_field', 'A poll names its deviceCode.', 'deviceCode');
  const clientId = bound(env[provider.clientBinding]);
  if (clientId === undefined) return notConfigured(provider.clientBinding);
  const pseudonymKey = bound(env.PSEUDONYM_KEY);
  if (pseudonymKey === undefined) return notConfigured('PSEUDONYM_KEY');
  const signingKey = bound(env.BUNDLE_SIGNING_KEY);
  if (signingKey === undefined) return notConfigured('BUNDLE_SIGNING_KEY');
  const secret = provider.secretBinding === undefined ? undefined : bound(env[provider.secretBinding]);
  if (provider.secretBinding !== undefined && secret === undefined) return notConfigured(provider.secretBinding);

  const form = new URLSearchParams({ client_id: clientId, device_code: deviceCode, grant_type: DEVICE_GRANT, ...(secret === undefined ? {} : { client_secret: secret }) });
  const granted = await askProvider(provider.tokenUrl, form);
  if (granted === undefined) return refuse(502, 'provider_error', 'The provider did not answer in JSON.');
  const accessToken = textField(granted, 'access_token');
  if (accessToken === undefined) {
    const error = textField(granted, 'error') ?? 'no_token';
    return PENDING.has(error) ? answer(200, { status: 'pending', ...(error === 'slow_down' ? { slowDown: true } : {}) }) : refuse(401, 'login_refused', `The provider refused the sign-in: ${error}.`);
  }
  const profile = await providerBody(provider.userUrl, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, 'user-agent': 'oars-pool' } });
  const userId = provider.userIdOf(profile);
  if (userId === undefined) return refuse(502, 'provider_error', 'The provider did not name the user.');

  const account = pseudonymOf(pseudonymKey, name, userId);
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_LIFETIME_MS;
  await env.DB.prepare('INSERT INTO accounts (id) VALUES (?) ON CONFLICT (id) DO NOTHING').bind(account).run();
  await env.DB.prepare('INSERT INTO tokens (hash, account, expires_at) VALUES (?, ?, ?)').bind(hashToken(token), account, expiresAt).run();
  return answer(200, { status: 'ok', token, account, expiresAt, signingKey: publicKeyOf(signingKey) });
};
