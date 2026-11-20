import { randomBytes, randomUUID } from 'node:crypto';
import type { components, OarsClient } from '@manyoars/oars-client';
import { refusalFor, UNAVAILABLE, type Outcome } from './refusal.js';

type Balance = components['schemas']['CreditBalanceView'];
type Offer = components['schemas']['PurchaseOfferView'];
type Reservation = components['schemas']['ReservationView'];
type Committed = components['schemas']['ReservationCommitView'];
type Released = components['schemas']['ReservationReleaseView'];

/** Credits one download holds (the design's step 9). */
export const RESERVE_CREDITS = 1;
/** The platform allows 1 to 300 seconds; a build and a stream fit in the longest hold. */
export const RESERVE_TTL_SECONDS = 300;
/** The platform takes US buyers only, so every customer carries this country; the state is the one thing the buyer brings. */
export const CUSTOMER_COUNTRY_CODE = 'US';

/** The states a buyer can name: the 50 US state codes and DC, in upper case (the same list the pool takes). No territory is on it. */
export const US_STATES: ReadonlySet<string> = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));

export interface Billing {
  /** Creates a customer under a fresh high-entropy ref, as a US buyer in `regionCode` (a state code the caller has checked), and returns the ref. */
  createCustomer: (regionCode: string) => Promise<Outcome<string>>;
  createOffer: (customerRef: string) => Promise<Outcome<Offer>>;
  balance: (customerRef: string) => Promise<Outcome<Balance>>;
  reserve: (customerRef: string, idempotencyKey?: string) => Promise<Outcome<Reservation>>;
  commit: (reservationId: string) => Promise<Outcome<Committed>>;
  release: (reservationId: string) => Promise<Outcome<Released>>;
}

interface Answered<T> {
  data?: T;
  response: Response;
}

/** Turns an openapi-fetch answer, or a thrown network error, into an outcome; the platform's own body is never read past `data`. */
const outcome = async <T>(call: () => Promise<Answered<T>>): Promise<Outcome<T>> => {
  try {
    const { data, response } = await call();
    if (data === undefined) return { ok: false, refusal: refusalFor(response.status) };
    return { ok: true, value: data };
  } catch {
    return { ok: false, refusal: UNAVAILABLE };
  }
};

/** The seller's billing calls, all under its own SDK key (`aorsk_...`), which the client passes per call and never logs. */
export const createBilling = (client: OarsClient, sdkKey: string): Billing => {
  const header = { 'X-Agent-SDK-Key': sdkKey };
  return {
    createCustomer: async (regionCode) => {
      const customerRef = `c_${randomBytes(32).toString('base64url')}`;
      const made = await outcome(() =>
        client.POST('/billing/customers', {
          params: { header },
          body: { customerRef, countryCode: CUSTOMER_COUNTRY_CODE, regionCode },
        }),
      );
      return made.ok ? { ok: true, value: customerRef } : made;
    },
    createOffer: (customerRef) => outcome(() => client.POST('/billing/offers', { params: { header }, body: { customerRef } })),
    balance: (customerRef) =>
      outcome(() => client.GET('/billing/credits/{customerRef}', { params: { header, path: { customerRef } } })),
    reserve: (customerRef, idempotencyKey) =>
      outcome(() =>
        client.POST('/billing/credits/reservations', {
          params: { header: { ...header, 'Idempotency-Key': idempotencyKey ?? randomUUID() } },
          body: { customerRef, credits: RESERVE_CREDITS, ttlSeconds: RESERVE_TTL_SECONDS },
        }),
      ),
    commit: (reservationId) =>
      outcome(() =>
        client.POST('/billing/credits/reservations/{reservationId}/commit', { params: { header, path: { reservationId } } }),
      ),
    release: (reservationId) =>
      outcome(() =>
        client.POST('/billing/credits/reservations/{reservationId}/release', { params: { header, path: { reservationId } } }),
      ),
  };
};
