import { createOarsClient } from '@manyoars/oars-client';
import { ConfigError, ENV_API_URL } from './config.js';
import { loadPackInputs, openPackStore } from './pack-store.js';
import { SELLER_VERSION } from './server.js';
import { amountFrom, ensurePrice, priceInputFor, PricingError } from './pricing.js';

export const ENV_WORKLOAD_ID = 'OARS_SELLER_WORKLOAD_ID';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PriceDeps {
  /** The operator's bearer token for `apiUrl` (the CLI's `resolveAuthToken`); the seller's SDK key cannot create a price. */
  token: (apiUrl: string) => Promise<string>;
}

export interface PriceResult {
  ok: boolean;
  /** One line per pack, or one line for the refusal. It never holds the token, the SDK key, or a platform answer. */
  lines: string[];
}

const SAYS = { created: 'created.', present: 'already exists.', differs: 'exists with other terms and was left unchanged (an amount is immutable once charged).' } as const;

/** Creates the `CREDIT_PACK` price of every pack in the catalog under the operator's login; a second run creates nothing. */
export const runPrice = async (env: Readonly<NodeJS.ProcessEnv>, deps: PriceDeps): Promise<PriceResult> => {
  const refused = (line: string): PriceResult => ({ ok: false, lines: [line] });
  try {
    const apiUrl = env[ENV_API_URL]?.trim() ?? '';
    if (apiUrl === '') throw new ConfigError(`${ENV_API_URL} is not set.`);
    if (!URL.canParse(apiUrl)) throw new ConfigError(`${ENV_API_URL} is not a URL.`);
    const workloadId = env[ENV_WORKLOAD_ID]?.trim() ?? '';
    if (workloadId === '') throw new ConfigError(`${ENV_WORKLOAD_ID} is not set.`);
    if (!UUID.test(workloadId)) throw new ConfigError(`${ENV_WORKLOAD_ID} is not a workload id (a UUID).`);
    const amount = amountFrom(env);
    const packs = (await openPackStore(loadPackInputs(env))).packs();
    if (packs.length === 0) throw new ConfigError('The packs folder lists no pack.');
    const inputs = packs.map((pack) => priceInputFor(pack, amount));
    let token: string;
    try {
      token = await deps.token(apiUrl);
    } catch {
      return refused('The operator login could not be used: run oars login, or set OARS_API_KEY.');
    }
    const client = createOarsClient({ version: SELLER_VERSION, baseUrl: apiUrl, token });
    const lines: string[] = [];
    let ok = true;
    for (const input of inputs) {
      try {
        const answer = await ensurePrice(client, workloadId, input);
        // A price that exists with other terms is configuration drift the operator must see, so the run fails; nothing was changed.
        if (answer === 'differs') ok = false;
        lines.push(`Price ${input.priceRef} ${SAYS[answer]}`);
      } catch (error) {
        if (error instanceof PricingError) return { ok: false, lines: [...lines, error.message] };
        // A network failure, or anything else ensurePrice throws.
        return { ok: false, lines: [...lines, 'The platform could not be reached.'] };
      }
    }
    return { ok, lines };
  } catch (error) {
    if (error instanceof ConfigError || error instanceof PricingError) return refused(error.message);
    // Anything else (a packs folder that cannot be read) would print a stack trace; the operator gets one fixed line.
    return refused('The packs folder could not be read.');
  }
};
