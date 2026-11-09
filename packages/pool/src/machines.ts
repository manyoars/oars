// Machine keys: each runtime an account runs (a cloud environment, a VPS, a CI runner) is a machine of that account with a key of its own, and the key can deposit and do nothing else. The account credential enrolls and revokes machines and never goes
// to one. A token is minted at enrollment, shown once, and stored only as a hash.
import { randomBytes, randomUUID } from 'node:crypto';
import type { HostClass } from '../../cli/src/sessions/machine.js';
import { answer, bodyOf, fieldOf, refuse, textField, type Env } from './http.js';
import { accountOf, bearerOf, hashToken } from './identity.js';

/** How long an enrollment token waits to be used: long enough to paste it into an environment's secrets and start a session the next day, short enough that a token left in a shell or a note is dead by then. */
export const TOKEN_LIFE_MS = 24 * 60 * 60 * 1000;

/** How long an activated key lives. The account lists and revokes keys, and a key nobody renews ends by itself. */
export const KEY_LIFE_MS = 90 * 24 * 60 * 60 * 1000;

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
}

/** A key or token as the person holds it: 32 random bytes, hex. */
const mint = (): string => randomBytes(32).toString('hex');

/** Writes a `pending` machine for the account and returns it with the token, the only time the token exists in the clear. The row holds the token's hash. */
export const createMachine = async (env: Env, account: string, machine: NewMachine, now: number): Promise<{ machine: MachineView; token: string }> => {
  const id = randomUUID();
  const token = mint();
  const expiresAt = now + TOKEN_LIFE_MS;
  await env.DB.prepare('INSERT INTO machines (id, account, key_hash, label, host_class, launcher, allow_repos, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, account, hashToken(token), machine.label, machine.hostClass, machine.launcher, JSON.stringify(machine.allowRepos), 'pending', expiresAt, now)
    .run();
  return { machine: { id, ...machine, state: 'pending', expiresAt, createdAt: now }, token };
};

/** The one place a machine key's scope is decided: a key deposits and reads the covenant, activates and rotates itself, and does nothing else. `allowed` is the matched route's own word on it (`ROUTES` in `worker.ts`), so a route added without one is closed to a machine key. A bearer that is no machine's key is none of this check's business. */
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
  return { label, hostClass, launcher, allowRepos: [...new Set<string>(listed)] };
};

/** `POST /v1/machines/enroll`: the account credential declares a machine and gets its one-time token, which dies unused after `TOKEN_LIFE_MS`. */
export const enroll = async (request: Request, env: Env): Promise<Response> => {
  const account = await accountOf(request, env);
  if (account === undefined) return refuse(401, 'unauthorized', 'Sign in with oars pool login first.');
  const declared = declaredMachine(await bodyOf(request));
  if (declared instanceof Response) return declared;
  return answer(201, await createMachine(env, account, declared, Date.now()));
};
