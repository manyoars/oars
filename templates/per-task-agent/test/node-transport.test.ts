// The real network side of the SSRF guard, against a local server: the socket goes to the address the guard checked, whatever
// the URL's host name says, and a signal ends the request.
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { dnsResolve, nodeTransport } from '../src/node-transport.js';

let server: Server | undefined;

afterEach(async () => {
  const closing = server;
  server = undefined;
  await new Promise<void>((done) => {
    if (closing === undefined) done();
    else closing.close(() => {
      done();
    });
  });
});

const listen = async (handler: Parameters<typeof createServer>[1]): Promise<number> => {
  const created = createServer(handler);
  server = created;
  await new Promise<void>((done) => {
    created.listen(0, '127.0.0.1', () => {
      done();
    });
  });
  const address = created.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
};

const text = async (body: AsyncIterable<Uint8Array>): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

describe('nodeTransport', () => {
  it('connects to the given address while the request keeps the URL host, so a name cannot be re-resolved to something else', async () => {
    const port = await listen((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(`host=${request.headers.host ?? ''} path=${request.url ?? ''} ua=${request.headers['user-agent'] ?? ''}`);
    });

    const response = await nodeTransport({ url: new URL(`http://pinned.example:${String(port)}/a?b=1`), address: '127.0.0.1', signal: new AbortController().signal });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html');
    const body = await text(response.body);
    expect(body).toContain(`host=pinned.example:${String(port)}`);
    expect(body).toContain('path=/a?b=1');
    expect(body).toMatch(/ua=\S+/);
  });

  it('does not follow a redirect, and hands back its Location', async () => {
    const port = await listen((_request, response) => {
      response.writeHead(302, { Location: 'http://169.254.169.254/' });
      response.end();
    });

    const response = await nodeTransport({ url: new URL(`http://pinned.example:${String(port)}/`), address: '127.0.0.1', signal: new AbortController().signal });

    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe('http://169.254.169.254/');
  });

  it('asks for an uncompressed body and still decodes a gzip one a server sends anyway', async () => {
    let asked = '';
    const port = await listen((request, response) => {
      asked = request.headers['accept-encoding'] ?? '';
      response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/html' });
      response.end(gzipSync('<h1>zipped</h1>'));
    });

    const response = await nodeTransport({ url: new URL(`http://pinned.example:${String(port)}/`), address: '127.0.0.1', signal: new AbortController().signal });

    expect(asked).toBe('identity');
    expect(await text(response.body)).toBe('<h1>zipped</h1>');
  });

  it('rejects when the signal fires before the server answers', async () => {
    const port = await listen(() => {
      // never answers
    });

    await expect(
      nodeTransport({ url: new URL(`http://pinned.example:${String(port)}/`), address: '127.0.0.1', signal: AbortSignal.timeout(50) }),
    ).rejects.toThrow();
  });

  it('rejects when the connection is refused', async () => {
    const port = await listen((_request, response) => {
      response.end();
    });
    await new Promise<void>((done) => {
      server?.close(() => {
        done();
      });
    });

    await expect(
      nodeTransport({ url: new URL(`http://pinned.example:${String(port)}/`), address: '127.0.0.1', signal: new AbortController().signal }),
    ).rejects.toThrow();
  });
});

describe('dnsResolve', () => {
  it('returns every address the system resolver has for a name', async () => {
    const addresses = await dnsResolve('localhost');

    expect(addresses.length).toBeGreaterThan(0);
    expect(addresses.some((address) => address === '127.0.0.1' || address === '::1')).toBe(true);
  });

  it('rejects for a name that does not exist', async () => {
    await expect(dnsResolve('no-such-host.invalid')).rejects.toThrow();
  });
});
