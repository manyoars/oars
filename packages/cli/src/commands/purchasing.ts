import { readFile } from 'node:fs/promises';
import { purchases, type components } from '@manyoars/oars-client';
import { apiClient, unwrap } from '../api.js';
import { CliError, ExitCode } from '../errors.js';
import { stepKey } from './keys.js';
import type { Outcome, RunDeps } from '../cli.js';

type Pack = components['schemas']['PurchaseOfferPack'];

const OFFER_STEP = 'purchasing-offer';
const BUY_STEP = 'purchasing-buy';
const GET_STEP = 'purchasing-get';

export interface PurchasingOptions {
  apiUrl: string;
  /** `--sdk-key-file`; absent means `OARS_SDK_KEY`. */
  sdkKeyFile?: string;
}

export interface PurchasingOfferOptions extends PurchasingOptions {
  offerId: string;
}

export interface PurchasingBuyOptions extends PurchasingOfferOptions {
  /** `--pack`: the offer's pack to buy. */
  priceRef: string;
  /** The base of the step key, so a retry of this command returns the same purchase. */
  idempotencyKey: string;
}

export interface PurchasingGetOptions extends PurchasingOptions {
  purchaseId: string;
}

/** The buying agent's own SDK key, from a file (so it stays off the command line and out of shell history) or `OARS_SDK_KEY`. */
const resolveSdkKey = async (deps: RunDeps, step: string, file?: string): Promise<string> => {
  const raw = file === undefined ? deps.env.OARS_SDK_KEY : await readFile(file, 'utf8').catch(() => undefined);
  const key = raw?.trim();
  if (key !== undefined && key !== '') return key;
  throw new CliError(
    file === undefined ? 'The buying agent needs its SDK key: set OARS_SDK_KEY or pass --sdk-key-file.' : `Cannot read an SDK key from ${file}.`,
    ExitCode.USAGE,
    step,
  );
};

const describePack = (pack: Pack): string => [pack.priceRef, pack.displayName, `${String(pack.credits)} credits`, `$${Number(pack.amountUsd).toFixed(2)}`].join('  ');

const describePurchase = (purchase: { purchaseId: string; status: string; failureCode?: string; credits: number }): string =>
  `Purchase ${purchase.purchaseId}: ${purchase.status}${purchase.failureCode === undefined ? '' : ` (${purchase.failureCode})`}, ${String(purchase.credits)} credits.`;

/** `GET /billing/offers/{offerId}`: what the seller offers on this offer, before anything is bought. */
export const purchasingOffer = async (deps: RunDeps, options: PurchasingOfferOptions): Promise<Outcome> => {
  const sdkKey = await resolveSdkKey(deps, OFFER_STEP, options.sdkKeyFile);
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: OFFER_STEP });
  const offer = unwrap(OFFER_STEP, await purchases.offer(client, { sdkKey, offerId: options.offerId }));
  return {
    document: { ok: true, offer },
    text: [`Offer ${offer.offerId} from ${offer.sellerName} (${offer.sellerSlug}), ${offer.mode}, expires ${offer.expiresAt}`, ...offer.packs.map(describePack)].join('\n'),
  };
};

/** `POST /billing/purchases`: buy one pack of an offer. A retry with the same `--idempotency-key` returns the same purchase. */
export const purchasingBuy = async (deps: RunDeps, options: PurchasingBuyOptions): Promise<Outcome> => {
  const sdkKey = await resolveSdkKey(deps, BUY_STEP, options.sdkKeyFile);
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: BUY_STEP });
  const purchase = unwrap(
    BUY_STEP,
    await purchases.buy(client, { sdkKey, offerId: options.offerId, priceRef: options.priceRef, idempotencyKey: stepKey(options.idempotencyKey, BUY_STEP) }),
  );
  return {
    document: { ok: true, purchase },
    text: `${describePurchase(purchase)} Poll it with \`oars purchasing get ${purchase.purchaseId}\`.`,
  };
};

/** `GET /billing/purchases/{purchaseId}`: where a purchase stands; run it again until it leaves PENDING. */
export const purchasingGet = async (deps: RunDeps, options: PurchasingGetOptions): Promise<Outcome> => {
  const sdkKey = await resolveSdkKey(deps, GET_STEP, options.sdkKeyFile);
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: GET_STEP });
  const purchase = unwrap(GET_STEP, await purchases.get(client, { sdkKey, purchaseId: options.purchaseId }));
  return { document: { ok: true, purchase }, text: describePurchase(purchase) };
};
