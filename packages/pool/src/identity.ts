// Sign-in (pool vocabulary spec, Section 1.4): the pool brokers the provider's device flow (RFC 8628). The client asks the pool to start one, shows the person the code, and polls the pool; the pool calls the provider with its own client ID
// (and Google's client secret, held only as a Worker secret), reads the person with the token it received, and answers its own credential. The provider's tokens and device code never reach the client, and every token the pool reads
// was issued to its own client, so a token another app holds for a person cannot sign in as them. The person's id is hashed under a key the database never holds, so a read of the database names nobody: no email, login, provider id, or provider token is kept.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { answer, bodyOf, bound, fieldOf, notConfigured, refuse, textField, wholeBinding, type Env } from './http.js';

/** The id of the signing key until a deploy sets `BUNDLE_KEY_ID`: the name a client file from before key ids pins its one key under. */
const DEFAULT_KEY_ID = 'k1';

const TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

/** The hour a client's device-code requests are counted over (`login_starts.slot` is the epoch ms divided by this). */
export const LOGIN_START_WINDOW_MS = 60 * 60 * 1000;
/** Live credentials one account may hold (S8): a person signs in on a few machines (laptop, desktop, a build runner, a spare), so five is room for them, while a copied credential cannot ride beside an unbounded pile of others. A login past it revokes the oldest. */
const LIVE_TOKEN_CAP = 5;

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
  /** When the provider made the account (epoch ms), if its profile says. Google's does not, so a Google account's age is its first-seen time at the pool. */
  createdOf: (user: unknown) => number | undefined;
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
      createdOf: (user) => {
        const created = Date.parse(textField(user, 'created_at') ?? '');
        return Number.isNaN(created) ? undefined : created;
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
      createdOf: () => undefined,
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

/** The bearer token a request presents, whatever it is a token of. */
export const bearerOf = (request: Request): string | undefined => /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];

/** The account a bearer token belongs to. Only the token's hash is stored, so a read of the database signs nobody in. */
export const accountOf = async (request: Request, env: Env): Promise<string | undefined> => {
  const token = bearerOf(request);
  if (token === undefined) return undefined;
  const row = await env.DB.prepare('SELECT account FROM tokens WHERE hash = ? AND expires_at > ?').bind(hashToken(token), Date.now()).first();
  return hasAccount(row) ? row.account : undefined;
};

/** The refusal for a closed account (covenant 6.1: the operator closed it on request), or undefined when it is open or the pool has never seen it. Sign-in, machine enrollment, and activation answer it, so a closed account cannot get a new credential by any route. */
export const closedRefusal = async (env: Env, account: string): Promise<Response | undefined> => {
  const row = await env.DB.prepare('SELECT closed_at FROM accounts WHERE id = ?').bind(account).first();
  return row === null || fieldOf(row, 'closed_at') === null ? undefined : closedAccount();
};

/** The refusal for a restricted account (GDPR Art. 18: the operator restricted it on request), or undefined when it is not or the pool has never seen it. A deposit and a raw request answer it; no credential is revoked, so lifting the restriction restores the account whole. The export, an erasure, and the withdrawal do not ask. */
export const restrictedRefusal = async (env: Env, account: string): Promise<Response | undefined> => {
  const row = await env.DB.prepare('SELECT restricted_at FROM accounts WHERE id = ?').bind(account).first();
  return row === null || fieldOf(row, 'restricted_at') === null ? undefined : refuse(403, 'account_restricted', 'This account is restricted at your request: the pool keeps its data stored and takes nothing more until the restriction is lifted. Write to privacy@manyoars.com.');
};

/** `POST /v1/account/proof`: the account proves control of itself with its sign-in token and the pool stores the time (`proved_at`) for the operator to confirm a requester against (GDPR Art. 12(6)). The route is token-only: it reads the caller with `accountOf`, which a machine key is not (and `machine: false` in `ROUTES` answers a key 403 `deposit_only` before this runs), because a key may sit on a host and not with the person (Art. 32). A revoked, expired, or unknown token gets the usual 401. */
export const proveControl = async (request: Request, env: Env): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  const provedAt = Date.now();
  await env.DB.prepare('UPDATE accounts SET proved_at = ? WHERE id = ?').bind(provedAt, account).run();
  return answer(200, { account, provedAt }, { 'cache-control': 'private, no-store' });
};

/** `DELETE /v1/login`: revokes the credential the request presents, so a copy of it signs nobody in. 204 when it was live; a revoked, expired, or unknown credential gets the usual 401. */
export const logout = async (request: Request, env: Env): Promise<Response> => {
  const token = bearerOf(request);
  const revoked = token === undefined ? undefined : await env.DB.prepare('DELETE FROM tokens WHERE hash = ? AND expires_at > ?').bind(hashToken(token), Date.now()).run();
  return revoked?.meta.changes === 1 ? new Response(null, { status: 204 }) : refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
};

/** The id the bundle signing key is known by (S17), from `BUNDLE_KEY_ID`; `k1` until a rotation sets another, and undefined for one that is set but is not letters, digits, dot, dash, or underscore (at most 32): a typo must not label a key with a wrong id. A client pins each key under its id, so a bundle names the key that signed it. */
export const keyIdOf = (env: Env): string | undefined => {
  const set = bound(env.BUNDLE_KEY_ID);
  if (set === undefined) return DEFAULT_KEY_ID;
  return /^[A-Za-z0-9._-]{1,32}$/.test(set) ? set : undefined;
};

/** The half of the signing key a client pins at login. */
export const publicKeyOf = (privateJwk: string): { kty: unknown; crv: unknown; x: unknown } => {
  const parsed: unknown = JSON.parse(privateJwk);
  return { kty: fieldOf(parsed, 'kty'), crv: fieldOf(parsed, 'crv'), x: fieldOf(parsed, 'x') };
};

/** The key the login handles are sealed under, derived from `PSEUDONYM_KEY` by HKDF with a label of its own, so the secret itself is never a cipher key, no other use of it (the pseudonyms, the client hash) yields this key, and another Worker (another `PSEUDONYM_KEY`) cannot open this one's handles. */
const sealKeyOf = (pseudonymKey: string): Buffer => Buffer.from(hkdfSync('sha256', pseudonymKey, 'oars-pool', 'oars-pool login handle seal v2', 32));

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const EXPIRY_BYTES = 8;

interface Pending {
  provider: string;
  deviceCode: string;
  expiresAt: number;
}

/** The part of a handle that is readable but bound: the provider's name and the expiry. It is the AES-GCM associated data, so a change to either fails the tag instead of reaching the provider call. */
const headerOf = (provider: string, expiresAt: number): Buffer => {
  const name = Buffer.from(provider, 'utf8');
  const expiry = Buffer.alloc(EXPIRY_BYTES);
  expiry.writeBigUInt64BE(BigInt(expiresAt));
  return Buffer.concat([Buffer.from([name.length]), name, expiry]);
};

/** `base64url(nonce || header || ciphertext || tag)`, AES-256-GCM with the header as associated data: the client holds the handle and learns nothing of the device code in it, and a change anywhere in it, the provider and expiry included, fails the tag. */
const sealHandle = (pseudonymKey: string, pending: Pending): string => {
  const nonce = randomBytes(NONCE_BYTES);
  const header = headerOf(pending.provider, pending.expiresAt);
  const cipher = createCipheriv('aes-256-gcm', sealKeyOf(pseudonymKey), nonce);
  cipher.setAAD(header);
  const sealed = Buffer.concat([cipher.update(JSON.stringify({ deviceCode: pending.deviceCode }), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, header, sealed, cipher.getAuthTag()]).toString('base64url');
};

/** What a handle holds, or undefined for one this Worker did not seal or one whose provider or expiry was changed. */
const unsealHandle = (pseudonymKey: string, handle: string): Pending | undefined => {
  const bytes = Buffer.from(handle, 'base64url');
  const nameLength = bytes[NONCE_BYTES];
  if (nameLength === undefined) return undefined;
  const headerEnd = NONCE_BYTES + 1 + nameLength + EXPIRY_BYTES;
  if (bytes.length <= headerEnd + TAG_BYTES) return undefined;
  try {
    const header = bytes.subarray(NONCE_BYTES, headerEnd);
    const decipher = createDecipheriv('aes-256-gcm', sealKeyOf(pseudonymKey), bytes.subarray(0, NONCE_BYTES));
    decipher.setAAD(header);
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const text = Buffer.concat([decipher.update(bytes.subarray(headerEnd, bytes.length - TAG_BYTES)), decipher.final()]).toString('utf8');
    const deviceCode = textField(JSON.parse(text), 'deviceCode');
    if (deviceCode === undefined) return undefined;
    return { provider: header.subarray(1, 1 + nameLength).toString('utf8'), deviceCode, expiresAt: Number(header.readBigUInt64BE(1 + nameLength)) };
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

/** How many device-code requests one client may cause in an hour when `LOGIN_STARTS_PER_HOUR` is unset: a person starts a login a few times, a loop starts thousands. */
const DEFAULT_STARTS_PER_HOUR = 10;

/** The provider's `slow_down` adds this many seconds to the interval (RFC 8628, section 3.5). */
const SLOW_DOWN_SEC = 5;

/** The row key for a handle: its hash, so the table never holds a handle (which holds a device code, sealed). */
const handleHash = (handle: string): string => createHash('sha256').update(handle).digest('hex');

/** The first four hextets of an IPv6 address, `::` expanded, lower case: its /64, which one host holds whole and can rotate through at will. An address with a `.` (IPv4-mapped) is an IPv4 client and stays whole. */
const prefixOf = (address: string): string => {
  if (!address.includes(':') || address.includes('.')) return address;
  const [head = '', tail] = address.toLowerCase().split('::');
  const first = head === '' ? [] : head.split(':');
  const last = tail === undefined || tail === '' ? [] : tail.split(':');
  const filled = tail === undefined ? first : [...first, ...Array<string>(Math.max(0, 8 - first.length - last.length)).fill('0'), ...last];
  return filled.slice(0, 4).map((hextet) => hextet.padStart(4, '0')).join(':');
};

/** The client as the table counts it: an HMAC of its address (an IPv6 one by its /64) under `PSEUDONYM_KEY`, so the table holds no address. Cloudflare sets `cf-connecting-ip` on every request that reaches the Worker. */
const clientOf = (request: Request, pseudonymKey: string): string => createHmac('sha256', pseudonymKey).update(`login client:${prefixOf(request.headers.get('cf-connecting-ip') ?? 'unknown')}`).digest('hex');

/** `POST /v1/login/start` with `{ provider }`: asks the provider for a device code with the pool's own client ID, and answers the code to type, the link, the interval and lifetime, and a handle that holds the device code sealed. */
export const loginStart = async (request: Request, env: Env): Promise<Response> => {
  const name = textField(await bodyOf(request), 'provider') ?? '';
  const provider = PROVIDERS.get(name);
  if (provider === undefined) return refuse(400, 'unknown_provider', 'The provider is github or google.', 'provider');
  const pseudonymKey = bound(env.PSEUDONYM_KEY);
  if (pseudonymKey === undefined) return notConfigured('PSEUDONYM_KEY');
  const config = configOf(env, provider);
  if (config instanceof Response) return config;

  // Counted before the provider is called: this route spends the pool's own client ID's quota at the provider, so a loop on it is bounded here and not only by the WAF rule. A fault in the count refuses the start; a bound that opens when its store fails is no bound.
  const now = Date.now();
  const slot = Math.floor(now / LOGIN_START_WINDOW_MS);
  try {
    const counted = await env.DB.prepare('INSERT INTO login_starts (client, slot, count) VALUES (?, ?, 1) ON CONFLICT (client, slot) DO UPDATE SET count = count + 1 RETURNING count').bind(clientOf(request, pseudonymKey), slot).first();
    const started = fieldOf(counted, 'count');
    if (typeof started !== 'number') throw new Error('the count came back without a number');
    if (started > wholeBinding(env.LOGIN_STARTS_PER_HOUR, DEFAULT_STARTS_PER_HOUR)) {
      return refuse(429, 'rate_limited', 'Too many sign-ins were started from this address. Try again later.', undefined, { 'retry-after': String(Math.max(1, Math.ceil(((slot + 1) * LOGIN_START_WINDOW_MS - now) / 1000))) });
    }
  } catch {
    return refuse(503, 'login_unavailable', 'The sign-in could not be started. Try again.');
  }

  const reply = await formReply(provider.deviceUrl, [['client_id', config.clientId], ['scope', provider.scope]]);
  if (reply === undefined) return refuse(502, 'provider_error', 'The provider could not be reached.');
  const refusal = wordOf(reply.body);
  if (refusal !== undefined) return refuse(502, 'provider_error', `The provider refused to start the sign-in: ${refusal}.`);
  // Google names the link `verification_url`, against the RFC's `verification_uri`.
  const [deviceCode, userCode, verificationUrl] = [textField(reply.body, 'device_code'), textField(reply.body, 'user_code'), textField(reply.body, 'verification_uri') ?? textField(reply.body, 'verification_url')];
  if (deviceCode === undefined || userCode === undefined || verificationUrl === undefined || !URL.canParse(verificationUrl)) return refuse(502, 'provider_error', 'The provider did not start a sign-in.');
  const interval = positive(fieldOf(reply.body, 'interval'), DEFAULT_INTERVAL_SEC);
  const expiresIn = positive(fieldOf(reply.body, 'expires_in'), DEFAULT_EXPIRY_SEC);
  const expiresAt = Date.now() + expiresIn * 1000;
  const handle = sealHandle(pseudonymKey, { provider: name, deviceCode, expiresAt });
  // The provider's interval is the pool's to hold per handle (S7): the first poll may come when it says, and not before.
  try {
    await env.DB.prepare('INSERT INTO login_polls (handle_hash, next_at, interval_sec, expires_at) VALUES (?, ?, ?, ?)').bind(handleHash(handle), Date.now() + interval * 1000, interval, expiresAt).run();
  } catch {
    return refuse(503, 'login_unavailable', 'The sign-in could not be started. Try again.');
  }
  return answer(200, { handle, userCode, verificationUrl, interval, expiresIn });
};

/** The poll answers for a provider's OAuth error word: the person has not approved yet, the client is polling too fast, the code ran out, or the person said no. Any other word is the provider's trouble. */
const WAITING = new Map([
  ['authorization_pending', 'pending'],
  ['slow_down', 'slow_down'],
  ['expired_token', 'expired'],
  ['access_denied', 'denied'],
]);

const closedAccount = (): Response => refuse(403, 'account_closed', 'This account is closed. To reopen it, write to privacy@manyoars.com.');

/** A sign-in the pool refuses because the account is closed. The provider step finished, so the person has shown they control the account: the pool stores the time as `proved_at` (the operator confirms a requester against it, GDPR Art. 12(6)) and answers it with the account, so the person can send both in reply to the operator's request for proof. */
const provedClosed = async (env: Env, account: string): Promise<Response> => {
  const provedAt = Date.now();
  await env.DB.prepare('UPDATE accounts SET proved_at = ? WHERE id = ?').bind(provedAt, account).run();
  return answer(403, { error: 'account_closed', message: `This account is closed. Your sign-in was recorded at ${new Date(provedAt).toISOString()} as proof that you control it. To make a request about it, write to privacy@manyoars.com; if we asked you for proof, reply with the account and that time.`, account, provedAt });
};

/** Stores a credential's hash only while the account is open, in one statement, so a close that lands after the check in `closedRefusal` cannot leave a live token on a closed account. False when nothing was written. */
export const storeToken = async (env: Env, account: string, hash: string, expiresAt: number): Promise<boolean> => {
  const stored = await env.DB.prepare('INSERT INTO tokens (hash, account, expires_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ? AND closed_at IS NULL)').bind(hash, account, expiresAt, account).run();
  return stored.meta.changes === 1;
};

/** The pool's own credential for an account: only its hash is stored. Also when the table sheds the rows past their expiry, since they sign nobody in. */
export const credentialFor = async (env: Env, signingKey: string, kid: string, account: string, providerCreated: number | undefined): Promise<Response> => {
  if ((await closedRefusal(env, account)) !== undefined) return provedClosed(env, account);
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + TOKEN_LIFETIME_MS;
  // The two ages the cluster rule reads (t937): the pool's first sight of the account stays the first one, and the provider's creation time is refreshed, since a later login may be the first to carry it.
  await env.DB.prepare('INSERT INTO accounts (id, first_seen, provider_created) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET first_seen = COALESCE(accounts.first_seen, excluded.first_seen), provider_created = COALESCE(excluded.provider_created, accounts.provider_created)')
    .bind(account, now, providerCreated ?? null)
    .run();
  await env.DB.prepare('DELETE FROM tokens WHERE expires_at <= ?').bind(now).run();
  if (!(await storeToken(env, account, hashToken(token), expiresAt))) return provedClosed(env, account);
  // Newest first by rowid (the table is a rowid table, so a later credential has a later one); everything past the cap is the oldest and is revoked.
  await env.DB.prepare('DELETE FROM tokens WHERE account = ? AND rowid NOT IN (SELECT rowid FROM tokens WHERE account = ? ORDER BY rowid DESC LIMIT ?)').bind(account, account, LIVE_TOKEN_CAP).run();
  return answer(200, { status: 'authorized', token, account, expiresAt, kid, signingKey: publicKeyOf(signingKey) });
};

/** `POST /v1/login/poll` with `{ handle }`: one poll of the provider's token route for the device code the handle holds. Answers the state, or on approval the pool's credential, its expiry, and the public half of the signing key. */
export const loginPoll = async (request: Request, env: Env): Promise<Response> => {
  const handle = textField(await bodyOf(request), 'handle');
  if (handle === undefined) return refuse(400, 'missing_field', 'A poll names the login handle.', 'handle');
  const pseudonymKey = bound(env.PSEUDONYM_KEY);
  if (pseudonymKey === undefined) return notConfigured('PSEUDONYM_KEY');
  const signingKey = bound(env.BUNDLE_SIGNING_KEY);
  if (signingKey === undefined) return notConfigured('BUNDLE_SIGNING_KEY');
  const kid = keyIdOf(env);
  if (kid === undefined) return notConfigured('BUNDLE_KEY_ID');
  const pending = unsealHandle(pseudonymKey, handle);
  const provider = pending === undefined ? undefined : PROVIDERS.get(pending.provider);
  if (pending === undefined || provider === undefined) return refuse(401, 'invalid_handle', 'This pool did not issue that login handle. Start the login again.', 'handle');
  if (Date.now() >= pending.expiresAt) return answer(200, { status: 'expired' });
  const config = configOf(env, provider);
  if (config instanceof Response) return config;

  // The provider's interval is held here per handle, and a poll that comes early is answered `slow_down` without calling the provider, so a client cannot spend the pool's client ID's rate limit at the provider (S7).
  const now = Date.now();
  const hash = handleHash(handle);
  try {
    const claimed = await env.DB.prepare('UPDATE login_polls SET next_at = ? + interval_sec * 1000 WHERE handle_hash = ? AND next_at <= ?').bind(now, hash, now).run();
    if (claimed.meta.changes === 0) {
      const known = await env.DB.prepare('SELECT 1 AS known FROM login_polls WHERE handle_hash = ?').bind(hash).first();
      if (known === null) return refuse(401, 'invalid_handle', 'This pool has no record of that login handle. Start the login again.', 'handle');
      return answer(200, { status: 'slow_down' });
    }
  } catch {
    return refuse(503, 'login_unavailable', 'The poll could not be checked. Try again.');
  }

  const form: Array<[string, string]> = [['client_id', config.clientId], ['device_code', pending.deviceCode], ['grant_type', DEVICE_GRANT]];
  if (config.clientSecret !== undefined) form.push(['client_secret', config.clientSecret]);
  const reply = await formReply(provider.tokenUrl, form);
  if (reply === undefined) return refuse(502, 'provider_error', 'The provider could not be reached.');
  const accessToken = textField(reply.body, 'access_token');
  if (accessToken === undefined) {
    const word = wordOf(reply.body);
    const status = word === undefined ? undefined : WAITING.get(word);
    if (status === 'slow_down') {
      // The provider wants a longer wait: hold it for this handle, as the RFC has the client do.
      try {
        await env.DB.prepare('UPDATE login_polls SET interval_sec = interval_sec + ?, next_at = ? + (interval_sec + ?) * 1000 WHERE handle_hash = ?').bind(SLOW_DOWN_SEC, now, SLOW_DOWN_SEC, hash).run();
      } catch {
        return refuse(503, 'login_unavailable', 'The poll could not be checked. Try again.');
      }
    }
    if (status !== undefined) return answer(200, { status });
    return refuse(502, 'provider_error', word === undefined ? 'The provider did not answer the poll.' : `The provider refused the poll: ${word}.`);
  }

  const profile = await profileOf(provider.userUrl, accessToken);
  if (profile === undefined) return refuse(502, 'provider_error', 'The provider could not be reached.');
  // Only a 401 says the token is bad. GitHub answers a call over its rate limit with 403, so any other non-2xx answer is provider_error: the token may be fine. Whatever such a body names, it signs nobody in (S19).
  if (profile.status === 401) return refuse(401, 'login_refused', 'The provider did not accept the token.');
  if (profile.status < 200 || profile.status >= 300) return refuse(502, 'provider_error', 'The provider did not answer the profile read.');
  const userId = provider.userIdOf(profile.body);
  if (userId === undefined) return refuse(502, 'provider_error', 'The provider did not name the user.');
  return credentialFor(env, signingKey, kid, pseudonymOf(pseudonymKey, pending.provider, userId), provider.createdOf(profile.body));
};

/** `POST /v1/login` took a provider's token from the client, which let a token another app holds for a person sign in as them. It is gone, and an old client is told where to go. */
export const loginGone = (): Response => refuse(410, 'gone', 'POST /v1/login no longer takes a provider token. Sign in with POST /v1/login/start and POST /v1/login/poll.');
