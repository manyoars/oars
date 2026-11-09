// `oars pool hold pull` (`machine-pull.ts`): the trusted machine admits what a VM held on its branches. Each case runs against bare repositories in a temp folder that stand for the private repositories, with the branches made by git plumbing as
// the VM makes them; GitHub's visibility record is injected, so nothing reaches a network.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Outcome } from '../cli.js';
import { harness, type Harness } from '../test-support.js';
import { derivedSalt } from './machine-ids.js';
import type { MachineRecord, Visibility } from './machine-enroll.js';
import { termsDigest, runNetGit } from './machine-hold.js';
import { holdPull } from './machine-pull.js';
import { canonicalBytes, currentStamp, outboxFolder } from './pool-outbox.js';
import { REGISTER_FIXTURE } from './pool-fixture.js';
import { DEFAULT_POOL_URL } from './pool-command.js';
import { localSalt } from './store.js';
import { runGit, type Git } from './survival.js';
import { cleanup, stage, type Staged } from './test-support.js';

// Each case runs a dozen git processes, which a Windows runner starts slowly.
const SLOW = 60_000;

afterEach(cleanup);

const MACHINE = '1111111111111111';
const OTHER_MACHINE = '2222222222222222';
const ID = '0123456789abcdef';
const OTHER_ID = 'fedcba9876543210';
const TERMS = ['acme corp', 'project x'];
const REPO = 'acme/widgets';
const OTHER_REPO = 'acme/gadgets';
const PRIVATE: Visibility = () => Promise.resolve('private');

const RECORD: MachineRecord = { machine: MACHINE, hostClass: 'cloud', launcher: 'orchestrated', allowRepos: [REPO] };

interface Scene {
  staged: Staged;
  h: Harness;
  remotes: string;
  outbox: string;
  /** The session salt the enrollment derived: what a VM's `terms` digest is keyed with. */
  salt: string;
  /** Every git command that went over the network, as one line each. */
  network: string[];
}

const scene = async (machines: readonly MachineRecord[] = [RECORD], terms = `${TERMS.join('\n')}\n`): Promise<Scene> => {
  const staged = stage();
  const termsFile = join(staged.root, 'terms.txt');
  writeFileSync(termsFile, terms);
  const h = harness({ OARS_EXCLUSION_TERMS: termsFile });
  h.deps.sessions = staged.runtime;
  mkdirSync(staged.storeDir, { recursive: true });
  writeFileSync(join(staged.storeDir, 'machines.jsonl'), machines.map((record) => `${JSON.stringify(record)}\n`).join(''));
  const remotes = join(staged.root, 'remotes');
  mkdirSync(remotes);
  return { staged, h, remotes, outbox: outboxFolder(staged.storeDir, DEFAULT_POOL_URL), salt: derivedSalt((await localSalt(staged.storeDir)).salt, 'sessionId/1'), network: [] };
};

const bareOf = (s: Scene, repo: string): string => join(s.remotes, `${repo.replace('/', '__')}.git`);

const gitIn = (cwd: string, args: readonly string[], input?: string, env: NodeJS.ProcessEnv = {}): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', input, env: { ...process.env, ...env } });

/** The files a VM commits for a good batch: the batch, the client's stamp, and the digest of the exclusion terms it was gated under. */
const goodFiles = (s: Scene, id = ID): { [file: string]: string } => ({
  'batch.json': canonicalBytes({ ...REGISTER_FIXTURE, id }),
  stamp: `${currentStamp()}\n`,
  terms: `${termsDigest(s.salt, TERMS)}\n`,
});

/** Commits `files` on top of `parent` in the bare repository standing for `repo`, as the branch `name`, and answers the commit. `at` is the commit's time in epoch seconds. */
const hold = (s: Scene, repo: string, name: string, files: { [file: string]: string }, at = 1_700_000_000, parent?: string): string => {
  const bare = bareOf(s, repo);
  if (!existsSync(bare)) {
    mkdirSync(bare, { recursive: true });
    gitIn(bare, ['init', '--bare', '-q']);
  }
  const entries = Object.entries(files).map(([file, content]) => `100644 blob ${gitIn(bare, ['hash-object', '-w', '--no-filters', '--stdin'], content).trim()}\t${file}\n`);
  const tree = gitIn(bare, ['mktree'], entries.join('')).trim();
  const date = `${String(at)} +0000`;
  const commit = gitIn(bare, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit-tree', tree, ...(parent === undefined ? [] : ['-p', parent]), '-m', 'oars hold [skip ci]'], undefined, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }).trim();
  gitIn(bare, ['update-ref', `refs/heads/${name}`, commit]);
  return commit;
};

const branchesOf = (s: Scene, repo: string): string[] => gitIn(bareOf(s, repo), ['for-each-ref', '--format=%(refname:short)', 'refs/heads/oars-hold/']).split('\n').filter((line) => line !== '');

const pull = (s: Scene, visibility: Visibility = PRIVATE): Promise<Outcome> => {
  const net: Git = (root, args, stdin) => {
    s.network.push(args.join(' '));
    return runNetGit(root, args, stdin);
  };
  return holdPull(s.h.deps, {}, { visibility, git: runGit, net, remoteOf: (repo) => bareOf(s, repo) });
};

/** The files the outbox holds under one stamp folder; none when the folder was never made. */
const filed = (s: Scene, stamp: string = currentStamp()): string[] => (existsSync(join(s.outbox, stamp)) ? readdirSync(join(s.outbox, stamp)) : []);

describe('oars pool hold pull: who may hold', () => {
  it('admits the tip of a known machine\'s branch in a private repository, filed under its stamp', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    const out = await pull(s);
    expect(out.document).toMatchObject({ ok: true, admitted: [{ repo: REPO, branch: `oars-hold/${MACHINE}/${ID}`, id: ID, stamp: currentStamp() }], refused: [] });
    expect(filed(s)).toHaveLength(1);
    expect(filed(s)[0]).toMatch(new RegExp(`^${ID}\\.[0-9a-f]{64}\\.jsonl$`, 'u'));
  }, SLOW);

  it('rechecks every repository on every run: one that is public, or whose record cannot be read, is refused and reported, and none of its branches is read', async () => {
    const s = await scene([{ ...RECORD, allowRepos: [REPO, OTHER_REPO] }]);
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    hold(s, OTHER_REPO, `oars-hold/${MACHINE}/${OTHER_ID}`, goodFiles(s, OTHER_ID));
    const first = await pull(s);
    expect(first.document).toMatchObject({ admitted: [{ id: ID }, { id: OTHER_ID }], refused: [] });
    s.network.length = 0;
    const second = await pull(s, (repo) => Promise.resolve(repo === REPO ? 'public' : 'private'));
    expect(second.document).toMatchObject({ admitted: [{ repo: OTHER_REPO }], refused: [{ repo: REPO, reason: 'repo_public' }] });
    expect(s.network.some((line) => line.includes(bareOf(s, REPO)))).toBe(false);
    s.network.length = 0;
    const third = await pull(s, (repo) => Promise.resolve(repo === REPO ? 'unknown' : 'private'));
    expect(third.document).toMatchObject({ refused: [{ repo: REPO, reason: 'repo_unconfirmed' }] });
    expect(s.network.some((line) => line.includes(bareOf(s, REPO)))).toBe(false);
  }, SLOW);

  it('reads the tip of a branch only: a good commit in its history does not admit a tip that is not', async () => {
    const s = await scene();
    const older = hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s), 1_700_000_000);
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), 'batch.json': 'not json\n' }, 1_700_000_100, older);
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [], refused: [{ branch: `oars-hold/${MACHINE}/${ID}`, reason: 'batch_invalid' }] });
    expect(filed(s)).toEqual([]);
  }, SLOW);

  it('admits one batch for an id: of two branches that name it the newer commit is admitted, and the other is reported', async () => {
    const s = await scene([RECORD, { ...RECORD, machine: OTHER_MACHINE }]);
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s), 1_700_000_000);
    hold(s, REPO, `oars-hold/${OTHER_MACHINE}/${ID}`, goodFiles(s), 1_700_000_500);
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [{ branch: `oars-hold/${OTHER_MACHINE}/${ID}`, id: ID }], refused: [{ branch: `oars-hold/${MACHINE}/${ID}`, reason: 'duplicate_id' }] });
    expect(filed(s)).toHaveLength(1);
  }, SLOW);

  it('refuses and reports a branch of a machine that is not in machines.jsonl, writes nothing for it, and leaves the branch', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${OTHER_MACHINE}/${ID}`, goodFiles(s));
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [], refused: [{ repo: REPO, branch: `oars-hold/${OTHER_MACHINE}/${ID}`, reason: 'unknown_machine' }] });
    expect(existsSync(s.outbox)).toBe(false);
    expect(branchesOf(s, REPO)).toEqual([`oars-hold/${OTHER_MACHINE}/${ID}`]);
  }, SLOW);

  it('refuses a branch in a repository its machine was not enrolled for, and one whose name is not a machine and an id', async () => {
    const s = await scene([RECORD, { ...RECORD, machine: OTHER_MACHINE, allowRepos: [OTHER_REPO] }]);
    hold(s, OTHER_REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    hold(s, REPO, 'oars-hold/stray', goodFiles(s));
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [], refused: [{ repo: OTHER_REPO, branch: `oars-hold/${MACHINE}/${ID}`, reason: 'machine_repo' }, { repo: REPO, branch: 'oars-hold/stray', reason: 'branch_name' }] });
    expect(existsSync(s.outbox)).toBe(false);
    expect(branchesOf(s, OTHER_REPO)).toHaveLength(1);
  }, SLOW);
});

/** A stamp this client did not build under, in the form a real one has: the batch's own vocabulary version, then eight hex digits. */
const OLDER = `v${REGISTER_FIXTURE.vocabVersion}-00000000`;

const without = (files: { [file: string]: string }, name: string): { [file: string]: string } => Object.fromEntries(Object.entries(files).filter(([file]) => file !== name));

const pulledOf = (s: Scene): unknown => JSON.parse(readFileSync(join(s.outbox, 'pulled.json'), 'utf8'));

describe('oars pool hold pull: the stamp', () => {
  it('files a batch under its branch\'s stamp, a differing one under its own folder, and records each id and stamp in pulled.json', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), stamp: `${OLDER}\n` });
    hold(s, REPO, `oars-hold/${MACHINE}/${OTHER_ID}`, goodFiles(s, OTHER_ID));
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [{ id: ID, stamp: OLDER }, { id: OTHER_ID, stamp: currentStamp() }], refused: [] });
    expect(filed(s, OLDER)).toHaveLength(1);
    expect(filed(s)).toHaveLength(1);
    expect(pulledOf(s)).toEqual({ [ID]: OLDER, [OTHER_ID]: currentStamp() });
  }, SLOW);

  it('keeps and reports a branch whose stamp is path-like, names another vocabulary than its batch, or is missing, and writes nothing', async () => {
    const s = await scene();
    const third = '00000000000000aa';
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), stamp: '../../escape\n' });
    hold(s, REPO, `oars-hold/${MACHINE}/${OTHER_ID}`, { ...goodFiles(s, OTHER_ID), stamp: 'v99-00000000\n' });
    hold(s, REPO, `oars-hold/${MACHINE}/${third}`, without(goodFiles(s, third), 'stamp'));
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [], refused: [{ branch: `oars-hold/${MACHINE}/${third}`, reason: 'stamp_invalid' }, { branch: `oars-hold/${MACHINE}/${ID}`, reason: 'stamp_invalid' }, { branch: `oars-hold/${MACHINE}/${OTHER_ID}`, reason: 'stamp_invalid' }] });
    expect(existsSync(s.outbox)).toBe(false);
    expect(branchesOf(s, REPO)).toHaveLength(3);
  }, SLOW);

  it('reports a refused batch of a differing stamp under its own reason with the cause, and a format the pool would refuse stays on its branch', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), stamp: `${OLDER}\n`, 'batch.json': canonicalBytes({ ...REGISTER_FIXTURE, id: ID, format: 99 }) });
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [], refused: [{ branch: `oars-hold/${MACHINE}/${ID}`, reason: 'differing_stamp' }] });
    expect(out.text).toContain('differing_stamp: batch_invalid: format');
    expect(existsSync(s.outbox)).toBe(false);
    expect(branchesOf(s, REPO)).toHaveLength(1);
  }, SLOW);

  it('stops before any fetch when pulled.json is not a list of ids and stamps', async () => {
    const s = await scene();
    mkdirSync(s.outbox, { recursive: true });
    writeFileSync(join(s.outbox, 'pulled.json'), '[1, 2');
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    await expect(pull(s)).rejects.toThrow(/not a list of ids and stamps/u);
    expect(s.network).toEqual([]);
    expect(filed(s)).toEqual([]);
  }, SLOW);

  it('removes the copy of an id held under another stamp once the new one is durable, and pulled.json names the new stamp', async () => {
    const s = await scene();
    const first = hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), stamp: `${OLDER}\n` }, 1_700_000_000);
    await pull(s);
    expect(filed(s, OLDER)).toHaveLength(1);
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s), 1_700_000_100, first);
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [{ id: ID, stamp: currentStamp() }] });
    expect(filed(s, OLDER)).toEqual([]);
    expect(filed(s)).toHaveLength(1);
    expect(pulledOf(s)).toEqual({ [ID]: currentStamp() });
  }, SLOW);
});

describe('oars pool hold pull: the terms', () => {
  it('keeps and reports a branch whose terms digest is of another list or is missing, even with a matching stamp, and writes nothing', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), terms: `${termsDigest(s.salt, [...TERMS, 'a newer term'])}\n` });
    hold(s, REPO, `oars-hold/${MACHINE}/${OTHER_ID}`, without(goodFiles(s, OTHER_ID), 'terms'));
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [], refused: [{ branch: `oars-hold/${MACHINE}/${ID}`, reason: 'terms_stale' }, { branch: `oars-hold/${MACHINE}/${OTHER_ID}`, reason: 'terms_stale' }] });
    expect(existsSync(s.outbox)).toBe(false);
    expect(branchesOf(s, REPO)).toHaveLength(2);
  }, SLOW);

  it('admits a branch whose list is this machine\'s own in another order and case', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), terms: `${termsDigest(s.salt, ['PROJECT X', 'Acme Corp', ''])}\n` });
    expect((await pull(s)).document).toMatchObject({ admitted: [{ id: ID }], refused: [] });
  }, SLOW);

  it('refuses the whole run, before any fetch, when this machine has no term list', async () => {
    const s = await scene([RECORD], '');
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    await expect(pull(s)).rejects.toThrow(/no exclusion terms/iu);
    expect(s.network).toEqual([]);
    expect(existsSync(s.outbox)).toBe(false);
  }, SLOW);
});
