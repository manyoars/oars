import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { createOarsClient } from '@manyoars/oars-client';
import { createBilling } from './billing.js';
import { createRateLimiter, OFFER_RATE_LIMIT, OFFER_RATE_WINDOW_MS } from './rate-limit.js';
import type { PackStore } from './pack-store.js';
import { createHandler, memoryOfferLedger, type PackCatalog, type PackListing } from './routes.js';

export const API = 'https://api.test';
export const SDK_KEY = 'aorsk_test_secret_value';
export const server = setupServer();

/** Starts the shared msw server for one test file; an unmocked request fails the test. */
export const useServer = (): void => {
  beforeAll(() => {
    server.listen({ onUnhandledFrame: 'error' });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });
};

export const PACK: PackListing = { packId: 'alpha', priceRef: 'pack-alpha', title: 'Alpha pack' };
export const catalog: PackCatalog = { list: () => [PACK], find: (id) => (id === PACK.packId ? PACK : undefined) };

export const platform = (path: string, status: number, body: object, method: 'get' | 'post' = 'post') =>
  http[method](`${API}${path}`, () => HttpResponse.json(body, { status }));

/** A seller wired to msw, a driven clock, and a captured log. */
export const harness = (store?: PackStore) => {
  let time = 1_000;
  const lines: string[] = [];
  const ledger = store?.ledger ?? memoryOfferLedger();
  const now = () => time;
  const client = createOarsClient({ version: 'test', baseUrl: API });
  const handle = createHandler({
    billing: createBilling(client, SDK_KEY),
    catalog: store?.catalog ?? catalog,
    ledger,
    source: store ?? { prepare: () => Promise.reject(new Error('This harness has no pack source.')), check: () => Promise.reject(new Error('This harness has no pack source.')), record: () => Promise.reject(new Error('This harness has no pack source.')) },
    limiter: createRateLimiter(OFFER_RATE_LIMIT, OFFER_RATE_WINDOW_MS, now),
    log: (line) => lines.push(line),
    now,
  });
  return {
    lines,
    ledger,
    advance: (ms: number) => {
      time += ms;
    },
    call: (method: string, path: string, init: { body?: object; headers?: [string, string][]; caller?: string } = {}) =>
      handle(
        new Request(`http://seller.test${path}`, {
          method,
          headers: [['Content-Type', 'application/json'], ...(init.headers ?? [])],
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
        }),
        init.caller ?? 'caller-1',
      ),
  };
};

/** The `customerRef` an offer response carries; fails the test when it has none. */
export const customerRefOf = async (response: Response): Promise<string> => {
  const body: unknown = await response.json();
  const ref: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'customerRef') : undefined;
  if (typeof ref !== 'string') throw new Error('The response carries no customerRef.');
  return ref;
};

const TAR_BLOCK = 512;
const tarText = (bytes: Buffer, at: number, length: number): string => bytes.toString('utf8', at, at + length).replace(/\0.*$/s, '');

/** What a buyer's tar reader does: writes each whole entry under `dir` and stops at the end blocks or the end of the bytes, whichever comes first. Returns the entry names. */
export const untar = (bytes: Buffer, dir: string): string[] => {
  const names: string[] = [];
  let at = 0;
  while (at + TAR_BLOCK <= bytes.length && bytes.subarray(at, at + TAR_BLOCK).some((byte) => byte !== 0)) {
    const prefix = tarText(bytes, at + 345, 155);
    const base = tarText(bytes, at, 100);
    const name = prefix === '' ? base : `${prefix}/${base}`;
    const size = parseInt(tarText(bytes, at + 124, 12), 8);
    const body = bytes.subarray(at + TAR_BLOCK, at + TAR_BLOCK + size);
    if (body.length < size) break;
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    names.push(name);
    at += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return names;
};
