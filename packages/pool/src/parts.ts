// A deposit past the request cap arrives in parts, each under it, and the server keeps them as one deposit (t880). The parts wait in `deposit_parts`; the last to arrive completes the batch, and the join is stored by the same path as a deposit sent whole.
import type { HashKey } from './ingest-hash.js';
import { answer, bodyOf, fieldOf, refuse, textField, type Env } from './http.js';

/** What one stored row can hold: D1 caps a row at 2,000,000 bytes, and the stored skeleton shares the row with its other columns. A batch past this is refused whole, whatever its parts. */
export const MAX_ASSEMBLED_BYTES = 1_800_000;
/** How many parts one batch may have. The client sends parts of 512 KiB, so the join cap needs 4 at most; 8 leaves room for a smaller part size. */
const MAX_PARTS = 8;

/**
 * How many unfinished batches one account may stage at once. The CLI sends a batch's parts in order under a send lock, so one machine has one batch unfinished at a time and a batch is at most 4 parts (the join cap over 512 KiB parts); 16 leaves
 * room for the same account on several machines, each with an interrupted batch. At the cap an account stages at most 16 x 1,800,000 bytes, about 29 MB, of sealed text.
 */
export const MAX_STAGED_BATCHES = 16;
/** An unfinished batch older than this is swept. A client that comes back later sends every part again, which starts a batch clean, so a sweep costs a retry and no data. */
export const STAGED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PART = /^([1-9][0-9]{0,2})\/([1-9][0-9]{0,2})$/;
const SHA256 = /^[0-9a-f]{64}$/;

const badPart = (message: string): Response => refuse(400, 'bad_part', message, 'oars-part');

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** AES-GCM takes a 96-bit IV and appends a 128-bit tag; a sealed part is the base64 of the IV, then the ciphertext and tag. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** In chunks, because a spread of a 512 KiB part into one call overflows the stack. */
const toBase64 = (bytes: Uint8Array): string => {
  const chunks: string[] = [];
  for (let at = 0; at < bytes.length; at += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(at, at + 0x8000)));
  return btoa(chunks.join(''));
};
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** The key a part is sealed under: HKDF-SHA-256 over the pool's host-hash secret, bound to the account and the batch, so a part of one batch opens for no other. No new secret: a pool that can hash hosts can seal parts. */
const sealKey = async (secret: string, account: string, batch: string): Promise<HashKey> => {
  const source = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']);
  const info = new TextEncoder().encode(`oars-pool-parts:${account}:${batch}`);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('oars-pool-parts-v1'), info }, source, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};

/** A part's text, sealed with a fresh IV: what `deposit_parts.body` holds, so a host in a staged part is not readable from the table (t907). */
const seal = async (key: HashKey, text: string): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text)));
  const joined = new Uint8Array(IV_BYTES + sealed.length);
  joined.set(iv);
  joined.set(sealed, IV_BYTES);
  return toBase64(joined);
};

/** A sealed part's text, or null when it does not open: a wrong key, a changed byte, or text that was never sealed. */
const open = async (key: HashKey, sealed: string): Promise<string | null> => {
  try {
    const bytes = fromBase64(sealed);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES) }, key, bytes.slice(IV_BYTES)));
  } catch {
    return null;
  }
};

/** The bytes of the text a sealed part holds, read off its length without opening it, so the staging bound needs no decryption. */
const plainBytes = (sealed: string): number => Math.max(0, Math.floor(((sealed.length - (sealed.endsWith('==') ? 2 : sealed.endsWith('=') ? 1 : 0)) * 3) / 4) - IV_BYTES - TAG_BYTES);

interface Held {
  part: number;
  count: number;
  body: string;
  deposit: string | null;
}

const heldParts = async (env: Env, account: string, batch: string): Promise<Held[]> => {
  const { results } = await env.DB.prepare('SELECT part, count, body, deposit FROM deposit_parts WHERE account = ? AND batch = ? ORDER BY part').bind(account, batch).all();
  return results.map((row) => ({ part: Number(fieldOf(row, 'part')), count: Number(fieldOf(row, 'count')), body: textField(row, 'body') ?? '', deposit: textField(row, 'deposit') ?? null }));
};

const forget = (env: Env, account: string, batch: string): Promise<unknown> => env.DB.prepare('DELETE FROM deposit_parts WHERE account = ? AND batch = ?').bind(account, batch).run();

/** An account's unfinished batches older than `STAGED_MAX_AGE_MS`, a batch's age being its oldest part's. A finished batch's marker (`deposit` set, no body) is never swept, because a retried part is answered from it. It runs on the account's own staging write, so no cron is needed and each account pays only for its own rows. */
const sweep = (env: Env, account: string, now: number): Promise<unknown> =>
  env.DB.prepare('DELETE FROM deposit_parts WHERE account = ? AND deposit IS NULL AND batch IN (SELECT batch FROM deposit_parts WHERE account = ? AND deposit IS NULL GROUP BY batch HAVING MIN(COALESCE(staged_at, 0)) < ?)')
    .bind(account, account, now - STAGED_MAX_AGE_MS)
    .run();

/** How many unfinished batches the account holds other than this one. */
const otherUnfinished = async (env: Env, account: string, batch: string): Promise<number> =>
  Number(fieldOf(await env.DB.prepare('SELECT COUNT(DISTINCT batch) AS held FROM deposit_parts WHERE account = ? AND deposit IS NULL AND batch <> ?').bind(account, batch).first(), 'held'));

/** One part of a batch, already read and under the request cap. `secret` is the pool's `INGEST_HASH_KEY`, which seals the staged text. `store` is the path a whole deposit takes. */
export const receivePart = async (request: Request, env: Env, account: string, secret: string, body: string, store: (text: string) => Promise<Response>): Promise<Response> => {
  const found = PART.exec(request.headers.get('oars-part') ?? '');
  const batch = request.headers.get('oars-batch') ?? '';
  const part = Number(found?.[1]);
  const count = Number(found?.[2]);
  if (found === null || part > count || count > MAX_PARTS) return badPart(`oars-part is n/m with 1 <= n <= m <= ${String(MAX_PARTS)}.`);
  if (!SHA256.test(batch)) return badPart('oars-batch is the SHA-256 of the whole batch, in lowercase hexadecimal.');
  await sweep(env, account, Date.now());
  const before = await heldParts(env, account, batch);
  // A finished batch answers any retried part from its deposit, whatever the retry names.
  const finished = before.find((row) => row.deposit !== null);
  if (finished !== undefined) return answer(201, { ok: true, id: finished.deposit });
  // Parts naming two counts are never one batch. Nothing is written for this one, and what is held is dropped so the client's next full send starts clean.
  if (before.some((row) => row.count !== count)) {
    await forget(env, account, batch);
    return badPart('The parts of one batch all name the same count. Send every part again.');
  }
  // A batch not yet begun needs room: an account holds at most `MAX_STAGED_BATCHES` unfinished ones, so staging is bounded per account and not only per batch. A part of a batch already held always passes.
  if (before.length === 0 && (await otherUnfinished(env, account, batch)) >= MAX_STAGED_BATCHES) {
    return refuse(429, 'staging_full', `An account may hold ${String(MAX_STAGED_BATCHES)} unfinished batches at once. Finish them, or wait: an unfinished batch is dropped after 24 hours.`, 'oars-batch', { 'retry-after': String(STAGED_MAX_AGE_MS / 1000) });
  }
  // Staging is bounded by what the join may hold: a part that takes the held bytes past it is refused now, not when the last part arrives.
  const staged = before.filter((row) => row.part !== part).reduce((sum, row) => sum + plainBytes(row.body), new TextEncoder().encode(body).length);
  if (staged > MAX_ASSEMBLED_BYTES) {
    await forget(env, account, batch);
    return refuse(413, 'too_large', `A deposit holds at most ${String(MAX_ASSEMBLED_BYTES)} bytes, in parts or whole.`);
  }
  // A retried part lands on its own row and changes nothing. The text is sealed first: no host is written in clear, staged or not.
  const key = await sealKey(secret, account, batch);
  await env.DB.prepare('INSERT INTO deposit_parts (account, batch, part, count, body, staged_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (account, batch, part) DO NOTHING').bind(account, batch, part, count, await seal(key, body), Date.now()).run();
  const held = await heldParts(env, account, batch);
  // Parts that arrive together each read a small `before`, so the bound that holds is on what is staged after the insert: past it, nothing of the batch stays.
  if (held.reduce((sum, row) => sum + plainBytes(row.body), 0) > MAX_ASSEMBLED_BYTES) {
    await forget(env, account, batch);
    return refuse(413, 'too_large', `A deposit holds at most ${String(MAX_ASSEMBLED_BYTES)} bytes, in parts or whole.`);
  }
  if (held.length < count) return answer(202, { ok: true, pending: count - held.length });
  // The join opens every part; one that does not open (a changed byte, another key) is a batch that is not the one named.
  const opened = await Promise.all(held.map((row) => open(key, row.body)));
  const whole = opened.every((text) => text !== null) ? opened.join('') : null;
  const bytes = new TextEncoder().encode(whole ?? '');
  if (whole === null || hex(await crypto.subtle.digest('SHA-256', bytes)) !== batch) {
    await forget(env, account, batch);
    return refuse(400, 'part_mismatch', 'The parts do not join to the batch that oars-batch names. Send every part again.', 'oars-batch');
  }
  const stored = await store(whole);
  if (stored.status === 201) {
    const id = textField(await bodyOf(stored.clone()), 'id') ?? '';
    await env.DB.prepare("UPDATE deposit_parts SET body = '', deposit = ? WHERE account = ? AND batch = ?").bind(id, account, batch).run();
  } else if (stored.status === 400 || stored.status === 422) {
    // The batch itself is refused (size was refused above, before the join, so there is no 413 here): sending its parts again would change nothing, so they are not kept. A conflict or a brake can pass later, so those keep them.
    await forget(env, account, batch);
  }
  return stored;
};
