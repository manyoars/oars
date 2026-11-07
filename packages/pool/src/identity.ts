// Sign-in (pool vocabulary spec, Section 1.4): the pool brokers the provider's device flow (RFC 8628). The client asks the pool to start one, shows the person the code, and polls the pool; the pool calls the provider with its own client ID
// (and Google's client secret, held only as a Worker secret), reads the person with the token it received, and answers its own credential. The provider's tokens and device code never reach the client, and every token the pool reads
// was issued to its own client, so a token another app holds for a person cannot sign in as them. The person's id is hashed under a key the database never holds, so a read of the database names nobody: no email, login, provider id, or provider token is kept.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { answer, bodyOf, bound, fieldOf, notConfigured, refuse, textField, type Env } from './http.js';

const TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/** What a provider that names no interval or expiry gets: RFC 8628's 5 seconds, and the 900 both providers use. */
const DEFAULT_INTERVAL_SEC = 5;
const DEFAULT_EXPIRY_SEC = 900;

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface Provider {
  deviceUrl: string;
  tokenUrl: string;
  userUrl: string;
  /** The least that names the account: Google's `openid` gives only `sub`, and GitHub's public profile needs no scope. */
  scope: string;
  clientIdBinding: 'GITHUB_CLIENT_ID' | 'GOOGLE_CLIENT_ID';
  /** Google's token route requires its client secret; GitHub's device flow takes none. */
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
      clientIdBinding: 'GITHUB_CLIENT_ID',
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
      clientIdBinding: 'GOOGLE_CLIENT_ID',
      secretBinding: 'GOOGLE_CLIENT_SECRET',
      userIdOf: (user) => textField(user, 'sub'),
    },
  ],
]);

interface ProviderReply {
  status: number;
  body: unknown;
}

/** The provider's answer: its status, and its body when it is JSON. Undefined when the provider cannot be reached, so the route says it could not. */
const providerReply = async (url: string, init: RequestInit): Promise<ProviderReply | undefined> => {
  try {
    const response = await fetch(url, init);
    return { status: response.status, body: await bodyOf(response) };
  } catch {
    return undefined;
  }
};

const profileOf = (url: string, accessToken: string): Promise<ProviderReply | undefined> => providerReply(url, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}`, 'user-agent': 'oars-pool' } });

/** One form POST to a provider's device or token route. The provider answers JSON on whatever status it chooses (Google's pending poll is a 428), so the caller reads the body and not the status. */
const formReply = (url: string, form: Array<[string, string]>): Promise<ProviderReply | undefined> =>
  providerReply(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'oars-pool' }, body: new URLSearchParams(form).toString() });

/** A provider's OAuth error word, if it is only lowercase letters and underscores: nothing else the provider sent is echoed back. */
const wordOf = (body: unknown): string | undefined => {
  const word = textField(body, 'error');
  return word !== undefined && /^[a-z_]{1,64}$/.test(word) ? word : undefined;
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

/** The key the login handles are sealed under, derived from `PSEUDONYM_KEY` by a fixed label so the secret itself is never a cipher key, and so another Worker (another `PSEUDONYM_KEY`) cannot open this one's handles. */
const sealKeyOf = (pseudonymKey: string): Buffer => createHmac('sha256', pseudonymKey).update('oars-pool login handle v1').digest();

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

interface Pending {
  provider: string;
  deviceCode: string;
  expiresAt: number;
}

/** `base64url(nonce || ciphertext || tag)`, AES-256-GCM: the client holds the handle and learns nothing of the device code in it, and a change anywhere in it fails the tag. */
const sealHandle = (pseudonymKey: string, pending: Pending): string => {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', sealKeyOf(pseudonymKey), nonce);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(pending), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString('base64url');
};

/** What a handle holds, or undefined for one this Worker did not seal. */
const unsealHandle = (pseudonymKey: string, handle: string): Pending | undefined => {
  const bytes = Buffer.from(handle, 'base64url');
  if (bytes.length <= NONCE_BYTES + TAG_BYTES) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', sealKeyOf(pseudonymKey), bytes.subarray(0, NONCE_BYTES));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const text = Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    const parsed: unknown = JSON.parse(text);
    const [provider, deviceCode, expiresAt] = [textField(parsed, 'provider'), textField(parsed, 'deviceCode'), fieldOf(parsed, 'expiresAt')];
    return provider !== undefined && deviceCode !== undefined && typeof expiresAt === 'number' ? { provider, deviceCode, expiresAt } : undefined;
  } catch {
    return undefined;
  }
};

/** The provider's settings, or the refusal naming the binding that is missing. Checked before any call goes out. */
const configOf = (env: Env, provider: Provider): { clientId: string; clientSecret: string | undefined } | Response => {
  const clientId = bound(env[provider.clientIdBinding]);
  if (clientId === undefined) return notConfigured(provider.clientIdBinding);
  if (provider.secretBinding === undefined) return { clientId, clientSecret: undefined };
  const clientSecret = bound(env[provider.secretBinding]);
  return clientSecret === undefined ? notConfigured(provider.secretBinding) : { clientId, clientSecret };
};

/** A positive number from the provider, or the default for one that is missing, zero, or negative: an interval of 0 would poll with no wait. */
const positive = (value: unknown, fallback: number): number => (typeof value === 'number' && value > 0 ? value : fallback);

/** `POST /v1/login/start` with `{ provider }`: asks the provider for a device code with the pool's own client ID, and answers the code to type, the link, the interval and lifetime, and a handle that holds the device code sealed. */
export const loginStart = async (request: Request, env: Env): Promise<Response> => {
  const name = textField(await bodyOf(request), 'provider') ?? '';
  const provider = PROVIDERS.get(name);
  if (provider === undefined) return refuse(400, 'unknown_provider', 'The provider is github or google.', 'provider');
  const pseudonymKey = bound(env.PSEUDONYM_KEY);
  if (pseudonymKey === undefined) return notConfigured('PSEUDONYM_KEY');
  const config = configOf(env, provider);
  if (config instanceof Response) return config;

  const reply = await formReply(provider.deviceUrl, [['client_id', config.clientId], ['scope', provider.scope]]);
  if (reply === undefined) return refuse(502, 'provider_error', 'The provider could not be reached.');
  const refusal = wordOf(reply.body);
  if (refusal !== undefined) return refuse(502, 'provider_error', `The provider refused to start the sign-in: ${refusal}.`);
  // Google names the link `verification_url`, against the RFC's `verification_uri`.
  const [deviceCode, userCode, verificationUrl] = [textField(reply.body, 'device_code'), textField(reply.body, 'user_code'), textField(reply.body, 'verification_uri') ?? textField(reply.body, 'verification_url')];
  if (deviceCode === undefined || userCode === undefined || verificationUrl === undefined || !URL.canParse(verificationUrl)) return refuse(502, 'provider_error', 'The provider did not start a sign-in.');
  const interval = positive(fieldOf(reply.body, 'interval'), DEFAULT_INTERVAL_SEC);
  const expiresIn = positive(fieldOf(reply.body, 'expires_in'), DEFAULT_EXPIRY_SEC);
  const handle = sealHandle(pseudonymKey, { provider: name, deviceCode, expiresAt: Date.now() + expiresIn * 1000 });
  return answer(200, { handle, userCode, verificationUrl, interval, expiresIn });
};

/** The poll answers for a provider's OAuth error word: the person has not approved yet, the client is polling too fast, the code ran out, or the person said no. Any other word is the provider's trouble. */
const WAITING = new Map([
  ['authorization_pending', 'pending'],
  ['slow_down', 'slow_down'],
  ['expired_token', 'expired'],
  ['access_denied', 'denied'],
]);

/** The pool's own credential for an account: only its hash is stored. Also when the table sheds the rows past their expiry, since they sign nobody in. */
const credentialFor = async (env: Env, signingKey: string, account: string): Promise<Response> => {
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + TOKEN_LIFETIME_MS;
  await env.DB.prepare('INSERT INTO accounts (id) VALUES (?) ON CONFLICT (id) DO NOTHING').bind(account).run();
  await env.DB.prepare('DELETE FROM tokens WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('INSERT INTO tokens (hash, account, expires_at) VALUES (?, ?, ?)').bind(hashToken(token), account, expiresAt).run();
  return answer(200, { status: 'authorized', token, account, expiresAt, signingKey: publicKeyOf(signingKey) });
};

/** `POST /v1/login/poll` with `{ handle }`: one poll of the provider's token route for the device code the handle holds. Answers the state, or on approval the pool's credential, its expiry, and the public half of the signing key. */
export const loginPoll = async (request: Request, env: Env): Promise<Response> => {
  const handle = textField(await bodyOf(request), 'handle');
  if (handle === undefined) return refuse(400, 'missing_field', 'A poll names the login handle.', 'handle');
  const pseudonymKey = bound(env.PSEUDONYM_KEY);
  if (pseudonymKey === undefined) return notConfigured('PSEUDONYM_KEY');
  const signingKey = bound(env.BUNDLE_SIGNING_KEY);
  if (signingKey === undefined) return notConfigured('BUNDLE_SIGNING_KEY');
  const pending = unsealHandle(pseudonymKey, handle);
  const provider = pending === undefined ? undefined : PROVIDERS.get(pending.provider);
  if (pending === undefined || provider === undefined) return refuse(401, 'invalid_handle', 'This pool did not issue that login handle. Start the login again.', 'handle');
  if (Date.now() >= pending.expiresAt) return answer(200, { status: 'expired' });
  const config = configOf(env, provider);
  if (config instanceof Response) return config;

  const form: Array<[string, string]> = [['client_id', config.clientId], ['device_code', pending.deviceCode], ['grant_type', DEVICE_GRANT]];
  if (config.clientSecret !== undefined) form.push(['client_secret', config.clientSecret]);
  const reply = await formReply(provider.tokenUrl, form);
  if (reply === undefined) return refuse(502, 'provider_error', 'The provider could not be reached.');
  const accessToken = textField(reply.body, 'access_token');
  if (accessToken === undefined) {
    const word = wordOf(reply.body);
    const status = word === undefined ? undefined : WAITING.get(word);
    if (status !== undefined) return answer(200, { status });
    return refuse(502, 'provider_error', word === undefined ? 'The provider did not answer the poll.' : `The provider refused the poll: ${word}.`);
  }

  const profile = await profileOf(provider.userUrl, accessToken);
  if (profile === undefined) return refuse(502, 'provider_error', 'The provider could not be reached.');
  // Only a 401 says the token is bad. GitHub answers a call over its rate limit with 403, so a 403 falls through to provider_error: the token may be fine.
  if (profile.status === 401) return refuse(401, 'login_refused', 'The provider did not accept the token.');
  const userId = provider.userIdOf(profile.body);
  if (userId === undefined) return refuse(502, 'provider_error', 'The provider did not name the user.');
  return credentialFor(env, signingKey, pseudonymOf(pseudonymKey, pending.provider, userId));
};

/** `POST /v1/login` took a provider's token from the client, which let a token another app holds for a person sign in as them. It is gone, and an old client is told where to go. */
export const loginGone = (): Response => refuse(410, 'gone', 'POST /v1/login no longer takes a provider token. Sign in with POST /v1/login/start and POST /v1/login/poll.');
