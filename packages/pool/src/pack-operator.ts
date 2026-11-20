// Paid pack fetches, the operator's side (K2 spec section 2, steps 4 and 5): the queue the builder reads, the mark that a pack is built, and the hand-over that takes the buyer's credit. Every route is behind `OPERATOR_TOKEN`, as the telemetry operator read is.
// The credit is taken once, at hand-over, under the fetch id as billing's idempotency key: a short balance leaves the fetch unready and takes nothing, and a retry after a lost answer finds the credit taken and marks the fetch ready.
import { BillingError, billingOf, BuyerRefused, customerRefOf, IdempotencyConflict } from './billing.js';
import { answer, bodyOf, bound, fieldOf, notConfigured, refuse, textField, type Env, type PacksBucket } from './http.js';
import { PACK_WINDOW_MS, UNSPENT } from './pack-fetches.js';
import { digest, type OperatorEnv } from './telemetry-fleet.js';

/** The most fetches one listing answers. A longer queue is read page by page, each page's `nextCursor` asking for the next. */
export const QUEUE_PAGE = 100;

/** The most expired packs one night deletes: one listing, one delete, and one update, so the nightly run's call budget does not move with the backlog. A larger backlog is finished on later nights. */
export const SWEEP_PACKS = 100;

const STATES = ['queued', 'built', 'ready', 'failed'];

type OperatorBindings = Env & OperatorEnv;

/** The refusal for a caller that is not the operator, or undefined for the operator. Compared as digests, so the comparison does not depend on how much of a guess matched. */
const notOperator = async (request: Request, env: OperatorBindings): Promise<Response | undefined> => {
  const secret = bound(env.OPERATOR_TOKEN);
  if (secret === undefined) return notConfigured('OPERATOR_TOKEN');
  const sent = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  return sent !== undefined && (await digest(sent)) === (await digest(secret)) ? undefined : refuse(401, 'unauthorized', 'This route is for the pool operator.');
};

interface Held {
  account: string;
  lot: string;
  state: string;
  /** The billing mode the fetch was queued in (what the balance reported at its start). */
  mode: string;
  objectKey: string | undefined;
  expiresAt: number | undefined;
}

const heldOf = async (env: Env, fetchId: string): Promise<Held | undefined> => {
  const row = await env.DB.prepare('SELECT account, lot, state, mode, object_key, expires_at FROM pack_fetches WHERE fetch_id = ?').bind(fetchId).first();
  const account = textField(row, 'account');
  const lot = textField(row, 'lot');
  const state = textField(row, 'state');
  const mode = textField(row, 'mode');
  if (account === undefined || lot === undefined || state === undefined || mode === undefined) return undefined;
  const expiresAt = fieldOf(row, 'expires_at');
  return { account, lot, state, mode, objectKey: textField(row, 'object_key'), expiresAt: typeof expiresAt === 'number' ? expiresAt : undefined };
};

const noSuchFetch = (): Response => refuse(404, 'not_found', 'No such fetch.');

const ready = (fetchId: string, expiresAt: number | undefined): Response => answer(200, { fetchId, state: 'ready', expiresAt: expiresAt ?? null });

/** A page's resume point: the last row's `created_at` and `fetch_id`, as one opaque token. */
const cursorOf = (createdAt: number, fetchId: string): string => btoa(`${String(createdAt)}:${fetchId}`).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

const readCursor = (cursor: string): { createdAt: number; fetchId: string } | undefined => {
  try {
    const [, createdAt, fetchId] = /^(\d+):(.+)$/.exec(atob(cursor.replaceAll('-', '+').replaceAll('_', '/'))) ?? [];
    return createdAt === undefined || fetchId === undefined ? undefined : { createdAt: Number(createdAt), fetchId };
  } catch {
    // `atob` throws on text that is not base64: a cursor the pool never gave.
    return undefined;
  }
};

/** `GET /v1/operator/fetches?state=&cursor=`: the fetches in a state (`queued` unless asked), oldest first, `QUEUE_PAGE` at a time. `nextCursor` is present while more rows remain; pass it back as `cursor` for the next page. A queued row carries the buyer key the builder builds under; no other state holds one. */
export const listFetches = async (request: Request, env: OperatorBindings): Promise<Response> => {
  const refused = await notOperator(request, env);
  if (refused !== undefined) return refused;
  const params = new URL(request.url).searchParams;
  const state = params.get('state') ?? 'queued';
  if (!STATES.includes(state)) return refuse(400, 'missing_field', `state is one of ${STATES.join(', ')}.`, 'state');
  const given = params.get('cursor');
  const after = given === null ? undefined : readCursor(given);
  if (given !== null && after === undefined) return refuse(400, 'missing_field', 'cursor is the nextCursor an earlier listing answered.', 'cursor');
  const columns = 'fetch_id, price_ref, lot, buyer_key_id, buyer_key, mode, state, object_key, created_at, ready_at, expires_at';
  // One row more than a page tells whether another page follows.
  const { results } =
    after === undefined
      ? await env.DB.prepare(`SELECT ${columns} FROM pack_fetches WHERE state = ? ORDER BY created_at, fetch_id LIMIT ?`).bind(state, QUEUE_PAGE + 1).all()
      : await env.DB.prepare(`SELECT ${columns} FROM pack_fetches WHERE state = ? AND (created_at > ? OR (created_at = ? AND fetch_id > ?)) ORDER BY created_at, fetch_id LIMIT ?`).bind(state, after.createdAt, after.createdAt, after.fetchId, QUEUE_PAGE + 1).all();
  const page = results.slice(0, QUEUE_PAGE);
  const last = page.at(-1);
  const [lastAt, lastId] = [fieldOf(last, 'created_at'), fieldOf(last, 'fetch_id')];
  const more = results.length > QUEUE_PAGE && typeof lastAt === 'number' && typeof lastId === 'string';
  return answer(200, {
    fetches: page.map((row) => ({
      fetchId: fieldOf(row, 'fetch_id'),
      priceRef: fieldOf(row, 'price_ref'),
      lot: fieldOf(row, 'lot'),
      buyerKeyId: fieldOf(row, 'buyer_key_id'),
      buyerKey: fieldOf(row, 'buyer_key'),
      mode: fieldOf(row, 'mode'),
      state: fieldOf(row, 'state'),
      objectKey: fieldOf(row, 'object_key'),
      createdAt: fieldOf(row, 'created_at'),
      readyAt: fieldOf(row, 'ready_at'),
      expiresAt: fieldOf(row, 'expires_at'),
    })),
    ...(more ? { nextCursor: cursorOf(lastAt, lastId) } : {}),
  });
};

/** `POST /v1/operator/fetches/:id/built` with `{objectKey}`: the builder has put the pack in `PACKS` under `packs/<fetchId>/`. Only a queued fetch is built; the buyer key is dropped, since nothing builds under it again. */
export const markBuilt = async (request: Request, env: OperatorBindings, fetchId: string): Promise<Response> => {
  const refused = await notOperator(request, env);
  if (refused !== undefined) return refused;
  if (env.PACKS === undefined) return notConfigured('PACKS');
  const objectKey = textField(await bodyOf(request), 'objectKey');
  // The prefix keeps one fetch's mark from naming another buyer's pack.
  if (objectKey === undefined || objectKey.length > 512 || !objectKey.startsWith(`packs/${fetchId}/`)) return refuse(400, 'missing_field', `A built pack's key starts with packs/${fetchId}/.`, 'objectKey');
  const held = await heldOf(env, fetchId);
  if (held === undefined) return noSuchFetch();
  if (held.state !== 'queued') return refuse(409, 'not_queued', `This fetch is ${held.state}, not queued.`);
  if ((await env.PACKS.head(objectKey)) === null) return refuse(422, 'object_missing', 'PACKS holds no object under that key.', 'objectKey');
  const marked = await env.DB.prepare("UPDATE pack_fetches SET state = 'built', object_key = ?, buyer_key = NULL WHERE fetch_id = ? AND state = 'queued'").bind(objectKey, fetchId).run();
  if (marked.meta.changes === 0) return refuse(409, 'not_queued', 'This fetch is no longer queued.');
  return answer(200, { fetchId, state: 'built', objectKey });
};

/** `POST /v1/operator/fetches/:id/handover`: takes the buyer's credit and marks the fetch ready for its seven days. 409 `insufficient_credits` leaves it built and takes nothing; a retry after an answer was lost takes no second credit; a fetch already ready answers as it was. */
export const handOver = async (request: Request, env: OperatorBindings, fetchId: string, now: number): Promise<Response> => {
  const refused = await notOperator(request, env);
  if (refused !== undefined) return refused;
  const held = await heldOf(env, fetchId);
  if (held === undefined) return noSuchFetch();
  if (held.state === 'ready') return ready(fetchId, held.expiresAt);
  if (held.state !== 'built') return refuse(409, 'not_built', `This fetch is ${held.state}; only a built pack is handed over.`);
  const pseudonymKey = bound(env.PSEUDONYM_KEY);
  if (pseudonymKey === undefined) return notConfigured('PSEUDONYM_KEY');
  const billing = billingOf(env);
  if ('missing' in billing) return notConfigured(billing.missing);
  try {
    const customerRef = customerRefOf(pseudonymKey, held.account, held.lot);
    // Billing's mode is the workload's, and a call cannot name one, so a flip since the fetch was queued is read here: a credit of one mode never pays for a fetch queued in the other. This narrows the window (a flip between this read and the consume is not seen); only a pin on the platform's side closes it.
    if ((await billing.balance(customerRef)).livemode !== (held.mode === 'live')) return refuse(409, 'mode_changed', `Billing is in another mode than the one this fetch was queued in (${held.mode}). The fetch stays built and nothing was taken; hand it over when billing is back in that mode.`);
    if ((await billing.consume(customerRef, fetchId)) === 'insufficient') return refuse(409, 'insufficient_credits', 'The buyer has no credit left for this lot (refunded or spent elsewhere). The fetch stays built and nothing was taken.');
  } catch (error) {
    if (error instanceof BuyerRefused) return refuse(409, 'buyer_refused', 'Billing has refused this buyer (revoked). The fetch stays built and nothing was taken; a retry changes nothing.');
    if (error instanceof IdempotencyConflict) return refuse(409, 'idempotency_conflict', 'Billing already holds this fetch id for a different request. The fetch stays built and nothing was taken; a retry changes nothing, so look into it.');
    if (error instanceof BillingError) return refuse(502, 'billing_unavailable', 'Billing did not answer. The fetch stays built; hand it over again.');
    throw error;
  }
  // Guarded by the state, so two hand-overs at once mark it once; both then answer from the row.
  await env.DB.prepare("UPDATE pack_fetches SET state = 'ready', ready_at = ?, expires_at = ? WHERE fetch_id = ? AND state = 'built'").bind(now, now + PACK_WINDOW_MS, fetchId).run();
  const after = await heldOf(env, fetchId);
  return after?.state === 'ready' ? ready(fetchId, after.expiresAt) : refuse(409, 'not_built', 'This fetch changed while it was handed over.');
};

/** `POST /v1/operator/fetches/:id/failed`: the build failed. Nothing is consumed; a pack already put in `PACKS` is deleted and the buyer key dropped. A ready fetch cannot fail (its credit is taken), and a failed one answers as it was. */
export const markFailed = async (request: Request, env: OperatorBindings, fetchId: string): Promise<Response> => {
  const refused = await notOperator(request, env);
  if (refused !== undefined) return refused;
  const held = await heldOf(env, fetchId);
  if (held === undefined) return noSuchFetch();
  if (held.state === 'failed') return answer(200, { fetchId, state: 'failed' });
  if (held.state === 'ready') return refuse(409, 'already_ready', 'This fetch was handed over and its credit taken.');
  if (held.objectKey !== undefined) {
    if (env.PACKS === undefined) return notConfigured('PACKS');
    // Deleted first: a delete that fails leaves the fetch as it was for another try, and a pack whose fetch is failed is never left behind.
    await env.PACKS.delete([held.objectKey]);
  }
  await env.DB.prepare(`UPDATE pack_fetches SET state = 'failed', buyer_key = NULL, object_key = NULL WHERE fetch_id = ? AND state IN ${UNSPENT}`).bind(fetchId).run();
  return answer(200, { fetchId, state: 'failed' });
};

/** The nightly sweep: deletes the packs whose seven days are over, and any pack a failed fetch still names (only an account's erasure leaves one, `scripts/erase.ts`), and drops their keys from the rows. The row stays, as the hand-over record. Answers how many it deleted; an unbound bucket sweeps nothing. */
export const sweepPacks = async (env: { DB: Env['DB']; PACKS?: Pick<PacksBucket, 'delete'> }, now: number): Promise<number> => {
  const bucket = env.PACKS;
  if (bucket === undefined) return 0;
  const { results } = await env.DB.prepare("SELECT fetch_id, object_key FROM pack_fetches WHERE object_key IS NOT NULL AND ((state = 'ready' AND expires_at <= ?) OR state = 'failed') ORDER BY expires_at LIMIT ?").bind(now, SWEEP_PACKS).all();
  const ids = results.flatMap((row) => textField(row, 'fetch_id') ?? []);
  const keys = results.flatMap((row) => textField(row, 'object_key') ?? []);
  if (ids.length === 0) return 0;
  await bucket.delete(keys);
  await env.DB.prepare(`UPDATE pack_fetches SET object_key = NULL WHERE fetch_id IN (${ids.map(() => '?').join(', ')})`).bind(...ids).run();
  return ids.length;
};
