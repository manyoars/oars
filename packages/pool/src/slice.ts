// Serving a slice: the deposits of one stack, derived and signed. The signature covers the exact payload bytes and the client pinned the public half at login, so a replica can be
// kept and checked again anywhere.
import { ALL_STACKS, isStack, parseSkeleton, type SessionSkeleton, type SignedSlice, type Slice } from '../../cli/src/sessions/pool-wire.js';
import { sliceOf } from './derive.js';
import { answer, bound, fieldOf, notConfigured, refuse, textField, type Env } from './http.js';
import { accountOf } from './identity.js';

const signed = async (slice: Slice, privateJwk: string): Promise<SignedSlice> => {
  const parsed: unknown = JSON.parse(privateJwk);
  const key = await crypto.subtle.importKey('jwk', { kty: textField(parsed, 'kty') ?? '', crv: textField(parsed, 'crv') ?? '', x: textField(parsed, 'x') ?? '', d: textField(parsed, 'd') ?? '' }, 'Ed25519', false, ['sign']);
  const payload = JSON.stringify(slice);
  const signature = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(payload));
  return { payload, signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
};

/** A stored skeleton is parsed again on the way out, so one that a narrower vocabulary no longer admits stops counting instead of being served. */
const depositsOf = async (env: Env, stack: string): Promise<SessionSkeleton[][]> => {
  const statement = stack === ALL_STACKS ? env.DB.prepare('SELECT account, skeleton FROM deposits').bind() : env.DB.prepare('SELECT account, skeleton FROM deposits WHERE EXISTS (SELECT 1 FROM json_each(deposits.stacks) WHERE value = ?)').bind(stack);
  const { results } = await statement.all();
  const accounts = new Map<string, SessionSkeleton[]>();
  for (const row of results) {
    const account = textField(row, 'account');
    const parsed = parseSkeleton(JSON.parse(textField(row, 'skeleton') ?? 'null'));
    if (account === undefined || !parsed.ok) continue;
    accounts.set(account, [...(accounts.get(account) ?? []), parsed.skeleton]);
  }
  return [...accounts.values()];
};

const DEFAULT_READ_CAP = 50;
const RESERVE_ATTEMPTS = 8;

const capOf = (env: Env): number => {
  const cap = Number(bound(env.READ_CAP) ?? DEFAULT_READ_CAP);
  return Number.isSafeInteger(cap) && cap > 0 ? cap : DEFAULT_READ_CAP;
};

const hasDeposited = async (env: Env, account: string): Promise<boolean> => (await env.DB.prepare('SELECT 1 AS held FROM deposits WHERE account = ? LIMIT 1').bind(account).first()) !== null;

/**
 * Takes up to `wanted` reads out of what is left of the cap; undefined when nothing is left. A compare-and-swap, because two pulls at once would otherwise both spend the same
 * remainder, and a retry after losing it reads the count again.
 */
const reserve = async (env: Env, account: string, limit: number, wanted: number): Promise<{ taken: number; total: number } | undefined> => {
  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
    const row = await env.DB.prepare('SELECT reads_served AS served FROM accounts WHERE id = ?').bind(account).first();
    const held = fieldOf(row, 'served');
    const served = typeof held === 'number' ? held : limit;
    if (served >= limit) return undefined;
    const taken = Math.min(limit - served, wanted);
    const { meta } = await env.DB.prepare('UPDATE accounts SET reads_served = ? WHERE id = ? AND reads_served = ?').bind(served + taken, account, served).run();
    if (meta.changes === 1) return { taken, total: served + taken };
  }
  return undefined;
};

export const pullSlice = async (request: Request, env: Env, stack: string): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  if (!isStack(stack)) return refuse(400, 'unknown_stack', `No stack is named ${stack}.`, 'stack');
  const key = bound(env.SLICE_SIGNING_KEY);
  if (key === undefined) return notConfigured('SLICE_SIGNING_KEY');
  const whole = sliceOf(stack, await depositsOf(env, stack));
  if (await hasDeposited(env, account)) return answer(200, await signed(whole, key));
  const limit = capOf(env);
  const served = await reserve(env, account, limit, whole.reads.length);
  if (served === undefined) return refuse(403, 'read_cap', `An account with no deposit is served ${String(limit)} reads. Run oars pool deposit for the whole pool.`);
  // Cells are what a depositor gets on top: they would let a capped account compute every read it was not served.
  return answer(200, await signed({ ...whole, cells: [], motifs: [], reads: whole.reads.slice(0, served.taken), capped: { limit, served: served.total } }, key));
};
