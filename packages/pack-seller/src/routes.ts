import type { Billing } from './billing.js';
import { RESERVE_CREDITS } from './billing.js';
import type { PackSource } from './pack-store.js';
import { END_OF_ARCHIVE, archiveNames, entries } from './tar.js';
import { OFFER_RATE_REFUSAL_STATUS, type RateLimiter } from './rate-limit.js';
import { BAD_REQUEST, BUILD_FAILED, NO_CREDITS, NOT_FOUND, type Outcome, type Refusal } from './refusal.js';

/** What the pack list and the offer need of one pack. The pack store's `PackPage` widens it with the manifest terms, census, and card the pack page shows. */
export interface PackListing {
  packId: string;
  /** `pack-<packId>`, the platform price the buyer pays for (design section b). */
  priceRef: string;
  title: string;
}

export interface PackCatalog {
  list: () => PackListing[];
  find: (packId: string) => PackListing | undefined;
}

/** What an offer request records against its customer, kept for the delivery record (design step 9). */
export interface OfferRecord {
  customerRef: string;
  packId: string;
  recipientLegalName: string;
  licenseVersion: string;
  recordedAt: number;
}

export interface OfferLedger {
  record: (entry: OfferRecord) => void;
  find: (customerRef: string) => OfferRecord | undefined;
}

/** Offer records in memory, for tests of the routes alone; the seller itself keeps them on disk (`fileLedger`, beside `deliveries.jsonl`). */
export const memoryOfferLedger = (): OfferLedger => {
  const entries = new Map<string, OfferRecord>();
  return {
    record: (entry) => {
      entries.set(entry.customerRef, entry);
    },
    find: (customerRef) => entries.get(customerRef),
  };
};

export interface RouteDeps {
  billing: Billing;
  catalog: PackCatalog;
  ledger: OfferLedger;
  source: PackSource;
  limiter: RateLimiter;
  /** One line per request: method, path, status. Never a header, a body, or a customer ref. */
  log: (line: string) => void;
  now: () => number;
}

export const MAX_NAME_LENGTH = 200;
export const MAX_LICENSE_VERSION_LENGTH = 64;
/** Longest buyer key a download request carries. */
export const MAX_BUYER_KEY_LENGTH = 512;
/** The customer ref travels in this header, not in a path, so no access log or proxy keeps it. */
export const CUSTOMER_REF_HEADER = 'x-customer-ref';

const CUSTOMER_REF = /^[A-Za-z0-9_-]{16,128}$/;

const respond = (status: number, body: object): Response => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const refuse = (refusal: Refusal): Response => respond(refusal.status, { error: refusal.message });
const answer = <T extends object>(done: Outcome<T>): Response => (done.ok ? respond(200, done.value) : refuse(done.refusal));

const readBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
};

const text = (body: unknown, field: string, max: number): string | undefined => {
  if (typeof body !== 'object' || body === null || !(field in body)) return undefined;
  const value: unknown = Reflect.get(body, field);
  return typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : undefined;
};

/** Step 5: a customer with a fresh ref, the recipient and license recorded against it, an offer, and the ref returned this once. */
const offer = async (deps: RouteDeps, request: Request, caller: string, pack: PackListing): Promise<Response> => {
  if (!deps.limiter.allow(caller)) return respond(OFFER_RATE_REFUSAL_STATUS, { error: 'Too many offer requests. Try again later.' });
  const body = await readBody(request);
  const recipientLegalName = text(body, 'recipientLegalName', MAX_NAME_LENGTH);
  if (recipientLegalName === undefined) return respond(400, { error: 'recipientLegalName is required.' });
  const licenseVersion = text(body, 'licenseVersion', MAX_LICENSE_VERSION_LENGTH);
  if (licenseVersion === undefined) return respond(400, { error: 'licenseVersion is required.' });
  const customer = await deps.billing.createCustomer();
  if (!customer.ok) return refuse(customer.refusal);
  const made = await deps.billing.createOffer(customer.value);
  if (!made.ok) return refuse(made.refusal);
  deps.ledger.record({ customerRef: customer.value, packId: pack.packId, recipientLegalName, licenseVersion, recordedAt: deps.now() });
  return respond(200, { offerId: made.value.offerId, expiresAt: made.value.expiresAt, priceRef: pack.priceRef, customerRef: customer.value });
};

/**
 * Step 9: balance, reserve one credit, rebuild when the objections moved, build under the buyer's key, stream, commit, record. The archive's end blocks go out only after the commit and the record,
 * so a failure before the commit leaves an archive without its terminator and a released reservation. The buyer key lives in this function's scope for the build and is never logged or stored.
 */
const download = async (deps: RouteDeps, request: Request, pack: PackListing): Promise<Response> => {
  const ref = customerRefOf(request);
  if (ref === undefined) return refuse(BAD_REQUEST);
  const body = await readBody(request);
  const given: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'buyerKey') : undefined;
  if (typeof given !== 'string' || given === '' || given.length > MAX_BUYER_KEY_LENGTH) return respond(400, { error: 'buyerKey is required.' });
  const key: string = given;
  const offer = deps.ledger.find(ref);
  if (offer === undefined || offer.packId !== pack.packId) return refuse(NOT_FOUND);
  const balance = await deps.billing.balance(ref);
  if (!balance.ok) return refuse(balance.refusal);
  if (balance.value.creditsAvailable < RESERVE_CREDITS) return refuse(NO_CREDITS);
  const reserved = await deps.billing.reserve(ref);
  if (!reserved.ok) return refuse(reserved.refusal);
  const reservationId = reserved.value.reservationId;
  let built: Outcome<string>;
  let names: string[] = [];
  try {
    built = await deps.source.prepare(pack.packId, key);
    if (built.ok) names = await archiveNames(built.value);
  } catch {
    built = { ok: false, refusal: BUILD_FAILED };
  }
  if (!built.ok || names.length === 0) {
    await deps.billing.release(reservationId);
    return refuse(built.ok ? BUILD_FAILED : built.refusal);
  }
  const [dir, held] = [built.value, offer];
  async function* archive(): AsyncGenerator<Uint8Array> {
    let spent = false;
    try {
      yield* entries(dir, names);
      // An objection that landed during the stream makes this build stale: release instead of charging for a pack that must not be delivered.
      if (!(await deps.source.check(dir))) throw new Error('objections changed');
      const committed = await deps.billing.commit(reservationId);
      if (!committed.ok) throw new Error('commit refused');
      spent = true;
      try {
        await deps.source.record(dir, key, held);
      } catch {
        // The buyer is charged and holds the whole pack; the operator runs `deliver` by hand. The line names the pack, never the customer ref.
        deps.log(`delivery record failed after commit for pack ${pack.packId}: run deliver by hand`);
      }
      yield END_OF_ARCHIVE;
    } finally {
      if (!spent) await deps.billing.release(reservationId);
    }
  }
  return new Response(ReadableStream.from(archive()), {
    status: 200,
    headers: { 'Content-Type': 'application/x-tar', 'Content-Disposition': `attachment; filename="${pack.packId}.tar"`, 'Cache-Control': 'no-store' },
  });
};

const customerRefOf = (request: Request): string | undefined => {
  const ref = request.headers.get(CUSTOMER_REF_HEADER);
  return ref !== null && CUSTOMER_REF.test(ref) ? ref : undefined;
};

const route = async (deps: RouteDeps, request: Request, caller: string): Promise<Response> => {
  const { pathname } = new URL(request.url);
  const parts = pathname.split('/').filter((part) => part !== '');
  const [first, second, third] = parts;
  const method = request.method;

  if (method === 'GET' && pathname === '/health') return respond(200, { status: 'ok' });

  // Step 4: the pack page. The catalog supplies the pack's census, card, and terms; this serves what it lists.
  if (first === 'packs') {
    if (method === 'GET' && parts.length === 1) return respond(200, { packs: deps.catalog.list().map(({ packId, priceRef, title }) => ({ packId, priceRef, title })) });
    const pack = second === undefined ? undefined : deps.catalog.find(second);
    if (pack === undefined) return refuse(NOT_FOUND);
    if (method === 'GET' && parts.length === 2) return respond(200, pack);
    if (method === 'POST' && parts.length === 3 && third === 'offer') return offer(deps, request, caller, pack);
    if (method === 'POST' && parts.length === 3 && third === 'download') return download(deps, request, pack);
    return refuse(NOT_FOUND);
  }

  // Step 9: the balance. Reserve, commit, and release run inside the download route, never as public routes. The seller learns of settlement only by reading the balance (design Fact 3).
  if (first === 'credits') {
    if (method === 'GET' && parts.length === 1) {
      const ref = customerRefOf(request);
      return ref === undefined ? refuse(BAD_REQUEST) : answer(await deps.billing.balance(ref));
    }
  }
  return refuse(NOT_FOUND);
};

/** The seller as a Web `Request` to `Response` function; the node server only adapts to it, so tests need no socket. */
export const createHandler = (deps: RouteDeps) => async (request: Request, caller: string): Promise<Response> => {
  const response = await route(deps, request, caller);
  deps.log(`${request.method} ${new URL(request.url).pathname} ${String(response.status)}`);
  return response;
};
