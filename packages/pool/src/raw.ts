// The raw tier: a locally redacted transcript goes to R2 in parts, and D1 keeps one ledger row per object. This file is the only one that touches the raw bucket or `raw_objects`, and it serves nothing: no route returns a raw byte, a hash, or a count (`raw-serves-nothing.test.ts` pins that).
// The server cannot verify redaction. It takes the client's word that the bytes were redacted (and hosts masked) before they were sent, and it runs no scanner.
import { createHash } from 'node:crypto';
import { covenantNotAccepted, depositsClosed, hasAccepted } from './covenant.js';
import { answer, bodyOf, bound, fieldOf, notConfigured, refuse, type Env, type RawBucket, type RawUploadedPart } from './http.js';
import { accountOf } from './identity.js';

/** One request carries at most this much, the same cap a deposit has. A transcript past it goes in parts. */
const MAX_RAW_PART_BYTES = 1024 * 1024;

/** R2 will not complete a multipart upload from parts under 5 MiB (except the last), and wants the others equal, so the staged parts are re-cut to this size when the object is assembled. */
const ASSEMBLY_PART_BYTES = 5 * 1024 * 1024;

const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const REDACTION_HEADER = 'oars-redaction-version';
const CAPTURE_HEADER = 'oars-capture-version';
const CONSENT_HEADER = 'oars-raw-consent';

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

/** Raw consent is its own answer, apart from the covenant. Stating it records it once; after that a request need not repeat it, and one that states anything but `granted` is a refusal. */
const consented = async (request: Request, env: Env, account: string): Promise<boolean> => {
  const stated = request.headers.get(CONSENT_HEADER);
  if (stated === 'granted') {
    await env.DB.prepare('UPDATE accounts SET raw_consent = COALESCE(raw_consent, ?) WHERE id = ?').bind(Date.now(), account).run();
    return true;
  }
  if (stated !== null) return false;
  return typeof fieldOf(await env.DB.prepare('SELECT raw_consent FROM accounts WHERE id = ?').bind(account).first(), 'raw_consent') === 'number';
};

/** Every raw request passes the same gate, in this order: the pool is open, the account is signed in and has accepted the covenant in force, the request states its redaction and capture versions, and the account has given raw consent. */
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
  if (!(await consented(request, env, account))) return refuse(403, 'raw_consent_required', `Raw transcripts need their own consent: send ${CONSENT_HEADER}: granted once the person has said yes.`, CONSENT_HEADER);
  if (env.RAW === undefined) return notConfigured('RAW');
  return { account, redaction, capture, bucket: env.RAW };
};

const stored = async (env: Env, account: string, hash: string): Promise<boolean> => (await env.DB.prepare('SELECT 1 AS held FROM raw_objects WHERE account = ? AND sha256 = ?').bind(account, hash).first()) !== null;

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
  if (await stored(env, account, hash)) return answer(200, { ok: true, stored: true });
  if (body.byteLength > MAX_RAW_PART_BYTES) return tooLarge();
  if (body.byteLength === 0) return refuse(422, 'empty_part', 'A part holds at least one byte.');
  await bucket.put(stagingKey(account, hash, part), body);
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
