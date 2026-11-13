// `oars club` and `oars board` (t1091): the commands over the pool's board routes (docs/pool.md, "Boards"). A club shares counts with the people who hold its code; the open board is public. Joining is a person at a terminal who reads the pool's consent text and types yes, the way the covenant is accepted: a flag or a script on stdin is not that person.
import { createHash } from 'node:crypto';
import type { Outcome, RunDeps } from './cli.js';
import { CliError, exitCodeForProblem, ExitCode } from './errors.js';
import { ask, isTerminal, lineFrom, poolServer, runtimeOf, type Reply } from './sessions/pool-command.js';
import { isObject, loadSignIns, numberIn, textIn } from './sessions/pool-replica.js';

const CREATE = 'club-create';
const JOIN = 'club-join';
const LEAVE = 'club-leave';
const SHOW = 'club-show';
const BOARD = 'board';

interface Options {
  server?: string | undefined;
}

/** The word that names the open board where a club's code goes. */
const OPEN_WORD = 'open';

/** A plain span of time: seconds under two minutes, minutes under two hours, else hours. */
const spanOf = (seconds: number): string => {
  if (seconds < 120) return `${String(Math.max(1, Math.ceil(seconds)))} seconds`;
  if (seconds < 7200) return `${String(Math.ceil(seconds / 60))} minutes`;
  return `${String(Math.ceil(seconds / 3600))} hours`;
};

const failure = (step: string, code: string, exit: ExitCode, message: string): CliError => new CliError(`${code}: ${message}`, exit, step, { title: `${code}: ${message}`, code });

/** The pool's named refusal with its code first (`club_full: ...`), and for a brake, when to try again. */
const refused = (step: string, { status, body }: Reply): CliError => {
  // A token the pool no longer knows (revoked, or expired there) while the local sign-in still looks valid: the same cause as no sign-in at all.
  if (status === 401) return failure(step, 'not_signed_in', ExitCode.AUTH, 'the pool did not accept your sign-in. Run oars pool login first.');
  const code = isObject(body) ? textIn(body, 'error') : undefined;
  const said = (isObject(body) ? textIn(body, 'message') : undefined) ?? `The pool answered HTTP ${String(status)}.`;
  const wait = isObject(body) ? numberIn(body, 'retry_after') : undefined;
  const title = `${code === undefined ? '' : `${code}: `}${said}${code === 'rate_limited' && wait !== undefined ? ` Try again in ${spanOf(wait)}.` : ''}`;
  const exit = status === 409 ? ExitCode.CONFLICT : status === 404 ? ExitCode.INVALID : exitCodeForProblem(status, code === undefined ? undefined : { code });
  return new CliError(title, exit, step, { title, status, ...(code === undefined ? {} : { code }) });
};

/** The pool and the credential held for it, or `not_signed_in` before anything is shown or asked. */
const credential = async (deps: RunDeps, step: string, options: Options): Promise<{ server: string; token: string }> => {
  const server = poolServer(deps.env, step, options.server);
  const found = (await loadSignIns(runtimeOf(deps).storeDir, step)).find((entry) => entry.server === server);
  if (found === undefined || found.expiresAt <= deps.now()) throw failure(step, 'not_signed_in', ExitCode.AUTH, `you are not signed in to ${server}. Run oars pool login first.`);
  return { server, token: found.token };
};

/** The text a person is shown before joining, read from the pool, and the hash of exactly those bytes. */
const textOf = async (deps: RunDeps, server: string, which: 'club' | 'open', step: string): Promise<{ text: string; sha256: string }> => {
  const reply = await ask(deps, step, server, '/v1/clubs/consent', {});
  const entry: unknown = isObject(reply.body) ? Reflect.get(reply.body, which) : undefined;
  const text = isObject(entry) ? textIn(entry, 'text') : undefined;
  if (reply.status !== 200 || text === undefined) throw reply.status === 200 ? new CliError('The pool did not state the consent text for this board.', ExitCode.UNEXPECTED, step) : refused(step, reply);
  return { text, sha256: createHash('sha256').update(text).digest('hex') };
};

/** Shows the consent text and reads yes from a person at a terminal. Nothing is sent without it. */
const agreed = async (deps: RunDeps, step: string, text: string): Promise<void> => {
  if (!isTerminal(deps)) throw failure(step, 'consent_not_given', ExitCode.AUTH, 'agreeing takes a person at a terminal who reads the text and types yes: run this command from one. Nothing was sent.');
  deps.io.stderr(`\n${text}\n\nType yes to agree, anything else to stop.\n> `);
  const typed = await lineFrom(runtimeOf(deps).stdin);
  if (typed?.trim().toLowerCase() !== 'yes') throw failure(step, 'consent_not_given', ExitCode.AUTH, `${typed === undefined ? 'No answer was typed' : 'That was not yes'}. Nothing was sent.`);
};

const stringIn = (body: unknown, key: string): string => (isObject(body) ? (textIn(body, key) ?? '') : '');

/** `oars club create <name> --nickname <n>`: a new club with the caller as its first member. The code comes back once. */
export const clubCreate = async (deps: RunDeps, name: string, options: Options & { nickname: string }): Promise<Outcome> => {
  const { server, token } = await credential(deps, CREATE, options);
  const consent = await textOf(deps, server, 'club', CREATE);
  await agreed(deps, CREATE, consent.text);
  const reply = await ask(deps, CREATE, server, '/v1/clubs', { token, body: { name, nickname: options.nickname, consent: consent.sha256 } });
  if (reply.status !== 201) throw refused(CREATE, reply);
  const [id, code] = [stringIn(reply.body, 'id'), stringIn(reply.body, 'code')];
  return {
    document: { ok: true, id, name, nickname: options.nickname, code },
    text: [`Club "${name}" created. You are ${options.nickname}.`, `Code: ${code}`, 'This is the only time the code is shown. Share it only with the people you want in the club: anyone who holds it can join.', `See the board with: oars club show ${id}`].join('\n'),
  };
};

/** `oars club join <code> --nickname <n>`; the word `open` joins the open board under its own text. */
export const clubJoin = async (deps: RunDeps, code: string, options: Options & { nickname: string }): Promise<Outcome> => {
  const { server, token } = await credential(deps, JOIN, options);
  const open = code.trim().toLowerCase() === OPEN_WORD;
  const consent = await textOf(deps, server, open ? 'open' : 'club', JOIN);
  await agreed(deps, JOIN, consent.text);
  const reply = await ask(deps, JOIN, server, '/v1/clubs/join', { token, body: { code, nickname: options.nickname, consent: consent.sha256 } });
  if (reply.status !== 200) throw refused(JOIN, reply);
  const [id, name] = [stringIn(reply.body, 'id'), stringIn(reply.body, 'name')];
  return {
    document: { ok: true, id, name, nickname: options.nickname },
    text: [`Joined "${name}" as ${options.nickname}.`, ...(open ? ['Your row shows on the open board once your account has 90 days of standing.'] : []), `Leave any time with: oars club leave ${id}`].join('\n'),
  };
};

/** `oars club leave <club>`: the row leaves every view at once. */
export const clubLeave = async (deps: RunDeps, club: string, options: Options): Promise<Outcome> => {
  const { server, token } = await credential(deps, LEAVE, options);
  const reply = await ask(deps, LEAVE, server, `/v1/clubs/${encodeURIComponent(club)}/me`, { token, method: 'DELETE' });
  if (reply.status !== 204) throw refused(LEAVE, reply);
  return { document: { ok: true, id: club, left: true }, text: 'You left the club. Your row is gone from its board.' };
};

interface Row {
  place: number;
  nickname: string;
  ashore: boolean;
  weeksRowing: number;
  activeDays: number;
  sessions: number;
  strokesThisWeek: number;
}

const rowsOf = (body: unknown): Row[] => {
  const members: unknown = isObject(body) ? Reflect.get(body, 'members') : undefined;
  const rows: Row[] = [];
  for (const member of Array.isArray(members) ? members : []) {
    if (!isObject(member)) continue;
    rows.push({ place: numberIn(member, 'place') ?? rows.length + 1, nickname: textIn(member, 'nickname') ?? '', ashore: Reflect.get(member, 'ashore') === true, weeksRowing: numberIn(member, 'weeksRowing') ?? 0, activeDays: numberIn(member, 'activeDays') ?? 0, sessions: numberIn(member, 'sessions') ?? 0, strokesThisWeek: numberIn(member, 'strokesThisWeek') ?? 0 });
  }
  return rows;
};

/** What the club shows a member with no counting week, and where to go from it. */
export const ASHORE_CLUB_LINE = 'ashore: run oars pool join to start rowing.';

/** The board as lines, in the pool's order: a member with no counting week is "ashore" and has no numbers. */
const tableOf = (rows: readonly Row[]): string => {
  const head = ['#', 'nickname', 'weeks rowing', 'active days', 'sessions', 'strokes this week'];
  const body = rows.map((row) => [String(row.place), row.nickname, ...(row.ashore ? ['ashore', '', '', ''] : [String(row.weeksRowing), String(row.activeDays), String(row.sessions), String(row.strokesThisWeek)])]);
  const widths = head.map((title, at) => Math.max(title.length, ...body.map((line) => (line[at] ?? '').length)));
  const table = [head, ...body].map((line) => line.map((cell, at) => cell.padEnd(widths[at] ?? 0)).join('  ').trimEnd()).join('\n');
  return rows.some((row) => row.ashore) ? `${table}\n${ASHORE_CLUB_LINE}` : table;
};

/** `oars club show <club>`: the board, to its members only. */
export const clubShow = async (deps: RunDeps, club: string, options: Options): Promise<Outcome> => {
  const { server, token } = await credential(deps, SHOW, options);
  const reply = await ask(deps, SHOW, server, `/v1/clubs/${encodeURIComponent(club)}`, { token });
  if (reply.status !== 200 || !isObject(reply.body)) throw refused(SHOW, reply);
  const rows = rowsOf(reply.body);
  return { document: { ok: true, ...reply.body }, text: `${stringIn(reply.body, 'name')}\n${tableOf(rows)}` };
};

/** `oars board`: the open board. It is public, so it needs no sign-in. */
export const board = async (deps: RunDeps, options: Options): Promise<Outcome> => {
  const server = poolServer(deps.env, BOARD, options.server);
  const reply = await ask(deps, BOARD, server, '/v1/board', {});
  if (reply.status !== 200 || !isObject(reply.body)) throw refused(BOARD, reply);
  const rows = rowsOf(reply.body);
  return { document: { ok: true, ...reply.body }, text: rows.length === 0 ? 'No one is on the open board yet.' : `Open board\n${tableOf(rows)}` };
};
