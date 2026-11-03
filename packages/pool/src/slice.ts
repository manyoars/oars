// Serving a slice: the deposits of one stack, derived and signed. The signature covers the exact payload bytes and the client pinned the public half at login, so a replica can be
// kept and checked again anywhere.
import { ALL_STACKS, isStack, parseSkeleton, type SessionSkeleton, type SignedSlice, type Slice } from '../../cli/src/sessions/pool-wire.js';
import { sliceOf } from './derive.js';
import { answer, bound, notConfigured, refuse, textField, type Env } from './http.js';
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

export const pullSlice = async (request: Request, env: Env, stack: string): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  if (!isStack(stack)) return refuse(400, 'unknown_stack', `No stack is named ${stack}.`, 'stack');
  const key = bound(env.SLICE_SIGNING_KEY);
  if (key === undefined) return notConfigured('SLICE_SIGNING_KEY');
  return answer(200, await signed(sliceOf(stack, await depositsOf(env, stack)), key));
};
