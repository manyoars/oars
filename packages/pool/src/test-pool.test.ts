// The pool harness itself: its requests share a keep-alive undici Agent the pool owns, which is what keeps a full `vitest run` from leaving thousands of loopback sockets in TIME_WAIT.
import { once } from 'node:events';
import { connect } from 'node:net';
import { createServer, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreHeaders, ProxyOps } from 'miniflare';
import { keepAliveSender, startPool, workerError, type TestPool } from './test-pool.js';

describe('the pool harness reuses its connections', () => {
  let pool: TestPool;
  beforeAll(async () => {
    pool = await startPool();
  });
  afterAll(() => pool.dispose());

  // `pool.connects()` counts the connects of the Agent the pool's own requests ride, on the real loopback transport. Miniflare's batched release of the handles `getBindings` returns rides another
  // Agent (the last case here), so a release in flight cannot cost a call a connection.
  it('opens at most two connections for twenty requests and twenty D1 calls', async () => {
    const before = pool.connects();
    for (let at = 0; at < 20; at += 1) {
      // No body: workerd closes the connection when a Worker answers without reading the request body, so an unread-body POST measures that close and not connection reuse.
      expect((await pool.get('/v1/covenant')).status).toBe(200);
      expect(await (await pool.db()).prepare('select 1 as one').first('one')).toBe(1);
    }
    // Without the keep-alive sender Miniflare resets every connection: one connect per call, 40 here.
    expect(pool.connects() - before, `connects=${String(pool.connects() - before)} peak=${String(pool.peak())}`).toBeLessThanOrEqual(2);
  });

  // A test process starved by a loaded box can sit idle longer than undici's default keep-alive timeout (4 s) between two calls, which closes the socket and costs a reconnect. The pause is
  // made here, so the case does not wait for a load to make it.
  it('keeps its connection across a pause longer than the default keep-alive timeout', async () => {
    await pool.get('/v1/covenant');
    const before = pool.connects();
    await new Promise<void>((resolve) => setTimeout(resolve, 4_500));
    // No body: workerd closes the connection when a Worker answers without reading the request body, so an unread-body POST measures that close and not connection reuse.
    expect((await pool.get('/v1/covenant')).status).toBe(200);
    expect(pool.connects() - before, `connects=${String(pool.connects() - before)} peak=${String(pool.peak())}`).toBe(0);
  });

  // The premise, on the real workerd: it closes the connection when a Worker answers before the request body has all reached it (the 404 router never reads one), and keeps it when the body came whole
  // with the headers. A body handed on as a stream goes out as a chunk and then, apart from it, the closing chunk, so on a loaded box the Worker answers in between and closes a socket the next call is
  // about to reuse: `read ECONNRESET` in raw-serves-nothing.test.ts. The reset can also land on the closing chunk's own write, on a connection the request itself opened. The chunked request here holds its closing chunk back for good, which is that load made exact.
  it('shows workerd closing a connection it answered before the body arrived, and keeping one whose body came whole', async () => {
    const port = Number(new URL(await pool.url()).port);
    const crlf = String.fromCharCode(13, 10);
    /**
     * Sends `lines` as one request on a new socket and says whether workerd closed the socket. Nothing here is timed: a closing socket is awaited as long as the case's own timeout allows, and a socket that
     * must stay open proves it by carrying a second request (`reuse`): a bodyless GET written on workerd's first bytes, the case ending on the second status line. A reset is an outcome that reaches `close`.
     */
    const outcomeOf = (lines: string[], reuse: boolean): Promise<string> =>
      new Promise((resolve) => {
        const socket = connect(port, '127.0.0.1');
        let received = '';
        let followed = false;
        socket.on('error', () => undefined);
        socket.on('data', (chunk: Buffer) => {
          received += chunk.toString('latin1');
          if (!reuse) return;
          if (!followed) {
            followed = true;
            socket.write(['GET /v1/raw/none HTTP/1.1', 'Host: pool.test', '', ''].join(crlf));
          }
          if (received.split('HTTP/1.1 ').length - 1 >= 2) {
            resolve('answered, reused');
            socket.destroy();
          }
        });
        socket.on('close', () => {
          resolve(`${received === '' ? 'unanswered' : 'answered'}, closed by workerd`);
        });
        socket.write(lines.join(crlf));
      });
    const head = ['POST /v1/raw/none HTTP/1.1', 'Host: pool.test'];
    // The body is promised and never finishes: the Worker answers 404 without it.
    expect(await outcomeOf([...head, 'transfer-encoding: chunked', '', '2', '{}', ''], false)).toBe('answered, closed by workerd');
    expect(await outcomeOf([...head, 'content-length: 2', '', '{}'], true)).toBe('answered, reused');
  });

  // What the sender puts on the wire, read by a server that records it: a small string or byte body goes out with a content-length and no chunking, so its headers and body leave in one write. A stream
  // stays chunked (the oversized-body cases hand one in on purpose), and so does a body over what one write carries.
  it('sends a small body whole with a content-length, and leaves a stream or a large body chunked', async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${String(request.headers['content-length'])}/${String(request.headers['transfer-encoding'])}`);
      request.resume();
      response.end('ok');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const sender = keepAliveSender(() => Promise.resolve(new URL(`http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`)));
    try {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode('{}'));
          controller.close();
        },
      });
      for (const body of ['{}', new TextEncoder().encode('{}')]) await (await sender.send('http://pool.test/', { method: 'POST', body })).text();
      await (await sender.send('http://pool.test/', { method: 'POST', body: stream, duplex: 'half' })).text();
      await (await sender.send('http://pool.test/', { method: 'POST', body: new Uint8Array(65 * 1024) })).text();
      // 33,792 characters but 67,584 bytes: the limit counts bytes, so this string is over it.
      await (await sender.send('http://pool.test/', { method: 'POST', body: 'é'.repeat(33 * 1024) })).text();
      expect(requests).toEqual(['2/undefined', '2/undefined', 'undefined/chunked', 'undefined/chunked', 'undefined/chunked']);
    } finally {
      await sender.close();
      server.close();
    }
  });

  // A release that Miniflare sends has no timing the test could drive, so the server here answers every call at once and holds each release until the case lets it go.
  it('sends a release that is still in flight on its own connection, so the next call reuses the one it had', async () => {
    const held: ServerResponse[] = [];
    const server = createServer((request, response) => {
      if (request.method === 'DELETE') held.push(response);
      else response.end('ok');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    const sender = keepAliveSender(() => Promise.resolve(new URL(`http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`)));
    try {
      await (await sender.send('http://pool.test/warm')).text();
      const warm = sender.connects();
      const arrived = once(server, 'request');
      const release = sender.send('http://pool.test/', { method: 'DELETE', headers: { [CoreHeaders.OP]: ProxyOps.FREE } });
      await arrived;
      expect(await (await sender.send('http://pool.test/call')).text()).toBe('ok');
      expect(sender.connects() - warm).toBe(0);
      for (const response of held) response.end();
      await release;
    } finally {
      // `close` waits for requests in flight, so a failed assertion above must not leave the release held.
      for (const response of held) response.end();
      await sender.close();
      server.close();
    }
  });
});

describe('a Worker exception reads as the Worker\'s own error', () => {
  const thrown = { name: 'TypeError', message: 'x is not a function', stack: 'TypeError: x is not a function\n    at handler (worker.ts:12:3)' };
  const failure = (body: string, headers: { [name: string]: string } = {}): Response => new Response(body, { status: 500, headers: { 'MF-Experimental-Error-Stack': 'true', ...headers } });

  it('takes the message and stack from the body', async () => {
    const error = await workerError(failure(JSON.stringify(thrown)));
    expect(error.message).toBe(thrown.message);
    expect(error.stack).toBe(thrown.stack);
  });

  it('falls back to the payload header when the body is empty', async () => {
    const error = await workerError(failure('', { 'MF-Experimental-Error-Stack-Payload': encodeURIComponent(JSON.stringify(thrown)) }));
    expect(error.message).toBe(thrown.message);
    expect(error.stack).toBe(thrown.stack);
  });

  it('keeps the raw text when it is not the expected JSON, and says so when there is none', async () => {
    expect((await workerError(failure(JSON.stringify({ code: 7 })))).message).toBe('{"code":7}');
    expect((await workerError(failure('boom'))).message).toBe('the Worker threw a non-JSON error: boom');
    expect((await workerError(failure(''))).message).toBe('the Worker threw a non-JSON error: (empty)');
  });

  it('reads a malformed payload header as no payload, not as a URIError', async () => {
    const error = await workerError(failure('', { 'MF-Experimental-Error-Stack-Payload': '%E0%A4%A' }));
    expect(error.message).toBe('the Worker threw a non-JSON error: (empty)');
  });
});
