// `oars pool enroll`: the whole configuration a cloud VM needs to hold its deposit in its own private repository, printed as one env block. With `--hold-only` it uses no pool credential (the pool may not exist yet); without it,
// the pool is also asked for a one-time enrollment token after every check below, and the machine is recorded only after the pool answers.
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
import { isMissing, mkdirOwnerOnly, writeOwnerOnly } from './owner-only.js';
import { ask, poolServer, refusal, runtimeOf, signedIn } from './pool-command.js';
import { isObject, numberIn, textIn } from './pool-replica.js';
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
  /** The full enrollment's label for the machine, as the pool lists it. */
  name?: string | undefined;
  /** `--days` as typed: how long the key lives from its activation. */
  days?: string | undefined;
  server?: string | undefined;
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
  const earlier = await readFile(file, 'utf8').catch((error: unknown) => {
    if (isMissing(error)) return '';
    throw error;
  });
  const staged = `${file}.${String(process.pid)}`;
  await writeOwnerOnly(staged, `${earlier}${JSON.stringify(record)}\n`);
  await rename(staged, file);
};

const quoted = (value: string): string => `"${value.replace(/[\\"]/gu, '\\$&')}"`;

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

/** `--days` as the pool takes it, or left out for the pool's default. The wording is the pool's own. */
const daysOf = (given: string | undefined): number | undefined => {
  if (given === undefined) return undefined;
  const days = /^\d+$/u.test(given) ? Number(given) : Number.NaN;
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw usage('--days is a whole number of days from 1 to 365. Nothing was checked.');
  return days;
};

/** What the pool answered to an enrollment: the token, the time it lapses unactivated, and the machine's id there. */
interface Enrolled {
  token: string;
  tokenExpiresAt: number;
  poolId: string;
}

const enrolledOf = (body: unknown): Enrolled => {
  const machine: unknown = isObject(body) ? Reflect.get(body, 'machine') : undefined;
  const token = isObject(body) ? textIn(body, 'token') : undefined;
  const poolId = isObject(machine) ? textIn(machine, 'id') : undefined;
  const tokenExpiresAt = isObject(machine) ? numberIn(machine, 'expiresAt') : undefined;
  if (token === undefined || poolId === undefined || tokenExpiresAt === undefined) throw new CliError('The pool did not answer the enrollment with a token and a machine.', ExitCode.UNEXPECTED, STEP);
  return { token, tokenExpiresAt, poolId };
};

/**
 * Prints the env block for a machine that holds its deposit in its own private repository. Without `--hold-only` it also asks the pool for a one-time enrollment token after every check has passed, and records the
 * machine only after the pool has answered. Everything it refuses, it refuses before it asks GitHub anything: the flags, then the term list (a block with no terms
 * would exclude every session, so nothing would be held). A repository that is public, or whose record cannot be read, refuses the whole block, and the message names each such repository.
 */
export const poolEnroll = async (deps: RunDeps, options: EnrollOptions, visibility: Visibility): Promise<Outcome> => {
  const hostClass = classOf(options.hostClass);
  if (!options.holdOnly && hostClass === 'hosted') throw usage('The pool enrolls a vps, cloud, or ci machine; a hosted run uses a per-run token, so it does not enroll. Nothing was checked.');
  const launcher = launcherOf(options.launcher);
  const repos = reposOf(options.allowRepos);
  if (options.holdOnly && (options.days !== undefined || options.name !== undefined)) throw usage('--name and --days belong to the enrollment that asks the pool for a token; --hold-only sends nothing to the pool. Nothing was checked.');
  const days = options.holdOnly ? undefined : daysOf(options.days);
  if (!options.holdOnly && (options.name === undefined || options.name === '')) throw usage('--name takes the label the pool lists this machine by. Nothing was checked.');
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
  // The pool is asked only after every repository is confirmed private, and the machine is recorded only after the pool has answered: a refusal at either leaves nothing behind.
  const server = options.holdOnly ? '' : poolServer(deps.env, STEP, options.server);
  const credential = options.holdOnly ? undefined : await signedIn(deps, runtime.storeDir, server, STEP);
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
  const enrolled =
    credential === undefined
      ? undefined
      : await askToEnroll(deps, server, credential.token, { label: options.name ?? '', hostClass, launcher, allowRepos: repos, ...(days === undefined ? {} : { days }) });
  // Recorded after every check has passed (and the pool has answered, in a full enrollment) and before the block is printed: a block the operator can copy always names a machine the trusted side knows.
  await recordMachine(runtime.storeDir, { machine: env.OARS_MACHINE, hostClass, launcher, allowRepos: repos });
  const lines = Object.entries(env).map(([name, value]) => `${name}=${name === 'OARS_EXCLUSION_TERMS_INLINE' ? quoted(value) : value}`);
  const count = `${String(repos.length)} private ${repos.length === 1 ? 'repository' : 'repositories'}`;
  const block = ['', ...lines, '', 'A change to your term list needs this run again and the new block set in every environment.'];
  if (enrolled === undefined) {
    const text = [`Hold-only enrollment for ${count}. No pool credential was used or needed.`, 'Set these variables in the cloud environment. The block holds two salts and your exclusion terms, so treat it as a secret:', ...block].join('\n');
    return { document: { ok: true, holdOnly: true, hostClass, launcher, machine: env.OARS_MACHINE, allowRepos: repos, env }, text };
  }
  const text = [
    `Enrolled ${options.name ?? ''} with the pool for ${count}.`,
    `One-time enrollment token (shown once; it must be activated within 24 hours, by ${new Date(enrolled.tokenExpiresAt).toISOString()}, or it is useless):`,
    `  ${enrolled.token}`,
    `Hold it where the runtime keeps secrets: a network secret on the cloud environment (Bearer, host ${new URL(server).host}), or an owner-only file on a server. Never in a repository.`,
    'Set these variables in the cloud environment. The block holds two salts and your exclusion terms, so treat it as a secret:',
    ...block,
  ].join('\n');
  return { document: { ok: true, holdOnly: false, hostClass, launcher, machine: env.OARS_MACHINE, poolMachine: enrolled.poolId, token: enrolled.token, tokenExpiresAt: enrolled.tokenExpiresAt, allowRepos: repos, env }, text };
};

interface Declared {
  label: string;
  hostClass: string;
  launcher: string;
  allowRepos: readonly string[];
  days?: number;
}

/** `POST /v1/machines/enroll` with the account's credential. Any answer but the 201 is the pool's own refusal, and nothing is recorded. */
const askToEnroll = async (deps: RunDeps, server: string, token: string, declared: Declared): Promise<Enrolled> => {
  const reply = await ask(deps, STEP, server, '/v1/machines/enroll', { token, body: declared });
  if (reply.status !== 201) throw refusal(STEP, reply);
  return enrolledOf(reply.body);
};

const MACHINES = 'pool-machines';

/** One of the account's machines as `GET /v1/machines` lists it, kept to what a line prints. */
interface Listed {
  id: string;
  label: string;
  hostClass: string;
  launcher: string;
  state: string;
  lastDepositDay: string | null;
  expiresAt: number;
}

const listedOf = (row: unknown): Listed => {
  const [id, label, hostClass, launcher, state] = ['id', 'label', 'hostClass', 'launcher', 'state'].map((name) => (isObject(row) ? textIn(row, name) : undefined));
  const expiresAt = isObject(row) ? numberIn(row, 'expiresAt') : undefined;
  if (id === undefined || label === undefined || hostClass === undefined || launcher === undefined || state === undefined || expiresAt === undefined) {
    throw new CliError('The pool listed a machine this client cannot read.', ExitCode.UNEXPECTED, MACHINES);
  }
  return { id, label, hostClass, launcher, state, lastDepositDay: isObject(row) ? (textIn(row, 'lastDepositDay') ?? null) : null, expiresAt };
};

/** `oars pool machines`: the account's machines, one line each, with the id `machines revoke` takes. */
export const poolMachines = async (deps: RunDeps, options: { server?: string | undefined }): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  const server = poolServer(deps.env, MACHINES, options.server);
  const { token } = await signedIn(deps, storeDir, server, MACHINES);
  const reply = await ask(deps, MACHINES, server, '/v1/machines', { token });
  const rows: unknown = isObject(reply.body) ? Reflect.get(reply.body, 'machines') : undefined;
  if (reply.status !== 200 || !Array.isArray(rows)) throw refusal(MACHINES, reply);
  const machines = rows.map(listedOf);
  const lines = machines.map(
    (one) => `${one.label}  ${one.id}  ${one.hostClass}  ${one.launcher}  ${one.state}  last deposit ${one.lastDepositDay ?? 'never'}  expires ${new Date(one.expiresAt).toISOString().slice(0, 10)}`,
  );
  return { document: { ok: true, server, machines }, text: machines.length === 0 ? `No machines are enrolled with ${server}. oars pool enroll adds one.` : lines.join('\n') };
};

/** `oars pool machines revoke <id>`: effective on the machine's next request. The pool answers 404 for an id that is not this account's and for one already revoked. */
export const poolMachineRevoke = async (deps: RunDeps, id: string, options: { server?: string | undefined }): Promise<Outcome> => {
  const { storeDir } = runtimeOf(deps);
  const server = poolServer(deps.env, MACHINES, options.server);
  const { token } = await signedIn(deps, storeDir, server, MACHINES);
  const reply = await ask(deps, MACHINES, server, `/v1/machines/${encodeURIComponent(id)}`, { method: 'DELETE', token });
  if (reply.status === 404) throw new CliError(`No machine ${id} to revoke: it is not one of this account's machines, or it is already revoked. oars pool machines lists them.`, ExitCode.USAGE, MACHINES);
  if (reply.status !== 204) throw refusal(MACHINES, reply);
  return { document: { ok: true, server, revoked: id }, text: `Revoked machine ${id}. Its key is refused from its next request.` };
};
