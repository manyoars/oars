// The pool server (t758): a Workers fetch handler over one D1 database. Deposits take closed-vocabulary skeletons only, and a refusal names the field.
import { parseSkeleton, stacksOf, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import type { Frame } from '../../cli/src/sessions/schema.js';
import { covenantAccept, covenantNotAccepted, covenantStatus, depositsClosed, hasAccepted } from './covenant.js';
import { answer, bound, refuse, wholeBinding, type Env } from './http.js';
import { accountOf, loginPoll, loginStart } from './identity.js';
import { pullSlice } from './slice.js';

/** D1 holds at most 2 MB in one value. A body declaring more is refused unread, and one that declares nothing is measured before it is parsed. */
const MAX_DEPOSIT_BYTES = 1024 * 1024;

/** Every pull parses every row, so one account's rows are a cost on every other account's pull. These two bound that one account's share, by row and by stored byte; they do not bound the pool, whose rows across all accounts a pull still loads at once. */
const DEFAULT_MAX_DEPOSITS = 20_000;
const DEFAULT_MAX_ACCOUNT_BYTES = 64 * 1024 * 1024;

const SLICES = '/v1/slices/';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The field of a frame dated after tomorrow UTC. A forged day would set the pool's `lastDay`, so `asOf` and every adoption read would follow it. Tomorrow passes because a client's clock can run a little ahead. Here and not in `parseSkeleton`, which has no clock. */
const futureDayField = ({ transcripts }: SessionSkeleton, now: number): string | undefined => {
  const tomorrow = new Date(now + DAY_MS).toISOString().slice(0, 10);
  const late = ({ day }: Frame): boolean => day !== null && day > tomorrow;
  for (const [at, { frame, prompts }] of transcripts.entries()) {
    if (late(frame)) return `transcripts[${String(at)}].frame.day`;
    const index = prompts.findIndex((entry) => late(entry.frame));
    if (index !== -1) return `transcripts[${String(at)}].prompts[${String(index)}].frame.day`;
  }
  return undefined;
};

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
  const lateField = futureDayField(skeleton, Date.now());
  if (lateField !== undefined) return refuse(422, 'closed_vocabulary', `${lateField}: later than tomorrow UTC`, lateField);
  const limit = wholeBinding(env.MAX_DEPOSITS_PER_ACCOUNT, DEFAULT_MAX_DEPOSITS);
  const budget = wholeBinding(env.MAX_DEPOSIT_BYTES_PER_ACCOUNT, DEFAULT_MAX_ACCOUNT_BYTES);
  const stored = JSON.stringify(skeleton);
  // One statement, so two deposits at once cannot both take the last of either limit. A redeposit replaces its own row: it adds no row, so it passes the count at the limit, and only its new size counts against the budget.
  const { meta } = await env.DB.prepare(
    'INSERT INTO deposits (account, id, stacks, skeleton) SELECT ?, ?, ?, ? WHERE ((SELECT COUNT(*) FROM deposits WHERE account = ?) < ? OR EXISTS (SELECT 1 FROM deposits WHERE account = ? AND id = ?)) AND (SELECT COALESCE(SUM(LENGTH(CAST(skeleton AS BLOB))), 0) FROM deposits WHERE account = ? AND id <> ?) + ? <= ? ON CONFLICT (account, id) DO UPDATE SET stacks = excluded.stacks, skeleton = excluded.skeleton',
  )
    .bind(account, skeleton.id, JSON.stringify(stacksOf(skeleton)), stored, account, limit, account, skeleton.id, account, skeleton.id, new TextEncoder().encode(stored).length, budget)
    .run();
  if (meta.changes === 0) return refuse(403, 'deposit_limit', `An account holds at most ${String(limit)} deposits and ${String(budget)} stored bytes.`);
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
