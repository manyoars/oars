// The network side of the SSRF guard: node:http and node:https, with the socket pinned to the address fetch-page.ts checked.
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { pipeline, type Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Transport, TransportResponse } from './fetch-page.js';

const USER_AGENT = 'ManyOarsPerTaskAgent/0.1 (landing-page audit)';

/** Every address the system resolver has for a name, in the order it returned them. */
export const dnsResolve = async (host: string): Promise<string[]> => (await lookup(host, { all: true, order: 'verbatim' })).map((entry) => entry.address);

const decoderFor = (encoding: string | undefined): (() => Transform) | undefined => {
  if (encoding === 'gzip' || encoding === 'x-gzip') return createGunzip;
  if (encoding === 'deflate') return createInflate;
  if (encoding === 'br') return createBrotliDecompress;
  return undefined;
};

const respond = (response: IncomingMessage): TransportResponse => {
  const headers: { [name: string]: string | undefined } = {};
  for (const [name, value] of Object.entries(response.headers)) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  const decoder = decoderFor(headers['content-encoding']?.trim().toLowerCase());
  // pipeline closes the response (and its socket) when the reader stops early, e.g. at the size cap.
  const body = decoder === undefined ? response : pipeline(response, decoder(), () => undefined);
  return { status: response.statusCode ?? 0, headers, body };
};

/**
 * One GET, no redirect followed, no keep-alive. The request keeps the URL's host (the Host header, the TLS server name and its
 * certificate check) but the socket goes to `address`, so a name cannot be re-resolved to something else after the check.
 */
export const nodeTransport: Transport = ({ url, address, signal }) =>
  new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(
      url,
      {
        method: 'GET',
        agent: false,
        signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'identity' },
        lookup: (_host, options, callback) => {
          const family = isIP(address);
          if (options.all === true) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      },
      (response) => {
        resolve(respond(response));
      },
    );
    request.once('error', reject);
    request.end();
  });
