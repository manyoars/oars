// The machine child's pool credential, in one place. A cloud machine's secret is held by the runtime's proxy (a network secret on the pool's host, added outside the VM, so the VM never sees it), so the child sends no Authorization header. Any other class holds
// its own: the key an earlier run rotated to (`machine-key`, owner-only in the store), else the enrollment's token (`machine-token` in the store, or the file `OARS_MACHINE_TOKEN_FILE` names). The value is read when asked and never kept, logged, or put in a notice.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MachineClass } from './machine.js';

export interface MachineCredential {
  source: 'proxy' | 'key' | 'token';
  /** Absent for the proxy: the request carries no Authorization header. */
  token?: string;
}

export const keyFile = (storeDir: string): string => join(storeDir, 'machine-key');

export const tokenFile = (env: NodeJS.ProcessEnv, storeDir: string): string => {
  const named = env.OARS_MACHINE_TOKEN_FILE?.trim();
  return named === undefined || named === '' ? join(storeDir, 'machine-token') : named;
};

const valueOf = (file: string): Promise<string | undefined> => readFile(file, 'utf8').then((text) => (text.trim() === '' ? undefined : text.trim()), () => undefined);

/** The credential this machine presents, or `undefined` when it holds none (a hold-only machine, or one whose enrollment token was never put on it). */
export const credentialOf = async (hostClass: MachineClass, env: NodeJS.ProcessEnv, storeDir: string): Promise<MachineCredential | undefined> => {
  if (hostClass === 'cloud') return { source: 'proxy' };
  const key = await valueOf(keyFile(storeDir));
  if (key !== undefined) return { source: 'key', token: key };
  const token = await valueOf(tokenFile(env, storeDir));
  return token === undefined ? undefined : { source: 'token', token };
};
