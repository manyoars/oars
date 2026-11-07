// One pool under the Workers runtime for a test file: the bundled handler and its D1 store in Miniflare's workerd, with a stub device-flow provider behind the Worker's outbound fetch. No account, no Docker, no network.
import { webcrypto } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Request as StubRequest, Response as StubResponse } from 'miniflare';
import { expect } from 'vitest';

interface Statement {
  first: (column?: string) => Promise<unknown>;
  all: () => Promise<{ results: readonly unknown[] }>;
  run: () => Promise<unknown>;
}

/** The D1 calls these tests make. Miniflare's own return type names a package whose ambient types clash with Node's, so it is named here. */
export interface TestDb {
  prepare: (sql: string) => Statement & { bind: (...values: (string | number | null)[]) => Statement };
}

/** The R2 calls these tests make, named for the same reason as `TestDb`. */
export interface TestBucket {
  list: (options?: { prefix?: string; cursor?: string }) => Promise<{ objects: readonly { key: string }[]; truncated?: boolean; cursor?: string }>;
  put: (key: string, value: string) => Promise<unknown>;
  get: (key: string) => Promise<{ text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> } | null>;
  delete: (keys: string[]) => Promise<void>;
}

export interface StubUser {
  id: string;
  login: string;
  email: string;
}

export interface StubCall {
  url: string;
  body: string;
}

const fileIn = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** The config the deploy uses, so the test runs what ships. The file is plain JSON apart from its leading comment lines. */
export const wranglerConfig = (): { compatibilityDate: string; compatibilityFlags: string[]; text: string; parsed: object } => {
  const text = readFileSync(fileIn('../wrangler.jsonc'), 'utf8');
  const parsed: unknown = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  if (typeof parsed !== 'object' || parsed === null || !('compatibility_date' in parsed) || typeof parsed.compatibility_date !== 'string') throw new Error('wrangler.jsonc has no compatibility_date');
  const flags: unknown = 'compatibility_flags' in parsed ? parsed.compatibility_flags : [];
  const entries: readonly unknown[] = Array.isArray(flags) ? flags : [];
  return { compatibilityDate: parsed.compatibility_date, compatibilityFlags: entries.filter((flag): flag is string => typeof flag === 'string'), text, parsed };
};

const json = (body: object, status = 200): StubResponse => new StubResponse(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface StubProvider {
  approve: (deviceCode: string, user: StubUser) => void;
  /** An access token the provider would hand this user, with no device flow in front of it: what the CLI sends the pool at login. */
  issue: (user: StubUser) => string;
  calls: StubCall[];
  /** URLs answered with an HTML 502, the way a provider's outage looks. */
  html: Set<string>;
  /** URLs answered 403, the way GitHub answers a call over its rate limit. */
  forbidden: Set<string>;
  outbound: (request: StubRequest) => Promise<StubResponse>;
}

/** GitHub and Google as the Worker and the CLI's login see them: the Worker reaches only the profile routes, and the device and token routes serve the full-run test, which plays the client. Google answers a pending poll with 428 and names its URL differently, which is why both are stubbed apart. */
const stubProvider = (): StubProvider => {
  const users = new Map<string, StubUser | null>();
  const calls: StubCall[] = [];
  const html = new Set<string>();
  const forbidden = new Set<string>();
  let issued = 0;
  const device = (): { device_code: string; user_code: string; expires_in: number; interval: number } => {
    issued += 1;
    const code = `device-${String(issued)}`;
    users.set(code, null);
    return { device_code: code, user_code: `USER-${String(issued)}`, expires_in: 900, interval: 1 };
  };
  const token = (form: URLSearchParams, pendingStatus: number): StubResponse => {
    const code = form.get('device_code') ?? '';
    const user = users.get(code);
    if (user === undefined) return json({ error: 'expired_token' }, 400);
    if (user === null) return json({ error: 'authorization_pending' }, pendingStatus);
    return json({ access_token: `access-${code}`, token_type: 'bearer' });
  };
  const outbound = async (request: StubRequest): Promise<StubResponse> => {
    const { origin, pathname } = new URL(request.url);
    const at = `${origin}${pathname}`;
    const body = await request.text();
    calls.push({ url: at, body });
    if (html.has(at)) return new StubResponse('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    if (forbidden.has(at)) return json({ message: 'API rate limit exceeded' }, 403);
    const form = new URLSearchParams(body);
    if (at === 'https://github.com/login/device/code') return json({ ...device(), verification_uri: 'https://github.com/login/device' });
    if (at === 'https://oauth2.googleapis.com/device/code') return json({ ...device(), verification_url: 'https://www.google.com/device' });
    if (at === 'https://github.com/login/oauth/access_token') return token(form, 200);
    if (at === 'https://oauth2.googleapis.com/token') return token(form, 428);
    const found = users.get((request.headers.get('authorization') ?? '').replace('Bearer access-', ''));
    if (typeof found !== 'object' || found === null) return json({ error: 'bad token' }, 401);
    if (at === 'https://api.github.com/user') return json({ id: Number(found.id), login: found.login, email: found.email, name: found.login });
    if (at === 'https://openidconnect.googleapis.com/v1/userinfo') return json({ sub: found.id, email: found.email, name: found.login });
    return json({ error: `no stub for ${at}` }, 500);
  };
  const issue = (user: StubUser): string => {
    const { device_code: code } = device();
    users.set(code, user);
    return `access-${code}`;
  };
  return { approve: (code, user) => users.set(code, user), issue, calls, html, forbidden, outbound };
};

export interface Answer {
  status: number;
  /** Null for an answer with no body, such as a 304. */
  json: unknown;
}

/** An answer with its headers, for the tests that read an ETag or a Retry-After. */
export interface RawAnswer extends Answer {
  headers: Headers;
}

export interface TestPool {
  miniflare: Miniflare;
  url: () => Promise<string>;
  db: () => Promise<TestDb>;
  /** The telemetry bucket the Worker keeps batches in. */
  bucket: () => Promise<TestBucket>;
  /** The raw tier's bucket, read straight from the binding: what the Worker wrote, never through a route. */
  rawBucket: () => Promise<TestBucket>;
  /** A request with any method and a text or byte body, for the raw tier's PUT and POST. */
  send: (path: string, init: { method: string; body?: string | Uint8Array }, token?: string, headers?: { [name: string]: string }) => Promise<RawAnswer>;
  post: (path: string, body: unknown, token?: string, headers?: { [name: string]: string }) => Promise<Answer>;
  get: (path: string, token?: string) => Promise<Answer>;
  raw: (path: string, token?: string, headers?: { [name: string]: string }) => Promise<RawAnswer>;
  /** What the CLI's own `fetch` reaches when it asks a provider for a device code or a token: the same stub the Worker's outbound calls reach, so one approval serves both. */
  providerFetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** The sign-in the CLI performs, with the provider's approval already given at the stub. */
  signIn: (provider: string, user: StubUser) => Promise<{ token: string; account: string; signingKey: unknown }>;
  stub: StubProvider;
  signingKey: () => { kty: string; crv: string; x: string };
  dispose: () => Promise<void>;
}

export const fieldOf = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

export const textOf = (value: unknown, key: string): string => {
  const found = fieldOf(value, key);
  if (typeof found !== 'string') throw new Error(`no text at ${key} in ${JSON.stringify(value)}`);
  return found;
};

const generatedKey = async (): Promise<{ jwk: string; x: string }> => {
  const pair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('no key pair');
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  return { jwk: JSON.stringify(jwk), x: jwk.x ?? '' };
};

/** `raw: false` leaves the R2 binding out, the way a pool deployed before its bucket exists looks. */
export const startPool = async (bindings: { [name: string]: string } = {}, options: { raw?: boolean } = {}): Promise<TestPool> => {
  const bundled = await build({ entryPoints: [fileIn('./worker.ts')], bundle: true, write: false, format: 'esm', platform: 'node', conditions: ['workerd', 'worker'], external: ['node:*'] });
  const contents = bundled.outputFiles[0]?.text;
  if (contents === undefined) throw new Error('the bundle is empty');
  const config = wranglerConfig();
  const stub = stubProvider();
  const key = await generatedKey();
  const miniflare = new Miniflare({
    name: 'pool',
    modules: [{ type: 'ESModule', path: 'worker.js', contents }],
    compatibilityDate: config.compatibilityDate,
    compatibilityFlags: config.compatibilityFlags,
    d1Databases: { DB: 'pool-test' },
    // The bindings wrangler.jsonc names. Miniflare's local Analytics Engine accepts a write and keeps nothing, so a test reads what the Worker wrote to it through a fake (telemetry.test.ts).
    r2Buckets: { TELEMETRY: 'telemetry-test', ...(options.raw === false ? {} : { RAW: 'oars-pool-raw' }) },
    analyticsEngineDatasets: { TELEMETRY_EVENTS: { dataset: 'oars_telemetry' } },
    bindings: { PSEUDONYM_KEY: 'a-test-pseudonym-key', INGEST_HASH_KEY: 'a-test-ingest-hash-key', BUNDLE_SIGNING_KEY: key.jwk, COVENANT_VERSION: 'v1', FETCH_CAP: '1000', ...bindings },
    outboundService: stub.outbound,
  });
  await miniflare.ready;
  const db = async (): Promise<TestDb> => (await miniflare.getBindings<{ DB: TestDb }>()).DB;
  const bucket = async (): Promise<TestBucket> => (await miniflare.getBindings<{ TELEMETRY: TestBucket }>()).TELEMETRY;
  const database = await db();
  for (const file of readdirSync(fileIn('../migrations')).sort()) {
    for (const line of readFileSync(fileIn(`../migrations/${file}`), 'utf8').split('\n')) if (line.trim() !== '' && !line.startsWith('--')) await database.prepare(line).run();
  }

  const rawBucket = async (): Promise<TestBucket> => (await miniflare.getBindings<{ RAW: TestBucket }>()).RAW;

  const call = async (path: string, init: { method: string; body?: string | Uint8Array }, token?: string, headers: { [name: string]: string } = {}): Promise<RawAnswer> => {
    const response = await miniflare.dispatchFetch(`http://pool.test${path}`, { ...init, headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers } });
    const text = await response.text();
    return { status: response.status, json: text === '' ? null : JSON.parse(text), headers: response.headers };
  };
  const post: TestPool['post'] = async (path, body, token, headers) => {
    const { status, json } = await call(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }, token, headers);
    return { status, json };
  };
  const raw: TestPool['raw'] = (path, token, headers) => call(path, { method: 'GET' }, token, headers);
  const get: TestPool['get'] = async (path, token) => {
    const { status, json } = await raw(path, token);
    return { status, json };
  };
  return {
    miniflare,
    url: async () => (await miniflare.ready).origin,
    db,
    bucket,
    rawBucket,
    send: call,
    post,
    get,
    raw,
    stub,
    providerFetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const stubbed = await stub.outbound(new StubRequest(String(input), { method: init?.method ?? 'GET', headers: [...headers.entries()], ...(typeof init?.body === 'string' ? { body: init.body } : {}) }));
      return new Response(await stubbed.text(), { status: stubbed.status, headers: { 'content-type': 'application/json' } });
    },
    signIn: async (provider, user) => {
      const signedIn = await post('/v1/login', { provider, token: stub.issue(user) });
      return { token: textOf(signedIn.json, 'token'), account: textOf(signedIn.json, 'account'), signingKey: fieldOf(signedIn.json, 'signingKey') };
    },
    signingKey: () => ({ kty: 'OKP', crv: 'Ed25519', x: key.x }),
    dispose: () => miniflare.dispose(),
  };
};

// Vitest types its matchers as `any`; these name what they stand for, so a test's expected shape stays checked.
export const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);
export const containing = (text: string): unknown => expect.stringContaining(text);
export const anyText = (): unknown => expect.any(String);
export const anyNumber = (): unknown => expect.any(Number);

export const stubUser = (id: string): StubUser => ({ id, login: `login-of-${id}`, email: `person-${id}@example.test` });
