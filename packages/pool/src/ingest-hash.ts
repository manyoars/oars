// A host is hashed at ingest (class `hashed at ingest` in `field-classes.ts`): replaced by an HMAC-SHA-256 under the pool's one `INGEST_HASH_KEY` before anything is written.
// One key for the pool and not one per account, because the floor counts the same value across accounts.
import type { webcrypto } from 'node:crypto';
import { OTHER } from '../../cli/src/sessions/pool-wire.js';
import { LITERAL, PRIVATE } from '../../cli/src/sessions/public-vocabulary.js';
import { FIELD_CLASSES } from './field-classes.js';

/** The HMAC key a Worker secret becomes. */
export type HashKey = webcrypto.CryptoKey;

/** The keys that hold a host: the field, and the literal a client sends beside an `other` host. Derived from the class table, so a field made `hashed at ingest` there is hashed here. */
const HASHED_KEYS: ReadonlySet<string> = new Set(Object.entries(FIELD_CLASSES).filter(([, row]) => row.class === 'hashed at ingest').flatMap(([field]) => [field, `${field}Literal`]));

/** `h:` and 64 lowercase hex digits: the digest of the lowercased value, in the wire's name shape. A host compares without case, so `Example.com` and `example.com` are one value. */
const digestOf = async (key: HashKey, value: string): Promise<string> => {
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value.toLowerCase()));
  return `h:${[...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

/** The words the wire puts where there is no host: they name no host, so they stay as they are and never take a digest the floor would count as a host. */
const SENTINELS: ReadonlySet<unknown> = new Set([OTHER, PRIVATE, LITERAL]);

/** The text a hashed field's value is digested from: a string as it is, and anything else as its JSON, so no shape of the field escapes. */
const hashedText = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

/** Whether a field's value takes a digest: a hashed key that holds a value other than null or a sentinel. */
const takesDigest = (name: string, entry: unknown): boolean => HASHED_KEYS.has(name) && entry !== null && !SENTINELS.has(entry);

/** The texts under hashed keys, at any depth, added to `into`. A walk with no promise per node, so a body of millions of nodes holds one set of texts and not a promise for each node (t1583). */
const collect = (value: unknown, into: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const entry of value) collect(entry, into);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [name, entry] of Object.entries(value)) {
    if (takesDigest(name, entry)) into.add(hashedText(entry));
    else if (!HASHED_KEYS.has(name)) collect(entry, into);
  }
};

/** The value with every hashed key, at any depth, replaced by its digest from `digests`. */
const replaced = (value: unknown, digests: ReadonlyMap<string, string>): unknown => {
  if (Array.isArray(value)) return value.map((entry: unknown) => replaced(entry, digests));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([name, entry]): [string, unknown] => [name, takesDigest(name, entry) ? digests.get(hashedText(entry)) : HASHED_KEYS.has(name) ? entry : replaced(entry, digests)]));
};

/** The key a Worker secret holds, as text. An empty secret never reaches here: `bound` reads it as unset. */
export const hashKey = (secret: string): Promise<HashKey> => crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

/**
 * The body with every hashed key, at any depth, replaced by its digest. It runs on the body as it came, so the skeleton, the bag (an unknown field's value, a literal beside `other`), and everything derived from them are
 * parsed from the hashed form, and a clear host never reaches a write. The body was parsed once already, so a host that is not a name was refused before it got here.
 */
export const hashHosts = async (key: HashKey, body: unknown): Promise<unknown> => {
  // Each distinct text is digested once, one at a time: a session names few hosts however many calls it holds.
  const texts = new Set<string>();
  collect(body, texts);
  const digests = new Map<string, string>();
  for (const text of texts) digests.set(text, await digestOf(key, text));
  return replaced(body, digests);
};
