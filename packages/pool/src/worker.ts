// The pool server (t758): a Workers fetch handler over one D1 database. Deposits take closed-vocabulary skeletons only, and a refusal names the field.
import { parseSkeleton, stacksOf } from '../../cli/src/sessions/pool-wire.js';
import { covenantAccept, covenantNotAccepted, covenantStatus, depositsClosed, hasAccepted } from './covenant.js';
import { answer, bound, refuse, wholeBinding, type Env } from './http.js';
import { accountOf, loginPoll, loginStart } from './identity.js';
import { pullSlice } from './slice.js';

/** D1 holds at most 2 MB in one value. A body declaring more is refused unread, and one that declares nothing is measured before it is parsed. */
const MAX_DEPOSIT_BYTES = 1024 * 1024;

/** Every pull parses every row, so one account's row count is a cost on every other account's pull. High enough for a fleet's whole store. */
const DEFAULT_MAX_DEPOSITS = 20_000;

const SLICES = '/v1/slices/';

const deposit = async (request: Request, env: Env): Promise<Response> => {
  // The gate comes before the sign-in and the body, so a closed pool reads neither.
  const version = bound(env.COVENANT_VERSION);
  if (version === undefined) return depositsClosed();
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  if (!(await hasAccepted(env, account, version))) return covenantNotAccepted(version);
  const tooLarge = (): Response => refuse(413, 'too_large', `A skeleton holds at most ${String(MAX_DEPOSIT_BYTES)} bytes.`);
  if (Number(request.headers.get('content-length')) > MAX_DEPOSIT_BYTES) return tooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_DEPOSIT_BYTES) return tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, 'closed_vocabulary', 'The body is not JSON.', 'skeleton');
  }
  const parsed = parseSkeleton(body);
  if (!parsed.ok) return refuse(422, 'closed_vocabulary', `${parsed.field}: ${parsed.reason}`, parsed.field);
  // The parsed skeleton is what is stored, not the text that came in: it holds only the fields that were read.
  const { skeleton } = parsed;
  const limit = wholeBinding(env.MAX_DEPOSITS_PER_ACCOUNT, DEFAULT_MAX_DEPOSITS);
  // One statement, so two deposits at once cannot both take the last row. A redeposit replaces its own row and adds none, so it passes at the limit.
  const { meta } = await env.DB.prepare(
    'INSERT INTO deposits (account, id, stacks, skeleton) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM deposits WHERE account = ?) < ? OR EXISTS (SELECT 1 FROM deposits WHERE account = ? AND id = ?) ON CONFLICT (account, id) DO UPDATE SET stacks = excluded.stacks, skeleton = excluded.skeleton',
  )
    .bind(account, skeleton.id, JSON.stringify(stacksOf(skeleton)), JSON.stringify(skeleton), account, limit, account, skeleton.id)
    .run();
  if (meta.changes === 0) return refuse(403, 'deposit_limit', `An account holds at most ${String(limit)} deposits.`);
  return answer(201, { ok: true, id: skeleton.id });
};

/** A name that does not decode stays as it came: no vocabulary holds it, so the route refuses it by name. */
const decoded = (name: string): string => {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

export default {
  fetch: async (request: Request, env: Env): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST') {
      if (pathname === '/v1/deposits') return deposit(request, env);
      if (pathname === '/v1/login/start') return loginStart(request, env);
      if (pathname === '/v1/login/poll') return loginPoll(request, env);
      if (pathname === '/v1/covenant/accept') return covenantAccept(request, env);
    }
    if (request.method === 'GET') {
      if (pathname === '/v1/covenant') return covenantStatus(request, env);
      if (pathname.startsWith(SLICES)) return pullSlice(request, env, decoded(pathname.slice(SLICES.length)));
    }
    return refuse(404, 'not_found', 'No such route.');
  },
};
