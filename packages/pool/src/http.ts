// What every route shares: the bindings and how an answer is written. A refusal always names its error, and its field when one is to blame.

export interface Bound {
  first: () => Promise<unknown>;
  all: () => Promise<{ results: readonly unknown[] }>;
  run: () => Promise<{ meta: { changes: number } }>;
}

/** The part of a D1 binding this server uses, so the code does not take the ambient Workers types, which clash with Node's. */
export interface PoolDb {
  prepare: (sql: string) => { bind: (...values: (string | number | null)[]) => Bound };
  /** Runs the statements in order as one transaction: all of them take effect or none does. */
  batch: (statements: readonly Bound[]) => Promise<{ meta: { changes: number } }[]>;
}

/** One uploaded part of an R2 multipart upload: the binding hands it back and wants the same list at `complete`. */
export interface RawUploadedPart {
  partNumber: number;
  etag: string;
}

export interface RawMultipart {
  uploadPart: (partNumber: number, value: Uint8Array) => Promise<RawUploadedPart>;
  complete: (parts: readonly RawUploadedPart[]) => Promise<unknown>;
  abort: () => Promise<void>;
}

/** The part of an R2 binding the raw tier uses (`raw.ts` is the only file that calls it). */
export interface RawBucket {
  put: (key: string, value: ArrayBuffer) => Promise<unknown>;
  get: (key: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null>;
  delete: (keys: readonly string[]) => Promise<void>;
  createMultipartUpload: (key: string) => Promise<RawMultipart>;
}

/** Every value but `DB` is a binding the deploy sets, so a secret lives in the account and never in the config. Unset ones refuse the route that needs them. */
export interface Env {
  DB: PoolDb;
  /** The raw tier's R2 bucket. Unset refuses the raw routes. */
  RAW?: RawBucket;
  PSEUDONYM_KEY?: string;
  /** An Ed25519 private key as a JWK. */
  BUNDLE_SIGNING_KEY?: string;
  /** The pool-wide HMAC key for a hashed field (a host). Unset refuses every deposit, so a host is never stored in clear. */
  INGEST_HASH_KEY?: string;
  /** Unset keeps deposits closed. */
  COVENANT_VERSION?: string;
  /** How many bundles an account without access may fetch in one ISO week. */
  FETCH_CAP?: string;
  /** How many clusters a cell needs to be served and a read to count it. A whole number of at least 1; unset, or anything else, is 5. */
  PUBLIC_FLOOR?: string;
  /** How many clusters must hold a signature's hash before its text may be requested. A whole number of at least 1; unset, or anything else, is 2. */
  DISCLOSURE_FLOOR?: string;
  /** Public floors for single read families, `live=3,tool-day=8`. A name that is not a served read family refuses the whole list. */
  PUBLIC_FLOOR_FAMILIES?: string;
  /** An operator's brake on the rows one account may hold. Unset means no limit: the pool does not ration contribution. */
  MAX_DEPOSITS_PER_ACCOUNT?: string;
  /** An operator's brake on the stored bytes one account may hold. Unset means no limit. */
  MAX_DEPOSIT_BYTES_PER_ACCOUNT?: string;
}

/** The response headers this worker sets: the ETag of a bundle and the `Retry-After` of a spent cap. */
export interface AnswerHeaders {
  etag?: string;
  'retry-after'?: string;
}

export const answer = (status: number, body: object, headers: AnswerHeaders = {}): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const refuse = (status: number, error: string, message: string, field?: string, headers?: AnswerHeaders): Response => answer(status, { error, message, ...(field === undefined ? {} : { field }) }, headers);

/** A binding with a value; an empty one counts as unset, the way a blank secret should. */
export const bound = (value: string | undefined): string | undefined => (value === undefined || value === '' ? undefined : value);

export const notConfigured = (binding: string): Response => refuse(503, 'not_configured', `This pool has no ${binding} binding.`);

export const fieldOf = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined);

export const textField = (value: unknown, key: string): string | undefined => {
  const found = fieldOf(value, key);
  return typeof found === 'string' && found !== '' ? found : undefined;
};

/** A positive whole number from an optional binding; anything else there is the default, so a bad value cannot open a limit. */
export const wholeBinding = (value: string | undefined, fallback: number): number => {
  const whole = Number(bound(value) ?? fallback);
  return Number.isSafeInteger(whole) && whole > 0 ? whole : fallback;
};

/** A positive whole number from an optional brake, or undefined for no limit: unset, empty, and anything that is not a positive whole number all leave the account unlimited. */
export const brake = (value: string | undefined): number | undefined => {
  const whole = Number(bound(value));
  return bound(value) !== undefined && Number.isSafeInteger(whole) && whole > 0 ? whole : undefined;
};

/** A body as JSON, or undefined: the route then refuses by the field it needed. A provider's response comes here too, since an outage can answer HTML. */
export const bodyOf = async (message: Request | Response): Promise<unknown> => {
  try {
    return await message.json();
  } catch {
    return undefined;
  }
};
