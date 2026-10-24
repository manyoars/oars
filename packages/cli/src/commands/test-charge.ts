import type { OarsClient } from '@manyoars/oars-client';
import { apiClient, unwrap } from '../api.js';
import { CliError, ExitCode } from '../errors.js';
import { stepKey } from '../journal.js';
import { resolveAuthToken } from '../session.js';
import type { Outcome, RunDeps } from '../cli.js';

export interface TestChargeOptions {
  apiUrl: string;
  workloadId: string;
  /** `--price`; absent means the workload's one active price. */
  priceRef?: string;
  /** The base of the step key, so a retry of this command replays the charge instead of making a second one. */
  idempotencyKey: string;
}

const STEP = 'test-charge';

/** The price a charge without `--price` uses: the workload's only active one, else exit 2 saying which to pick from. */
const onlyActivePrice = async (client: OarsClient, workloadId: string): Promise<string> => {
  const page = unwrap(STEP, await client.GET('/billing/agents/{workloadId}/prices', { params: { path: { workloadId }, query: { size: 100 } } }));
  const active = page.content.filter((price) => price.active).map((price) => price.priceRef);
  if (!page.last) {
    throw new CliError(`${workloadId} has more prices than one request lists; pass --price <priceRef>.`, ExitCode.USAGE, 'usage');
  }
  const [only, ...others] = active;
  if (only === undefined) {
    throw new CliError(`${workloadId} has no active price; create one, or pass --price <priceRef>.`, ExitCode.USAGE, 'usage');
  }
  if (others.length > 0) {
    throw new CliError(`${workloadId} has several active prices (${active.join(', ')}); pass --price <priceRef>.`, ExitCode.USAGE, 'usage');
  }
  return only;
};

/** `POST /billing/agents/{id}/test-charges`: a TEST-mode charge against one of the workload's prices (no money moves). */
export const testCharge = async (deps: RunDeps, options: TestChargeOptions): Promise<Outcome> => {
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: STEP, token: await resolveAuthToken(deps, options.apiUrl) });
  const priceRef = options.priceRef ?? (await onlyActivePrice(client, options.workloadId));
  const charge = unwrap(
    STEP,
    await client.POST('/billing/agents/{workloadId}/test-charges', {
      params: { path: { workloadId: options.workloadId }, header: { 'Idempotency-Key': stepKey(options.idempotencyKey, STEP) } },
      body: { priceRef },
    }),
  );
  return {
    document: { ok: true, chargeId: charge.chargeId, status: charge.status },
    text: `Test charge ${charge.chargeId} for ${priceRef}: ${charge.status}`,
  };
};
