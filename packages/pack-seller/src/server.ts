import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createOarsClient } from '@manyoars/oars-client';
import { createBilling } from './billing.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import {
  OFFER_RATE_LIMIT,
  OFFER_RATE_WINDOW_MS,
  createRateLimiter,
} from './rate-limit.js';
import { createHandler, memoryOfferLedger, type OfferLedger, type PackCatalog, type RouteDeps } from './routes.js';

export const SELLER_VERSION = '0.0.0';
/** Longest request body read; an offer request is two short strings. */
export const MAX_BODY_BYTES = 8_192;

/** Until brief 3's pack store exists the seller lists no packs, so every pack route answers 404. */
export const emptyCatalog: PackCatalog = { list: () => [], find: () => undefined };

export interface SellerOptions {
  config: Config;
  catalog?: PackCatalog;
  ledger?: OfferLedger;
  log?: (line: string) => void;
  now?: () => number;
}

const readBytes = async (incoming: IncomingMessage): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += part.length;
    // Keep reading past the limit without keeping the bytes, so the client sees the 413 and not a reset connection.
    if (size <= MAX_BODY_BYTES) chunks.push(part);
  }
  return size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks);
};

/** The seller's node server; it only adapts `http` to the handler in routes.ts. Call `listen` on it. */
export const createSellerServer = (options: SellerOptions): Server => {
  const now = options.now ?? Date.now;
  const client = createOarsClient({ version: SELLER_VERSION, token: options.config.sdkKey, baseUrl: options.config.apiUrl });
  const deps: RouteDeps = {
    billing: createBilling(client, options.config.sdkKey),
    catalog: options.catalog ?? emptyCatalog,
    ledger: options.ledger ?? memoryOfferLedger(),
    limiter: createRateLimiter(OFFER_RATE_LIMIT, OFFER_RATE_WINDOW_MS, now),
    log: options.log ?? ((line) => {
      console.log(line);
    }),
    now,
  };
  const handle = createHandler(deps);
  return createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    void (async () => {
      const body = await readBytes(incoming);
      if (body === undefined) {
        outgoing.writeHead(413, { 'Content-Type': 'application/json' }).end('{"error":"The request body is too large."}');
        return;
      }
      const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(name, value);
      }
      const request = new Request(new URL(incoming.url ?? '/', 'http://seller.invalid'), {
        method: incoming.method,
        headers,
        body: hasBody ? new Uint8Array(body) : undefined,
      });
      const response = await handle(request, incoming.socket.remoteAddress ?? 'unknown');
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
    })().catch(() => {
      // A handler never throws on a platform refusal; this is a bug, so answer one line and leave the detail out of the response.
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"Internal error."}');
    });
  });
};

export type StartResult = { ok: true; server: Server; port: number } | { ok: false; line: string };

/** Reads the environment and starts listening; a bad configuration comes back as one line to print, with nothing started. */
export const start = async (env: Readonly<Record<string, string | undefined>>, options: Omit<SellerOptions, 'config'> = {}): Promise<StartResult> => {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, line: error.message };
    throw error;
  }
  const server = createSellerServer({ ...options, config });
  await new Promise<void>((resolve) => server.listen(config.port, '127.0.0.1', resolve));
  const address = server.address();
  return { ok: true, server, port: typeof address === 'object' && address !== null ? address.port : config.port };
};
