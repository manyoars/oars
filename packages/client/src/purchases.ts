import { randomUUID } from 'node:crypto';
import type { OarsClient } from './client.js';

/** The buying agent's own SDK key: only it starts or reads a purchase (T §6), never a seller or a developer token. */
export interface BuyerCredentials {
  sdkKey: string;
}

export interface BuyInput extends BuyerCredentials {
  /** The `po_...` offer the seller issued. */
  offerId: string;
  /** One of the offer's credit packs. */
  priceRef: string;
  /** A retry of the same buy passes the same key, so the platform returns the same purchase; a fresh UUID when absent. */
  idempotencyKey?: string;
}

export interface GetPurchaseInput extends BuyerCredentials {
  purchaseId: string;
}

/**
 * The buyer's side of an agent-to-agent purchase (T §3 steps 5-6) over the generated operations. Each call returns what
 * openapi-fetch returns (`data` or `error` plus the `response`), so the caller decides how a refusal reads.
 */
export const purchases = {
  /** `POST /billing/purchases`: buy one of an offer's credit packs. `Idempotency-Key` is required, so every buy sends one. */
  buy: (client: OarsClient, input: BuyInput) =>
    client.POST('/billing/purchases', {
      params: { header: { 'Idempotency-Key': input.idempotencyKey ?? randomUUID(), 'X-Agent-SDK-Key': input.sdkKey } },
      body: { offerId: input.offerId, priceRef: input.priceRef },
    }),
  /** `GET /billing/purchases/{purchaseId}`: poll a purchase until it leaves `PENDING`. */
  get: (client: OarsClient, input: GetPurchaseInput) =>
    client.GET('/billing/purchases/{purchaseId}', {
      params: { path: { purchaseId: input.purchaseId }, header: { 'X-Agent-SDK-Key': input.sdkKey } },
    }),
};
