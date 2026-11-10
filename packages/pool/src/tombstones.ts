// What an erasure leaves behind (migration 0018) and the check ingest makes against it. The Worker writes only `raw-object` tombstones (the nightly withdrawal sweep, `raw.ts`), never `account`, and the tombstones are append-only (0018); every other kind comes from the operator's own command (`scripts/erase.ts`), so no route can erase anything else. The operator's `telemetry-batch` kind (`scripts/erase-batches.ts`) holds the SHA-256 of an old telemetry batch's R2 key and the erasure date, and no size.
// The digests live here so the Worker and the command cannot drift apart.
import { fieldOf, refuse, type Env } from './http.js';

/** What a tombstone stands for. */
export type TombstoneKind = 'raw-object' | 'deposit' | 'value';

/** SHA-256 of a text, lowercase hex. */
export const digestOf = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** The tombstone digest of a raw object: its R2 key (`raw/<account>/<sha256>`). */
export const rawDigest = (key: string): Promise<string> => digestOf(key);

/** The tombstone digest of a stored session: the account's id for it. */
export const depositDigest = (account: string, id: string): Promise<string> => digestOf(`${account}/${id}`);

/** The refusal for content that was erased. It names no row and no reason, so a refusal confirms nothing to a caller who did not already send the content. */
export const erasedRefusal = (): Response => refuse(403, 'erased', 'This content was erased from the pool and cannot be deposited again.');

/** Whether a tombstone of this kind and digest stands. */
export const isErased = async (env: Env, kind: TombstoneKind, digest: string): Promise<boolean> =>
  fieldOf(await env.DB.prepare('SELECT 1 AS held FROM erasure_tombstones WHERE kind = ? AND digest = ?').bind(kind, digest).first(), 'held') === 1;

/** Every string a JSON value holds, keys left out: a leaked value is a value. */
const stringsOf = (value: unknown, into: Set<string>): Set<string> => {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, into);
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) stringsOf(item, into);
  return into;
};

/** Whether any string in a deposit body is a value an erasure tombstoned. The tombstones are read once and the body is hashed only when there are some, so a pool that never erased pays one small read. */
export const holdsErasedValue = async (env: Env, body: unknown): Promise<boolean> => {
  const held = await env.DB.prepare("SELECT digest FROM erasure_tombstones WHERE kind = 'value'").bind().all();
  const digests = new Set(held.results.map((row) => fieldOf(row, 'digest')));
  if (digests.size === 0) return false;
  for (const text of stringsOf(body, new Set<string>())) if (digests.has(await digestOf(text))) return true;
  return false;
};
