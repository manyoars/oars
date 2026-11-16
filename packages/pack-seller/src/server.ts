import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createOarsClient } from '@manyoars/oars-client';
import { createBilling } from './billing.js';
import { ConfigError, ENV_HOST, ENV_PORT, loadConfig, type Config } from './config.js';
import {
  OFFER_RATE_LIMIT,
  OFFER_RATE_WINDOW_MS,
  createRateLimiter,
} from './rate-limit.js';
import { loadPackInputs, openPackStore, type PackStore, type StoreOptions } from './pack-store.js';
import { createHandler, type RouteDeps } from './routes.js';

export const SELLER_VERSION = '0.0.0';
/** Longest request body read; an offer request is two short strings. */
export const MAX_BODY_BYTES = 8_192;

export interface SellerOptions {
  config: Config;
  store: PackStore;
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

/** The body's chunks; leaving early (a closed client, a failed write) cancels the source, which is what releases a download's reservation. */
async function* chunksOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel();
  }
}

/** The seller's node server; it only adapts `http` to the handler in routes.ts. Call `listen` on it. */
export const createSellerServer = (options: SellerOptions): Server => {
  const now = options.now ?? Date.now;
  const client = createOarsClient({ version: SELLER_VERSION, baseUrl: options.config.apiUrl });
  const deps: RouteDeps = {
    billing: createBilling(client, options.config.sdkKey),
    catalog: options.store.catalog,
    ledger: options.store.ledger,
    source: options.store,
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
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      // A download streams: the pipeline ends the response when the archive ends, and a failure or a closed client stops the source, which releases the reservation.
      if (response.body === null) outgoing.end();
      else await pipeline(Readable.from(chunksOf(response.body)), outgoing);
    })().catch(() => {
      // A handler never throws on a platform refusal; this is a bug, so answer one line and leave the detail out of the response.
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"Internal error."}');
      else outgoing.destroy();
    });
  });
};

export type StartResult = { ok: true; server: Server; port: number } | { ok: false; line: string };

export interface StartOptions extends StoreOptions {
  log?: (line: string) => void;
  now?: () => number;
}

/** Reads the environment and starts listening; a bad configuration comes back as one line to print, with nothing started. */
export const start = async (env: Readonly<NodeJS.ProcessEnv>, options: StartOptions = {}): Promise<StartResult> => {
  let config: Config;
  let store: PackStore;
  try {
    config = loadConfig(env);
    store = await openPackStore(loadPackInputs(env), options);
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, line: error.message };
    throw error;
  }
  const server = createSellerServer({ log: options.log, now: options.now, config, store });
  // A taken port or an unusable host rejects here instead of crashing the process with an unhandled error event. The system's message can name the address, so the line names the variables instead.
  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', () => {
      resolve(false);
    });
    server.listen(config.port, config.host, () => {
      server.removeAllListeners('error');
      resolve(true);
    });
  });
  if (!listening) return { ok: false, line: `The pack seller could not listen: check ${ENV_PORT} and ${ENV_HOST}.` };
  const address = server.address();
  return { ok: true, server, port: typeof address === 'object' && address !== null ? address.port : config.port };
};
