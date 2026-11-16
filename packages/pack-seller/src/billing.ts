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
/** The platform requires a country on a customer; the seller does not collect one, so every customer carries this. */
export const CUSTOMER_COUNTRY_CODE = 'US';

export interface Billing {
  /** Creates a customer under a fresh high-entropy ref and returns the ref. */
  createCustomer: () => Promise<Outcome<string>>;
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
    createCustomer: async () => {
      const customerRef = `c_${randomBytes(32).toString('base64url')}`;
      const made = await outcome(() =>
        client.POST('/billing/customers', {
          params: { header },
          body: { customerRef, countryCode: CUSTOMER_COUNTRY_CODE },
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
