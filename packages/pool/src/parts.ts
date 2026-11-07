// A deposit past the request cap arrives in parts, each under it, and the server keeps them as one deposit (t880). The parts wait in `deposit_parts`; the last to arrive completes the batch, and the join is stored by the same path as a deposit sent whole.
import { answer, bodyOf, fieldOf, refuse, textField, type Env } from './http.js';

/** What one stored row can hold: D1 caps a row at 2,000,000 bytes, and the stored skeleton shares the row with its other columns. A batch past this is refused whole, whatever its parts. */
export const MAX_ASSEMBLED_BYTES = 1_800_000;
/** How many parts one batch may have. The client sends parts of 512 KiB, so the join cap needs 4 at most; 8 leaves room for a smaller part size. */
const MAX_PARTS = 8;

const PART = /^([1-9][0-9]{0,2})\/([1-9][0-9]{0,2})$/;
const SHA256 = /^[0-9a-f]{64}$/;

const badPart = (message: string): Response => refuse(400, 'bad_part', message, 'oars-part');

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

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

/** One part of a batch, already read and under the request cap. `store` is the path a whole deposit takes. */
export const receivePart = async (request: Request, env: Env, account: string, body: string, store: (text: string) => Promise<Response>): Promise<Response> => {
  const found = PART.exec(request.headers.get('oars-part') ?? '');
  const batch = request.headers.get('oars-batch') ?? '';
  const part = Number(found?.[1]);
  const count = Number(found?.[2]);
  if (found === null || part > count || count > MAX_PARTS) return badPart(`oars-part is n/m with 1 <= n <= m <= ${String(MAX_PARTS)}.`);
  if (!SHA256.test(batch)) return badPart('oars-batch is the SHA-256 of the whole batch, in lowercase hexadecimal.');
  const before = await heldParts(env, account, batch);
  // A finished batch answers any retried part from its deposit, whatever the retry names.
  const finished = before.find((row) => row.deposit !== null);
  if (finished !== undefined) return answer(201, { ok: true, id: finished.deposit });
  // Parts naming two counts are never one batch. Nothing is written for this one, and what is held is dropped so the client's next full send starts clean.
  if (before.some((row) => row.count !== count)) {
    await forget(env, account, batch);
    return badPart('The parts of one batch all name the same count. Send every part again.');
  }
  // Staging is bounded by what the join may hold: a part that takes the held bytes past it is refused now, not when the last part arrives.
  const staged = before.filter((row) => row.part !== part).reduce((sum, row) => sum + new TextEncoder().encode(row.body).length, new TextEncoder().encode(body).length);
  if (staged > MAX_ASSEMBLED_BYTES) {
    await forget(env, account, batch);
    return refuse(413, 'too_large', `A deposit holds at most ${String(MAX_ASSEMBLED_BYTES)} bytes, in parts or whole.`);
  }
  // A retried part lands on its own row and changes nothing.
  await env.DB.prepare('INSERT INTO deposit_parts (account, batch, part, count, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT (account, batch, part) DO NOTHING').bind(account, batch, part, count, body).run();
  const held = await heldParts(env, account, batch);
  // Parts that arrive together each read a small `before`, so the bound that holds is on what is staged after the insert: past it, nothing of the batch stays.
  const bytes = new TextEncoder().encode(held.map((row) => row.body).join(''));
  if (bytes.length > MAX_ASSEMBLED_BYTES) {
    await forget(env, account, batch);
    return refuse(413, 'too_large', `A deposit holds at most ${String(MAX_ASSEMBLED_BYTES)} bytes, in parts or whole.`);
  }
  if (held.length < count) return answer(202, { ok: true, pending: count - held.length });
  const whole = held.map((row) => row.body).join('');
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== batch) {
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
