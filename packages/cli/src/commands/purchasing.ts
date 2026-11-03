import type { components, OarsClient } from '@manyoars/oars-client';
import { apiClient, unwrap } from '../api.js';
import { CliError, ExitCode } from '../errors.js';
import { stepKey } from '../journal.js';
import { resolveAuthToken } from '../session.js';
import type { Outcome, RunDeps } from '../cli.js';

export type BillingMode = components['schemas']['BillingMode'];
type Purchase = components['schemas']['PurchaseListItem'];

const CARD_STEP = 'purchasing-card';
const CAP_STEP = 'purchasing-cap';
const LIST_STEP = 'purchasing-list';

// An agent's purchases fit one request nearly always; the loop below only covers an agent that outgrows it.
const PAGE_SIZE = 100;

export interface PurchasingCardOptions {
  apiUrl: string;
  mode: BillingMode;
  /** The base of the step key, so a retry of this command replays the same setup instead of opening a second one. */
  idempotencyKey: string;
}

export interface PurchasingCapOptions extends PurchasingCardOptions {
  workloadId: string;
  /** `--usd`: whole cents, as typed; the platform parses it, so `100` and `100.00` are the same cap. */
  monthlyCapUsd: string;
}

export interface PurchasingListOptions {
  apiUrl: string;
  workloadId: string;
}

/** An exit 6: a person has to open `url`. The same shape the platform's own `actionUrl` problems take, so `--json` and stderr read alike. */
const needsPerson = (step: string, title: string, url: string | undefined, detail: string): CliError =>
  new CliError(title, ExitCode.HUMAN, step, { title, detail, ...(url === undefined ? {} : { actionUrl: url }) });

/** `POST /billing/purchasing/payment-method`: starts saving the developer's purchasing card; a person saves it at the URL it prints. */
export const purchasingCard = async (deps: RunDeps, options: PurchasingCardOptions): Promise<Outcome> => {
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: CARD_STEP, token: await resolveAuthToken(deps, options.apiUrl) });
  const method = unwrap(
    CARD_STEP,
    await client.POST('/billing/purchasing/payment-method', {
      params: { header: { 'Idempotency-Key': stepKey(options.idempotencyKey, CARD_STEP) } },
      body: { mode: options.mode },
    }),
  );
  if (method.setupUrl !== undefined) {
    throw needsPerson(CARD_STEP, `Save the ${options.mode} purchasing card`, method.setupUrl, 'A person saves the card on that page; this developer\'s agents buy with it, each up to its own cap.');
  }
  if (method.status !== 'ACTIVE') {
    throw new CliError(`The ${options.mode} purchasing card is ${method.status}${method.failureCode === undefined ? '' : ` (${method.failureCode})`}.`, ExitCode.INVALID, CARD_STEP);
  }
  return {
    document: { ok: true, mode: method.mode, status: method.status, brand: method.brand, last4: method.last4 },
    text: `${method.mode} purchasing card: ${method.brand ?? 'a card'} ending ${method.last4 ?? '????'} is saved.`,
  };
};

/**
 * `PUT /billing/agents/{workloadId}/purchasing`: a lower cap (or 0) applies at once; a new or higher one is only proposed, and a person
 * approves it at the URL printed (T §3 step 2), so a coding agent cannot raise its own cap.
 */
export const purchasingCap = async (deps: RunDeps, options: PurchasingCapOptions): Promise<Outcome> => {
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: CAP_STEP, token: await resolveAuthToken(deps, options.apiUrl) });
  const cap = unwrap(
    CAP_STEP,
    await client.PUT('/billing/agents/{workloadId}/purchasing', {
      params: { path: { workloadId: options.workloadId }, header: { 'Idempotency-Key': stepKey(options.idempotencyKey, CAP_STEP) } },
      body: { mode: options.mode, monthlyCapUsd: options.monthlyCapUsd },
    }),
  );
  if (cap.status === 'PROPOSED') {
    throw needsPerson(
      CAP_STEP,
      `Approve a ${cap.mode} purchasing cap of $${cap.proposedCapUsd ?? options.monthlyCapUsd} a month`,
      cap.approvalUrl,
      cap.approvalUrl === undefined
        ? 'This proposal is already open and its link was shown by the first run; pass a new --idempotency-key for a fresh link.'
        : 'A person signs in again and approves it on that page; the link works once.',
    );
  }
  return {
    document: { ok: true, workloadId: cap.workloadId, mode: cap.mode, status: cap.status, monthlyCapUsd: cap.monthlyCapUsd },
    text:
      cap.status === 'OFF'
        ? `${cap.mode} purchasing for ${cap.workloadId} is off.`
        : `${cap.mode} purchasing cap for ${cap.workloadId}: $${cap.monthlyCapUsd} a month, in force now.`,
  };
};

const allPurchases = async (client: OarsClient, workloadId: string): Promise<Purchase[]> => {
  const purchases: Purchase[] = [];
  for (let page = 0; ; page += 1) {
    const result = unwrap(LIST_STEP, await client.GET('/billing/agents/{workloadId}/purchases', { params: { path: { workloadId }, query: { page, size: PAGE_SIZE } } }));
    purchases.push(...result.content);
    if (result.last) return purchases;
  }
};

const describePurchase = (purchase: Purchase): string =>
  [
    purchase.purchaseId,
    purchase.failureCode === undefined ? purchase.status : `${purchase.status} (${purchase.failureCode})`,
    `$${purchase.amountUsd}`,
    purchase.packName ?? `${String(purchase.credits)} credits`,
    purchase.sellerSlug ?? purchase.sellerWorkloadId,
    purchase.priceRef,
    purchase.livemode ? 'LIVE' : 'TEST',
    purchase.createdAt,
  ].join('  ');

/** `GET /billing/agents/{workloadId}/purchases`: what the agent has bought, newest first. */
export const purchasingList = async (deps: RunDeps, options: PurchasingListOptions): Promise<Outcome> => {
  const client = apiClient(deps, { apiUrl: options.apiUrl, step: LIST_STEP, token: await resolveAuthToken(deps, options.apiUrl) });
  const purchases = await allPurchases(client, options.workloadId);
  return {
    document: { ok: true, purchases },
    text: purchases.length === 0 ? 'This agent has made no purchases.' : purchases.map(describePurchase).join('\n'),
  };
};
