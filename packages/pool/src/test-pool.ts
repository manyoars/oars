// One pool under the Workers runtime for a test file: the bundled handler and its D1 store in Miniflare's workerd, with a stub device-flow provider behind the Worker's outbound fetch. No account, no Docker, no network.
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, Response as StubResponse, type Request as StubRequest } from 'miniflare';
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
  deny: (deviceCode: string) => void;
  calls: StubCall[];
  /** URLs answered with an HTML 502, the way a provider's outage looks. */
  html: Set<string>;
  outbound: (request: StubRequest) => Promise<StubResponse>;
}

/** GitHub and Google as the Worker sees them. Google answers a pending poll with 428 and names its URL differently, which is why both are stubbed apart. */
const stubProvider = (): StubProvider => {
  const users = new Map<string, StubUser | 'denied' | null>();
  const calls: StubCall[] = [];
  const html = new Set<string>();
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
    if (user === 'denied') return json({ error: 'access_denied' }, 403);
    if (user === null) return json({ error: 'authorization_pending' }, pendingStatus);
    return json({ access_token: `access-${code}`, token_type: 'bearer' });
  };
  const outbound = async (request: StubRequest): Promise<StubResponse> => {
    const { origin, pathname } = new URL(request.url);
    const at = `${origin}${pathname}`;
    const body = await request.text();
    calls.push({ url: at, body });
    if (html.has(at)) return new StubResponse('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
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
  return { approve: (code, user) => users.set(code, user), deny: (code) => users.set(code, 'denied'), calls, html, outbound };
};

export interface Answer {
  status: number;
  json: unknown;
}

export interface TestPool {
  miniflare: Miniflare;
  url: () => Promise<string>;
  db: () => Promise<TestDb>;
  post: (path: string, body: unknown, token?: string) => Promise<Answer>;
  get: (path: string, token?: string) => Promise<Answer>;
  /** The whole device flow through the routes, approved at the stub. */
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

export const startPool = async (bindings: { [name: string]: string } = {}): Promise<TestPool> => {
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
    bindings: { PSEUDONYM_KEY: 'a-test-pseudonym-key', GITHUB_CLIENT_ID: 'github-client', GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret', SLICE_SIGNING_KEY: key.jwk, COVENANT_VERSION: 'v1', ...bindings },
    outboundService: stub.outbound,
  });
  await miniflare.ready;
  const db = async (): Promise<TestDb> => (await miniflare.getBindings<{ DB: TestDb }>()).DB;
  const database = await db();
  const migration = readFileSync(fileIn('../migrations/0001_init.sql'), 'utf8');
  for (const line of migration.split('\n')) if (line.startsWith('CREATE')) await database.prepare(line).run();

  const call = async (path: string, init: { method: string; body?: string }, token?: string): Promise<Answer> => {
    const response = await miniflare.dispatchFetch(`http://pool.test${path}`, { ...init, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
    return { status: response.status, json: await response.json() };
  };
  const post: TestPool['post'] = (path, body, token) => call(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }, token);
  const get: TestPool['get'] = (path, token) => call(path, { method: 'GET' }, token);
  return {
    miniflare,
    url: async () => (await miniflare.ready).origin,
    db,
    post,
    get,
    stub,
    signIn: async (provider, user) => {
      const started = await post('/v1/login/start', { provider });
      const deviceCode = textOf(started.json, 'deviceCode');
      stub.approve(deviceCode, user);
      const polled = await post('/v1/login/poll', { provider, deviceCode });
      return { token: textOf(polled.json, 'token'), account: textOf(polled.json, 'account'), signingKey: fieldOf(polled.json, 'signingKey') };
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
