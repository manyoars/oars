// Machine keys: each runtime an account runs (a cloud environment, a VPS, a CI runner) is a machine of that account with a key of its own, and the key can deposit and do nothing else. The account credential enrolls and revokes machines and never goes
// to one. A token is minted at enrollment, shown once, and stored only as a hash.
import { randomBytes, randomUUID } from 'node:crypto';
import type { HostClass } from '../../cli/src/sessions/machine.js';
import type { Env } from './http.js';
import { hashToken } from './identity.js';

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

/** A key or token as the person holds it: 32 random bytes, hex. */
const mint = (): string => randomBytes(32).toString('hex');

/** Writes a `pending` machine for the account and returns its id and the token, the only time the token exists in the clear. The row holds the token's hash. */
export const createMachine = async (env: Env, account: string, machine: NewMachine, now: number): Promise<{ id: string; token: string; expiresAt: number }> => {
  const id = randomUUID();
  const token = mint();
  const expiresAt = now + TOKEN_LIFE_MS;
  await env.DB.prepare('INSERT INTO machines (id, account, key_hash, label, host_class, launcher, allow_repos, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, account, hashToken(token), machine.label, machine.hostClass, machine.launcher, JSON.stringify(machine.allowRepos), 'pending', expiresAt, now)
    .run();
  return { id, token, expiresAt };
};
