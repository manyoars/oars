// `oars pool hold pull`: admission of the batches a cloud VM held on `oars-hold/<machine>/<id>` branches of its own private repository (the VM side is `machine-hold.ts`). The trusted machine does it, and treats every branch as input
// from outside: anything able to push a branch can write one, the session's own agent included. A branch that fails any gate is reported with its reason, writes nothing to the outbox, and stays where it is; branches are never deleted here.
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Outcome, RunDeps } from '../cli.js';
import { readMachines, type MachineRecord, type Visibility } from './machine-enroll.js';
import { poolServer, runtimeOf } from './pool-command.js';
import { currentStamp, outboxFolder, writeBatch } from './pool-outbox.js';
import { parseSkeleton } from './pool-wire.js';
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
export type PullReason = 'repo_public' | 'repo_unconfirmed' | 'repo_unreadable' | 'branch_name' | 'unknown_machine' | 'machine_repo' | 'duplicate_id' | 'unreadable_file' | 'batch_invalid' | 'id_mismatch';

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

const BRANCH = /^oars-hold\/([^/]+)\/([^/]+)$/u;

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
}

/** One tip through its gates; answers the admission, or throws `Refused` with the first gate that failed. Nothing is written before the last line. */
const admit = async (run: Pulling, tip: Tip, id: string, machine: string): Promise<PullAdmission> => {
  const record = run.machines.find((known) => known.machine === machine);
  if (record === undefined) throw new Refused('unknown_machine', `no machine ${machine} in machines.jsonl`);
  if (!record.allowRepos.includes(tip.repo)) throw new Refused('machine_repo', `machine ${machine} was not enrolled for ${tip.repo}`);
  const batch = await fileOf(run.ports, tip, 'batch.json');
  if (batch === undefined) throw new Refused('unreadable_file', 'the branch holds no batch.json');
  let value: unknown;
  try {
    value = JSON.parse(batch);
  } catch {
    throw new Refused('batch_invalid', 'batch.json is not JSON');
  }
  const parsed = parseSkeleton(value);
  if (!parsed.ok) throw new Refused('batch_invalid', `${parsed.field}: ${parsed.reason}`);
  if (parsed.skeleton.id !== id) throw new Refused('id_mismatch', `the batch names ${parsed.skeleton.id}, the branch ${id}`);
  const stamp = currentStamp();
  await writeBatch(run.outbox, id, parsed.skeleton, stamp);
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
 * remain are taken newest first, so of two that name one `id` the newer commit is admitted and the other is reported; each branch must name a machine this one enrolled, for that repository.
 */
export const holdPull = async (deps: RunDeps, options: { server?: string | undefined }, ports: PullPorts): Promise<Outcome> => {
  const runtime = runtimeOf(deps);
  const outbox = outboxFolder(runtime.storeDir, poolServer(deps.env, STEP, options.server));
  const machines = await readMachines(runtime.storeDir);
  const repos = [...new Set(machines.flatMap((record) => record.allowRepos))].sort();
  const admitted: PullAdmission[] = [];
  const refused: PullRefusal[] = [];
  if (repos.length === 0) return { document: { ok: true, admitted, refused }, text: 'No machine is enrolled: nothing to pull. oars pool enroll --hold-only enrolls one.' };
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
      } catch (error) {
        refused.push({ repo, reason: 'repo_unreadable', detail: `its branches could not be fetched: ${error instanceof Error ? error.message.split('\n')[0] ?? '' : ''}` });
      }
    }
    const run: Pulling = { ports, outbox, machines };
    const taken = new Set<string>();
    for (const tip of [...tips].sort((a, b) => b.at - a.at || (a.branch < b.branch ? -1 : 1))) {
      try {
        const named = BRANCH.exec(tip.branch);
        if (named === null) throw new Refused('branch_name', 'the branch is not oars-hold/<machine>/<id>');
        const [, machine = '', id = ''] = named;
        if (taken.has(id)) throw new Refused('duplicate_id', `a newer branch already supplied ${id}`);
        admitted.push(await admit(run, tip, id, machine));
        taken.add(id);
      } catch (error) {
        refused.push(refusalOf(tip, error));
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return { document: { ok: true, admitted, refused }, text: summary(admitted, refused) };
};
