// `oars pool enroll --hold-only`: the whole configuration a cloud VM needs to hold its deposit in its own private repository, printed as one env block, with no pool credential (the pool may not exist yet).
// The trusted machine mints the machine id, derives the two salts from its own (so a local capture and a VM's key one repository the same way), reads its term file, and refuses any repository that is not
// private: a hold branch is exactly as readable as the repository it sits in.
import { randomBytes } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Outcome, RunDeps } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { exclusionPaths, loadTerms } from './exclusion.js';
import { derivedSalt } from './machine-ids.js';
import { HOST_CLASSES } from './machine.js';
import { mkdirOwnerOnly, writeOwnerOnly } from './owner-only.js';
import { runtimeOf } from './pool-command.js';
import { localSalt } from './store.js';

const STEP = 'pool-enroll';

/** How a session starts on the machine; the pool records it with the machine (cloud self-deposit, enrollment). */
export const LAUNCHERS = ['interactive', 'orchestrated', 'scheduled'] as const;

/** What a repository's record says about it. `unknown` is any answer that does not say, and is refused like `public`. */
export type Visibility = (repo: string) => Promise<'private' | 'public' | 'unknown'>;

export interface EnrollOptions {
  holdOnly: boolean;
  hostClass: string | undefined;
  launcher: string | undefined;
  /** `owner/name` entries, each possibly several joined by commas or spaces. */
  allowRepos: readonly string[];
}

const usage = (message: string): CliError => new CliError(message, ExitCode.USAGE, STEP);

const REPO_NAME = /^[\w.-]+\/[\w.-]+$/u;

/** The check against GitHub's own repository record, `private` true or false. A repository the token cannot see answers 404, which says nothing, so it is `unknown`, as is every error and every record with no flag. */
export const githubVisibility = (get: typeof fetch, token: string | undefined): Visibility => async (repo) => {
  try {
    const headers: { [name: string]: string } = { accept: 'application/vnd.github+json', 'user-agent': 'oars' };
    if (token !== undefined && token !== '') headers.authorization = `Bearer ${token}`;
    const reply = await get(`https://api.github.com/repos/${repo}`, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!reply.ok) return 'unknown';
    const record: unknown = await reply.json();
    const flag: unknown = typeof record === 'object' && record !== null ? Reflect.get(record, 'private') : undefined;
    if (flag === true) return 'private';
    return flag === false ? 'public' : 'unknown';
  } catch {
    return 'unknown';
  }
};

/** The trusted machine's record of the machines it enrolled, one JSON line each. Admission of a hold branch (cloud self-deposit, B2b) reads it as the source of `claimed` and refuses a machine id it does not hold. */
export const machinesFile = (storeDir: string): string => join(storeDir, 'machines.jsonl');

/** What an enrollment records about its machine. */
export interface MachineRecord {
  machine: string;
  hostClass: string;
  launcher: string;
  allowRepos: readonly string[];
}

/** Appends `record` as one line. The new file is staged beside the old one, owner-only, and renamed onto its name, so a reader sees the old list or the new one, and a crash leaves the old one. */
const recordMachine = async (storeDir: string, record: MachineRecord): Promise<void> => {
  const file = machinesFile(storeDir);
  const earlier = await readFile(file, 'utf8').catch(() => '');
  const staged = `${file}.${String(process.pid)}`;
  await writeOwnerOnly(staged, `${earlier}${JSON.stringify(record)}\n`);
  await rename(staged, file);
};

const quoted =(value: string): string => `"${value.replace(/[\\"]/gu, '\\$&')}"`;

const classOf = (given: string | undefined): (typeof HOST_CLASSES)[number] => {
  const found = HOST_CLASSES.find((name) => name === given && name !== 'local');
  if (found === undefined) throw usage(`--host-class takes one of ${HOST_CLASSES.filter((name) => name !== 'local').join(', ')}; got ${given ?? 'nothing'}. Nothing was checked.`);
  return found;
};

const launcherOf = (given: string | undefined): (typeof LAUNCHERS)[number] => {
  const found = LAUNCHERS.find((name) => name === given);
  if (found === undefined) throw usage(`--launcher takes one of ${LAUNCHERS.join(', ')}; got ${given ?? 'nothing'}. Nothing was checked.`);
  return found;
};

const reposOf = (given: readonly string[]): string[] => {
  const repos = [...new Set(given.flatMap((entry) => entry.split(/[\s,]+/u)).filter((entry) => entry !== '').map((entry) => entry.toLowerCase()))];
  if (repos.length === 0) throw usage('--allow-repos takes the repositories this machine may hold, as owner/name. Nothing was checked.');
  const bad = repos.find((repo) => !REPO_NAME.test(repo) || repo.split('/').some((part) => /^\.+$/u.test(part)));
  if (bad !== undefined) throw usage(`--allow-repos takes owner/name; got ${bad}. Nothing was checked.`);
  return repos;
};

/**
 * Prints the env block for a machine that holds its deposit in its own private repository. Everything it refuses, it refuses before it asks GitHub anything: the flags, then the term list (a block with no terms
 * would exclude every session, so nothing would be held). A repository that is public, or whose record cannot be read, refuses the whole block, and the message names each such repository.
 */
export const poolEnroll = async (deps: RunDeps, options: EnrollOptions, visibility: Visibility): Promise<Outcome> => {
  if (!options.holdOnly) throw usage('oars pool enroll takes --hold-only for now: the enrollment that also mints a pool key is not available yet. Nothing was checked.');
  const hostClass = classOf(options.hostClass);
  const launcher = launcherOf(options.launcher);
  const repos = reposOf(options.allowRepos);
  const runtime = runtimeOf(deps);
  const termsFile = exclusionPaths(runtime.projectsRoot, deps.env).terms;
  const terms = [...new Set(await loadTerms(termsFile))];
  if (terms.length === 0) throw usage(`No exclusion terms in ${termsFile}: a block without them would exclude every session, and nothing would be held. Nothing was checked.`);
  const refused: string[] = [];
  for (const repo of repos) {
    const seen = await visibility(repo);
    if (seen === 'public') refused.push(`  ${repo} is public: a hold branch there is readable by anyone.`);
    else if (seen === 'unknown') refused.push(`  ${repo}: could not confirm it is private (the check needs a GH_TOKEN or GITHUB_TOKEN that can read it, and the repository's current name).`);
  }
  if (refused.length > 0) throw usage(`Refusing to enroll: every repository must be private.\n${refused.join('\n')}`);
  await mkdirOwnerOnly(runtime.storeDir);
  const localKey = (await (runtime.accountSalt ?? localSalt)(runtime.storeDir)).salt;
  const env = {
    OARS_HOST_CLASS: hostClass,
    OARS_LAUNCHER: launcher,
    OARS_MACHINE: randomBytes(8).toString('hex'),
    OARS_ALLOW_REPOS: repos.join(','),
    OARS_REPO_SALT: derivedSalt(localKey, 'repoKey/1'),
    OARS_SESSION_SALT: derivedSalt(localKey, 'sessionId/1'),
    OARS_EXCLUSION_TERMS_INLINE: terms.join('\n'),
  };
  // Recorded after every check has passed and before the block is printed: a block the operator can copy always names a machine the trusted side knows.
  await recordMachine(runtime.storeDir, { machine: env.OARS_MACHINE, hostClass, launcher, allowRepos: repos });
  const lines = Object.entries(env).map(([name, value]) => `${name}=${name === 'OARS_EXCLUSION_TERMS_INLINE' ? quoted(value) : value}`);
  const text = [
    `Hold-only enrollment for ${String(repos.length)} private ${repos.length === 1 ? 'repository' : 'repositories'}. No pool credential was used or needed.`,
    'Set these variables in the cloud environment. The block holds two salts and your exclusion terms, so treat it as a secret:',
    '',
    ...lines,
    '',
    'A change to your term list needs this run again and the new block set in every environment.',
  ].join('\n');
  return { document: { ok: true, holdOnly: true, hostClass, launcher, machine: env.OARS_MACHINE, allowRepos: repos, env }, text };
};
