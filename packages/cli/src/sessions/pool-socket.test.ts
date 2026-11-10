import { createHash, webcrypto } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness } from '../test-support.js';
import { networkSender, poolDeposit, type Sender } from './pool-command.js';
import { VOCAB_VERSION } from './pool-wire.js';
import { deposit } from './store.js';
import { cleanup, NOW, settledClock, stage, TEST_FLOOR } from './test-support.js';

// These tests send over a real loopback socket, not through msw: msw answers above the HTTP layer, so it cannot see a header that Node's own `fetch` adds. What the server reads off the wire
// (`rawHeaders`) is compared with what the command had printed when the request arrived. The two are pinned to the engine this repository declares (Node >= 24); a header another version adds shows up here.

afterEach(cleanup);

const HANDLE = 'sealed-login-handle';
const POOL_TOKEN = 'a-pool-token';

interface Arrival {
  method: string;
  url: string;
  /** Name and value, as read off the socket. */
  raw: Array<[string, string]>;
  /** The body as it came off the socket. */
  body: string;
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

// Keeps its socket: the CLI's network sender over a real loopback connection is what these tests cover.
const listen = async (err: string[]): Promise<Loopback> => {
  const arrivals: Arrival[] = [];
  const answers = new Map<string, Array<(response: ServerResponse) => void>>();
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const raw: Array<[string, string]> = [];
    for (let at = 0; at < request.rawHeaders.length; at += 2) raw.push([request.rawHeaders[at] ?? '', request.rawHeaders[at + 1] ?? '']);
    const arrival: Arrival = { method: request.method ?? '', url: request.url ?? '', raw, body: '', printedBefore: err.join('') };
    arrivals.push(arrival);
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      arrival.body += chunk;
    });
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
  afterEach(async () => {
    await loop.stop();
  });

  it('a plain fetch, a conditional fetch answered 304, and the login each print every header they send', async () => {
    const staged = stage();
    const h = harness();
    h.deps.sessions = staged.runtime;
    loop = await listen(h.err);
    const { x, sign } = await signer();
    const payload = JSON.stringify({ format: 1, harness: 'claude-code', harnessVersion: '2.1.314', vocabVersion: VOCAB_VERSION, floor: TEST_FLOOR, asOf: { pool: 'p' }, cells: [{}], motifs: [], reads: [{}], strata: [] });
    loop.answers.set('POST /v1/login/start', [json(200, { handle: HANDLE, userCode: 'USER-1', verificationUrl: 'https://provider.test/device', interval: 1, expiresIn: 10 })]);
    loop.answers.set('POST /v1/login/poll', [json(200, { status: 'authorized', token: POOL_TOKEN, account: 'acct_one', expiresAt: Date.parse('2099-01-01T00:00:00Z'), signingKey: { kty: 'OKP', crv: 'Ed25519', x } })]);
    loop.answers.set(`GET /bundle/claude-code/2.1.314/${VOCAB_VERSION}`, [json(200, { payload, signature: await sign(payload) }, { etag: '"e1"' }), (response) => { response.writeHead(304, { etag: '"e1"' }); response.end(); }]);
    const cli = (...args: string[]): Promise<ExitCode> => run(args, h.deps);

    expect(await cli('pool', 'login', '--provider', 'github', '--server', loop.origin, '--verbose')).toBe(ExitCode.OK);
    expect(await cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', loop.origin)).toBe(ExitCode.OK);
    expect(await cli('pool', 'fetch', '--harness-version', '2.1.314', '--server', loop.origin)).toBe(ExitCode.OK);

    const poolLogin = loop.arrivals.find((arrival) => arrival.url === '/v1/login/poll');
    const [plain, conditional] = loop.arrivals.filter((arrival) => arrival.url.startsWith('/bundle/'));
    expect(poolLogin).toBeDefined();
    expect(plain).toBeDefined();
    expect(conditional).toBeDefined();
    // The second fetch is conditional: Node's fetch adds a header or two of its own for that, and the print has to carry them.
    expect(conditional?.raw.map(([name]) => name.toLowerCase())).toContain('if-none-match');
    for (const arrival of [poolLogin, plain, conditional]) if (arrival !== undefined) expectPrinted(arrival, arrival === poolLogin ? undefined : POOL_TOKEN);
  });

  it('a deposit sent after outbox shows every header it prints, and its body is the printed batch', async () => {
    const staged = stage();
    const termsFile = join(staged.root, 'terms.txt');
    writeFileSync(termsFile, 'zorblax\n');
    const h = harness({ OARS_EXCLUSION_TERMS: termsFile });
    h.deps.sessions = staged.runtime;
    h.deps.now = settledClock;
    // `outbox` prints to stdout, so what counts as printed before the request is what stdout held when it arrived.
    const shown: string[] = [];
    loop = await listen(shown);
    const { x } = await signer();
    loop.answers.set('POST /v1/login/start', [json(200, { handle: HANDLE, userCode: 'USER-1', verificationUrl: 'https://provider.test/device', interval: 1, expiresIn: 10 })]);
    loop.answers.set('POST /v1/login/poll', [json(200, { status: 'authorized', token: POOL_TOKEN, account: 'acct_one', expiresAt: Date.parse('2099-01-01T00:00:00Z'), signingKey: { kty: 'OKP', crv: 'Ed25519', x } })]);
    loop.answers.set('GET /v1/covenant', [json(200, { version: 'v1', accepted: true })]);
    loop.answers.set('POST /v1/deposits', [json(201, { ok: true })]);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const cli = (...args: string[]): Promise<ExitCode> => run(args, h.deps);

    expect(await cli('pool', 'login', '--provider', 'github', '--server', loop.origin, '--verbose')).toBe(ExitCode.OK);
    expect(await cli('pool', 'deposit', '--server', loop.origin)).toBe(ExitCode.OK);
    expect(await cli('pool', 'outbox', '--server', loop.origin)).toBe(ExitCode.OK);
    const text = h.out.join('');
    const hash = /^sha256: ([0-9a-f]{64})$/m.exec(text)?.[1] ?? '';
    expect(hash).toHaveLength(64);
    // Several sessions are batched; what counts is the block printed for the batch that is sent.
    const end = text.indexOf(`sha256: ${hash}`);
    shown.push(text.slice(text.lastIndexOf('POST /v1/deposits HTTP/1.1', end), end));

    const outcome = await poolDeposit(h.deps, { server: loop.origin, send: hash, via: networkSender(h.deps, 'deposit') });
    expect(outcome.document).toMatchObject({ ok: true, sent: true, hash });

    const posts = loop.arrivals.filter((arrival) => arrival.url === '/v1/deposits');
    // One deposit POST; the covenant check is a GET beside it.
    expect(posts).toHaveLength(1);
    expect(loop.arrivals.filter((arrival) => arrival.url === '/v1/covenant')).toHaveLength(1);
    const [post] = posts;
    expect(post).toBeDefined();
    if (post === undefined) return;
    expectPrinted(post, POOL_TOKEN);
    expect(createHash('sha256').update(post.body).digest('hex')).toBe(hash);
    const folder = join(staged.storeDir, 'pool-outbox');
    const files = readdirSync(folder, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith(`.${hash}.jsonl`));
    expect(files).toHaveLength(1);
    expect(post.body).toBe(readFileSync(join(folder, files[0] ?? ''), 'utf8'));
  });

  describe('a deposit the lock refuses sends no deposit over the socket', () => {
    /** A batch in the outbox, the file that holds it, and its hash, with the pool listening on the loopback. */
    const batchedOnLoopback = async (): Promise<{ h: ReturnType<typeof harness>; file: string; hash: string; cli: (...args: string[]) => Promise<ExitCode> }> => {
      const staged = stage();
      const termsFile = join(staged.root, 'terms.txt');
      writeFileSync(termsFile, 'zorblax\n');
      const h = harness({ OARS_EXCLUSION_TERMS: termsFile });
      h.deps.sessions = staged.runtime;
      h.deps.now = settledClock;
      loop = await listen([]);
      const { x } = await signer();
      loop.answers.set('POST /v1/login/start', [json(200, { handle: HANDLE, userCode: 'USER-1', verificationUrl: 'https://provider.test/device', interval: 1, expiresIn: 10 })]);
      loop.answers.set('POST /v1/login/poll', [json(200, { status: 'authorized', token: POOL_TOKEN, account: 'acct_one', expiresAt: Date.parse('2099-01-01T00:00:00Z'), signingKey: { kty: 'OKP', crv: 'Ed25519', x } })]);
      loop.answers.set('GET /v1/covenant', [json(200, { version: 'v1', accepted: true })]);
      loop.answers.set('POST /v1/deposits', [json(201, { ok: true })]);
      await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
      const cli = (...args: string[]): Promise<ExitCode> => run(args, h.deps);
      expect(await cli('pool', 'login', '--provider', 'github', '--server', loop.origin, '--verbose')).toBe(ExitCode.OK);
      expect(await cli('pool', 'deposit', '--server', loop.origin)).toBe(ExitCode.OK);
      const folder = join(staged.storeDir, 'pool-outbox');
      const name = readdirSync(folder, { recursive: true, encoding: 'utf8' }).find((entry) => entry.endsWith('.jsonl')) ?? '';
      return { h, file: join(folder, name), hash: /\.([0-9a-f]{64})\.jsonl$/.exec(name)?.[1] ?? '', cli };
    };

    const deposits = (): number => loop.arrivals.filter((arrival) => arrival.url === '/v1/deposits').length;
    const edit = (file: string): void => {
      writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()} \n`);
    };

    it('a batch never printed', async () => {
      const { h, hash } = await batchedOnLoopback();
      await expect(poolDeposit(h.deps, { server: loop.origin, send: hash, via: networkSender(h.deps, 'deposit') })).rejects.toMatchObject({ problem: { code: 'batch_not_shown' } });
      expect(deposits()).toBe(0);
    });

    it('a batch edited after it was printed', async () => {
      const { h, file, hash, cli } = await batchedOnLoopback();
      expect(await cli('pool', 'outbox', '--server', loop.origin)).toBe(ExitCode.OK);
      edit(file);
      await expect(poolDeposit(h.deps, { server: loop.origin, send: hash, via: networkSender(h.deps, 'deposit') })).rejects.toMatchObject({ problem: { code: 'batch_changed' } });
      expect(deposits()).toBe(0);
    });

    it('a batch edited between the check and the send, at the first request', async () => {
      const { h, file, hash, cli } = await batchedOnLoopback();
      expect(await cli('pool', 'outbox', '--server', loop.origin)).toBe(ExitCode.OK);
      const real = networkSender(h.deps, 'deposit');
      const via: Sender = async (request) => {
        if (request.method === 'GET') edit(file);
        return real(request);
      };
      await expect(poolDeposit(h.deps, { server: loop.origin, send: hash, via })).rejects.toMatchObject({ problem: { code: 'batch_changed' } });
      expect(deposits()).toBe(0);
    });
  });
});
