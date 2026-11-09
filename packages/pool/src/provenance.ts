// What a ledger row says about where its deposit came from. The pool stamps it from the credential that sent the deposit, never from the batch: a machine cannot claim another class or launcher.
import type { HostClass } from '../../cli/src/sessions/machine.js';
import type { ActiveMachine, Launcher } from './machines.js';

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
