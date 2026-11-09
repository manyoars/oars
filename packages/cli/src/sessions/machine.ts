// What makes a runtime a machine: a cloud VM, a VPS, or a self-hosted runner that builds its session's deposit batch at every Stop. The gate is one variable, `OARS_HOST_CLASS`, set to a class
// other than `local`; a laptop never sets it, so it keeps its own hooks and its end-of-session gate untouched. The rest of the enrollment block (launcher, machine id, allowed repositories,
// salts, exclusion terms) is read where it is used; this file holds the names, the gate, and the install-time parsing of the block.
import { dirname, join, resolve } from 'node:path';
import { CliError, ExitCode } from '../errors.js';
import { mkdirOwnerOnly, writeOwnerOnly } from './owner-only.js';

/** Where a session runs: `local` is every ordinary machine and the only class that is not a machine here. */
export const HOST_CLASSES = ['local', 'vps', 'cloud', 'ci', 'hosted'] as const;
export type HostClass = (typeof HOST_CLASSES)[number];
export type MachineClass = Exclude<HostClass, 'local'>;

/** Every variable of the enrollment block; an install writes these and refuses any other name, so a typo is never silently dropped. */
export const ENROLLMENT_NAMES = [
  'OARS_HOST_CLASS',
  'OARS_LAUNCHER',
  'OARS_MACHINE',
  'OARS_ALLOW_REPOS',
  'OARS_REPO_SALT',
  'OARS_SESSION_SALT',
  'OARS_EXCLUSION_TERMS',
  'OARS_EXCLUSION_TERMS_INLINE',
] as const;

export interface MachineConfig {
  hostClass: MachineClass;
  /** `OARS_LAUNCHER`, as the enrollment printed it; absent when unset. */
  launcher: string | undefined;
  /** `OARS_MACHINE`, the opaque id minted at enrollment; absent when unset. */
  machine: string | undefined;
  /** `OARS_ALLOW_REPOS` split on commas and whitespace, lowercased; empty means no repository is allowed. */
  allowRepos: string[];
}

const isMachineClass = (value: string | undefined): value is MachineClass => HOST_CLASSES.some((name) => name === value && name !== 'local');

const present = (value: string | undefined): string | undefined => (value === undefined || value.trim() === '' ? undefined : value.trim());

/** The machine configuration in `env`, or `undefined` for a local runtime (no `OARS_HOST_CLASS`, `local`, or a value that is not a class). A value that is not a class is not a machine: nothing is built. */
export const machineOf = (env: { [name: string]: string | undefined }): MachineConfig | undefined => {
  const hostClass = present(env.OARS_HOST_CLASS);
  if (!isMachineClass(hostClass)) return undefined;
  return {
    hostClass,
    launcher: present(env.OARS_LAUNCHER),
    machine: present(env.OARS_MACHINE),
    allowRepos: (env.OARS_ALLOW_REPOS ?? '')
      .split(/[\s,]+/u)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ''),
  };
};

const usage = (message: string): CliError => new CliError(message, ExitCode.USAGE, 'usage');

const isEnrollmentName = (name: string): name is (typeof ENROLLMENT_NAMES)[number] => ENROLLMENT_NAMES.some((known) => known === name);

/**
 * The `env` entries a user-scope machine install writes, from the `NAME=value` pairs of `--env`. `OARS_HOST_CLASS` is required and is the gate, so it must be a class other than `local`. With
 * `--terms-file`, the inline terms go to that file (owner-only) and `OARS_EXCLUSION_TERMS` names it, so the settings file holds no term. Nothing is written until every pair is valid.
 */
export const enrollmentOf = async (pairs: readonly string[], termsFile: string | undefined, cwd: string): Promise<{ env: { [name: string]: string }; termsPath: string | undefined }> => {
  const env: { [name: string]: string } = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    const name = at < 0 ? pair : pair.slice(0, at);
    if (at < 0 || !isEnrollmentName(name)) throw usage(`--env takes NAME=value with a name from the enrollment block (${ENROLLMENT_NAMES.join(', ')}); got ${at < 0 ? 'no "="' : name}. Nothing was written.`);
    env[name] = pair.slice(at + 1);
  }
  if (!isMachineClass(present(env.OARS_HOST_CLASS))) throw usage('--scope user --machine needs --env OARS_HOST_CLASS=<vps|cloud|ci|hosted>: that variable is the gate, and local is not a machine. Nothing was written.');
  const inline = env.OARS_EXCLUSION_TERMS_INLINE;
  if (inline !== undefined && env.OARS_EXCLUSION_TERMS !== undefined) throw usage('Give the exclusion terms once: OARS_EXCLUSION_TERMS_INLINE or OARS_EXCLUSION_TERMS, not both. Nothing was written.');
  if (termsFile === undefined) return { env, termsPath: undefined };
  if (inline === undefined) throw usage('--terms-file moves the terms of --env OARS_EXCLUSION_TERMS_INLINE into an owner-only file, and none was given. Nothing was written.');
  const termsPath = resolve(cwd, termsFile);
  await mkdirOwnerOnly(dirname(termsPath));
  await writeOwnerOnly(termsPath, inline.endsWith('\n') ? inline : `${inline}\n`);
  Reflect.deleteProperty(env, 'OARS_EXCLUSION_TERMS_INLINE');
  env.OARS_EXCLUSION_TERMS = termsPath;
  return { env, termsPath };
};

/** Where a machine's child keeps the terms it was given in `OARS_EXCLUSION_TERMS_INLINE`: in the store, owner-only. */
export const inlineTermsFile = (storeDir: string): string => join(storeDir, 'exclusion-terms-inline.txt');

/**
 * A machine whose enrollment put the exclusion terms in one variable (a cloud environment has no file to point at) gets them written, owner-only, into its store at every Stop, with `OARS_EXCLUSION_TERMS` pointed at that file, so the
 * file is always the variable's current value. The inline terms win over a file named by `OARS_EXCLUSION_TERMS`, because the enrollment is where the operator stated them. With no inline terms (unset or blank) `env` is returned as it is,
 * and a machine with no term file at all fails closed, as everywhere. The given `env` is not changed.
 */
export const withInlineTerms = async (env: NodeJS.ProcessEnv, storeDir: string): Promise<NodeJS.ProcessEnv> => {
  const inline = env.OARS_EXCLUSION_TERMS_INLINE;
  if (inline === undefined || inline.trim() === '') return env;
  const file = inlineTermsFile(storeDir);
  await mkdirOwnerOnly(storeDir);
  await writeOwnerOnly(file, inline.endsWith('\n') ? inline : `${inline}\n`);
  return { ...env, OARS_EXCLUSION_TERMS: file };
};
