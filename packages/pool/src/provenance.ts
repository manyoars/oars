// What a ledger row says about where its deposit came from. The pool stamps it from the credential that sent the deposit, never from the batch: a machine cannot claim another class or launcher.
import type { HostClass } from '../../cli/src/sessions/machine.js';
import { fieldOf, refuse } from './http.js';
import type { ActiveMachine, Launcher } from './machines.js';

/** The host classes a ledger row can hold, the client's own list: `local` for the account credential, the three a machine is enrolled for, and `hosted` for a run the launcher mints a token for. */
export const LEDGER_HOST_CLASSES = ['local', 'vps', 'cloud', 'ci', 'hosted'] as const satisfies readonly HostClass[];

/** The launchers a ledger row can hold: the three a machine is enrolled with, the CI runner's own, a hosted run's, and `unknown` for what the pool cannot tell. */
export const LEDGER_LAUNCHERS = ['interactive', 'orchestrated', 'scheduled', 'ci', 'hosted-run', 'unknown'] as const satisfies readonly (Launcher | 'ci' | 'hosted-run' | 'unknown')[];

export type LedgerLauncher = (typeof LEDGER_LAUNCHERS)[number];

/** The stamp of a deposit: the machine whose key sent it (null for the account's own credential), and that machine's class and launcher. */
export interface Stamp {
  machine: string | null;
  hostClass: HostClass;
  launcher: LedgerLauncher;
}

/** The account credential is a person at a machine they sit at: class `local`, no machine, and no way to tell who started the session. */
const ACCOUNT_STAMP: Stamp = { machine: null, hostClass: 'local', launcher: 'unknown' };

/** The stamp the credential of a deposit gives it: the machine's own, or the account credential's. */
export const stampOf = (machine: ActiveMachine | undefined): Stamp => (machine === undefined ? ACCOUNT_STAMP : { machine: machine.id, hostClass: machine.hostClass, launcher: machine.launcher });

/** What a batch states about the run it came from, when it is sent later than it ran. The pool keeps it beside its stamp and reads it for the one thing it is for, the account's own baseline units. */
export interface Claim {
  hostClass: HostClass;
  launcher: LedgerLauncher;
}

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const unclaimed = (field: string, reason: string): Response => refuse(422, 'closed_vocabulary', `${field}: ${reason}`, field);

/** One of a claim's two closed values, or the refusal naming its field. */
const named = <T extends string>(claim: object, key: 'hostClass' | 'launcher', names: readonly T[]): T | Response => {
  const sent = fieldOf(claim, key);
  if (sent === undefined) return unclaimed(`claimed.${key}`, 'missing');
  return names.find((name) => name === sent) ?? unclaimed(`claimed.${key}`, `not one of ${names.join(', ')}`);
};

/**
 * The batch's `claimed`, set apart from the rest of the body. `claimed` is the one field the pool reads for itself instead of parsing it as part of the skeleton, so it is taken out first: it is neither kept in the bag of fields the reader does not know nor judged as a stranger there.
 * Closed: exactly `hostClass` and `launcher`, each on its list. Null counts as absent, as it does for every optional field of a batch. A machine's key claims nothing, because its batch is stamped from the key: only a batch held or pulled and sent under the account credential carries a claim.
 */
export const takeClaim = (body: unknown, machine: ActiveMachine | undefined): { claim: Claim | undefined; rest: unknown } | Response => {
  if (typeof body !== 'object' || body === null || !Object.hasOwn(body, 'claimed')) return { claim: undefined, rest: body };
  const sent: unknown = Reflect.get(body, 'claimed');
  const rest = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'claimed'));
  if (sent === null) return { claim: undefined, rest };
  if (machine !== undefined) return unclaimed('claimed', "a machine key's batch is stamped from the key and claims nothing; only a batch held or pulled and sent under the account credential does");
  if (typeof sent !== 'object' || Array.isArray(sent)) return unclaimed('claimed', 'not an object');
  const stranger = Object.keys(sent).find((key) => key !== 'hostClass' && key !== 'launcher');
  if (stranger !== undefined) return unclaimed(FIELD_NAME.test(stranger) ? `claimed.${stranger}` : 'claimed', 'not a field of a claim');
  const hostClass = named(sent, 'hostClass', LEDGER_HOST_CLASSES);
  if (hostClass instanceof Response) return hostClass;
  const launcher = named(sent, 'launcher', LEDGER_LAUNCHERS);
  return launcher instanceof Response ? launcher : { claim: { hostClass, launcher }, rest };
};
