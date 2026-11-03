// The pool server (t758): a Workers fetch handler over one D1 database. Deposits take closed-vocabulary skeletons only, and a refusal names the field.
import { parseSkeleton, stacksOf } from '../../cli/src/sessions/pool-wire.js';
import { answer, refuse, type Env } from './http.js';
import { accountOf, loginPoll, loginStart } from './identity.js';
import { pullSlice } from './slice.js';

/** D1 holds at most 2 MB in one value; a skeleton past this limit is refused before it is read. */
const MAX_DEPOSIT_BYTES = 1024 * 1024;

const SLICES = '/v1/slices/';

const deposit = async (request: Request, env: Env): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_DEPOSIT_BYTES) return refuse(413, 'too_large', `A skeleton holds at most ${String(MAX_DEPOSIT_BYTES)} bytes.`);
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
  await env.DB.prepare('INSERT INTO deposits (account, id, stacks, skeleton) VALUES (?, ?, ?, ?) ON CONFLICT (account, id) DO UPDATE SET stacks = excluded.stacks, skeleton = excluded.skeleton')
    .bind(account, skeleton.id, JSON.stringify(stacksOf(skeleton)), JSON.stringify(skeleton))
    .run();
  return answer(201, { ok: true, id: skeleton.id });
};

export default {
  fetch: async (request: Request, env: Env): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST') {
      if (pathname === '/v1/deposits') return deposit(request, env);
      if (pathname === '/v1/login/start') return loginStart(request, env);
      if (pathname === '/v1/login/poll') return loginPoll(request, env);
    }
    if (request.method === 'GET' && pathname.startsWith(SLICES)) return pullSlice(request, env, decodeURIComponent(pathname.slice(SLICES.length)));
    return refuse(404, 'not_found', 'No such route.');
  },
};
