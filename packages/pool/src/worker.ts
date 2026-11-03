// The pool server (t758): a Workers fetch handler over one D1 database. Deposits take closed-vocabulary skeletons only, and a refusal names the field.
import { createHash } from 'node:crypto';
import { parseSkeleton, stacksOf } from '../../cli/src/sessions/pool-wire.js';

/** The part of a D1 binding this server uses, so the code does not take the ambient Workers types, which clash with Node's. */
export interface PoolDb {
  prepare: (sql: string) => { bind: (...values: (string | number | null)[]) => { first: () => Promise<unknown>; run: () => Promise<unknown> } };
}

export interface Env {
  DB: PoolDb;
}

/** D1 holds at most 2 MB in one value; a skeleton past this limit is refused before it is read. */
const MAX_DEPOSIT_BYTES = 1024 * 1024;

const answer = (status: number, body: object): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refuse = (status: number, error: string, message: string, field?: string): Response => answer(status, { error, message, ...(field === undefined ? {} : { field }) });

const hasAccount = (row: unknown): row is { account: string } => typeof row === 'object' && row !== null && 'account' in row && typeof row.account === 'string';

/** The account a bearer token belongs to. Only the token's hash is stored, so a read of the database signs nobody in. */
const accountOf = async (request: Request, env: Env): Promise<string | undefined> => {
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (token === undefined) return undefined;
  const hash = createHash('sha256').update(token).digest('hex');
  const row = await env.DB.prepare('SELECT account FROM tokens WHERE hash = ? AND expires_at > ?').bind(hash, Date.now()).first();
  return hasAccount(row) ? row.account : undefined;
};

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
    if (pathname === '/v1/deposits' && request.method === 'POST') return deposit(request, env);
    return refuse(404, 'not_found', 'No such route.');
  },
};
