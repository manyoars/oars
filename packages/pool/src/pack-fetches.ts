// Paid pack fetches, the buyer's two routes (K2 spec section 2). A buyer's agent starts a fetch for a DATASET price with its account credential and buyer key: with no credit it is told to buy one (402 and an offer), with credit its fetch is queued for the operator's builder (`pack-operator.ts`), and it downloads the pack once the operator has handed it over, for seven days.
// Entitlement lives in billing, never here: the pool reads a balance, issues an offer, and consumes one credit at hand-over. It adds no purchase gate of its own.
import { createHash, randomUUID } from 'node:crypto';
import { BillingError, billingOf, BuyerRefused, customerRefOf, lotOf, RegionNotSupported, WorkloadNotActive } from './billing.js';
import { answer, bodyOf, bound, fieldOf, notConfigured, refuse, textField, type Env } from './http.js';
import { accountOf, restrictedRefusal } from './identity.js';

/** How long a handed-over pack can be downloaded. */
export const PACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The longest buyer key accepted, the same bound the pack seller puts on one. */
export const MAX_BUYER_KEY_LENGTH = 512;

/** The states a buyer can name: the 50 US state codes and DC, in upper case. Buyers are US only, and no territory is on the list. */
export const US_STATES: ReadonlySet<string> = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));

/** The states of a fetch that hold a credit the buyer has not yet spent: a fetch not yet handed over. */
export const UNSPENT = "('queued', 'built')";

/** Which buyer key a pack's match ids belong to: the first 16 hex of the key's SHA-256, never the key (`keyIdOf` in `scripts/sample-pack.ts`, which the scripts and the pack seller use). */
export const buyerKeyIdOf = (buyerKey: string): string => createHash('sha256').update(buyerKey).digest('hex').slice(0, 16);

const unavailable = (): Response => refuse(502, 'billing_unavailable', 'Billing did not answer. Nothing was charged; try again.');

/** `POST /v1/packs/:priceRef/fetches`: starts a paid fetch of the lot `priceRef` sells. Account credential and `{buyerKey, state}`; the state is the buyer's US state, handed to billing on every start and kept nowhere here (not on the row, not in a log); a machine key is refused before this runs (`machine: false`). */
export const startFetch = async (request: Request, env: Env, priceRef: string): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  const restricted = await restrictedRefusal(env, account);
  if (restricted !== undefined) return restricted;
  const pseudonymKey = bound(env.PSEUDONYM_KEY);
  if (pseudonymKey === undefined) return notConfigured('PSEUDONYM_KEY');
  const billing = billingOf(env);
  if ('missing' in billing) return notConfigured(billing.missing);
  const body = await bodyOf(request);
  const buyerKey = textField(body, 'buyerKey');
  if (buyerKey === undefined || buyerKey.length > MAX_BUYER_KEY_LENGTH) return refuse(400, 'missing_field', `A fetch names the buyer key its pack is built under, in at most ${String(MAX_BUYER_KEY_LENGTH)} characters.`, 'buyerKey');
  // The state is checked before billing is asked anything, so a bad one costs no call and queues nothing.
  const state = textField(body, 'state');
  if (state === undefined) return refuse(400, 'state_required', 'A fetch names the US state of the buyer, as its two-letter code in upper case (DC counts). Buyers are US only.', 'state');
  if (!US_STATES.has(state)) return refuse(400, 'state_invalid', 'The state is not one of the 50 US state codes or DC, in upper case.', 'state');
  try {
    const sold = await lotOf(billing, priceRef);
    if (sold === undefined) return refuse(404, 'not_found', 'No such price.');
    const { lot } = sold;
    const customerRef = customerRefOf(pseudonymKey, account, lot);
    // Every start upserts the customer, so billing's tax region is the one the buyer last named; billing answers 200 for one it already has.
    await billing.createCustomer(customerRef, state);
    const credits = await billing.balance(customerRef);
    const { available: balance } = credits;
    // The mode is billing's: the workload's stored mode, which the balance just read says. The row keeps it so a start counts only the unspent fetches of the credits it reads.
    const mode = credits.livemode ? 'live' : 'test';
    const fetchId = randomUUID();
    // One statement, so two starts at once cannot both take the last credit: an account never holds more unspent fetches for a lot, in one billing mode, than the lot's balance in that mode.
    const queued = await env.DB.prepare(
      `INSERT INTO pack_fetches (fetch_id, account, price_ref, lot, buyer_key_id, buyer_key, mode, state, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, 'queued', ? WHERE (SELECT COUNT(*) FROM pack_fetches WHERE account = ? AND lot = ? AND mode = ? AND state IN ${UNSPENT}) < ?`,
    )
      .bind(fetchId, account, priceRef, lot, buyerKeyIdOf(buyerKey), buyerKey, mode, Date.now(), account, lot, mode, balance)
      .run();
    if (queued.meta.changes > 0) return answer(202, { fetchId, state: 'queued', priceRef });
    const offerId = await billing.issueOffer(customerRef, lot);
    return answer(402, { error: 'payment_required', message: 'This account has no credit left for this pack. Buy one with the offer, then start the fetch again.', offerId, priceRefs: sold.priceRefs, balance });
  } catch (error) {
    if (error instanceof BuyerRefused) return refuse(403, 'buyer_refused', 'Billing has refused this account as a buyer, so it cannot start a paid fetch.');
    if (error instanceof RegionNotSupported) return refuse(400, 'region_not_supported', 'Billing does not take a buyer in this state. Nothing was charged or queued.', 'state');
    if (error instanceof WorkloadNotActive) return refuse(503, 'workload_not_active', 'The seller is not selling right now. Nothing was charged or queued; try again later.');
    if (error instanceof BillingError) return unavailable();
    throw error;
  }
};

/** `GET /v1/packs/fetches/:fetchId`: the pack once handed over and inside its window, a pending answer before, 409 for a failed build, and 410 after the window. Another account's fetch is 404, the same as an unknown one. */
export const downloadFetch = async (request: Request, env: Env, fetchId: string, now: number): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  const row = await env.DB.prepare('SELECT state, object_key, expires_at FROM pack_fetches WHERE fetch_id = ? AND account = ?').bind(fetchId, account).first();
  if (row === null) return refuse(404, 'not_found', 'No such fetch.');
  const state = textField(row, 'state');
  if (state === 'failed') return refuse(409, 'fetch_failed', 'The pack could not be built. Nothing was charged; start the fetch again.');
  if (state !== 'ready') return answer(202, { fetchId, state: 'pending' });
  const key = textField(row, 'object_key');
  const expiresAt = fieldOf(row, 'expires_at');
  const gone = (): Response => refuse(410, 'gone', 'This pack is past its seven days. Start a new fetch.');
  if (key === undefined || typeof expiresAt !== 'number' || now >= expiresAt) return gone();
  if (env.PACKS === undefined) return notConfigured('PACKS');
  const object = await env.PACKS.get(key);
  if (object === null) return gone();
  return new Response(object.body, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(object.size), 'content-disposition': `attachment; filename="pack-${fetchId}"`, 'cache-control': 'private, no-store' } });
};
