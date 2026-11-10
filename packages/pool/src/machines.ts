// Machine keys: each runtime an account runs (a cloud environment, a VPS, a CI runner) is a machine of that account with a key of its own, and the key can deposit and do nothing else. The account credential enrolls and revokes machines and never goes
// to one. A token is minted at enrollment, shown once, and stored only as a hash.
import { randomBytes, randomUUID } from 'node:crypto';
import type { HostClass } from '../../cli/src/sessions/machine.js';
import { answer, bodyOf, fieldOf, refuse, textField, type Env } from './http.js';
import { accountOf, bearerOf, hashToken } from './identity.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long an enrollment token waits to be used: long enough to paste it into an environment's secrets and start a session the next day, short enough that a token left in a shell or a note is dead by then. */
export const TOKEN_LIFE_MS = 24 * 60 * 60 * 1000;

/** How long an activated key lives when enrollment asks for no other. The account lists and revokes keys, and a key nobody renews ends by itself. */
export const KEY_LIFE_MS = 90 * DAY_MS;

/** The most days an enrollment may ask a key to live: a key nobody renews still ends within a year. */
export const MAX_KEY_DAYS = 365;

/** The host classes a machine key is enrolled for. `local` is a person at the machine (the account credential), and `hosted` runs on a per-run token the launcher mints. */
export const ENROLLED_HOST_CLASSES = ['vps', 'cloud', 'ci'] as const satisfies readonly HostClass[];

/** Who starts the sessions a machine runs. */
export const LAUNCHERS = ['interactive', 'orchestrated', 'scheduled'] as const;

export type EnrolledHostClass = (typeof ENROLLED_HOST_CLASSES)[number];
export type Launcher = (typeof LAUNCHERS)[number];

/** What an account declares about a machine when it enrolls it. */
export interface NewMachine {
  label: string;
  hostClass: EnrolledHostClass;
  launcher: Launcher;
  /** Repositories as `owner/name`; empty names none. */
  allowRepos: readonly string[];
  /** How many days the key lives from its activation, 1 to `MAX_KEY_DAYS`; left out, it lives `KEY_LIFE_MS`. Kept for activation and never shown. */
  days?: number;
}

/** What the account sees of a machine: never a hash, and never the token or key. `state` is `expired` once the credential held has run out, whichever it is. */
export interface MachineView {
  id: string;
  label: string;
  hostClass: EnrolledHostClass;
  launcher: Launcher;
  allowRepos: readonly string[];
  state: 'pending' | 'active' | 'expired';
  /** When the credential held now ends: the token's life while `pending`, the key's once `active`. */
  expiresAt: number;
  createdAt: number;
  /** The `YYYY-MM-DD` day of the machine's last stored deposit, or null before a first one. */
  lastDepositDay: string | null;
}

/** A key or token as the person holds it: 32 random bytes, hex. */
const mint = (): string => randomBytes(32).toString('hex');

/** Writes a `pending` machine for the account and returns it with the token, the only time the token exists in the clear. The row holds the token's hash. */
export const createMachine = async (env: Env, account: string, declared: NewMachine, now: number): Promise<{ machine: MachineView; token: string }> => {
  const { days, ...machine } = declared;
  const id = randomUUID();
  const token = mint();
  const expiresAt = now + TOKEN_LIFE_MS;
  await env.DB.prepare('INSERT INTO machines (id, account, key_hash, label, host_class, launcher, allow_repos, state, expires_at, created_at, key_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, account, hashToken(token), machine.label, machine.hostClass, machine.launcher, JSON.stringify(machine.allowRepos), 'pending', expiresAt, now, days ?? null)
    .run();
  return { machine: { id, ...machine, state: 'pending', expiresAt, createdAt: now, lastDepositDay: null }, token };
};

/** The one place a machine key's scope is decided: a key deposits, reads the covenant, posts telemetry, and activates and rotates itself, and does nothing else. `allowed` is the matched route's own word on it (`ROUTES` in `worker.ts`), so a route added without one is closed to a machine key. A bearer that is no machine's key is none of this check's business. */
export const machineScope = async (request: Request, env: Env, allowed: boolean): Promise<Response | undefined> => {
  const token = bearerOf(request);
  if (allowed || token === undefined) return undefined;
  const held = await env.DB.prepare('SELECT 1 AS held FROM machines WHERE key_hash = ?').bind(hashToken(token)).first();
  return held === null ? undefined : refuse(403, 'deposit_only', 'A machine key deposits and does nothing else. Use the account credential (oars pool login) for this route.');
};

/** The most repositories one machine's allow list names. */
const MAX_ALLOWED_REPOS = 100;

/** A label the account reads back in its list: letters, digits, spaces, dots, underscores, and hyphens, 64 at most, starting with a letter or digit. */
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** `owner/name` as GitHub spells them: an owner of letters, digits, and hyphens (39 at most), a name of letters, digits, dots, underscores, and hyphens (100 at most) that is not `.` or `..`. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

/** One of a closed list, or the refusal naming the field. */
const oneOf = <T extends string>(body: unknown, field: string, names: readonly T[]): T | Response => {
  const said = textField(body, field);
  if (said === undefined) return refuse(400, 'missing_field', `An enrollment names its ${field}.`, field);
  return names.find((name) => name === said) ?? refuse(422, 'closed_vocabulary', `${field} is one of ${names.join(', ')}.`, field);
};

/** `days`, left out for the default: a whole number of days from 1 to `MAX_KEY_DAYS`, or the refusal naming the field. */
const declaredDays = (body: unknown): number | undefined | Response => {
  const sent = fieldOf(body, 'days');
  if (sent === undefined) return undefined;
  return typeof sent === 'number' && Number.isSafeInteger(sent) && sent >= 1 && sent <= MAX_KEY_DAYS ? sent : refuse(422, 'invalid_field', `days is a whole number of days from 1 to ${String(MAX_KEY_DAYS)}.`, 'days');
};

/** The machine an enrollment body declares, or the refusal for its first bad field. */
const declaredMachine = (body: unknown): NewMachine | Response => {
  const hostClass = oneOf(body, 'hostClass', ENROLLED_HOST_CLASSES);
  if (hostClass instanceof Response) return hostClass;
  const launcher = oneOf(body, 'launcher', LAUNCHERS);
  if (launcher instanceof Response) return launcher;
  const label = textField(body, 'label');
  if (label === undefined) return refuse(400, 'missing_field', 'An enrollment names its label.', 'label');
  if (!LABEL.test(label)) return refuse(422, 'invalid_field', 'label is letters, digits, spaces, dots, underscores, and hyphens, 64 at most, starting with a letter or digit.', 'label');
  const listed = fieldOf(body, 'allowRepos') ?? [];
  if (!Array.isArray(listed) || listed.length > MAX_ALLOWED_REPOS || !listed.every((entry): entry is string => typeof entry === 'string' && REPOSITORY.test(entry))) {
    return refuse(422, 'invalid_field', `allowRepos is a list of at most ${String(MAX_ALLOWED_REPOS)} repositories, each owner/name.`, 'allowRepos');
  }
  const days = declaredDays(body);
  if (days instanceof Response) return days;
  return { label, hostClass, launcher, allowRepos: [...new Set<string>(listed)], ...(days === undefined ? {} : { days }) };
};

/** `POST /v1/machines/enroll`: the account credential declares a machine and gets its one-time token, which dies unused after `TOKEN_LIFE_MS`. The key it activates into lives `days` days from activation, or `KEY_LIFE_MS`. */
export const enroll = async (request: Request, env: Env): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  const declared = declaredMachine(await bodyOf(request));
  if (declared instanceof Response) return declared;
  return answer(201, await createMachine(env, account, declared, Date.now()));
};

/** A value the table holds from a closed list. Every write came through that list, so a value off it is a corrupt row, and the route fails rather than answer it. */
const closed = <T extends string>(names: readonly T[], column: string, value: string | undefined): T => {
  const found = names.find((name) => name === value);
  if (found === undefined) throw new Error(`machines.${column} holds ${String(value)}, which is on no list`);
  return found;
};

/** A repository list as the table keeps it: a JSON array of text. */
const reposOf = (stored: string | undefined): string[] => {
  const parsed: unknown = JSON.parse(stored ?? '[]');
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
};

/** A row of a machine that is not revoked, as the account sees it: `expired` once the credential held has run out. */
const viewOf = (row: unknown, now: number): MachineView => {
  const expiresAt = Number(fieldOf(row, 'expires_at'));
  return {
    id: textField(row, 'id') ?? '',
    label: textField(row, 'label') ?? '',
    hostClass: closed(ENROLLED_HOST_CLASSES, 'host_class', textField(row, 'host_class')),
    launcher: closed(LAUNCHERS, 'launcher', textField(row, 'launcher')),
    allowRepos: reposOf(textField(row, 'allow_repos')),
    state: expiresAt <= now ? 'expired' : closed(['pending', 'active'] as const, 'state', textField(row, 'state')),
    expiresAt,
    createdAt: Number(fieldOf(row, 'created_at')),
    lastDepositDay: textField(row, 'last_deposit_day') ?? null,
  };
};

/** How long the key of a machine lives from its activation: the days enrollment asked for, or the default. */
const lifeOf = (row: unknown): number => {
  const days = fieldOf(row, 'key_days');
  return typeof days === 'number' ? days * DAY_MS : KEY_LIFE_MS;
};

/** A live machine as its presented key finds it: what the account sees, the account it belongs to (which the view never names), the hash the key is held as now, whether a rotation has happened, and how long its key lives. */
interface Held {
  view: MachineView;
  account: string;
  keyHash: string;
  rotated: boolean;
  /** How long the key lives from its activation: the days enrollment asked for, or `KEY_LIFE_MS`. */
  lifeMs: number;
}

/** The machine a key is the key of, or the refusal for it; undefined when no machine has it. A token a rotation replaced, a token or key past its life, and a revoked machine are each refused by name, so a client can tell a dead credential from one that never was. */
const heldByKey = async (env: Env, key: string, now: number): Promise<Held | Response | undefined> => {
  const hash = hashToken(key);
  const row = await env.DB.prepare('SELECT * FROM machines WHERE key_hash = ? OR retired_hash = ?').bind(hash, hash).first();
  if (row === null) return undefined;
  if (textField(row, 'retired_hash') === hash) return refuse(401, 'token_retired', 'A rotation replaced this token. Use the key it returned.');
  const state = textField(row, 'state');
  if (state === 'revoked') return refuse(401, 'machine_revoked', 'The account revoked this machine.');
  const expiresAt = Number(fieldOf(row, 'expires_at'));
  if (expiresAt <= now) {
    return state === 'pending' ? refuse(401, 'token_expired', 'This enrollment token went unused past its life. Enroll the machine again.') : refuse(401, 'machine_expired', 'This machine key has expired. Enroll the machine again.');
  }
  return { view: viewOf(row, now), account: textField(row, 'account') ?? '', keyHash: hash, rotated: fieldOf(row, 'rotated_at') !== null, lifeMs: lifeOf(row) };
};

/** The machine a request's bearer is the key of, or the refusal for it. */
const heldBy = async (request: Request, env: Env, now: number): Promise<Held | Response> => {
  const key = bearerOf(request);
  if (key === undefined) return refuse(401, 'unauthorized', 'Present the machine key as a bearer credential.');
  return (await heldByKey(env, key, now)) ?? refuse(401, 'unauthorized', 'No machine has this key.');
};

/** A live machine as a deposit stamps it. */
export interface ActiveMachine {
  id: string;
  hostClass: EnrolledHostClass;
  launcher: Launcher;
  /** When the key ends, in milliseconds since the epoch. */
  expiresAt: number;
}

/** Who a request is: an account, and when the credential is a machine's key, the machine it is the key of. The key acts for its machine's account. */
export interface Caller {
  account: string;
  machine?: ActiveMachine;
}

/**
 * The caller of a route that takes either credential: the account's own, or the key of an active machine. Undefined when the bearer is neither (none, or one no account and no machine holds), so the route's own refusal stands. A key that is not live is refused by name, as `heldBy` refuses it, and so is a token not yet activated.
 */
export const callerOf = async (request: Request, env: Env, now: number): Promise<Caller | Response | undefined> => {
  const account = await accountOf(request, env);
  if (account !== undefined) return { account };
  const key = bearerOf(request);
  const held = key === undefined ? undefined : await heldByKey(env, key, now);
  if (held === undefined || held instanceof Response) return held;
  if (held.view.state !== 'active') return refuse(409, 'not_activated', 'Activate the token with POST /v1/machines/activate before using it.');
  const { id, hostClass, launcher, expiresAt } = held.view;
  return { account: held.account, machine: { id, hostClass, launcher, expiresAt } };
};

/** What activation answers: the machine, and whether the caller should now trade the key for a fresh one. Only a runtime that can keep the result (any class but `cloud`) is told to, and only until it has. */
const activated = (held: Held): Response => answer(200, { machine: held.view, rotate: held.view.hostClass !== 'cloud' && !held.rotated });

/** `POST /v1/machines/activate`: the first use of a token binds it as the machine's key for the life enrollment asked for, and any later use of a live key answers the same way. */
export const activate = async (request: Request, env: Env): Promise<Response> => {
  const now = Date.now();
  const first = await heldBy(request, env, now);
  if (first instanceof Response) return first;
  if (first.view.state === 'active') return activated(first);
  // `AND state = 'pending'` lets the first of two uses at once bind the key; the other changes nothing and reads the same row.
  await env.DB.prepare("UPDATE machines SET state = 'active', activated_at = ?, expires_at = ? WHERE id = ? AND state = 'pending'").bind(now, now + first.lifeMs, first.view.id).run();
  const bound = await heldBy(request, env, now);
  return bound instanceof Response ? bound : activated(bound);
};

/** `POST /v1/machines/rotate`: an active key of a durable runtime is traded for a fresh one that never sat in a secret store. The old hash is kept as retired so the spent token is refused by name, and the key's expiry does not move. */
export const rotate = async (request: Request, env: Env): Promise<Response> => {
  const now = Date.now();
  const held = await heldBy(request, env, now);
  if (held instanceof Response) return held;
  if (held.view.state !== 'active') return refuse(409, 'not_activated', 'Activate the token before rotating it.');
  if (held.view.hostClass === 'cloud') return refuse(409, 'not_rotatable', 'A cloud runtime keeps its token as its key: it has nowhere to keep a rotated one.');
  const key = mint();
  // `AND key_hash = ?` makes the first of two rotations at once win: the other finds its token already replaced.
  const replaced = await env.DB.prepare('UPDATE machines SET key_hash = ?, retired_hash = ?, rotated_at = ? WHERE id = ? AND key_hash = ?').bind(hashToken(key), held.keyHash, now, held.view.id, held.keyHash).run();
  if (replaced.meta.changes === 0) return refuse(401, 'token_retired', 'A rotation replaced this token. Use the key it returned.');
  return answer(200, { machine: held.view, key });
};

/** `GET /v1/machines`: the account's machines, newest first, as the account sees them. Revoked ones are gone from the list. */
export const list = async (request: Request, env: Env): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  const { results } = await env.DB.prepare("SELECT * FROM machines WHERE account = ? AND state <> 'revoked' ORDER BY created_at DESC, id").bind(account).all();
  const now = Date.now();
  return answer(200, { machines: results.map((row) => viewOf(row, now)) });
};

/** `DELETE /v1/machines/:id`: revokes one of the account's machines, effective on the machine's next request. The row stays, so the key is refused as revoked and not as unknown. Another account's machine and one already revoked look the same: no such machine. */
export const revoke = async (request: Request, env: Env, id: string): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  const revoked = await env.DB.prepare("UPDATE machines SET state = 'revoked' WHERE id = ? AND account = ? AND state <> 'revoked'").bind(id, account).run();
  return revoked.meta.changes === 1 ? new Response(null, { status: 204 }) : refuse(404, 'not_found', 'None of this account\'s machines has this id.');
};
