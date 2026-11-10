// The pool server: a Workers fetch handler over one D1 database. A deposit is a skeleton of a closed list of fields, whose names the pool classes (`field-classes.ts`); a shape error is refused, naming the field.
import { parseSkeleton, type SessionSkeleton } from '../../cli/src/sessions/pool-wire.js';
import { batchCounts, batchTier } from './access.js';
import { fetchBundle, harnessRequired } from './bundle.js';
import { exportPage, exportRaw } from './export.js';
import { countryOf, covenantAccept, covenantNotAccepted, covenantStatus, depositsClosed, hasAccepted } from './covenant.js';
import { answer, bound, brake, notConfigured, refuse, type Env } from './http.js';
import { receivePart } from './parts.js';
import { heldBy, recount, repoKeysOf, signalStatements } from './cluster-store.js';
import { incrementsOf, incrementStatements, markOf, netCellCount, previousOf } from './ingest.js';
import { loginGone, loginPoll, loginStart, logout, proveControl } from './identity.js';
import { hashHosts, hashKey } from './ingest-hash.js';
import { activate, callerOf, enroll, list, machineScope, revoke, rotate, type Caller } from './machines.js';
import { stampOf, takeClaim } from './provenance.js';
import { grantRawConsent, rawRoute, withdrawRawConsent } from './raw.js';
import { depositDigest, erasedRefusal, holdsErasedValue, isErased } from './tombstones.js';
import { telemetry, type TelemetryEnv } from './telemetry.js';
import { fleet, operator, type OperatorEnv } from './telemetry-fleet.js';
import { nightly } from './nightly.js';
import type { SweepEnv } from './retention.js';
import type { RollupEnv } from './telemetry-rollup.js';

/** D1 holds at most 2 MB in one value. A body declaring more is refused unread, and one that declares nothing is measured before it is parsed. */
const MAX_DEPOSIT_BYTES = 1024 * 1024;

/** What an unset brake binds to: no account holds this many rows or bytes, so the statement below needs no second form. */
const UNLIMITED = Number.MAX_SAFE_INTEGER;

/** What a batch's `deltas` hold until the wire carries them (spec Section 2, "Deltas"): the client builds them, so ingest has none to take. */
const DELTAS = '[]';

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
const storeDeposit = async (env: Env, caller: Caller, secret: string, text: string, country: string | null): Promise<Response> => {
  const { account, machine } = caller;
  const stamp = stampOf(machine);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, 'closed_vocabulary', 'The body is not JSON.', 'skeleton');
  }
  // `claimed` is the pool's own to read, set apart before the skeleton is, so it is neither bagged nor parsed as one of its fields.
  const taken = takeClaim(body, machine);
  if (taken instanceof Response) return taken;
  const { claim } = taken;
  body = taken.rest;
  // The body is read once as it came, so a refusal is judged on what the client sent (a host that is not a name is still refused).
  const sent = parseSkeleton(body);
  if (!sent.ok) return refuse(422, 'closed_vocabulary', `${sent.field}: ${sent.reason}`, sent.field);
  // Erased content does not come back: a session the operator erased, or any string an erasure tombstoned (a leaked secret), is refused before anything is written.
  if ((await isErased(env, 'deposit', await depositDigest(account, sent.skeleton.id))) || (await holdsErasedValue(env, body))) return erasedRefusal();
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
    'INSERT INTO deposits (account, id, skeleton, deltas, tier, counted_at, ingest, format, vocab_version, fields_version, extensions, other_values, machine, host_class, launcher, claimed_host_class, claimed_launcher, request_country) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ((SELECT COUNT(*) FROM deposits WHERE account = ?) < ? OR EXISTS (SELECT 1 FROM deposits WHERE account = ? AND id = ?)) AND (SELECT COALESCE(SUM(LENGTH(CAST(skeleton AS BLOB)) + LENGTH(CAST(deltas AS BLOB)) + LENGTH(CAST(extensions AS BLOB))), 0) FROM deposits WHERE account = ? AND id <> ?) + ? <= ? ON CONFLICT (account, id) DO UPDATE SET skeleton = excluded.skeleton, deltas = excluded.deltas, tier = excluded.tier, ingest = excluded.ingest, format = excluded.format, vocab_version = excluded.vocab_version, fields_version = excluded.fields_version, extensions = excluded.extensions, other_values = excluded.other_values, machine = excluded.machine, host_class = excluded.host_class, launcher = excluded.launcher, claimed_host_class = excluded.claimed_host_class, claimed_launcher = excluded.claimed_launcher, request_country = excluded.request_country, counted_at = CASE WHEN ? = 0 THEN deposits.counted_at WHEN excluded.counted_at IS NULL THEN NULL ELSE COALESCE(deposits.counted_at, excluded.counted_at) END WHERE deposits.ingest = ?',
  )
    .bind(account, skeleton.id, stored, DELTAS, tier, countedAt, ingest, skeleton.format, skeleton.vocabVersion, skeleton.fieldsVersion, bag, others, stamp.machine, stamp.hostClass, stamp.launcher, claim?.hostClass ?? null, claim?.launcher ?? null, country, account, limit ?? UNLIMITED, account, skeleton.id, account, skeleton.id, new TextEncoder().encode(stored).length + new TextEncoder().encode(DELTAS).length + new TextEncoder().encode(bag).length, budget ?? UNLIMITED, written > 0 ? 1 : 0, previous?.ingest ?? '');
  // The row and every increment it writes are one transaction; the increments are guarded by the row's `ingest` mark, so a refused deposit writes none of them.
  const arrived = new Date();
  const [inserted] = await env.DB.batch([
    insert,
    // A machine records the day of its last stored deposit. Guarded by the row's `ingest` mark like the increments, so a deposit a brake refused moves nothing.
    ...(machine === undefined
      ? []
      : [env.DB.prepare('UPDATE machines SET last_deposit_day = ? WHERE id = ? AND EXISTS (SELECT 1 FROM deposits WHERE account = ? AND id = ? AND ingest = ?)').bind(arrived.toISOString().slice(0, 10), machine.id, account, skeleton.id, ingest)]),
    ...incrementStatements(env, account, skeleton.id, ingest, arrived.toISOString().slice(0, 10), next, previous?.increments),
    ...signalStatements(env, account, [account, skeleton.id, ingest], arrived, repoKeysOf(skeleton)),
  ]);
  if ((inserted?.meta.changes ?? 0) === 0) {
    // The upsert changes nothing in two cases: a brake refused the row, or another deposit of this session set the row after this one read it. Only the second leaves a row with another mark than the one read.
    const held = await markOf(env, account, skeleton.id);
    if (held !== undefined && held !== (previous?.ingest ?? '')) return refuse(409, 'deposit_conflict', 'Another deposit of this session landed first. Send it again.');
    // Only the brakes that are set are named: an unset one limits nothing.
    const set = [...(limit === undefined ? [] : [`${String(limit)} deposits`]), ...(budget === undefined ? [] : [`${String(budget)} stored bytes`])];
    return refuse(403, 'deposit_limit', `An operator's brake holds this account to at most ${set.join(' and ')}.`);
  }
  // The counts the floors compare are clusters of accounts, not accounts (t937): taken once the row and its contributor records are committed, for every cell and stratum this account holds, not only this batch's: the repo keys and hours it adds belong to the account, so they can join it to another account in cells the batch never touched.
  await recount(env, 'cell', await heldBy(env, account, 'cell'));
  await recount(env, 'stratum', await heldBy(env, account, 'stratum'));
  // A machine's key learns when it ends from every deposit it makes, so the machine can say so before it does.
  return answer(201, { ok: true, id: skeleton.id, ...(machine === undefined ? {} : { machineExpiresAt: machine.expiresAt }) });
};

const deposit = async (request: Request, env: Env): Promise<Response> => {
  // The gate comes before the sign-in and the body, so a closed pool reads neither.
  const version = bound(env.COVENANT_VERSION);
  if (version === undefined) return depositsClosed();
  // The account's own credential or a machine's key: the key deposits for its machine's account, stamped as that machine.
  const caller = await callerOf(request, env, Date.now());
  if (caller instanceof Response) return caller;
  if (caller === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  if (!(await hasAccepted(env, caller.account, version))) return covenantNotAccepted(version);
  // A host is hashed before any write, so a pool with no key refuses here, before the body is read, rather than store one in clear.
  const secret = bound(env.INGEST_HASH_KEY);
  if (secret === undefined) return notConfigured('INGEST_HASH_KEY');
  const tooLarge = (): Response => refuse(413, 'too_large', `A skeleton holds at most ${String(MAX_DEPOSIT_BYTES)} bytes.`);
  if (Number(request.headers.get('content-length')) > MAX_DEPOSIT_BYTES) return tooLarge();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_DEPOSIT_BYTES) return tooLarge();
  return request.headers.has('oars-part') ? receivePart(request, env, caller.account, secret, text, (whole) => storeDeposit(env, caller, secret, whole, countryOf(request))) : storeDeposit(env, caller, secret, text, countryOf(request));
};

/** A name that does not decode stays as it came: no vocabulary holds it, so the route refuses it by name. */
const decoded = (name: string): string => {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

type PoolEnv = Env & TelemetryEnv & RollupEnv & OperatorEnv;

interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** A `:name` segment matches anything but a slash, and its text reaches the handler. */
  path: string;
  /** Whether a machine key may call it. A machine key deposits, reads the covenant, activates and rotates itself, and posts telemetry (which reads no credential); every other route answers it 403 `deposit_only` (`machineScope`), so a route is closed to it until it says otherwise here. */
  machine: boolean;
  handle: (request: Request, env: PoolEnv, segments: readonly string[]) => Promise<Response> | Response;
}

/** Every route the pool serves but the raw tier's (`RAW_ROUTES`), which `rawRoute` matches itself and which a machine key may not call. The guard test walks this table. */
export const ROUTES: readonly Route[] = [
  { method: 'POST', path: '/v1/deposits', machine: true, handle: deposit },
  // Not a deposit: it needs no covenant, and it is answered with deposits closed. It reads no credential, so a key gains nothing here; a cloud VM's agent proxy adds the network secret to every request for the pool's host, and its telemetry must not be refused.
  { method: 'POST', path: '/v1/telemetry', machine: true, handle: (request, env) => telemetry(request, env, Date.now) },
  { method: 'POST', path: '/v1/login/start', machine: false, handle: loginStart },
  { method: 'POST', path: '/v1/login/poll', machine: false, handle: loginPoll },
  { method: 'POST', path: '/v1/login', machine: false, handle: loginGone },
  { method: 'DELETE', path: '/v1/login', machine: false, handle: logout },
  { method: 'POST', path: '/v1/covenant/accept', machine: false, handle: (request, env) => covenantAccept(request, env) },
  { method: 'POST', path: '/v1/machines/enroll', machine: false, handle: enroll },
  // The account lists and revokes its machines; a machine key may do neither.
  { method: 'GET', path: '/v1/machines', machine: false, handle: list },
  { method: 'DELETE', path: '/v1/machines/:id', machine: false, handle: (request, env, [id]) => revoke(request, env, decoded(id ?? '')) },
  // A machine key activates and rotates itself: it is the only credential these two routes read.
  { method: 'POST', path: '/v1/machines/activate', machine: true, handle: activate },
  { method: 'POST', path: '/v1/machines/rotate', machine: true, handle: rotate },
  // The account's own copy of what the pool holds (Articles 15(3) and 20), and one raw object of its own. Neither is open to a machine key: a runtime that deposits has no business reading the account back.
  { method: 'GET', path: '/v1/account/export', machine: false, handle: exportPage },
  { method: 'GET', path: '/v1/account/export/raw/:hash', machine: false, handle: (request, env, [hash]) => exportRaw(request, env, decoded(hash ?? '')) },
  // The account proves it controls itself (the operator confirms a requester against the stored time). Token-only: a machine key never proves a person.
  { method: 'POST', path: '/v1/account/proof', machine: false, handle: proveControl },
  { method: 'GET', path: '/v1/covenant', machine: true, handle: (request, env) => covenantStatus(request, env) },
  // The account takes its raw yes back (GDPR Article 7(3)). Account-only: a machine key never speaks for a person's consent.
  { method: 'DELETE', path: '/v1/consent/raw', machine: false, handle: withdrawRawConsent },
  // The one way to record a yes after a withdrawal: a header on a raw request cannot.
  { method: 'PUT', path: '/v1/consent/raw', machine: false, handle: grantRawConsent },
  // Not a deposit and not signed in: percentiles over installs, served only where at least the public floor reports. No query is read.
  { method: 'GET', path: '/v1/telemetry/fleet', machine: false, handle: (request, env) => fleet(env, Date.now(), !request.headers.has('authorization')) },
  // The operator's anomaly read, behind a secret the deploy sets: never served to users.
  { method: 'GET', path: '/v1/telemetry/operator', machine: false, handle: (request, env) => operator(request, env, Date.now()) },
  { method: 'GET', path: '/bundle/:harness/:harnessVersion/:vocabVersion', machine: false, handle: (request, env, [harness, version, vocab]) => fetchBundle(request, env, decoded(harness ?? ''), decoded(version ?? ''), decoded(vocab ?? '')) },
  // The route as it stood before the harness segment: refused by name rather than served.
  { method: 'GET', path: '/bundle/:harness/:harnessVersion', machine: false, handle: () => harnessRequired() },
];

/** A path template as the pattern its request path is matched with. */
const patternOf = (path: string): RegExp => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '([^/]*)')}$`);

const COMPILED = ROUTES.map((route) => ({ route, pattern: patternOf(route.path) }));

const routeOf = (method: string, pathname: string): { route: Route; segments: readonly string[] } | undefined => {
  for (const { route, pattern } of COMPILED) {
    const found = route.method === method ? pattern.exec(pathname) : null;
    if (found !== null) return { route, segments: found.slice(1) };
  }
  return undefined;
};

export default {
  /** The nightly cron (wrangler.jsonc): the telemetry rollup the fleet read comes from, then the retention sweeps (`nightly.ts`). It reads the telemetry record, writes the rollup table, and drops what has expired. */
  scheduled: async (controller: { scheduledTime: number }, env: Env & RollupEnv & SweepEnv): Promise<void> => {
    await nightly(env, controller.scheduledTime);
  },
  fetch: async (request: Request, env: PoolEnv): Promise<Response> => {
    const found = routeOf(request.method, new URL(request.url).pathname);
    // The scope comes before every route, the raw tier's and an unknown path included: a machine key is refused anywhere a route does not say it may go.
    const outOfScope = await machineScope(request, env, found?.route.machine === true);
    if (outOfScope !== undefined) return outOfScope;
    const raw = rawRoute(request, env);
    if (raw !== undefined) return raw;
    return found === undefined ? refuse(404, 'not_found', 'No such route.') : found.route.handle(request, env, found.segments);
  },
};
