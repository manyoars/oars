// One pool under the Workers runtime for a test file: the bundled handler and its D1 store in Miniflare's workerd, with a stub device-flow provider behind the Worker's outbound fetch. No account, no Docker, no network.
import { createHash, webcrypto } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, type PluginBuild } from 'esbuild';
import { convertV4MiniflareOptions, CoreHeaders, Miniflare, ProxyOps, Request as StubRequest, Response as StubResponse } from 'miniflare';
import { Agent, buildConnector } from 'undici';
import { expect } from 'vitest';
import type { Bound, PoolDb } from './http.js';

export { acceptanceOf } from './test-covenant-texts.js';

interface Statement {
  first: (column?: string) => Promise<unknown>;
  all: () => Promise<{ results: readonly unknown[] }>;
  run: () => Promise<unknown>;
}

/** The D1 calls these tests make. Miniflare's own return type names a package whose ambient types clash with Node's, so it is named here. */
export interface TestDb {
  prepare: (sql: string) => Statement & { bind: (...values: (string | number | null)[]) => Statement };
  batch: (statements: readonly Statement[]) => Promise<unknown>;
}

/** The R2 calls these tests make, named for the same reason as `TestDb`. */
export interface TestBucket {
  list: (options?: { prefix?: string; cursor?: string; limit?: number }) => Promise<{ objects: readonly { key: string }[]; truncated?: boolean; cursor?: string }>;
  put: (key: string, value: string) => Promise<unknown>;
  get: (key: string) => Promise<{ text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> } | null>;
  delete: (keys: string[]) => Promise<void>;
}

/**
 * The pool's D1 as `Env.DB` takes it, for a test that calls a route function directly. Miniflare runs one request at a time here, so a race between requests is scripted: `before` runs ahead of each statement's `run` and may hold it until the other requests have caught up.
 */
export const poolDbOf = (db: TestDb, before: (sql: string) => Promise<void> = () => Promise.resolve()): PoolDb => {
  // One statement reaches the database at a time (a burst of parallel calls resets Miniflare's sockets), so requests interleave between statements, never inside one.
  let turn: Promise<unknown> = Promise.resolve();
  const alone = <T>(call: () => Promise<T>): Promise<T> => {
    const next = turn.then(call);
    turn = next.catch(() => undefined);
    return next;
  };
  return {
    prepare: (sql) => ({
      bind: (...values): Bound => {
        const statement = db.prepare(sql).bind(...values);
        return {
          first: () => alone(() => statement.first()),
          all: () => alone(() => statement.all()),
          run: async () => {
            await before(sql);
            return alone(async () => ({ meta: { changes: Number(fieldOf(fieldOf(await statement.run(), 'meta'), 'changes')) } }));
          },
        };
      },
    }),
    batch: () => Promise.resolve([]),
  };
};

export interface StubUser {
  id: string;
  login: string;
  email: string;
  /** The `created_at` GitHub's profile states (ISO 8601). Absent, the stub states none. */
  createdAt?: string;
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

/** The payload header's text, or nothing when it is absent or not valid percent-encoding (a bare `URIError` would hide the Worker's failure). */
const decodedPayload = (encoded: string | null): string => {
  if (encoded === null) return '';
  try {
    return decodeURIComponent(encoded);
  } catch {
    return '';
  }
};

/**
 * What Miniflare's `dispatchFetch` throws for a Worker exception: the Worker's own message and stack, so a failing test points at the Worker's line. The error rides in the body or, when that is empty, in the payload header.
 */
export const workerError = async (response: Response): Promise<Error> => {
  const encoded = response.headers.get('MF-Experimental-Error-Stack-Payload');
  const serialized = (await response.text()) || decodedPayload(encoded);
  let caught: unknown;
  try {
    caught = JSON.parse(serialized);
  } catch {
    return new Error(`the Worker threw a non-JSON error: ${serialized === '' ? '(empty)' : serialized}`);
  }
  const message = fieldOf(caught, 'message');
  const stack = fieldOf(caught, 'stack');
  const error = new Error(typeof message === 'string' ? message : serialized);
  if (typeof stack === 'string') error.stack = stack;
  return error;
};

/** The most of a request body the sender holds whole: a chosen bound, small enough that headers and body leave in one write in practice. Past it a body can reach workerd in several segments anyway. */
const WHOLE_BODY_BYTES = 64 * 1024;

export interface KeepAliveSender {
  send: Miniflare['dispatchFetch'];
  /** The connections the pool's own requests have opened. Miniflare's release requests ride another Agent and are not counted. */
  connects: () => number;
  /** The most of the pool's own requests sent and not yet answered at once. */
  peak: () => number;
  close: () => Promise<void>;
}

/**
 * Miniflare sends every `dispatchFetch` with `reset: true`, so undici closes the socket after each response: one loopback socket in TIME_WAIT for every request a test makes, and for every D1 or R2 call it makes through `getBindings` too, because the proxy client holds this same function. A full run opened about 9,000 and left about 5,400 in TIME_WAIT (Linux), enough to exhaust the dynamic port range when gates run together.
 * This sends the same request on a keep-alive undici Agent the pool owns instead, with the two headers Miniflare's own dispatcher adds. `entry` names the server the request goes to.
 */
export const keepAliveSender = (entry: () => Promise<URL>): KeepAliveSender => {
  // undici closes a socket idle for 4 s by default, and a test process starved by a loaded box can idle that long between two calls; each such close costs a reconnect and a TIME_WAIT
  // socket. Ten seconds covers the longest planned pause between calls (4.5 s) and stays below the 15 s after which workerd closes an idle socket itself, so the client never reuses a socket
  // the server may be closing. `close` closes both agents, so no socket outlives a pool.
  const keepAliveTimeout = { keepAliveTimeout: 10_000, keepAliveMaxTimeout: 10_000 };
  const connector = buildConnector({});
  let connects = 0;
  let peak = 0;
  const calls = new Agent({
    ...keepAliveTimeout,
    connect: (options, callback) => {
      connects += 1;
      connector(options, callback);
    },
  });
  // Miniflare frees the handles `getBindings` returned in a DELETE it sends on its own schedule (100 ms after a garbage collection), so it can be in flight while a test makes its next call. An Agent opens
  // a connection for a request that finds none idle; on the calls' Agent that DELETE would take the connection the call is about to reuse and cost it a connect. Its own Agent keeps the calls' count about the calls.
  const releases = new Agent(keepAliveTimeout);
  let inFlight = 0;
  const send: Miniflare['dispatchFetch'] = async (input, init) => {
    const forward = new StubRequest(input, init);
    const base = await entry();
    const sent = new URL(forward.url);
    const headers = new Headers([...forward.headers.entries()]);
    headers.set('MF-Original-URL', forward.url);
    headers.set('MF-Disable-Pretty-Error', 'true');
    const dispatcher = forward.headers.get(CoreHeaders.OP) === ProxyOps.FREE ? releases : calls;
    const counted = dispatcher === calls;
    if (counted) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
    }
    // A body handed on as a stream goes out as chunks and a closing chunk written apart from the headers. workerd closes the connection when a Worker answers before the body has all arrived, so on a
    // loaded box the next call would find its socket reset (the closing chunk's own write can be reset too, on a connection the request opened). A small body held whole goes out with its headers and a content-length in one write. A stream a test hands in stays a stream (it is the
    // case under test), and so does a body over what one write carries: the Worker answers those early on purpose.
    const held = init?.body;
    const small = typeof held === 'string' ? Buffer.byteLength(held) <= WHOLE_BODY_BYTES : held instanceof Uint8Array && held.byteLength <= WHOLE_BODY_BYTES;
    const body = forward.body === null ? undefined : small ? new Uint8Array(await forward.arrayBuffer()) : forward.body;
    let response: Response;
    try {
      response = await fetch(new URL(`${sent.pathname}${sent.search}`, base), { method: forward.method, headers, ...(body === undefined ? {} : body instanceof Uint8Array ? { body } : { body, duplex: 'half' }), redirect: forward.redirect, dispatcher });
    } finally {
      if (counted) inFlight -= 1;
    }
    if (response.status === 500 && response.headers.has('MF-Experimental-Error-Stack')) throw await workerError(response);
    return new StubResponse(response.body, { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()] });
  };
  return {
    send,
    connects: () => connects,
    peak: () => peak,
    close: async () => {
      await Promise.all([calls.close(), releases.close()]);
    },
  };
};

const json = (body: object, status = 200): StubResponse => new StubResponse(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The secret the stub Google client expects at its token route; the test pool binds it as `GOOGLE_CLIENT_SECRET`. */
export const TEST_GOOGLE_SECRET = 'a-test-google-client-secret';

interface StubProvider {
  approve: (deviceCode: string, user: StubUser) => void;
  /** Makes the token route answer this OAuth error word for the device code, in the shape of each provider (Google's pending is 428, its other words 403 or 400; GitHub's are all 200). */
  script: (deviceCode: string, word: string) => void;
  /** Drops a code the stub issued, so the provider has no record of it, as after the provider's own expiry sweep. */
  forget: (deviceCode: string) => void;
  calls: StubCall[];
  /** URLs that answer this OAuth error word, the way a provider refuses a device flow it has switched off. */
  refuse: Map<string, string>;
  /** URLs answered with an HTML 502, the way a provider's outage looks. */
  html: Set<string>;
  /** URLs answered 403, the way GitHub answers a call over its rate limit. */
  forbidden: Set<string>;
  /** Profile URLs answered with this status and the user's real body, the way a proxy or a provider fault can put an id in a non-2xx answer. */
  statused: Map<string, number>;
  outbound: (request: StubRequest) => Promise<StubResponse>;
}

/** GitHub and Google as the Worker sees them: the device-code, token, and profile routes. Google answers a pending poll with 428, names its link `verification_url`, and wants its client secret at the token route, which is why both are stubbed apart. */
const stubProvider = (): StubProvider => {
  const users = new Map<string, StubUser | null>();
  const calls: StubCall[] = [];
  const html = new Set<string>();
  const forbidden = new Set<string>();
  const statused = new Map<string, number>();
  const refuse = new Map<string, string>();
  const scripted = new Map<string, string>();
  let issued = 0;
  const device = (): { device_code: string; user_code: string; expires_in: number; interval: number } => {
    issued += 1;
    const code = `device-${String(issued)}`;
    users.set(code, null);
    return { device_code: code, user_code: `USER-${String(issued)}`, expires_in: 900, interval: 1 };
  };
  const GOOGLE_STATUS = new Map([['authorization_pending', 428], ['slow_down', 403], ['access_denied', 403]]);
  const token = (form: URLSearchParams, google: boolean): StubResponse => {
    const code = form.get('device_code') ?? '';
    if (google && form.get('client_secret') !== TEST_GOOGLE_SECRET) return json({ error: 'invalid_client' }, 401);
    const word = scripted.get(code) ?? (users.get(code) === null ? 'authorization_pending' : undefined);
    if (word !== undefined) return json({ error: word }, google ? (GOOGLE_STATUS.get(word) ?? 400) : 200);
    const user = users.get(code);
    if (user === undefined) return json({ error: 'expired_token' }, 400);
    return json({ access_token: `access-${code}`, token_type: 'bearer' });
  };
  const outbound = async (request: StubRequest): Promise<StubResponse> => {
    const { origin, pathname } = new URL(request.url);
    const at = `${origin}${pathname}`;
    const body = await request.text();
    calls.push({ url: at, body });
    if (html.has(at)) return new StubResponse('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    if (forbidden.has(at)) return json({ message: 'API rate limit exceeded' }, 403);
    const refused = refuse.get(at);
    if (refused !== undefined) return json({ error: refused }, 400);
    const form = new URLSearchParams(body);
    if (at === 'https://github.com/login/device/code') return json({ ...device(), verification_uri: 'https://github.com/login/device' });
    if (at === 'https://oauth2.googleapis.com/device/code') return json({ ...device(), verification_url: 'https://www.google.com/device' });
    if (at === 'https://github.com/login/oauth/access_token') return token(form, false);
    if (at === 'https://oauth2.googleapis.com/token') return token(form, true);
    const found = users.get((request.headers.get('authorization') ?? '').replace('Bearer access-', ''));
    if (typeof found !== 'object' || found === null) return json({ error: 'bad token' }, 401);
    const status = statused.get(at) ?? 200;
    if (at === 'https://api.github.com/user') return json({ id: Number(found.id), login: found.login, email: found.email, name: found.login, ...(found.createdAt === undefined ? {} : { created_at: found.createdAt }) }, status);
    if (at === 'https://openidconnect.googleapis.com/v1/userinfo') return json({ sub: found.id, email: found.email, name: found.login }, status);
    return json({ error: `no stub for ${at}` }, 500);
  };
  return { approve: (code, user) => users.set(code, user), script: (code, word) => scripted.set(code, word), forget: (code) => users.delete(code), calls, html, forbidden, statused, refuse, outbound };
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
  /** Makes a handle's next poll due now, as if the provider's interval had passed: the pool holds the interval per handle, and a poll right after a start comes early. */
  due: (handle: string) => Promise<void>;
  /** Signs the stub user in through the pool's two login routes, as the CLI does, with the provider's approval given at the stub between them. The account has stood unless `fresh`: the floor counts only accounts that have (S13), so a test that serves a cell needs holders that have, and a test of the fetch cap or of what a fresh account does passes `fresh: true`. */
  signIn: (provider: string, user: StubUser, options?: { fresh?: boolean }) => Promise<{ token: string; account: string; signingKey: unknown }>;
  stub: StubProvider;
  /** The connections the pool's own requests have opened (see `KeepAliveSender`). */
  connects: () => number;
  /** The most requests the pool's own requests had in flight at once (see `KeepAliveSender`). */
  peak: () => number;
  signingKey: () => { kty: string; crv: string; x: string };
  /** The keys a client holds for this pool, by key id: what `verifyBundle` takes. */
  pinned: () => { [kid: string]: { kty: string; crv: string; x: string } };
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

/** The two public client IDs `wrangler.jsonc` sets as `vars`, bound as the deploy binds them, so the test runs the IDs that ship. */
const clientIds = (parsed: object): { [name: string]: string } => {
  const vars = fieldOf(parsed, 'vars');
  return { GITHUB_CLIENT_ID: textOf(vars, 'GITHUB_CLIENT_ID'), GOOGLE_CLIENT_ID: textOf(vars, 'GOOGLE_CLIENT_ID') };
};

/**
 * `raw: false` leaves the R2 binding out, the way a pool deployed before its bucket exists looks. A test pool serves clear cells at the thresholded floor (`CLEAR_FLOOR` the `PUBLIC_FLOOR` it is given, else 5), so the many tests that count accounts against `PUBLIC_FLOOR` with a
 * public tool keep meaning what they say; a test of the split passes its own `CLEAR_FLOOR` (`floor-split.test.ts`), and the default of 1 is `wrangler.jsonc`'s.
 */
export const startPool = async (bindings: { [name: string]: string } = {}, options: { raw?: boolean } = {}): Promise<TestPool> => {
  // The Worker bundles the stand-in covenant texts for `v1` and `v2` in place of the shipped ones: the pool refuses an acceptance for a version it holds no text for, and the shipped module holds none until a covenant's wording is settled.
  const standIn = { name: 'stand-in-covenant-texts', setup: (builder: PluginBuild): void => { builder.onResolve({ filter: /(^|\/)covenant-texts\.js$/ }, () => ({ path: fileIn('./test-covenant-texts.ts') })); } };
  const bundled = await build({ entryPoints: [fileIn('./worker.ts')], bundle: true, write: false, format: 'esm', platform: 'node', conditions: ['workerd', 'worker'], external: ['node:*'], plugins: [standIn] });
  const contents = bundled.outputFiles[0]?.text;
  if (contents === undefined) throw new Error('the bundle is empty');
  const config = wranglerConfig();
  const stub = stubProvider();
  const key = await generatedKey();
  // Miniflare 5 takes a new options shape; the v4 shape this harness was written in converts with the package's own function.
  const miniflare = new Miniflare(
    convertV4MiniflareOptions({
      name: 'pool',
      modules: [{ type: 'ESModule', path: 'worker.js', contents }],
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      d1Databases: { DB: 'pool-test' },
      // The bindings wrangler.jsonc names. Miniflare's local Analytics Engine accepts a write and keeps nothing, so a test reads what the Worker wrote to it through a fake (telemetry.test.ts).
      r2Buckets: { TELEMETRY: 'telemetry-test', ...(options.raw === false ? {} : { RAW: 'oars-pool-raw' }) },
      analyticsEngineDatasets: { TELEMETRY_EVENTS: { dataset: 'oars_telemetry' } },
      bindings: { ...clientIds(config.parsed), GOOGLE_CLIENT_SECRET: TEST_GOOGLE_SECRET, PSEUDONYM_KEY: 'a-test-pseudonym-key', INGEST_HASH_KEY: 'a-test-ingest-hash-key', BUNDLE_SIGNING_KEY: key.jwk, COVENANT_VERSION: 'v1', FETCH_CAP: '1000', LOGIN_STARTS_PER_HOUR: '1000', CLEAR_FLOOR: /^[1-9]\d*$/.test(bindings.PUBLIC_FLOOR ?? '') ? (bindings.PUBLIC_FLOOR ?? '5') : '5', ...bindings },
      outboundService: stub.outbound,
    }),
  );
  const sender = keepAliveSender(() => miniflare.ready);
  miniflare.dispatchFetch = sender.send;
  await miniflare.ready;
  const db = async (): Promise<TestDb> => (await miniflare.getBindings<{ DB: TestDb }>()).DB;
  const bucket = async (): Promise<TestBucket> => (await miniflare.getBindings<{ TELEMETRY: TestBucket }>()).TELEMETRY;
  const database = await db();
  // One batch, not one round trip per statement: the migrations are about 90 statements, so the hook no longer pays one round trip per statement when the machine is busy.
  const statements: Statement[] = [];
  for (const file of readdirSync(fileIn('../migrations')).sort()) {
    for (const line of readFileSync(fileIn(`../migrations/${file}`), 'utf8').split('\n')) if (line.trim() !== '' && !line.startsWith('--')) statements.push(database.prepare(line));
  }
  await database.batch(statements);

  const rawBucket = async (): Promise<TestBucket> => (await miniflare.getBindings<{ RAW: TestBucket }>()).RAW;

  const call = async (path: string, init: { method: string; body?: string | Uint8Array }, token?: string, headers: { [name: string]: string } = {}): Promise<RawAnswer> => {
    const response = await miniflare.dispatchFetch(`http://pool.test${path}`, { ...init, headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers } });
    const text = await response.text();
    return { status: response.status, json: text === '' ? null : JSON.parse(text), headers: response.headers };
  };
  const post: TestPool['post'] = async (path, body, token, headers) => {
    // A client posts JSON as `application/json`; a test that wants another type, or none, names it in `headers`.
    const { status, json } = await call(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }, token, { 'content-type': 'application/json', ...headers });
    return { status, json };
  };
  const raw: TestPool['raw'] = (path, token, headers) => call(path, { method: 'GET' }, token, headers);
  const get: TestPool['get'] = async (path, token) => {
    const { status, json } = await raw(path, token);
    return { status, json };
  };
  const due = async (handle: string): Promise<void> => {
    await database.prepare('UPDATE login_polls SET next_at = 0 WHERE handle_hash = ?').bind(createHash('sha256').update(handle).digest('hex')).run();
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
    due,
    connects: sender.connects,
    peak: sender.peak,
    signIn: async (provider, user, options = {}) => {
      const started = await post('/v1/login/start', { provider });
      const issued = /USER-(\d+)/.exec(textOf(started.json, 'userCode'))?.[1];
      stub.approve(`device-${issued ?? ''}`, user);
      const handle = textOf(started.json, 'handle');
      await due(handle);
      const signedIn = await post('/v1/login/poll', { handle });
      if (options.fresh !== true) await (await db()).prepare("UPDATE accounts SET access = 'standing' WHERE id = ?").bind(textOf(signedIn.json, 'account')).run();
      return { token: textOf(signedIn.json, 'token'), account: textOf(signedIn.json, 'account'), signingKey: fieldOf(signedIn.json, 'signingKey') };
    },
    signingKey: () => ({ kty: 'OKP', crv: 'Ed25519', x: key.x }),
    pinned: () => ({ k1: { kty: 'OKP', crv: 'Ed25519', x: key.x } }),
    dispose: async () => {
      await miniflare.dispose();
      await sender.close();
    },
  };
};

// Vitest types its matchers as `any`; these name what they stand for, so a test's expected shape stays checked.
export const matching = (pattern: RegExp): unknown => expect.stringMatching(pattern);
export const containing = (text: string): unknown => expect.stringContaining(text);
export const anyText = (): unknown => expect.any(String);
export const anyNumber = (): unknown => expect.any(Number);

/**
 * A user whose GitHub account is years old and was made days away from every other stub's, so a pool of stubs holds unrelated, established accounts: the cluster rule (`clusters.ts`) counts each as its own cluster.
 * A numeric id sets the offset itself (3 days apart, so two ids under 1,200 apart never share a 24-hour window); a non-numeric id takes it from a hash, where two ids can collide.
 */
export const stubUser = (id: string): StubUser => {
  const slot = /^\d+$/.test(id) ? Number(id) : Number.parseInt(createHash('sha256').update(id).digest('hex').slice(0, 6), 16);
  return { id, login: `login-of-${id}`, email: `person-${id}@example.test`, createdAt: new Date(Date.UTC(2015, 0, 1) + (slot % 1200) * 3 * 24 * 60 * 60 * 1000).toISOString() };
};
