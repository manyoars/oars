// Founding crew and vouch codes (t1229; supply move M2): `POST /v1/invites` makes a code, `POST /v1/invites/redeem` uses one, `GET /v1/me` states the account's crew number, founding mark, and vouches. All three are account-only: a machine key is refused 403 before they run.
// The crew number itself is written only by the operator's `scripts/grant-crew.ts`; no route writes it. A code is stored as a hash and shown once.
import { codeOf, GUESSES_PER_HOUR, hashOfInvite, HOUR_MS, reserve, slowed } from './clubs.js';
import { STANDING_AFTER_DAYS } from './access.js';
import { answer, bodyOf, fieldOf, refuse, textField, type Env } from './http.js';
import { accountOf, restrictedRefusal } from './identity.js';

/** Open codes (made, not yet used) one account may hold. */
export const OPEN_CODES = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const signedIn = async (request: Request, env: Env): Promise<string | Response> => (await accountOf(request, env)) ?? refuse(401, 'unauthorized', 'Sign in with oars pool login first.');

const count = (row: unknown, name: string): number => Number(fieldOf(row, name) ?? 0);

/** Whether the account may vouch: a crew number, a hand grant, the latched `standing` flag, or a first counting deposit at least `STANDING_AFTER_DAYS` old. */
const vouches = async (env: Env, account: string, now: number): Promise<boolean> =>
  (await env.DB.prepare(
    "SELECT 1 AS yes FROM accounts a WHERE a.id = ? AND (a.crew_number IS NOT NULL OR a.access = 'standing' OR EXISTS (SELECT 1 FROM board_standing g WHERE g.account = a.id) OR (SELECT MIN(counted_at) FROM deposits d WHERE d.account = a.id AND d.counted_at IS NOT NULL AND d.tier <> 'none') <= ?)",
  ).bind(account, now - STANDING_AFTER_DAYS * DAY_MS).first()) !== null;

/** `POST /v1/invites`: one new code for a founding or standing account, three open at most. The code comes back once. */
export const makeInvite = async (request: Request, env: Env): Promise<Response> => {
  const account = await signedIn(request, env);
  if (account instanceof Response) return account;
  const restricted = await restrictedRefusal(env, account);
  if (restricted !== undefined) return restricted;
  const now = Date.now();
  if (!(await vouches(env, account, now))) return refuse(403, 'not_vouching', 'Only a founding or standing account can vouch for others.');
  const code = codeOf();
  // One conditional insert, so a burst cannot pass a count read before any of its rows land.
  const made = await env.DB.prepare('INSERT INTO invites (code_hash, inviter, created_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM invites WHERE inviter = ? AND used_by IS NULL) < ?').bind(hashOfInvite(code), account, now, account, OPEN_CODES).run();
  if (made.meta.changes === 0) return refuse(409, 'invite_limit', `An account holds at most ${String(OPEN_CODES)} open invite codes. A used code frees its place.`);
  const open = count(await env.DB.prepare('SELECT COUNT(*) AS open FROM invites WHERE inviter = ? AND used_by IS NULL').bind(account).first(), 'open');
  return answer(201, { code, invitesLeft: Math.max(0, OPEN_CODES - open) }, { 'cache-control': 'private, no-store' });
};

/** The refusal for an invite that cannot be used by this account, or null when it can. */
const unusable = async (env: Env, id: number, account: string): Promise<Response | null> => {
  // The account's own edge comes first, so a run repeated after its redemption reads as joined already, not as a code someone else used.
  if ((await env.DB.prepare('SELECT 1 AS yes FROM vouch_edges WHERE invitee = ?').bind(account).first()) !== null) return refuse(409, 'already_vouched', 'This account joined on an invite already.');
  const held = await env.DB.prepare('SELECT used_by FROM invites WHERE id = ?').bind(id).first();
  if (fieldOf(held, 'used_by') !== null) return refuse(409, 'invite_used', 'That invite code has been used.');
  return null;
};

/** `POST /v1/invites/redeem`: the code the caller was given. It works once; an account joins on one invite at most; a self-invite is refused. A code nobody holds counts as a guess against the same hourly brake as a club code. */
export const redeemInvite = async (request: Request, env: Env): Promise<Response> => {
  const account = await signedIn(request, env);
  if (account instanceof Response) return account;
  const restricted = await restrictedRefusal(env, account);
  if (restricted !== undefined) return restricted;
  const code = textField(await bodyOf(request), 'code')?.trim().toUpperCase();
  if (code === undefined || code === '') return refuse(422, 'code_required', 'Send the invite code.', 'code');
  const now = Date.now();
  const [, reserved] = await env.DB.batch(reserve(env, account, 'guess', GUESSES_PER_HOUR, HOUR_MS, now));
  if ((reserved?.meta.changes ?? 0) === 0) return slowed(env, account, 'guess', GUESSES_PER_HOUR, HOUR_MS, now, 'Too many invite codes tried that no one holds. Redeeming is paused for this account.');
  const found = await env.DB.prepare('SELECT id, inviter FROM invites WHERE code_hash = ?').bind(hashOfInvite(code)).first();
  if (found === null) return refuse(404, 'not_found', 'No such invite code.', 'code');
  await env.DB.prepare("DELETE FROM club_attempts WHERE id = (SELECT id FROM club_attempts WHERE account = ? AND kind = 'guess' AND at = ? LIMIT 1)").bind(account, now).run();
  const [id, inviter] = [count(found, 'id'), String(fieldOf(found, 'inviter'))];
  if (inviter === account) return refuse(422, 'self_invite', 'You cannot use your own invite code.', 'code');
  const refused = await unusable(env, id, account);
  if (refused !== null) return refused;
  // The code and the edge are one transaction, and the update takes the code only while it is open and the account has no edge, so two redemptions cannot both win.
  const [taken] = await env.DB.batch([
    env.DB.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ? AND used_by IS NULL AND NOT EXISTS (SELECT 1 FROM vouch_edges WHERE invitee = ?)').bind(account, now, id, account),
    env.DB.prepare('INSERT INTO vouch_edges (inviter, invitee, at) SELECT ?, ?, ? WHERE changes() > 0').bind(inviter, account, now),
  ]);
  if ((taken?.meta.changes ?? 0) === 0) return (await unusable(env, id, account)) ?? refuse(409, 'invite_used', 'That invite code has been used.');
  return answer(200, { ok: true });
};

/** `GET /v1/me`: the crew number, the founding mark, and the vouches given. No count of crew members: only this account's own. */
export const viewMe = async (request: Request, env: Env): Promise<Response> => {
  const account = await signedIn(request, env);
  if (account instanceof Response) return account;
  const row = await env.DB.prepare('SELECT crew_number AS crew, (SELECT COUNT(*) FROM vouch_edges WHERE inviter = ?1) AS given, (SELECT COUNT(*) FROM invites WHERE inviter = ?1 AND used_by IS NULL) AS open FROM accounts WHERE id = ?1').bind(account).first();
  const crew = fieldOf(row, 'crew');
  const open = count(row, 'open');
  return answer(200, { account, crewNumber: typeof crew === 'number' ? crew : null, founding: typeof crew === 'number', vouchesGiven: count(row, 'given'), invitesOpen: open, invitesLeft: Math.max(0, OPEN_CODES - open) }, { 'cache-control': 'private, no-store' });
};
