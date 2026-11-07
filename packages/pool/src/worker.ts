// The pool server: a Workers fetch handler over one D1 database. Deposits take closed-vocabulary skeletons only, and a refusal names the field.
import { parseSkeleton, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { batchCounts, batchTier } from './access.js';
import { fetchBundle, harnessRequired } from './bundle.js';
import { covenantAccept, covenantNotAccepted, covenantStatus, depositsClosed, hasAccepted } from './covenant.js';
import { answer, bound, brake, notConfigured, refuse, type Env } from './http.js';
import { receivePart } from './parts.js';
import { incrementsOf, incrementStatements, markOf, netCellCount, previousOf } from './ingest.js';
import { accountOf, login } from './identity.js';
import { hashHosts, hashKey } from './ingest-hash.js';
import { rawRoute } from './raw.js';
import { telemetry, type TelemetryEnv } from './telemetry.js';

/** D1 holds at most 2 MB in one value. A body declaring more is refused unread, and one that declares nothing is measured before it is parsed. */
const MAX_DEPOSIT_BYTES = 1024 * 1024;

/** What an unset brake binds to: no account holds this many rows or bytes, so the statement below needs no second form. */
const UNLIMITED = Number.MAX_SAFE_INTEGER;

/** What a batch's `deltas` hold until the wire carries them (spec Section 2, "Deltas"): the client builds them, so ingest has none to take. */
const DELTAS = '[]';

const BUNDLE = /^\/bundle\/([^/]*)\/([^/]*)\/([^/]*)$/;
/** The route as it stood before the harness segment: refused by name rather than served. */
const BUNDLE_WITHOUT_HARNESS = /^\/bundle\/([^/]*)\/([^/]*)$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The field of a frame dated after tomorrow UTC. A forged day would set the pool's `lastDay`, so `asOf` and every adoption read would follow it. Tomorrow passes because a client's clock can run a little ahead. Here and not in `parseSkeleton`, which has no clock. */
const futureDayField = ({ transcripts }: SessionSkeleton, now: number): string | undefined => {
  const tomorrow = new Date(now + DAY_MS).toISOString().slice(0, 10);
  const late = ({ day }: { readonly day: string | null }): boolean => day !== null && day > tomorrow;
  for (const [at, { frame, prompts }] of transcripts.entries()) {
    if (late(frame)) return `transcripts[${String(at)}].frame.day`;
    const index = prompts.findIndex((entry) => late(entry.frame));
    if (index !== -1) return `transcripts[${String(at)}].prompts[${String(index)}].frame.day`;
  }
  return undefined;
};

/** A whole batch, from the request or joined from its parts: parsed, projected, and written as one deposit. The hash key is read before the body, so a pool with none never gets here. */
const storeDeposit = async (env: Env, account: string, secret: string, text: string): Promise<Response> => {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, 'closed_vocabulary', 'The body is not JSON.', 'skeleton');
  }
  // The body is read once as it came, so a refusal is judged on what the client sent (a host that is not a name is still refused).
  const sent = parseSkeleton(body);
  if (!sent.ok) return refuse(422, 'closed_vocabulary', `${sent.field}: ${sent.reason}`, sent.field);
  // Then the hosts are hashed and the body is read again: the row, the bag, the literals, the cells, and the motifs all come from the hashed form, so a clear host never reaches a write.
  const parsed = parseSkeleton(await hashHosts(await hashKey(secret), body));
  if (!parsed.ok) return refuse(422, 'closed_vocabulary', `${parsed.field}: ${parsed.reason}`, parsed.field);
  // The parsed skeleton is what is stored, not the text that came in: it holds only the fields that were read.
  const { skeleton, extensions, others } = parsed;
  const lateField = futureDayField(skeleton, Date.now());
  if (lateField !== undefined) return refuse(422, 'closed_vocabulary', `${lateField}: later than tomorrow UTC`, lateField);
  // The pool does not ration contribution (data is the point): both brakes are an operator's, off unless a binding sets one.
  const limit = brake(env.MAX_DEPOSITS_PER_ACCOUNT);
  const budget = brake(env.MAX_DEPOSIT_BYTES_PER_ACCOUNT);
  const stored = JSON.stringify(skeleton);
  // The bag is stored beside the skeleton and read by nothing that serves: ingest reads `skeleton` only, so no cell, read, or bundle is derived from it.
  const bag = JSON.stringify(extensions);
  // Whether this batch counts toward access is decided here, from the batch and the row it replaces; it is judged at the batch's own tier, which the upsert writes again on a resend: the tier falls on any resend whose root no longer holds, and the date clears only when that resend also writes a cell.
  // `written` is what ingest will write over the row held now, not what the batch derives: a batch sent again unchanged writes nothing and leaves the row's date alone.
  const next = incrementsOf(skeleton);
  const previous = await previousOf(env, account, skeleton.id);
  const tier = batchTier(skeleton);
  // A row held at `none` that now counts is a write too, though its cells are unchanged: its date was never set, and this resend is what sets it.
  const written = netCellCount(next, previous?.increments) + (previous?.none === true && tier !== 'none' ? 1 : 0);
  const countedAt = batchCounts(tier, skeleton, written) ? Date.now() : null;
  const ingest = crypto.randomUUID();
  // One statement, so two deposits at once cannot both take the last of either limit. A redeposit replaces its own row: it adds no row, so it passes the count at the limit, and only its new size counts against the budget.
  const insert = env.DB.prepare(
    'INSERT INTO deposits (account, id, skeleton, deltas, tier, counted_at, ingest, format, vocab_version, fields_version, extensions, other_values) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ((SELECT COUNT(*) FROM deposits WHERE account = ?) < ? OR EXISTS (SELECT 1 FROM deposits WHERE account = ? AND id = ?)) AND (SELECT COALESCE(SUM(LENGTH(CAST(skeleton AS BLOB)) + LENGTH(CAST(deltas AS BLOB)) + LENGTH(CAST(extensions AS BLOB))), 0) FROM deposits WHERE account = ? AND id <> ?) + ? <= ? ON CONFLICT (account, id) DO UPDATE SET skeleton = excluded.skeleton, deltas = excluded.deltas, tier = excluded.tier, ingest = excluded.ingest, format = excluded.format, vocab_version = excluded.vocab_version, fields_version = excluded.fields_version, extensions = excluded.extensions, other_values = excluded.other_values, counted_at = CASE WHEN ? = 0 THEN deposits.counted_at WHEN excluded.counted_at IS NULL THEN NULL ELSE COALESCE(deposits.counted_at, excluded.counted_at) END WHERE deposits.ingest = ?',
  )
    .bind(account, skeleton.id, stored, DELTAS, tier, countedAt, ingest, skeleton.format, skeleton.vocabVersion, skeleton.fieldsVersion, bag, others, account, limit ?? UNLIMITED, account, skeleton.id, account, skeleton.id, new TextEncoder().encode(stored).length + new TextEncoder().encode(DELTAS).length + new TextEncoder().encode(bag).length, budget ?? UNLIMITED, written > 0 ? 1 : 0, previous?.ingest ?? '');
  // The row and every increment it writes are one transaction; the increments are guarded by the row's `ingest` mark, so a refused deposit writes none of them.
  const [inserted] = await env.DB.batch([insert, ...incrementStatements(env, account, skeleton.id, ingest, new Date().toISOString().slice(0, 10), next, previous?.increments)]);
  if ((inserted?.meta.changes ?? 0) === 0) {
    // The upsert changes nothing in two cases: a brake refused the row, or another deposit of this session set the row after this one read it. Only the second leaves a row with another mark than the one read.
    const held = await markOf(env, account, skeleton.id);
    if (held !== undefined && held !== (previous?.ingest ?? '')) return refuse(409, 'deposit_conflict', 'Another deposit of this session landed first. Send it again.');
    // Only the brakes that are set are named: an unset one limits nothing.
    const set = [...(limit === undefined ? [] : [`${String(limit)} deposits`]), ...(budget === undefined ? [] : [`${String(budget)} stored bytes`])];
    return refuse(403, 'deposit_limit', `An operator's brake holds this account to at most ${set.join(' and ')}.`);
  }
  return answer(201, { ok: true, id: skeleton.id });
};

const deposit = async (request: Request, env: Env): Promise<Response> => {
  // The gate comes before the sign-in and the body, so a closed pool reads neither.
  const version = bound(env.COVENANT_VERSION);
  if (version === undefined) return depositsClosed();
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  if (!(await hasAccepted(env, account, version))) return covenantNotAccepted(version);
  // A host is hashed before any write, so a pool with no key refuses here, before the body is read, rather than store one in clear.
  const secret = bound(env.INGEST_HASH_KEY);
  if (secret === undefined) return notConfigured('INGEST_HASH_KEY');
  const tooLarge = (): Response => refuse(413, 'too_large', `A skeleton holds at most ${String(MAX_DEPOSIT_BYTES)} bytes.`);
  if (Number(request.headers.get('content-length')) > MAX_DEPOSIT_BYTES) return tooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_DEPOSIT_BYTES) return tooLarge();
  return request.headers.has('oars-part') ? receivePart(request, env, account, secret, text, (whole) => storeDeposit(env, account, secret, whole)) : storeDeposit(env, account, secret, text);
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
  fetch: async (request: Request, env: Env & TelemetryEnv): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const raw = rawRoute(request, env);
    if (raw !== undefined) return raw;
    if (request.method === 'POST') {
      if (pathname === '/v1/deposits') return deposit(request, env);
      // Not a deposit: it needs no covenant, and it is answered with deposits closed.
      if (pathname === '/v1/telemetry') return telemetry(request, env, Date.now);
      if (pathname === '/v1/login') return login(request, env);
      if (pathname === '/v1/covenant/accept') return covenantAccept(request, env);
    }
    if (request.method === 'GET') {
      if (pathname === '/v1/covenant') return covenantStatus(request, env);
      const route = BUNDLE.exec(pathname);
      if (route !== null) return fetchBundle(request, env, decoded(route[1] ?? ''), decoded(route[2] ?? ''), decoded(route[3] ?? ''));
      if (BUNDLE_WITHOUT_HARNESS.test(pathname)) return harnessRequired();
    }
    return refuse(404, 'not_found', 'No such route.');
  },
};
