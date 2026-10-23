// The SSRF guard (design 1T minimum §2.3). The audit fetches an address the buyer chose, from inside the agent's private
// network, so every address a request would connect to is checked before it is used, on every redirect hop, and the
// connection goes to the address that was checked, not to the name.
import { BlockList, isIP } from 'node:net';

export type FetchRefusedCode = 'URL_NOT_ALLOWED' | 'TOO_MANY_REDIRECTS';
export type FetchFailedCode = 'UNREACHABLE' | 'TIMED_OUT' | 'PAGE_TOO_LARGE';

/** The guard said no; the message is for the agent's log, never for the buyer. */
export class FetchRefused extends Error {
  override readonly name = 'FetchRefused';
  readonly code: FetchRefusedCode;

  constructor(code: FetchRefusedCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** The page could not be had; the message is for the agent's log, never for the buyer. */
export class FetchFailed extends Error {
  override readonly name = 'FetchFailed';
  readonly code: FetchFailedCode;

  constructor(code: FetchFailedCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Page {
  finalUrl: string;
  status: number;
  contentType: string;
  html: string;
  bytes: number;
  elapsedMs: number;
}

export interface TransportRequest { url: URL; address: string; signal: AbortSignal }
/** Header names are lowercase. The transport follows no redirect and connects to `address`, whatever `url` says. */
export interface TransportResponse { status: number; headers: { [name: string]: string | undefined }; body: AsyncIterable<Uint8Array> }
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface PageFetcherOptions {
  resolve: (host: string) => Promise<string[]>;
  transport: Transport;
  now?: () => number;
  maxBytes?: number;
}

const MAX_REDIRECTS = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// --- which addresses are public -------------------------------------------------------------------------------------------
const REFUSED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];
// IPv6 is allowed only inside global unicast (2000::/3), which leaves out loopback, link-local, unique-local (Fly's fdaa::/16),
// multicast, IPv4-mapped and NAT64. Inside it, the protocol-assignment block (Teredo, ORCHID), documentation and 6to4
// (which embeds an IPv4 address) are refused too.
const REFUSED_V6: Array<[string, number]> = [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]];

const refusedV4 = new BlockList();
for (const [network, prefix] of REFUSED_V4) refusedV4.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const refusedV6 = new BlockList();
for (const [network, prefix] of REFUSED_V6) refusedV6.addSubnet(network, prefix, 'ipv6');

/** True only for a literal IPv4 or IPv6 address on the public internet; anything else, a name included, is false. */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) return !refusedV4.check(address, 'ipv4');
  if (family === 6 && !address.includes('%')) return globalV6.check(address, 'ipv6') && !refusedV6.check(address, 'ipv6');
  return false;
};

// --- the fetch -------------------------------------------------------------------------------------------------------------
const refuse = (message: string): FetchRefused => new FetchRefused('URL_NOT_ALLOWED', message);

/** http or https, no credentials. `new URL` has already turned 2130706433, 0x7f.0.0.1 and 127.1 into 127.0.0.1. */
const parseTarget = (raw: string, base?: URL): URL => {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw refuse('not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse(`scheme ${url.protocol}`);
  if (url.username !== '' || url.password !== '') throw refuse('credentials in the URL');
  return url;
};

const failure = (signal: AbortSignal, error: unknown): FetchFailed => new FetchFailed(signal.aborted ? 'TIMED_OUT' : 'UNREACHABLE', String(error));

// Every address of the host, checked; the first is the one to connect to. One private address among public ones refuses the lot.
const checkedAddress = async (url: URL, options: PageFetcherOptions, signal: AbortSignal): Promise<string> => {
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const addresses =
    isIP(host) === 0
      ? await options.resolve(host).catch((error: unknown) => {
          throw failure(signal, error);
        })
      : [host];
  const [first] = addresses;
  if (first === undefined) throw new FetchFailed('UNREACHABLE', `${host} has no address`);
  if (!addresses.every(isPublicAddress)) throw refuse(`${host} resolves to a non-public address`);
  return first;
};

const readBody = async (body: AsyncIterable<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<{ html: string; bytes: number }> => {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new FetchFailed('PAGE_TOO_LARGE', `more than ${String(maxBytes)} bytes`);
      chunks.push(chunk);
    }
  } catch (error) {
    throw error instanceof FetchFailed ? error : failure(signal, error);
  }
  // UTF-8 only: a page in another charset is audited as read, which is enough for tags and the first words.
  return { html: new TextDecoder().decode(Buffer.concat(chunks)), bytes };
};

// A redirect's body is never read; closing the iterator releases its socket.
const discard = async (body: AsyncIterable<Uint8Array>): Promise<void> => {
  await body[Symbol.asyncIterator]().return?.();
};

/** Fetches a page with the guard on: at most 5 redirects (a sixth is refused), each hop resolved and checked before it is fetched. */
export const createPageFetcher = (options: PageFetcherOptions): ((url: string, signal: AbortSignal) => Promise<Page>) => {
  const now = options.now ?? ((): number => performance.now());
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  return async (rawUrl, signal) => {
    const started = now();
    let url = parseTarget(rawUrl);
    for (let redirects = 0; ; redirects += 1) {
      const address = await checkedAddress(url, options, signal);
      const response = await options.transport({ url, address, signal }).catch((error: unknown) => {
        throw failure(signal, error);
      });
      const location = response.headers['location'];
      if (REDIRECT_STATUSES.has(response.status) && location !== undefined && location !== '') {
        await discard(response.body).catch(() => undefined);
        if (redirects === MAX_REDIRECTS) throw new FetchRefused('TOO_MANY_REDIRECTS', `more than ${String(MAX_REDIRECTS)} redirects`);
        url = parseTarget(location, url);
        continue;
      }
      const { html, bytes } = await readBody(response.body, maxBytes, signal);
      return { finalUrl: url.href, status: response.status, contentType: response.headers['content-type'] ?? '', html, bytes, elapsedMs: now() - started };
    }
  };
};
