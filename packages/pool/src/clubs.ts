// Boards (t1083; virality loop 2, P100 (19) to (21)): private clubs joined by a code. A club is a limited audience entered by the person's own act; it shares counts, never a session. Every route is account-only (a machine key is refused by the route table).
// Ranked by weeks rowing (consecutive ISO weeks with a counting deposit, ending this week or last), then active days, then nickname. Sessions and strokes are shown, never ranked, and no token or cost is held in `account_weeks` to show.
import { createHash } from 'node:crypto';
import { answer, bodyOf, fieldOf, refuse, textField, type Bound, type Env } from './http.js';
import { STANDING_AFTER_DAYS } from './access.js';
import { accountOf, restrictedRefusal } from './identity.js';
import { isoWeekOf } from './week.js';

/** A club holds at most this many members. */
const MEMBER_CAP = 50;
export const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** The brakes (migration 0037), per account: this many joins with a code no club holds in a rolling hour, and this many clubs made in a rolling day. */
export const GUESSES_PER_HOUR = 10;
const CREATES_PER_DAY = 5;
const WEEK_MS = 7 * DAY_MS;
/** The reserved club the public board lists: it has no code, and its members join it by the code word `OPEN`. */
const OPEN_CLUB = 'open';

/** What a person is shown before they join, and the hash the join records. A change to either text is a new hash, so the record says which text was agreed to. */
const CLUB_TEXT = 'Members of this club will see my nickname, my weeks rowing, my active days, my sessions, and my strokes this week. They will never see my sessions, projects, prompts, or tokens. If I hold a founding crew number, it shows beside my nickname. I can leave at any time and my row leaves view at once.';
const OPEN_TEXT = 'The open board is public: anyone on the internet can see my nickname with my weeks rowing, active days, sessions, and strokes this week, once my account has 90 days of standing (90 days after its first counting deposit). If I hold a founding crew number, it shows beside my nickname. I can leave at any time and my row leaves the board at once.';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const CLUB_SHA = sha256(CLUB_TEXT);
const OPEN_SHA = sha256(OPEN_TEXT);

/** Letters and digits without the look-alikes: 32 symbols, so five random bits choose one with no bias. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const codeOf = (): string => [...crypto.getRandomValues(new Uint8Array(6))].map((byte) => CODE_ALPHABET.charAt(byte & 31)).join('');
const hashOfCode = (code: string): string => sha256(`club-code:${code}`);
/** The hash an invite code is kept under: its own prefix, so a club code and an invite code never collide. */
export const hashOfInvite = (code: string): string => sha256(`invite-code:${code}`);

/** A nickname or club name: letters and digits first, then those or space, dot, underscore, and hyphen; 24 at most. */
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,23}$/u;

/** The rule, in the one line a refusal carries. */
const NICKNAME_RULE = 'A nickname is 2 to 24 letters, digits, spaces, dots, underscores, or hyphens, with no space at either end, no @, and no web address.';
/** Letters, digits, space, dot, underscore, hyphen; no space at either end. Non-spacing and spacing combining marks (vowel signs in Devanagari, Thai, Tamil, and others) may follow the first character; enclosing marks may not. Length is checked apart, in characters. */
const NICKNAME = /^[\p{L}\p{N}_.-](?:[\p{L}\p{N}\p{Mn}\p{Mc} _.-]*[\p{L}\p{N}\p{Mn}\p{Mc}_.-])?$/u;
/** A run of three marks is a stack that spills over its neighbors. */
const MARK_STACK = /\p{M}{3}/u;
/** A web address in a name: "www." or a dot before a common top-level domain. The character set already keeps out "@", ":", and "/". */
const WEB_ADDRESS = /www\.|\.(?:com|net|org|io|dev|app|co|me|ly|xyz|info|biz|gg|tv)(?![\p{L}\p{N}])/iu;

/** The NFKC form of a nickname that follows the rule, else undefined. NFKC first, so a full-width or look-alike form is judged and stored as the plain one. The mark stack is also judged before NFKC, which would fold a letter and its first accent into one character and hide a stack. */
const nicknameOf = (given: string | undefined): string | undefined => {
  if (given === undefined) return undefined;
  const nickname = given.normalize('NFKC');
  const length = Array.from(nickname).length;
  return length >= 2 && length <= 24 && NICKNAME.test(nickname) && !MARK_STACK.test(given) && !MARK_STACK.test(nickname) && !WEB_ADDRESS.test(nickname) ? nickname : undefined;
};

const signedIn = async (request: Request, env: Env): Promise<string | Response> => (await accountOf(request, env)) ?? refuse(401, 'unauthorized', 'Sign in with oars pool login first.');

type Kind = 'guess' | 'create';

/** The 429 `rate_limited` for an account that has `limit` attempts of this kind inside the window: `retry_after` (seconds, also the `retry-after` header) is when the limit-th newest one leaves it, which is when the next try is allowed. */
export const slowed = async (env: Env, account: string, kind: Kind, limit: number, window: number, now: number, said?: string): Promise<Response> => {
  const edge = await env.DB.prepare('SELECT at FROM club_attempts WHERE account = ? AND kind = ? AND at > ? ORDER BY at DESC LIMIT 1 OFFSET ?').bind(account, kind, now - window, limit - 1).first();
  // A reservation that was refused means the window was full; the row can only have left it since, so the wait floors at one second.
  const wait = edge === null ? 1 : Math.max(1, Math.ceil((Number(fieldOf(edge, 'at')) + window - now) / 1000));
  const message = said ?? (kind === 'guess' ? 'Too many joins with a code no club holds. Joining is paused for this account.' : `An account makes at most ${String(limit)} clubs a day.`);
  return answer(429, { error: 'rate_limited', message, retry_after: wait }, { 'retry-after': String(wait) });
};

/** The statements that drop this account's rows older than a day (no window is longer) and reserve one attempt, only while the window holds fewer than `limit`. The reservation is one conditional insert, so a burst cannot all pass a read that comes before any write; its `changes` is 1 when it holds, 0 when the window was full. */
export const reserve = (env: Env, account: string, kind: Kind, limit: number, window: number, now: number): Bound[] => [
  env.DB.prepare('DELETE FROM club_attempts WHERE account = ? AND at <= ?').bind(account, now - DAY_MS),
  env.DB.prepare('INSERT INTO club_attempts (account, kind, at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM club_attempts WHERE account = ? AND kind = ? AND at > ?) < ?').bind(account, kind, now, account, kind, now - window, limit),
];

const missing = (): Response => refuse(404, 'not_found', 'No such club, or you are not in it.');

/** `GET /v1/clubs/consent`: the texts a person is shown, with the hashes a join sends back. Public: it states what the pool will record. */
export const consentTexts = (): Response => answer(200, { club: { text: CLUB_TEXT, sha256: CLUB_SHA }, open: { text: OPEN_TEXT, sha256: OPEN_SHA } });

interface Entry {
  nickname: string;
  crew?: number;
  weeks: Set<string>;
  days: number;
  sessions: number;
  strokes: number;
}

const bits = (mask: number): number => {
  let set = 0;
  for (let rest = mask; rest > 0; rest >>= 1) set += rest & 1;
  return set;
};

/** The consecutive weeks ending this week, or last week when this one has none yet. */
const streakOf = (weeks: ReadonlySet<string>, now: number): number => {
  let ago = weeks.has(isoWeekOf(now)) ? 0 : 1;
  let run = 0;
  while (weeks.has(isoWeekOf(now - ago * WEEK_MS))) {
    run += 1;
    ago += 1;
  }
  return run;
};

/** The open board's standing rule: a hand grant, the latched `standing` flag, or a first counting deposit at least `STANDING_AFTER_DAYS` old (read directly, so a flag not yet latched does not hide an old account). The second bind is the cutoff. */
const STANDING_ONLY = ` AND (EXISTS (SELECT 1 FROM board_standing g WHERE g.account = m.account) OR (SELECT access FROM accounts a WHERE a.id = m.account) = 'standing' OR (SELECT MIN(counted_at) FROM deposits d WHERE d.account = m.account AND d.counted_at IS NOT NULL AND d.tier <> 'none') <= ?)`;

/** The crew number as a board row carries it: present only for a founding member, so nothing in a row says how many hold one. */
const crewOf = (entry: Entry): { crewNumber?: number } => (entry.crew === undefined ? {} : { crewNumber: entry.crew });

/** A club's members as the board shows them: counted members by weeks rowing, active days, then nickname; those with no counting deposit last, "ashore", with no numbers. A closed or restricted account is not listed (its rows stay stored; GDPR Art. 18(1)). */
const boardOf = async (env: Env, club: string, now: number, standingOnly = false): Promise<object[]> => {
  const { results } = await env.DB.prepare(
    `SELECT m.nickname AS nickname, (SELECT a.crew_number FROM accounts a WHERE a.id = m.account AND EXISTS (SELECT 1 FROM club_consents c WHERE c.account = m.account AND c.club = m.club AND c.text_sha256 = ?)) AS crew, w.week AS week, w.sessions AS sessions, w.tool_steps AS steps, w.day_mask AS mask FROM club_members m LEFT JOIN account_weeks w ON w.account = m.account AND w.sessions > 0 WHERE m.club = ? AND NOT EXISTS (SELECT 1 FROM accounts c WHERE c.id = m.account AND (c.closed_at IS NOT NULL OR c.restricted_at IS NOT NULL))${standingOnly ? STANDING_ONLY : ''}`,
  ).bind(...(standingOnly ? [club === OPEN_CLUB ? OPEN_SHA : CLUB_SHA, club, now - STANDING_AFTER_DAYS * DAY_MS] : [club === OPEN_CLUB ? OPEN_SHA : CLUB_SHA, club])).all();
  const entries = new Map<string, Entry>();
  const thisWeek = isoWeekOf(now);
  for (const row of results) {
    const nickname = String(fieldOf(row, 'nickname'));
    const entry = entries.get(nickname) ?? { nickname, weeks: new Set<string>(), days: 0, sessions: 0, strokes: 0 };
    const crew = fieldOf(row, 'crew');
    if (typeof crew === 'number') entry.crew = crew;
    const week = fieldOf(row, 'week');
    if (typeof week === 'string') {
      entry.weeks.add(week);
      entry.days += bits(Number(fieldOf(row, 'mask')));
      entry.sessions += Number(fieldOf(row, 'sessions'));
      if (week === thisWeek) entry.strokes += Number(fieldOf(row, 'steps'));
    }
    entries.set(nickname, entry);
  }
  const ranked = [...entries.values()].map((entry) => ({ entry, streak: streakOf(entry.weeks, now) }));
  ranked.sort((a, b) => Number(a.entry.weeks.size === 0) - Number(b.entry.weeks.size === 0) || b.streak - a.streak || b.entry.days - a.entry.days || (a.entry.nickname < b.entry.nickname ? -1 : 1));
  return ranked.map(({ entry, streak }, at) => (entry.weeks.size === 0 ? { place: at + 1, nickname: entry.nickname, ...crewOf(entry), ashore: true } : { place: at + 1, nickname: entry.nickname, ...crewOf(entry), ashore: false, weeksRowing: streak, activeDays: entry.days, sessions: entry.sessions, strokesThisWeek: entry.strokes }));
};

/** The nickname and consent a create or a join carries, or the refusal naming the field. */
const asked = (body: unknown, expected: string): { nickname: string } | Response => {
  const nickname = nicknameOf(textField(body, 'nickname'));
  if (nickname === undefined) return refuse(422, 'nickname_invalid', NICKNAME_RULE, 'nickname');
  if (textField(body, 'consent') !== expected) return refuse(422, 'consent_required', 'Send the SHA-256 of the consent text shown for this board (GET /v1/clubs/consent) to agree to it.', 'consent');
  return { nickname };
};

/** The statements that seat the account: the member row and the consent record, the row only while the club has room (the open board has none to keep: its cap is unlimited). */
const seating = (env: Env, club: string, account: string, nickname: string, now: number, text: string, cap: number): Bound[] => [
  env.DB.prepare('INSERT OR IGNORE INTO club_members (club, account, nickname, joined_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM clubs WHERE id = ?) AND (SELECT COUNT(*) FROM club_members WHERE club = ?) < ?').bind(club, account, nickname, now, club, club, cap),
  env.DB.prepare('INSERT INTO club_consents (account, club, text_sha256, accepted_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM club_members WHERE club = ? AND account = ? AND joined_at = ? AND nickname = ?)').bind(account, club, text, now, club, account, now, nickname),
];

/** The refusal for an account that already sits in the club, or a nickname another member holds; null when neither does. */
const refusalOf = async (env: Env, club: string, account: string, nickname: string): Promise<Response | null> => {
  if ((await env.DB.prepare('SELECT 1 AS held FROM club_members WHERE club = ? AND account = ?').bind(club, account).first()) !== null) return refuse(409, 'already_member', 'You are already in this club. Leave it first to change your nickname.');
  if ((await env.DB.prepare('SELECT 1 AS held FROM club_members WHERE club = ? AND nickname = ? COLLATE NOCASE').bind(club, nickname).first()) !== null) return refuse(409, 'nickname_taken', 'Another member of this club has that nickname.', 'nickname');
  return null;
};

/** The account that may take a seat: signed in and not restricted, because joining a board publishes its counts and that is processing beyond storage (GDPR Art. 18(1)). Leaving and reading stay open. */
const seatable = async (request: Request, env: Env): Promise<string | Response> => {
  const account = await signedIn(request, env);
  return account instanceof Response ? account : ((await restrictedRefusal(env, account)) ?? account);
};

/** `POST /v1/clubs`: a club named by its creator, who is its first member. The code comes back once; only its hash is kept. */
export const createClub = async (request: Request, env: Env): Promise<Response> => {
  const account = await seatable(request, env);
  if (account instanceof Response) return account;
  const body = await bodyOf(request);
  const name = textField(body, 'name')?.trim();
  if (name === undefined || !NAME.test(name)) return refuse(422, 'bad_name', 'A club name is 1 to 24 letters, digits, spaces, dots, underscores, or hyphens, starting with a letter or digit.', 'name');
  const given = asked(body, CLUB_SHA);
  if (given instanceof Response) return given;
  const id = crypto.randomUUID();
  const code = codeOf();
  const now = Date.now();
  // One transaction: the reservation first, then the club only if it held (`changes()` is the reservation's), then the creator's seat only if the club exists. A failure leaves no club with a code and nobody in it, and a burst past the limit makes no club.
  const [, reserved] = await env.DB.batch([...reserve(env, account, 'create', CREATES_PER_DAY, DAY_MS, now), env.DB.prepare('INSERT INTO clubs (id, name, code_hash, created_at) SELECT ?, ?, ?, ? WHERE changes() > 0').bind(id, name, hashOfCode(code), now), ...seating(env, id, account, given.nickname, now, CLUB_SHA, MEMBER_CAP)]);
  if ((reserved?.meta.changes ?? 0) === 0) return slowed(env, account, 'create', CREATES_PER_DAY, DAY_MS, now);
  return answer(201, { id, name, code });
};

/** `POST /v1/clubs/join`: the code, a nickname, and the hash of the consent text. The code word `OPEN` joins the open board, whose consent text is its own. */
export const joinClub = async (request: Request, env: Env): Promise<Response> => {
  const account = await seatable(request, env);
  if (account instanceof Response) return account;
  const body = await bodyOf(request);
  const code = textField(body, 'code')?.trim().toUpperCase() ?? '';
  const open = code === 'OPEN';
  const given = asked(body, open ? OPEN_SHA : CLUB_SHA);
  if (given instanceof Response) return given;
  // Reserve the guess before looking: the lookup cannot be raced past the limit. A code a club holds gives the reservation back.
  const now = Date.now();
  const [, reserved] = await env.DB.batch(reserve(env, account, 'guess', GUESSES_PER_HOUR, HOUR_MS, now));
  if ((reserved?.meta.changes ?? 0) === 0) return slowed(env, account, 'guess', GUESSES_PER_HOUR, HOUR_MS, now);
  const found = await env.DB.prepare(open ? 'SELECT id, name FROM clubs WHERE id = ?' : 'SELECT id, name FROM clubs WHERE code_hash = ?').bind(open ? OPEN_CLUB : hashOfCode(code)).first();
  if (found === null) return missing();
  await env.DB.prepare("DELETE FROM club_attempts WHERE id = (SELECT id FROM club_attempts WHERE account = ? AND kind = 'guess' AND at = ? LIMIT 1)").bind(account, now).run();
  const club = String(fieldOf(found, 'id'));
  const taken = await refusalOf(env, club, account, given.nickname);
  if (taken !== null) return taken;
  const [seated] = await env.DB.batch(seating(env, club, account, given.nickname, Date.now(), open ? OPEN_SHA : CLUB_SHA, open ? Number.MAX_SAFE_INTEGER : MEMBER_CAP));
  // Two joins can pass the checks together and meet at the unique indexes, where the insert is ignored: answer with what now holds the seat, and say the club is full only when it is.
  if ((seated?.meta.changes ?? 0) === 0) return (await refusalOf(env, club, account, given.nickname)) ?? refuse(409, 'club_full', `A club holds at most ${String(MEMBER_CAP)} members.`);
  return answer(200, { id: club, name: String(fieldOf(found, 'name')), nickname: given.nickname });
};

/** `GET /v1/board`: the open board, public. It lists a member only once the account stands (90 days past its first counting deposit) or holds a hand grant; everyone else who joined is not shown at all. */
export const viewBoard = async (env: Env): Promise<Response> => answer(200, { board: 'open', members: await boardOf(env, OPEN_CLUB, Date.now(), true) }, { 'cache-control': 'no-store' });

/** `GET /v1/clubs/:id`: the board, to its members only. A club the caller is not in answers as one that does not exist. */
export const viewClub = async (request: Request, env: Env, id: string): Promise<Response> => {
  const account = await signedIn(request, env);
  if (account instanceof Response) return account;
  const found = await env.DB.prepare("SELECT c.name AS name FROM clubs c JOIN club_members m ON m.club = c.id WHERE c.id = ? AND c.code_hash IS NOT NULL AND m.account = ?").bind(id, account).first();
  if (found === null) return missing();
  return answer(200, { id, name: String(fieldOf(found, 'name')), members: await boardOf(env, id, Date.now()) }, { 'cache-control': 'private, no-store' });
};

/** `DELETE /v1/clubs/:id/me`: leave. The row is gone from every view at once; the consent record stays. */
export const leaveClub = async (request: Request, env: Env, id: string): Promise<Response> => {
  const account = await signedIn(request, env);
  if (account instanceof Response) return account;
  const left = await env.DB.prepare('DELETE FROM club_members WHERE club = ? AND account = ?').bind(id, account).run();
  return left.meta.changes === 0 ? missing() : new Response(null, { status: 204 });
};
