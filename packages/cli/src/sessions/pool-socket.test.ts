import { webcrypto } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness } from '../test-support.js';
import { VOCAB_VERSION } from './pool-wire.js';
import { cleanup, stage } from './test-support.js';

// These tests send over a real loopback socket, not through msw: msw answers above the HTTP layer, so it cannot see a header that Node's own `fetch` adds. What the server reads off the wire
// (`rawHeaders`) is compared with what the command had printed when the request arrived. The two are pinned to the engine this repository declares (Node >= 24); a header another version adds shows up here.

afterEach(cleanup);

const PROVIDER_TOKEN = 'provider-access-token';
const POOL_TOKEN = 'a-pool-token';

interface Arrival {
  method: string;
  url: string;
  /** Name and value, as read off the socket. */
  raw: Array<[string, string]>;
  /** What the command had printed to stderr when the request arrived. */
  printedBefore: string;
}

interface Loopback {
  origin: string;
  arrivals: Arrival[];
  /** The answers for the pool's routes, taken in order for a route that has more than one. */
  answers: Map<string, Array<(response: ServerResponse) => void>>;
  stop: () => Promise<void>;
}

const listen = async (err: string[]): Promise<Loopback> => {
  const arrivals: Arrival[] = [];
  const answers = new Map<string, Array<(response: ServerResponse) => void>>();
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const raw: Array<[string, string]> = [];
    for (let at = 0; at < request.rawHeaders.length; at += 2) raw.push([request.rawHeaders[at] ?? '', request.rawHeaders[at + 1] ?? '']);
    arrivals.push({ method: request.method ?? '', url: request.url ?? '', raw, printedBefore: err.join('') });
    request.resume();
    request.on('end', () => {
      const queue = answers.get(`${request.method ?? ''} ${request.url ?? ''}`) ?? [];
      (queue.length > 1 ? queue.shift() : queue[0])?.(response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  const { port } = address;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    arrivals,
    answers,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};

const json = (status: number, body: unknown, headers: { [name: string]: string } = {}) => (response: ServerResponse): void => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};

const signer = async (): Promise<{ x: string; sign: (text: string) => Promise<string> }> => {
  const pair = await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  if (!('privateKey' in pair)) throw new Error('no key pair');
  const { x } = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return { x: x ?? '', sign: async (text) => Buffer.from(await webcrypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(text))).toString('base64') };
};

/** Every line the wire carried is in the print, name and value, with the credential as its size. */
const expectPrinted = (arrival: Arrival, secret: string | undefined): void => {
  // Only this request's block counts: a line printed for an earlier request must not satisfy a later one.
  const start = arrival.printedBefore.lastIndexOf(`${arrival.method} ${arrival.url} HTTP/1.1`);
  expect(start, `${arrival.method} ${arrival.url} was not printed before it arrived`).toBeGreaterThanOrEqual(0);
  const lines = arrival.printedBefore.slice(start).split('\n').map((line) => line.toLowerCase());
  const mask = `<credential: ${String(Buffer.byteLength(secret ?? ''))} bytes>`;
  for (const [name, value] of arrival.raw) {
    const shown = secret === undefined ? value : value.split(secret).join(mask);
    expect(lines, `${arrival.method} ${arrival.url}: ${name}: ${shown}`).toContain(`${name.toLowerCase()}: ${shown}`.toLowerCase());
  }
};

describe('what is printed is what goes over the socket', () => {
  let loop: Loopback;
  const real = globalThis.fetch;

  beforeEach(() => {
    // The GitHub host is the only request that would leave the loopback in this file, so it is sent to the loopback here, with the request as built.
    vi.stubGlobal('fetch', (input: URL | string | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname !== 'github.com') return real(input, init);
      return real(`${loop.origin}${url.pathname}`, init);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await loop.stop();
  });

  it('a plain fetch, a conditional fetch answered 304, and the login each print every header they send', async () => {
    const staged = stage();
    const h = harness({ OARS_GITHUB_CLIENT_ID: 'gh-client' });
    h.deps.sessions = staged.runtime;
    loop = await listen(h.err);
    const { x, sign } = await signer();
    const payload = JSON.stringify({ format: 1, harnessVersion: '2.1.314', vocabVersion: VOCAB_VERSION, asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: [{}], strata: [] });
    loop.answers.set('POST /login/device/code', [json(200, { device_code: 'device-code-1', user_code: 'USER-1', verification_uri: 'https://provider.test/device', interval: 1, expires_in: 10 })]);
    loop.answers.set('POST /login/oauth/access_token', [json(200, { access_token: PROVIDER_TOKEN })]);
    loop.answers.set('POST /v1/login', [json(200, { token: POOL_TOKEN, account: 'acct_one', expiresAt: Date.parse('2099-01-01T00:00:00Z'), signingKey: { kty: 'OKP', crv: 'Ed25519', x } })]);
    loop.answers.set(`GET /bundle/2.1.314/${VOCAB_VERSION}`, [json(200, { payload, signature: await sign(payload) }, { etag: '"e1"' }), (response) => { response.writeHead(304, { etag: '"e1"' }); response.end(); }]);
    const cli = (...args: string[]): Promise<ExitCode> => run(args, h.deps);

    expect(await cli('pool', 'login', '--provider', 'github', '--server', loop.origin)).toBe(ExitCode.OK);
    expect(await cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', loop.origin)).toBe(ExitCode.OK);
    expect(await cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', loop.origin)).toBe(ExitCode.OK);

    const poolLogin = loop.arrivals.find((arrival) => arrival.url === '/v1/login');
    const [plain, conditional] = loop.arrivals.filter((arrival) => arrival.url.startsWith('/bundle/'));
    expect(poolLogin).toBeDefined();
    expect(plain).toBeDefined();
    expect(conditional).toBeDefined();
    // The second fetch is conditional: Node's fetch adds a header or two of its own for that, and the print has to carry them.
    expect(conditional?.raw.map(([name]) => name.toLowerCase())).toContain('if-none-match');
    for (const arrival of [poolLogin, plain, conditional]) if (arrival !== undefined) expectPrinted(arrival, arrival === poolLogin ? undefined : POOL_TOKEN);
  });
});
