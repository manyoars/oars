// The raw tier: a locally redacted transcript goes to R2 in parts, and D1 keeps one ledger row per object. This file is the only one that touches the raw bucket or `raw_objects`, and it serves nothing: no route returns a raw byte, a hash, or a count (`raw-serves-nothing.test.ts` pins that).
// The server cannot verify redaction. It takes the client's word that the bytes were redacted (and hosts masked) before they were sent, and it runs no scanner.
import { createHash } from 'node:crypto';
import { covenantNotAccepted, depositsClosed, hasAccepted } from './covenant.js';
import { answer, bodyOf, bound, fieldOf, notConfigured, refuse, textField, type Env, type RawBucket, type RawUploadedPart } from './http.js';
import { accountOf } from './identity.js';
import { erasedRefusal, isErased, rawDigest } from './tombstones.js';

/** One request carries at most this much, the same cap a deposit has. A transcript past it goes in parts. */
const MAX_RAW_PART_BYTES = 1024 * 1024;

/** R2 will not complete a multipart upload from parts under 5 MiB (except the last), and wants the others equal, so the staged parts are re-cut to this size when the object is assembled. */
const ASSEMBLY_PART_BYTES = 5 * 1024 * 1024;

/**
 * How many staged part objects one account may hold at once: R2's list page, so the check is one call. A part is at most 1 MiB and the CLI's are 512 KiB (`RAW_PART_BYTES`), so an account stages at most 1,000 MiB, and 500 MiB of the CLI's parts, which is a
 * single transcript far past any real session; a completed or refused object clears its parts, and the bucket's lifecycle rule (pool.md, raw tier) expires the rest after 7 days. A transcript of more than this many parts cannot be staged.
 */
export const MAX_STAGED_RAW_PARTS = 1000;

const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const REDACTION_HEADER = 'oars-redaction-version';
const CAPTURE_HEADER = 'oars-capture-version';
const CONSENT_HEADER = 'oars-raw-consent';
const CONSENT_VERSION_HEADER = 'oars-raw-consent-version';

const PART_ROUTE = /^\/v1\/raw\/([0-9a-f]{64})\/parts\/([1-9][0-9]{0,5})$/;
const COMPLETE_ROUTE = /^\/v1\/raw\/([0-9a-f]{64})\/complete$/;

/** Every raw route there is: an upload, in parts, and its completion. A guard test reads this table. */
export const RAW_ROUTES = [
  { method: 'PUT', pattern: PART_ROUTE },
  { method: 'POST', pattern: COMPLETE_ROUTE },
] as const;

const stagingPrefix = (account: string, hash: string): string => `staging/${account}/${hash}/`;
const stagingKey = (account: string, hash: string, part: number): string => `${stagingPrefix(account, hash)}${String(part).padStart(6, '0')}`;
const objectKey = (account: string, hash: string): string => `raw/${account}/${hash}`;

interface Admitted {
  account: string;
  redaction: string;
  capture: string;
  bucket: RawBucket;
}

const versionOf = (request: Request, header: string): string | undefined => {
  const value = request.headers.get(header);
  return value !== null && VERSION.test(value) ? value : undefined;
};

const notAsked = (): Response => refuse(403, 'raw_consent_required', `Raw transcripts need their own consent: send ${CONSENT_HEADER}: granted and ${CONSENT_VERSION_HEADER}: <the covenant version in force> once the person has said yes.`, CONSENT_HEADER);

const staleYes = (covenant: string): Response => refuse(403, 'raw_consent_stale', `The yes to raw copies was given under another covenant version. Answer again for ${covenant}: oars pool raw --consent yes.`, CONSENT_VERSION_HEADER);

const withdrawnYes = (): Response => refuse(403, 'raw_consent_withdrawn', 'This account withdrew its consent to raw copies. They are accepted again only after a new yes: oars pool raw --consent yes.', CONSENT_HEADER);

/**
 * Raw consent is its own answer, apart from the covenant, and it answers one covenant version (GDPR Article 7(1)): a yes counts only for the version in force. Stating it with the version it answered records it, and after that a request need not repeat it;
 * one that states anything but `granted` is a refusal. A yes with no version, in the request or in the row, reads as not asked, and one for another version is stale. After a withdrawal (`withdrawRawConsent`) the raw routes refuse by name, whatever the header says, until a new yes through `grantRawConsent`.
 */
const consented = async (request: Request, env: Env, account: string, covenant: string): Promise<Response | undefined> => {
  const stated = request.headers.get(CONSENT_HEADER);
  const row = await env.DB.prepare('SELECT raw_consent, raw_consent_version, raw_consent_withdrawn_at FROM accounts WHERE id = ?').bind(account).first();
  const standing = typeof fieldOf(row, 'raw_consent') === 'number';
  const held = fieldOf(row, 'raw_consent_version');
  // A withdrawal holds whatever a request says (GDPR Article 7(3)): the client states `granted` on every raw request from any machine with a local yes, so the header cannot be what undoes it. Only PUT /v1/consent/raw records a yes after a withdrawal.
  if (!standing && typeof fieldOf(row, 'raw_consent_withdrawn_at') === 'number') return withdrawnYes();
  if (stated === 'granted') {
    const answered = versionOf(request, CONSENT_VERSION_HEADER);
    if (answered === undefined) return notAsked();
    if (answered !== covenant) return staleYes(covenant);
    if (!standing || held !== answered) await env.DB.prepare('UPDATE accounts SET raw_consent = COALESCE(raw_consent, ?), raw_consent_version = ? WHERE id = ?').bind(Date.now(), answered, account).run();
    return undefined;
  }
  if (stated !== null) return notAsked();
  if (!standing) return notAsked();
  if (typeof held !== 'string') return notAsked();
  return held === covenant ? undefined : staleYes(covenant);
};

/** Every raw request passes the same gate, in this order: the pool is open, the account is signed in and has accepted the covenant in force, the request states its redaction and capture versions, and the account has given raw consent for the covenant in force. */
const admit = async (request: Request, env: Env): Promise<Admitted | Response> => {
  const version = bound(env.COVENANT_VERSION);
  if (version === undefined) return depositsClosed();
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  if (!(await hasAccepted(env, account, version))) return covenantNotAccepted(version);
  const redaction = versionOf(request, REDACTION_HEADER);
  if (redaction === undefined) return refuse(422, 'redaction_required', `State the redaction version the transcript went through in ${REDACTION_HEADER} (letters, digits, dot, dash, underscore; 64 at most).`, REDACTION_HEADER);
  const capture = versionOf(request, CAPTURE_HEADER);
  if (capture === undefined) return refuse(422, 'capture_required', `State the capture version in ${CAPTURE_HEADER} (letters, digits, dot, dash, underscore; 64 at most).`, CAPTURE_HEADER);
  const unconsented = await consented(request, env, account, version);
  if (unconsented !== undefined) return unconsented;
  if (env.RAW === undefined) return notConfigured('RAW');
  return { account, redaction, capture, bucket: env.RAW };
};

const stored = async (env: Env, account: string, hash: string): Promise<boolean> => (await env.DB.prepare('SELECT 1 AS held FROM raw_objects WHERE account = ? AND sha256 = ?').bind(account, hash).first()) !== null;

/** Whether an erasure tombstoned this object (the operator's command, docs/pool.md "Erasure"). */
const erased = async (env: Env, account: string, hash: string): Promise<boolean> => isErased(env, 'raw-object', await rawDigest(objectKey(account, hash)));

/** `PUT /v1/raw/:sha256/parts/:n`: one part, at most 1 MB. The same part sent again replaces itself, and a part for an object that already stands writes nothing. */
const putPart = async (request: Request, env: Env, hash: string, part: number): Promise<Response> => {
  const admitted = await admit(request, env);
  if (admitted instanceof Response) return admitted;
  const { account, bucket } = admitted;
  const tooLarge = (): Response => refuse(413, 'too_large', `A raw part holds at most ${String(MAX_RAW_PART_BYTES)} bytes.`);
  if (Number(request.headers.get('content-length')) > MAX_RAW_PART_BYTES) return tooLarge();
  // The body is read before the stored answer, not after: an answer sent over an unread body of up to 1 MB gets the
  // connection reset under the client on Windows (ECONNRESET, "terminated"), so a retried part would fail where it should answer 200.
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_RAW_PART_BYTES) return tooLarge();
  // An erased object does not come back, and the check comes before the stored answer: its ledger row stands after the erasure, and a 200 `stored` would tell the client it was kept.
  if (await erased(env, account, hash)) return erasedRefusal();
  if (await stored(env, account, hash)) return answer(200, { ok: true, stored: true });
  if (body.byteLength === 0) return refuse(422, 'empty_part', 'A part holds at least one byte.');
  // A part that replaces a staged one adds no object; any other needs room under the account's cap.
  const key = stagingKey(account, hash, part);
  const full = (): Response => refuse(429, 'staging_full', `An account may stage ${String(MAX_STAGED_RAW_PARTS)} raw parts at once. Complete the objects it has begun, or wait: staged parts expire after 7 days.`, undefined, { 'retry-after': String(7 * 24 * 60 * 60) });
  const staged = (await bucket.list({ prefix: `staging/${account}/`, limit: MAX_STAGED_RAW_PARTS })).objects;
  const isNew = !staged.some((object) => object.key === key);
  if (staged.length >= MAX_STAGED_RAW_PARTS && isNew) return full();
  await bucket.put(key, body);
  // Parts that arrive together each listed before any put, so the cap is checked again on what is staged now: a new part that finds the page full takes itself back.
  if (isNew && (await bucket.list({ prefix: `staging/${account}/`, limit: MAX_STAGED_RAW_PARTS })).truncated) {
    await bucket.delete([key]);
    return full();
  }
  return answer(200, { ok: true, part });
};

const wholeField = (value: unknown, key: string, most: number): number | undefined => {
  const found = fieldOf(value, key);
  return typeof found === 'number' && Number.isSafeInteger(found) && found >= 1 && found <= most ? found : undefined;
};

/** Joins the staged parts into one R2 object through a multipart upload, re-cut to equal 5 MiB parts, and checks that the bytes hash to the SHA-256 in the path. Memory holds one assembly part and one staged part at a time. A refusal aborts the upload, so nothing is left half made. */
const assemble = async (bucket: RawBucket, account: string, hash: string, parts: number, bytes: number): Promise<Response | undefined> => {
  const upload = await bucket.createMultipartUpload(objectKey(account, hash));
  const uploaded: RawUploadedPart[] = [];
  const buffer = new Uint8Array(ASSEMBLY_PART_BYTES);
  const digest = createHash('sha256');
  let filled = 0;
  let total = 0;
  const flush = async (): Promise<void> => {
    uploaded.push(await upload.uploadPart(uploaded.length + 1, buffer.subarray(0, filled)));
    filled = 0;
  };
  for (let at = 1; at <= parts; at += 1) {
    const staged = await bucket.get(stagingKey(account, hash, at));
    if (staged === null) {
      await upload.abort();
      return refuse(409, 'part_missing', `Part ${String(at)} was never uploaded.`, 'parts');
    }
    const chunk = new Uint8Array(await staged.arrayBuffer());
    total += chunk.length;
    digest.update(chunk);
    for (let from = 0; from < chunk.length; ) {
      const take = Math.min(chunk.length - from, ASSEMBLY_PART_BYTES - filled);
      buffer.set(chunk.subarray(from, from + take), filled);
      filled += take;
      from += take;
      if (filled === ASSEMBLY_PART_BYTES) await flush();
    }
  }
  if (total !== bytes) {
    await upload.abort();
    return refuse(422, 'bytes_mismatch', `The parts hold ${String(total)} bytes, not ${String(bytes)}.`, 'bytes');
  }
  if (digest.digest('hex') !== hash) {
    await upload.abort();
    return refuse(422, 'hash_mismatch', 'The parts do not hash to the SHA-256 in the path.', 'sha256');
  }
  if (filled > 0) await flush();
  await upload.complete(uploaded);
  return undefined;
};

/** `POST /v1/raw/:sha256/complete`, `{parts, bytes}`: joins parts 1 to `parts`, checks the byte count and the SHA-256, writes the object and then the ledger row. Sent again for an object that stands, it answers 200. */
const complete = async (request: Request, env: Env, hash: string): Promise<Response> => {
  const admitted = await admit(request, env);
  if (admitted instanceof Response) return admitted;
  const { account, redaction, capture, bucket } = admitted;
  if (await erased(env, account, hash)) return erasedRefusal();
  if (await stored(env, account, hash)) return answer(200, { ok: true, stored: true });
  const body = await bodyOf(request);
  const parts = wholeField(body, 'parts', 999_999);
  if (parts === undefined) return refuse(400, 'missing_field', 'Name the number of parts, a whole number from 1.', 'parts');
  const bytes = wholeField(body, 'bytes', Number.MAX_SAFE_INTEGER);
  if (bytes === undefined) return refuse(400, 'missing_field', 'Name the transcript size in bytes, a whole number from 1.', 'bytes');
  const refused = await assemble(bucket, account, hash, parts, bytes);
  if (refused !== undefined) return refused;
  // The row is the ledger's: never replaced, never deleted (migration 0011). Two completions at once write one row.
  await env.DB.prepare('INSERT INTO raw_objects (account, sha256, bytes, capture_version, redaction_version, stored_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (account, sha256) DO NOTHING')
    .bind(account, hash, bytes, capture, redaction, Date.now())
    .run();
  await bucket.delete(Array.from({ length: parts }, (_, at) => stagingKey(account, hash, at + 1)));
  return answer(201, { ok: true, stored: true });
};

/** Drops every staged part the account holds, a page at a time, and answers how many it dropped. A part staged while this runs is refused as withdrawn (`consented`), so the list ends. */
const dropStaged = async (bucket: RawBucket, account: string): Promise<number> => {
  let dropped = 0;
  for (;;) {
    const page = (await bucket.list({ prefix: `staging/${account}/`, limit: MAX_STAGED_RAW_PARTS })).objects.map((one) => one.key);
    if (page.length === 0) return dropped;
    await bucket.delete(page);
    dropped += page.length;
  }
};

/**
 * `DELETE /v1/consent/raw`: the account takes its raw yes back (GDPR Article 7(3)). It clears the yes and records the time and the covenant version the yes answered, and answers 200 whether or not a yes stood, so a retry is safe and a second withdrawal keeps the first record.
 * It needs a sign-in and nothing else: not an open pool, not an accepted covenant, because a person can always withdraw. The account's staged raw parts go at once; the objects it already holds are erased by the nightly sweep (`sweepWithdrawnRaw`), which reads the record this writes.
 */
export const withdrawRawConsent = async (request: Request, env: Env): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  // One statement, and a SET expression reads the row as it was, so the version withdrawn is the one the yes answered. With no yes standing it matches no row.
  await env.DB.prepare('UPDATE accounts SET raw_consent_withdrawn_at = ?, raw_consent_withdrawn_version = raw_consent_version, raw_consent = NULL, raw_consent_version = NULL WHERE id = ? AND raw_consent IS NOT NULL').bind(Date.now(), account).run();
  if (env.RAW !== undefined) await dropStaged(env.RAW, account);
  return answer(200, { ok: true });
};

/** How many held raw objects one sweep page erases. R2 deletes up to 1,000 keys in one call; D1 takes the batch as one call too. */
const SWEEP_PAGE = 100;

/** The subrequests one sweep page spends: the read, the tombstones, the R2 delete, and the ledger marks. */
export const SWEEP_PAGE_CALLS = 4;

/**
 * The raw copies a withdrawal reaches (GDPR Articles 7(3) and 17(1)(b)): every held object of an account that withdrew its yes, and every one stored before the yes it gave again after. An account whose yes stands has the objects that were stored
 * before that yes (`raw_consent` is the time of the first yes after the last withdrawal: a withdrawal clears it, and a yes said again or restated for a new covenant version keeps it, so a re-grant never reaches the copies it covers); one with no yes standing has them all, even one that finished while the withdrawal was being written. Raw bytes are opaque, so the whole copy goes. For each object the tombstone goes first (so the same bytes
 * cannot be taken again as already stored), then the object, then the mark on its ledger row, which keeps the hash, the byte count, and the date, as the operator's `erase raw` does. A run that stops halfway runs again to the end, and one with nothing left does nothing. A night that erased anything writes one `erasure_audit` row (kind `raw-object`, reason `consent-withdrawn`, the object count, no account).
 * `calls` is the subrequests it may spend; it answers how many objects it erased. The nightly cron runs it (`nightly.ts`), so no operator has to type it.
 */
export const sweepWithdrawnRaw = async (env: Env, now: number, calls: number): Promise<number> => {
  const bucket = env.RAW;
  if (bucket === undefined) return 0;
  const day = new Date(now).toISOString().slice(0, 10);
  let erased = 0;
  for (let spent = SWEEP_PAGE_CALLS; spent <= calls; spent += SWEEP_PAGE_CALLS) {
    const held = (
      await env.DB.prepare(
        'SELECT o.account AS account, o.sha256 AS sha256 FROM accounts a JOIN raw_objects o ON o.account = a.id WHERE a.raw_consent_withdrawn_at IS NOT NULL AND o.erased_on IS NULL AND (a.raw_consent IS NULL OR o.stored_at < a.raw_consent) LIMIT ?',
      )
        .bind(SWEEP_PAGE)
        .all()
    ).results.map((row) => ({ account: String(fieldOf(row, 'account')), sha256: String(fieldOf(row, 'sha256')) }));
    if (held.length === 0) break;
    const keys = held.map((one) => objectKey(one.account, one.sha256));
    const digests = await Promise.all(keys.map((key) => rawDigest(key)));
    await env.DB.batch(digests.map((digest) => env.DB.prepare("INSERT OR IGNORE INTO erasure_tombstones (kind, digest, reason, erased_on) VALUES ('raw-object', ?, 'consent-withdrawn', ?)").bind(digest, day)));
    await bucket.delete(keys);
    await env.DB.batch(held.map((one) => env.DB.prepare('UPDATE raw_objects SET erased_on = ? WHERE account = ? AND sha256 = ? AND erased_on IS NULL').bind(day, one.account, one.sha256)));
    erased += held.length;
    if (held.length < SWEEP_PAGE) break;
  }
  // One audit row for the night, as every operator erasure writes one (docs/pool.md, "The audit"). It is the one call past the pages, inside the margin `RESERVED_CALLS` holds back; a night that erased nothing writes none.
  if (erased > 0) await env.DB.prepare("INSERT INTO erasure_audit (kind, reason, erased_on, rows_erased, objects_erased, account) VALUES ('raw-object', 'consent-withdrawn', ?, 0, ?, NULL)").bind(day, erased).run();
  return erased;
};

/**
 * `PUT /v1/consent/raw`: the account says yes to raw copies for the covenant version in force, the one way to record a yes after a withdrawal. A person types the phrase at a terminal first (the client's side); the pool records which version the yes answers.
 * Account only. The withdrawal columns stay, because they are the record an erasure reads.
 */
export const grantRawConsent = async (request: Request, env: Env): Promise<Response> => {
  const version = bound(env.COVENANT_VERSION);
  if (version === undefined) return depositsClosed();
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  const named = textField(await bodyOf(request), 'version');
  if (named === undefined) return refuse(400, 'missing_field', 'A raw yes names the covenant version it answers.', 'version');
  if (named !== version) return refuse(409, 'covenant_version', `The covenant in force is ${version}, not ${named}.`, 'version');
  await env.DB.prepare('UPDATE accounts SET raw_consent = COALESCE(raw_consent, ?), raw_consent_version = ? WHERE id = ?').bind(Date.now(), version, account).run();
  return answer(200, { ok: true, version });
};

/** The raw routes, or undefined for a request that is not one. */
export const rawRoute = (request: Request, env: Env): Promise<Response> | undefined => {
  const { pathname } = new URL(request.url);
  if (request.method === 'PUT') {
    const route = PART_ROUTE.exec(pathname);
    if (route !== null) return putPart(request, env, route[1] ?? '', Number(route[2]));
  }
  if (request.method === 'POST') {
    const route = COMPLETE_ROUTE.exec(pathname);
    if (route !== null) return complete(request, env, route[1] ?? '');
  }
  return undefined;
};
