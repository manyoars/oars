import type { components, OarsClient } from '@manyoars/oars-client';

type PriceInput = components['schemas']['CreatePriceInput'];

/** Credits one pack purchase grants; a download consumes one (design open question 3). */
export const PACK_CREDITS = 3;
/** The platform's limits on a price (`AgentPrice.java`): the priceRef and the display name. */
export const MAX_PRICE_REF_LENGTH = 64;
export const MAX_DISPLAY_NAME_LENGTH = 120;
export const ENV_PRICE_USD = 'OARS_SELLER_PRICE_USD';

/** A pack that cannot become a price, or an amount the operator did not configure. The message is one line and names the cause. */
export class PricingError extends Error {}

const PRICE_REF = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AMOUNT = /^\d{1,7}(\.\d{1,2})?$/;

/** The price amount comes from operator configuration only: a price is immutable once charged, so no default is safe. */
export const amountFrom = (env: Readonly<NodeJS.ProcessEnv>): string => {
  const amount = env[ENV_PRICE_USD]?.trim();
  if (amount === undefined || !AMOUNT.test(amount) || Number(amount) <= 0) {
    throw new PricingError(`${ENV_PRICE_USD} must be a positive amount with at most two decimals.`);
  }
  return amount;
};

/** `pack.json`'s id and title as a `CREDIT_PACK` price: priceRef `pack-<packId>`, displayName the title. */
export const priceInputFor = (pack: { packId: string; title: string }, amountUsd: string): PriceInput => {
  const priceRef = `pack-${pack.packId}`;
  if (priceRef.length > MAX_PRICE_REF_LENGTH) throw new PricingError(`The priceRef pack-<packId> is over ${String(MAX_PRICE_REF_LENGTH)} characters.`);
  if (!PRICE_REF.test(priceRef)) throw new PricingError('The packId must be lowercase letters, digits, hyphens, and underscores.');
  const displayName = pack.title.trim();
  if (displayName === '') throw new PricingError('The pack title is empty.');
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) throw new PricingError(`The pack title is over ${String(MAX_DISPLAY_NAME_LENGTH)} characters.`);
  return { priceRef, displayName, kind: 'CREDIT_PACK', credits: PACK_CREDITS, amountUsd };
};

/**
 * Lists the price on the workload. The platform replays identical terms (200) and refuses a priceRef that exists with other terms (409);
 * either way the existing price is left alone, because its amount is immutable once charged.
 */
export const ensurePrice = async (client: OarsClient, workloadId: string, input: PriceInput): Promise<'created' | 'present' | 'differs'> => {
  const { response } = await client.POST('/billing/agents/{workloadId}/prices', { params: { path: { workloadId } }, body: input });
  if (response.status === 201) return 'created';
  if (response.status === 200) return 'present';
  if (response.status === 409) return 'differs';
  throw new PricingError(`The platform answered ${String(response.status)} to the price.`);
};
