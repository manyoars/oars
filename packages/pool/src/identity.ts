// Sign-in (pool vocabulary spec, Section 3): the client runs the GitHub or Google device flow itself and sends the provider's access token here once, in one route. The token is used once, to learn
// the stable user id, and dropped. That id is hashed under a key the database never holds, so a read of the database names nobody: no email, login, provider id, or provider token is kept.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { answer, bodyOf, bound, fieldOf, notConfigured, refuse, textField, type Env } from './http.js';

const TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

interface Provider {
  userUrl: string;
  userIdOf: (user: unknown) => string | undefined;
}

const PROVIDERS = new Map<string, Provider>([
  [
    'github',
    {
      userUrl: 'https://api.github.com/user',
      userIdOf: (user) => {
        const id = fieldOf(user, 'id');
        return typeof id === 'number' ? String(id) : undefined;
      },
    },
  ],
  [
    'google',
    {
      userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      userIdOf: (user) => textField(user, 'sub'),
    },
  ],
]);

/** The provider's answer to the profile read: its status, and its body when it is JSON. Undefined when the provider cannot be reached, so the route says it could not. */
const profileOf = async (url: string, accessToken: string): Promise<{ status: number; body: unknown } | undefined> => {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, 'user-agent': 'oars-pool' } });
    return { status: response.status, body: await bodyOf(response) };
  } catch {
    return undefined;
  }
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

/** `POST /v1/login` with `{ provider, token }`: the provider's access token, read once for its subject and not kept. Answers the pool's own credential, its expiry, and the public half of the signing key. */
export const login = async (request: Request, env: Env): Promise<Response> => {
  const body = await bodyOf(request);
  const name = textField(body, 'provider') ?? '';
  const provider = PROVIDERS.get(name);
  if (provider === undefined) return refuse(400, 'unknown_provider', 'The provider is github or google.', 'provider');
  const accessToken = textField(body, 'token');
  if (accessToken === undefined) return refuse(400, 'missing_field', "A login names the provider's token.", 'token');
  const pseudonymKey = bound(env.PSEUDONYM_KEY);
  if (pseudonymKey === undefined) return notConfigured('PSEUDONYM_KEY');
  const signingKey = bound(env.SLICE_SIGNING_KEY);
  if (signingKey === undefined) return notConfigured('SLICE_SIGNING_KEY');

  const profile = await profileOf(provider.userUrl, accessToken);
  if (profile === undefined) return refuse(502, 'provider_error', 'The provider could not be reached.');
  if (profile.status === 401 || profile.status === 403) return refuse(401, 'login_refused', 'The provider did not accept the token.');
  const userId = provider.userIdOf(profile.body);
  if (userId === undefined) return refuse(502, 'provider_error', 'The provider did not name the user.');

  const account = pseudonymOf(pseudonymKey, name, userId);
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + TOKEN_LIFETIME_MS;
  await env.DB.prepare('INSERT INTO accounts (id) VALUES (?) ON CONFLICT (id) DO NOTHING').bind(account).run();
  // A row past its expiry signs nobody in, so a login is also when the table sheds them.
  await env.DB.prepare('DELETE FROM tokens WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('INSERT INTO tokens (hash, account, expires_at) VALUES (?, ?, ?)').bind(hashToken(token), account, expiresAt).run();
  return answer(200, { token, account, expiresAt, signingKey: publicKeyOf(signingKey) });
};
