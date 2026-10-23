// The SSRF guard (design 1T minimum §2.3): the audit fetches an address the buyer chose, so every address it connects to is
// resolved first and refused unless it is public, and every redirect hop gets the same treatment before it is fetched.
import { describe, expect, it } from 'vitest';
import { createPageFetcher, FetchFailed, FetchRefused, isPublicAddress, type Transport } from '../src/fetch-page.js';

const PUBLIC = '93.184.216.34';

interface Route { status: number; location?: string; contentType?: string; body?: string }

// A network the tests control: names to addresses, URLs to responses, and a record of every connection the transport made.
const network = (routes: { [url: string]: Route }, dns: { [host: string]: string[] } = {}) => {
  const connections: Array<{ url: string; address: string }> = [];
  const resolved: string[] = [];
  const transport: Transport = (request) => {
    connections.push({ url: request.url.href, address: request.address });
    const route = routes[request.url.href] ?? { status: 404 };
    const headers: { [name: string]: string | undefined } = { location: route.location, 'content-type': route.contentType ?? 'text/html; charset=utf-8' };
    const chunk = new TextEncoder().encode(route.body ?? '<html></html>');
    return Promise.resolve({
      status: route.status,
      headers,
      body: (async function* () {
        await Promise.resolve();
        yield chunk;
      })(),
    });
  };
  const resolve = (host: string): Promise<string[]> => {
    resolved.push(host);
    const addresses = dns[host];
    return addresses === undefined ? Promise.reject(new Error(`ENOTFOUND ${host}`)) : Promise.resolve(addresses);
  };
  return { connections, resolved, fetcher: createPageFetcher({ resolve, transport }) };
};

const signal = (): AbortSignal => new AbortController().signal;

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '127.0.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1',
    '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.0.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1',
    '255.255.255.255',
  ])('refuses the IPv4 address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    '::', '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd00::1', 'fdaa::1', 'fdaa:0:1a2b:a7b:1:2:3:4', 'ff02::1', '2001:db8::1',
    '64:ff9b::7f00:1', '2002:7f00:1::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::ffff:93.184.216.34',
  ])('refuses the IPv6 address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '8.8.8.8', '1.1.1.1', '11.0.0.1', '100.63.255.255', '100.128.0.1', '169.253.1.1', '172.15.255.255', '172.32.0.1', '192.169.0.1', '223.255.255.255'])(
    'allows the public IPv4 address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each(['2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '2606:2800:220:1:248:1893:25c8:1946'])('allows the public IPv6 address %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(['', 'example.com', '1.2.3', '1.2.3.4.5', '256.1.1.1', 'not-an-ip'])('refuses %j, which is not an address', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe('createPageFetcher: what it fetches', () => {
  it('resolves a public name and connects to the address it checked, not to the name', async () => {
    const { fetcher, connections } = network({ 'https://example.com/': { status: 200, body: '<html><title>Hi</title></html>' } }, { 'example.com': [PUBLIC] });

    const page = await fetcher('https://example.com/', signal());

    expect(connections).toEqual([{ url: 'https://example.com/', address: PUBLIC }]);
    expect(page).toMatchObject({ finalUrl: 'https://example.com/', status: 200, contentType: 'text/html; charset=utf-8', html: '<html><title>Hi</title></html>', bytes: 30 });
  });

  it('connects to a public IP literal without a DNS lookup', async () => {
    const { fetcher, connections, resolved } = network({ [`http://${PUBLIC}/`]: { status: 200 } });

    await fetcher(`http://${PUBLIC}/`, signal());

    expect(connections).toEqual([{ url: `http://${PUBLIC}/`, address: PUBLIC }]);
    expect(resolved).toEqual([]);
  });

  it('accepts a public IPv6 literal and a public name that resolves to IPv6', async () => {
    const { fetcher, connections } = network(
      { 'http://[2606:4700:4700::1111]/': { status: 200 }, 'http://v6.example/': { status: 200 } },
      { 'v6.example': ['2606:4700:4700::1111'] },
    );

    await fetcher('http://[2606:4700:4700::1111]/', signal());
    await fetcher('http://v6.example/', signal());

    expect(connections.map((connection) => connection.address)).toEqual(['2606:4700:4700::1111', '2606:4700:4700::1111']);
  });

  it('measures the time from the first request to the last byte', async () => {
    let clock = 1_000;
    const fetcher = createPageFetcher({
      resolve: () => Promise.resolve([PUBLIC]),
      transport: () => {
        clock += 250;
        return Promise.resolve({ status: 200, headers: { 'content-type': 'text/html' }, body: (async function* () { await Promise.resolve(); clock += 50; yield new Uint8Array([60]); })() });
      },
      now: () => clock,
    });

    expect(await fetcher('http://example.com/', signal())).toMatchObject({ elapsedMs: 300, bytes: 1 });
  });

  it('follows up to five redirects, resolving a relative Location against the hop it came from', async () => {
    const { fetcher, connections } = network(
      {
        'http://example.com/a': { status: 301, location: '/b' },
        'http://example.com/b': { status: 302, location: 'http://other.example/c' },
        'http://other.example/c': { status: 307, location: 'd' },
        'http://other.example/d': { status: 308, location: 'https://other.example/e' },
        'https://other.example/e': { status: 303, location: '/f' },
        'https://other.example/f': { status: 200, body: 'done' },
      },
      { 'example.com': [PUBLIC], 'other.example': ['8.8.8.8'] },
    );

    const page = await fetcher('http://example.com/a', signal());

    expect(page).toMatchObject({ finalUrl: 'https://other.example/f', status: 200, html: 'done' });
    expect(connections).toHaveLength(6);
  });

  it('returns a redirect that has no Location as the page it is', async () => {
    const { fetcher } = network({ 'http://example.com/': { status: 301 } }, { 'example.com': [PUBLIC] });

    expect(await fetcher('http://example.com/', signal())).toMatchObject({ status: 301, finalUrl: 'http://example.com/' });
  });
});

describe('createPageFetcher: the guard', () => {
  it.each([
    'http://127.0.0.1/', 'http://127.1.2.3:8080/x', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/', 'http://0.0.0.0/',
    'http://2130706433/', 'http://0x7f.0.0.1/', 'http://127.1/', 'http://017700000001/',
    'http://[::1]/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://[fdaa:0:1a2b::3]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/',
    'http://[64:ff9b::7f00:1]/', 'https://[2001:db8::1]/',
  ])('refuses the literal target %s and never connects', async (url) => {
    const { fetcher, connections } = network({});

    await expect(fetcher(url, signal())).rejects.toMatchObject({ name: 'FetchRefused', code: 'URL_NOT_ALLOWED' });
    expect(connections).toEqual([]);
  });

  it.each([
    ['a name that resolves to a private IPv4 address', { 'evil.example': ['10.1.2.3'] }],
    ['a name that resolves to loopback', { 'evil.example': ['127.0.0.1'] }],
    ['a name that resolves to the metadata address', { 'evil.example': ['169.254.169.254'] }],
    ['a name that resolves to a Fly private (fdaa::/16) address', { 'evil.example': ['fdaa:0:1a2b:a7b:1:2:3:4'] }],
    ['a name that resolves to IPv6 loopback', { 'evil.example': ['::1'] }],
    ['a name with a public address and a private one', { 'evil.example': [PUBLIC, '10.0.0.1'] }],
    ['a name with a private address first', { 'evil.example': ['192.168.0.9', PUBLIC] }],
  ])('refuses %s after DNS resolution', async (_description, dns) => {
    const { fetcher, connections, resolved } = network({ 'http://evil.example/': { status: 200 } }, dns);

    await expect(fetcher('http://evil.example/', signal())).rejects.toMatchObject({ name: 'FetchRefused', code: 'URL_NOT_ALLOWED' });
    expect(resolved).toEqual(['evil.example']);
    expect(connections).toEqual([]);
  });

  it('refuses localhost, which resolves to loopback', async () => {
    const { fetcher, connections } = network({}, { localhost: ['127.0.0.1', '::1'] });

    await expect(fetcher('http://localhost:8080/', signal())).rejects.toBeInstanceOf(FetchRefused);
    expect(connections).toEqual([]);
  });

  it.each(['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)', 'http://user:secret@example.com/', 'http://:pw@example.com/', 'not a url', ''])(
    'refuses %j before any lookup',
    async (url) => {
      const { fetcher, connections, resolved } = network({}, { 'example.com': [PUBLIC] });

      await expect(fetcher(url, signal())).rejects.toBeInstanceOf(FetchRefused);
      expect(resolved).toEqual([]);
      expect(connections).toEqual([]);
    },
  );

  describe.each([301, 302, 303, 307, 308])('a %i redirect', (status) => {
    it.each([
      ['a loopback address', 'http://127.0.0.1/admin'],
      ['the metadata address', 'http://169.254.169.254/latest/meta-data/'],
      ['a private IPv6 address', 'http://[fdaa::1]/'],
      ['a name that resolves to a private address', 'http://internal.example/'],
      ['another scheme', 'file:///etc/passwd'],
      ['a URL with credentials', 'http://user:pw@other.example/'],
    ])('to %s is refused at the first hop, and only the public hop was connected to', async (_description, location) => {
      const { fetcher, connections } = network(
        { 'http://example.com/': { status, location }, [location]: { status: 200, body: 'secret' } },
        { 'example.com': [PUBLIC], 'internal.example': ['10.9.9.9'], 'other.example': ['8.8.8.8'] },
      );

      await expect(fetcher('http://example.com/', signal())).rejects.toMatchObject({ name: 'FetchRefused', code: 'URL_NOT_ALLOWED' });
      expect(connections).toEqual([{ url: 'http://example.com/', address: PUBLIC }]);
    });

    it('to a private address at the fourth hop is refused, after three public ones', async () => {
      const { fetcher, connections } = network(
        {
          'http://example.com/1': { status, location: '/2' },
          'http://example.com/2': { status, location: '/3' },
          'http://example.com/3': { status, location: 'http://10.0.0.1/' },
        },
        { 'example.com': [PUBLIC] },
      );

      await expect(fetcher('http://example.com/1', signal())).rejects.toMatchObject({ code: 'URL_NOT_ALLOWED' });
      expect(connections.map((connection) => connection.url)).toEqual(['http://example.com/1', 'http://example.com/2', 'http://example.com/3']);
    });
  });

  it('refuses a sixth redirect hop and fetches nothing past the fifth', async () => {
    const routes: { [url: string]: Route } = {};
    for (let hop = 0; hop <= 7; hop += 1) routes[`http://example.com/${String(hop)}`] = { status: 302, location: `/${String(hop + 1)}` };
    const { fetcher, connections } = network(routes, { 'example.com': [PUBLIC] });

    await expect(fetcher('http://example.com/0', signal())).rejects.toMatchObject({ name: 'FetchRefused', code: 'TOO_MANY_REDIRECTS' });
    expect(connections.map((connection) => connection.url)).toEqual([0, 1, 2, 3, 4, 5].map((hop) => `http://example.com/${String(hop)}`));
  });

  it('re-resolves each hop, so a rebinding name cannot reuse an earlier check', async () => {
    const answers = [[PUBLIC], ['10.0.0.1']];
    const connections: string[] = [];
    const fetcher = createPageFetcher({
      resolve: () => Promise.resolve(answers.shift() ?? []),
      transport: (request) => {
        connections.push(request.address);
        return Promise.resolve({ status: 302, headers: { location: 'http://rebind.example/again' }, body: (async function* () { await Promise.resolve(); yield new Uint8Array(); })() });
      },
    });

    await expect(fetcher('http://rebind.example/', signal())).rejects.toBeInstanceOf(FetchRefused);
    expect(connections).toEqual([PUBLIC]);
  });
});

describe('createPageFetcher: when the fetch fails', () => {
  it('reports a name that does not resolve as unreachable', async () => {
    const { fetcher } = network({});

    await expect(fetcher('http://nowhere.example/', signal())).rejects.toMatchObject({ name: 'FetchFailed', code: 'UNREACHABLE' });
  });

  it('reports a name with no addresses as unreachable', async () => {
    const { fetcher } = network({}, { 'empty.example': [] });

    await expect(fetcher('http://empty.example/', signal())).rejects.toBeInstanceOf(FetchFailed);
  });

  it('reports a transport error as unreachable', async () => {
    const fetcher = createPageFetcher({ resolve: () => Promise.resolve([PUBLIC]), transport: () => Promise.reject(new Error('ECONNREFUSED')) });

    await expect(fetcher('http://example.com/', signal())).rejects.toMatchObject({ name: 'FetchFailed', code: 'UNREACHABLE' });
  });

  it('gives the transport the signal and stops with TIMED_OUT when it fires', async () => {
    let seen: AbortSignal | undefined;
    const fetcher = createPageFetcher({
      resolve: () => Promise.resolve([PUBLIC]),
      transport: ({ signal: given }) => {
        seen = given;
        return new Promise((_resolve, reject) => {
          given.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        });
      },
    });
    const budget = AbortSignal.timeout(20);

    await expect(fetcher('http://example.com/', budget)).rejects.toMatchObject({ name: 'FetchFailed', code: 'TIMED_OUT' });
    expect(seen).toBe(budget);
  });

  it('refuses a body past the size cap instead of reading it all', async () => {
    let read = 0;
    const fetcher = createPageFetcher({
      resolve: () => Promise.resolve([PUBLIC]),
      transport: () =>
        Promise.resolve({
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: (async function* () {
            for (;;) {
              await Promise.resolve();
              read += 1;
              yield new Uint8Array(1024);
            }
          })(),
        }),
      maxBytes: 4096,
    });

    await expect(fetcher('http://example.com/', signal())).rejects.toMatchObject({ name: 'FetchFailed', code: 'PAGE_TOO_LARGE' });
    expect(read).toBeLessThanOrEqual(6);
  });
});
