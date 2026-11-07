// What a deposit says about whom it covers (t871). Two of the bands are the operator's word, kept in one file on this machine and never looked up; the third, `team`, is a count of the distinct commit
// authors in the local git log of the repository the session sat in. The count is made here and dropped: the log is read, the authors are counted, and no name or address leaves this function. No call goes
// over a network, and anything that cannot be read goes as `unknown`.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeRepoRoot } from './repo-root.js';
import { NO_COVERAGE, ORG_SIZES, REPO_VISIBILITIES, type Coverage, type OrgSize, type RepoVisibility, type Team } from './pool-wire.js';
import type { SessionObservation } from './schema.js';
import { writeAtomic, type SessionsRuntime } from './store.js';
import { cwdOfProject, type Git } from './survival.js';

/** The two bands only the operator can state. */
export interface CoverageSetting {
  orgSize: OrgSize;
  repoVisibility: RepoVisibility;
}

/** A history this long is read at most, so a very large repository costs a bounded read; the band needs to tell one author from several, not to count them all. */
const LOG_COMMITS_MAX = 5000;

export const coverageFile = (storeDir: string): string => join(storeDir, 'pool-coverage.json');

const held = <T extends string>(list: readonly T[], value: unknown, otherwise: T): T => list.find((entry) => entry === value) ?? otherwise;

/** The saved setting. A missing, damaged, or out-of-list file reads as `unknown`, which states nothing. */
export const readCoverageSetting = async (storeDir: string): Promise<CoverageSetting> => {
  const unset: CoverageSetting = { orgSize: NO_COVERAGE.orgSize, repoVisibility: NO_COVERAGE.repoVisibility };
  try {
    const parsed: unknown = JSON.parse(await readFile(coverageFile(storeDir), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return unset;
    return { orgSize: held(ORG_SIZES, Reflect.get(parsed, 'orgSize'), unset.orgSize), repoVisibility: held(REPO_VISIBILITIES, Reflect.get(parsed, 'repoVisibility'), unset.repoVisibility) };
  } catch {
    return unset;
  }
};

export const writeCoverageSetting = (storeDir: string, setting: CoverageSetting): Promise<void> => writeAtomic(coverageFile(storeDir), `${JSON.stringify(setting)}\n`);

/** The band for a count of distinct authors: one is `solo`, more is `team`, and none or an unread log is `unknown`. */
export const teamOf = (authors: number | null): Team => (authors === null || authors === 0 ? 'unknown' : authors === 1 ? 'solo' : 'team');

/** How many distinct commit authors the repository's local log shows (the author address, mailmap applied); null when git cannot read it or it holds no commit. Only the count leaves. */
export const authorsIn = async (git: Git, root: string): Promise<number | null> => {
  try {
    const lines = (await git(root, ['log', '--format=%aE', `--max-count=${String(LOG_COMMITS_MAX)}`])).split(/\r?\n/).filter((line) => line !== '');
    return lines.length === 0 ? null : new Set(lines.map((line) => line.toLowerCase())).size;
  } catch {
    return null;
  }
};

/** The coverage of a session, for one deposit pass: each repository's log is read once. */
export const makeCoverage = (runtime: Pick<SessionsRuntime, 'projectsRoot' | 'storeDir'>, setting: CoverageSetting, git: Git): ((main: SessionObservation) => Promise<Coverage>) => {
  const rootOf = makeRepoRoot();
  const teams = new Map<string, Team>();
  return async ({ project, session }) => {
    const cwd = await cwdOfProject(runtime, project, new Set([session]));
    const root = cwd === undefined ? null : rootOf(cwd);
    if (root === null) return { ...setting, team: 'unknown' };
    const known = teams.get(root);
    if (known !== undefined) return { ...setting, team: known };
    const team = teamOf(await authorsIn(git, root));
    teams.set(root, team);
    return { ...setting, team };
  };
};
