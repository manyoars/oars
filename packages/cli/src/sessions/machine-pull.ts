// `oars pool hold pull`: admission of the batches a cloud VM held on `oars-hold/<machine>/<id>` branches of its own private repository (the VM side is `machine-hold.ts`). The trusted machine does it, and treats every branch as input
// from outside: anything able to push a branch can write one, the session's own agent included. A branch that fails any gate is reported with its reason, writes nothing to the outbox, and stays where it is; branches are never deleted here.
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Outcome, RunDeps } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { exclusionPaths, loadTerms } from './exclusion.js';
import { termsDigest } from './machine-hold.js';
import { readMachines, type MachineRecord, type Visibility } from './machine-enroll.js';
import { derivedSalt } from './machine-ids.js';
import { isMissing, writeOwnerOnly } from './owner-only.js';
import { poolServer, runtimeOf } from './pool-command.js';
import { BATCH_FIELDS, STAMP_FOLDER, currentStamp, fieldsOf, outboxFolder, removeBatchOf, writeBatch } from './pool-outbox.js';
import { CLAIMED_HOST_CLASSES, CLAIMED_LAUNCHERS, parseSkeleton, type SessionSkeleton } from './pool-wire.js';
import { localSalt } from './store.js';
import type { Git } from './survival.js';

const STEP = 'pool-hold-pull';

/** What a pull reaches outside the store: GitHub's record of a repository, local git plumbing (`runGit`), git over the network (`runNetGit`), and where a repository is fetched from. */
export interface PullPorts {
  visibility: Visibility;
  git: Git;
  net: Git;
  remoteOf: (repo: string) => string;
}

/** Why a repository or a branch was set aside; the report names it, and a test holds each. */
export type PullReason =
  | 'repo_public'
  | 'repo_unconfirmed'
  | 'repo_unreadable'
  | 'branch_name'
  | 'unknown_machine'
  | 'machine_repo'
  | 'duplicate_id'
  | 'unreadable_file'
  | 'batch_invalid'
  | 'id_mismatch'
  | 'stamp_invalid'
  | 'terms_stale'
  | 'differing_stamp'
  | 'field_unknown'
  | 'claimed_present'
  | 'off_list'
  | 'a38_term'
  | 'machine_record';

/** A repository (no `branch`) or a branch that was refused, and why. */
export interface PullRefusal {
  repo: string;
  branch?: string;
  reason: PullReason;
  detail: string;
}

/** A batch that reached the outbox, under the folder of its stamp. */
export interface PullAdmission {
  repo: string;
  branch: string;
  id: string;
  stamp: string;
}

class Refused extends Error {
  constructor(
    readonly reason: PullReason,
    detail: string,
  ) {
    super(detail);
  }
}

/** A branch tip fetched into a scratch repository: the files are read from there when a gate needs them. */
interface Tip {
  repo: string;
  branch: string;
  sha: string;
  /** The commit's time in epoch seconds, which orders two branches that name one `id`. */
  at: number;
  scratch: string;
}

/** The id is the outbox key, which holds only 16 hex digits (`machineIdOf`), so a branch of any other id is refused by its name, before its file is read. */
const BRANCH = /^oars-hold\/([^/]+)\/([0-9a-f]{16})$/u;

/** The branch tips of `oars-hold/*` in one repository, each commit only: depth 1, so history is never fetched, and no tag. The scratch repository is bare and lives under `parent` until the pull ends. */
const tipsOf = async (ports: PullPorts, parent: string, repo: string): Promise<Tip[]> => {
  const scratch = await mkdtemp(join(parent, 'repo-'));
  await ports.git(scratch, ['init', '--bare', '--quiet']);
  await ports.net(scratch, ['fetch', '--quiet', '--no-tags', '--depth=1', ports.remoteOf(repo), '+refs/heads/oars-hold/*:refs/held/*']);
  const listing = await ports.git(scratch, ['for-each-ref', '--format=%(refname:strip=2)%09%(objectname)%09%(committerdate:unix)', 'refs/held/']);
  return listing
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [name = '', sha = '', at = '0'] = line.split('\t');
      return { repo, branch: `oars-hold/${name}`, sha, at: Number(at), scratch };
    });
};

/** A file of the tip's tree, or undefined when the tree has none by that name (or it is not a file). */
const fileOf = (ports: PullPorts, tip: Tip, name: string): Promise<string | undefined> => ports.git(tip.scratch, ['cat-file', 'blob', `${tip.sha}:${name}`]).catch(() => undefined);

const refusalOf = (tip: Tip, error: unknown): PullRefusal => {
  if (error instanceof Refused) return { repo: tip.repo, branch: tip.branch, reason: error.reason, detail: error.message };
  throw error;
};

interface Pulling {
  ports: PullPorts;
  outbox: string;
  machines: readonly MachineRecord[];
  /** `HMAC-SHA-256` of this machine's own term list under the session salt the enrollment derived: what a branch's `terms` file must equal. */
  terms: string;
  /** This machine's own exclusion terms, lowercased, as `loadTerms` reads them. */
  list: readonly string[];
  /** `pulled.json` as it stands: each admitted `id` and the stamp folder it is filed under. */
  pulled: { [id: string]: string };
}

/** Whether any string or key in `value` holds one of `terms`, compared lowercased the way the local gate compares a transcript. */
const holdsTerm = (value: unknown, terms: readonly string[]): boolean => {
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    return terms.some((term) => lower.includes(term));
  }
  if (Array.isArray(value)) return value.some((entry) => holdsTerm(entry, terms));
  if (typeof value === 'object' && value !== null) return Object.entries(value).some(([key, entry]) => holdsTerm(key, terms) || holdsTerm(entry, terms));
  return false;
};

/** The batch file of a tip as the skeleton the pool's own reader makes of it; throws `Refused` for anything that reader, or the branch's own name, would not take. */
const skeletonOf = async (run: Pulling, tip: Tip, id: string): Promise<SessionSkeleton> => {
  const batch = await fileOf(run.ports, tip, 'batch.json');
  if (batch === undefined) throw new Refused('unreadable_file', 'the branch holds no batch.json');
  let value: unknown;
  try {
    value = JSON.parse(batch);
  } catch {
    throw new Refused('batch_invalid', 'batch.json is not JSON');
  }
  // None of these details repeats a value of the file: a branch is written by whoever could push it, and its text must not reach a log.
  // `JSON.parse` takes a file nested far deeper than the recursive walks below can follow, and a RangeError out of one of them would end the whole pull.
  try {
    const names = fieldsOf(batch);
    if (names.includes('claimed')) throw new Refused('claimed_present', 'the batch holds a claimed field, which only this machine writes');
    if (names.some((name) => !BATCH_FIELDS.includes(name))) throw new Refused('field_unknown', 'the batch holds a field outside the batch field list');
    const parsed = parseSkeleton(value);
    if (!parsed.ok) throw new Refused('batch_invalid', `${parsed.field}: ${parsed.reason}`);
    if (parsed.extensions.length > 0) throw new Refused('off_list', `${String(parsed.extensions.length)} value or field off the current lists, at ${parsed.extensions.slice(0, 3).map(({ at }) => at).join(', ')}`);
    if (parsed.skeleton.id !== id) throw new Refused('id_mismatch', 'the batch names another id than its branch');
    if (holdsTerm(value, run.list)) throw new Refused('a38_term', 'a string or key of the batch holds a term of the exclusion list of this machine');
    return parsed.skeleton;
  } catch (error) {
    if (error instanceof RangeError) throw new Refused('batch_invalid', 'batch.json is nested too deeply');
    throw error;
  }
};

/** A refusal of a batch built under another stamp is reported as that, with the cause: an older vocabulary or field list is the usual reason a file fails the reader or the closed lists now. */
const underStamp = async <T>(stamp: string, work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Refused && stamp !== currentStamp()) throw new Refused('differing_stamp', `${error.reason}: ${error.message}`);
    throw error;
  }
};

const PULLED = 'pulled.json';

const readPulled = async (outbox: string): Promise<{ [id: string]: string }> => {
  let text: string;
  try {
    text = await readFile(join(outbox, PULLED), 'utf8');
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.values(value).every((stamp) => typeof stamp === 'string')) {
    throw new CliError(`${join(outbox, PULLED)} is not a list of ids and stamps. Move it aside and pull again; nothing was fetched.`, ExitCode.INVALID, STEP);
  }
  return Object.fromEntries(Object.entries(value).map(([id, stamp]) => [id, String(stamp)]));
};

/** Staged and renamed, so a crash leaves the whole old file or the whole new one. */
const writePulled = async (outbox: string, pulled: { [id: string]: string }): Promise<void> => {
  const staged = join(outbox, `${PULLED}.tmp`);
  await writeOwnerOnly(staged, `${JSON.stringify(Object.fromEntries(Object.entries(pulled).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2)}\n`);
  await rename(staged, join(outbox, PULLED));
};

/** One tip through its gates; answers the admission, or throws `Refused` with the first gate that failed. Nothing is written before the batch is through every gate. */
const admit = async (run: Pulling, tip: Tip, id: string, machine: string): Promise<PullAdmission> => {
  const record = run.machines.find((known) => known.machine === machine);
  if (record === undefined) throw new Refused('unknown_machine', `no machine ${machine} in machines.jsonl`);
  if (!record.allowRepos.includes(tip.repo)) throw new Refused('machine_repo', `machine ${machine} was not enrolled for ${tip.repo}`);
  // The claim comes from this machine's own record and nothing the branch holds, so a record the closed lists do not hold admits nothing.
  const hostClass = CLAIMED_HOST_CLASSES.find((name) => name === record.hostClass);
  const launcher = CLAIMED_LAUNCHERS.find((name) => name === record.launcher);
  if (hostClass === undefined || launcher === undefined) throw new Refused('machine_record', `machines.jsonl holds a host class or launcher for machine ${machine} that the closed lists do not`);
  // The stamp becomes a path segment, so it is checked before anything else of the branch is used.
  const stamp = (await fileOf(run.ports, tip, 'stamp'))?.trim();
  if (stamp === undefined || !STAMP_FOLDER.test(stamp)) throw new Refused('stamp_invalid', 'the branch holds no stamp, or it is not a stamp folder name');
  // The compare is made whatever the stamp says: a list that changed since the environment was enrolled keeps every branch of that environment.
  const held = (await fileOf(run.ports, tip, 'terms'))?.trim();
  if (held !== run.terms) throw new Refused('terms_stale', held === undefined ? 'the branch holds no terms digest' : 'the branch was gated under another exclusion term list than this machine\'s');
  const skeleton = await underStamp(stamp, () => skeletonOf(run, tip, id));
  // The stamp's version names the vocabulary the batch was built under: a file that says otherwise is not what its stamp claims.
  if (stamp.slice(0, -9) !== `v${skeleton.vocabVersion}`) throw new Refused('stamp_invalid', 'the stamp does not name the batch\'s vocabulary version');
  // The order is the batch, then pulled.json, then the older copy: a crash between them leaves the next pull to replace the same id.
  await writeBatch(run.outbox, id, { ...skeleton, claimed: { hostClass, launcher } }, stamp);
  run.pulled[id] = stamp;
  await writePulled(run.outbox, run.pulled);
  for (const folder of await readdir(run.outbox)) {
    if (folder !== stamp && STAMP_FOLDER.test(folder)) await removeBatchOf(run.outbox, id, folder);
  }
  return { repo: tip.repo, branch: tip.branch, id, stamp };
};

const summary = (admitted: readonly PullAdmission[], refused: readonly PullRefusal[]): string =>
  [
    `Admitted ${String(admitted.length)} ${admitted.length === 1 ? 'batch' : 'batches'}; refused ${String(refused.length)}. A refused branch stays where it is.`,
    ...admitted.map((entry) => `  admitted ${entry.branch} (${entry.repo}) as ${entry.id} under ${entry.stamp}`),
    ...refused.map((entry) => `  refused ${entry.branch ?? 'the repository'} (${entry.repo}): ${entry.reason}: ${entry.detail}`),
  ].join('\n');

/**
 * Pulls what every enrolled machine held. Each repository on any machine's list is checked against GitHub's record again on every run, and one that is no longer private is refused and reported, its branches unread. The branches that
 * remain are taken newest first, and the newest of an `id` alone speaks for it: an older branch of that `id` is reported as a duplicate whether or not the newest was admitted; each branch must name a machine this one enrolled, for that repository.
 */
export const holdPull = async (deps: RunDeps, options: { server?: string | undefined }, ports: PullPorts): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  const outbox = outboxFolder(runtime.storeDir, poolServer(deps.env, STEP, options.server));
  const machines = await readMachines(runtime.storeDir);
  const repos = [...new Set(machines.flatMap((record) => record.allowRepos))].sort();
  const admitted: PullAdmission[] = [];
  const refused: PullRefusal[] = [];
  if (repos.length === 0) return { document: { ok: true, admitted, refused }, text: 'No machine is enrolled: nothing to pull. oars pool enroll --hold-only enrolls one.' };
  // An empty term file refuses everything, as the local gate does: a digest of no terms would admit a branch from an environment that held none.
  const termsFile = exclusionPaths(runtime.projectsRoot, deps.env).terms;
  const terms = await loadTerms(termsFile);
  if (terms.length === 0) throw new CliError(`No exclusion terms in ${termsFile}: every branch would be unverifiable. Nothing was fetched.`, ExitCode.USAGE, STEP);
  const sessionSalt = derivedSalt((await (runtime.accountSalt ?? localSalt)(runtime.storeDir)).salt, 'sessionId/1');
  const pulled = await readPulled(outbox);
  const scratch = await mkdtemp(join(runtime.storeDir, 'hold-pull-'));
  try {
    const tips: Tip[] = [];
    for (const repo of repos) {
      const seen = await ports.visibility(repo);
      if (seen !== 'private') {
        refused.push({ repo, reason: seen === 'public' ? 'repo_public' : 'repo_unconfirmed', detail: seen === 'public' ? 'the repository is public now: its branches were not read' : 'could not confirm the repository is private (a GH_TOKEN or GITHUB_TOKEN that can read it is needed): its branches were not read' });
        continue;
      }
      try {
        tips.push(...(await tipsOf(ports, scratch, repo)));
      } catch {
        // The git error text carries the command line and the remote's URL, so the report gives a fixed cause instead.
        refused.push({ repo, reason: 'repo_unreadable', detail: 'its branches could not be fetched (check this machine\'s git credential for the repository)' });
      }
    }
    const run: Pulling = { ports, outbox, machines, terms: termsDigest(sessionSalt, terms), list: terms, pulled };
    const taken = new Set<string>();
    for (const tip of [...tips].sort((a, b) => b.at - a.at || (a.branch < b.branch ? -1 : 1))) {
      try {
        const named = BRANCH.exec(tip.branch);
        if (named === null) throw new Refused('branch_name', 'the branch is not oars-hold/<machine>/<id>');
        const [, machine = '', id = ''] = named;
        if (taken.has(id)) throw new Refused('duplicate_id', `a newer branch already supplied ${id}`);
        // Taken before the gates: the newest tip of an `id` alone speaks for it, so when it is refused an older one is not admitted in its place.
        taken.add(id);
        admitted.push(await admit(run, tip, id, machine));
      } catch (error) {
        refused.push(refusalOf(tip, error));
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { document: { ok: true, admitted, refused }, text: summary(admitted, refused) };
};
