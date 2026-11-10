// `oars pool hold pull` (`machine-pull.ts`): the trusted machine admits what a VM held on its branches. Each case runs against bare repositories in a temp folder that stand for the private repositories, with the branches made by git plumbing as
// the VM makes them; GitHub's visibility record is injected, so nothing reaches a network.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run, type Outcome } from '../cli.js';
import { harness, server, useServer, type Harness } from '../test-support.js';
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

useServer();
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

const MACHINE = '1111111111111111';
const OTHER_MACHINE = '2222222222222222';
const ID = '0123456789abcdef';
const OTHER_ID = 'fedcba9876543210';
const TERMS = ['acme corp', 'project x'];
const REPO = 'acme/widgets';
const OTHER_REPO = 'acme/gadgets';
const PRIVATE: Visibility = () => Promise.resolve('private');

/** What a VM commits: the register's invented session without `claimed`, which only this machine writes. The type still names it, since the fixture's does. */
const BRANCH_BATCH = structuredClone(REGISTER_FIXTURE);
Reflect.deleteProperty(BRANCH_BATCH, 'claimed');

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
  'batch.json': canonicalBytes({ ...BRANCH_BATCH, id }),
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
    // Admitting deletes the branches, so the VMs push again.
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    hold(s, OTHER_REPO, `oars-hold/${MACHINE}/${OTHER_ID}`, goodFiles(s, OTHER_ID));
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

  it('reports a repository whose branches cannot be fetched with a fixed detail, and still pulls the other repository', async () => {
    const s = await scene([{ ...RECORD, allowRepos: [REPO, OTHER_REPO] }]);
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    // OTHER_REPO has no bare repository: its remote names a path that does not exist.
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [{ repo: REPO, id: ID }], refused: [{ repo: OTHER_REPO, reason: 'repo_unreadable', detail: 'its branches could not be fetched (check this machine\'s git credential for the repository)' }] });
    expect(out.text).not.toContain('Command failed');
    expect(out.text).not.toContain(s.remotes);
    expect(filed(s)).toHaveLength(1);
  }, SLOW);

  it('reads a machines.jsonl line that is not a record as no machine: not JSON, a missing field, or a repository that is not owner/name', async () => {
    const s = await scene();
    const NOT_JSON = '3333333333333333';
    const NO_FIELD = '4444444444444444';
    const NO_OWNER = '5555555555555555';
    const line = (machine: string, shape: { [name: string]: unknown } = {}): string => JSON.stringify({ machine, hostClass: 'cloud', launcher: 'orchestrated', allowRepos: [REPO], ...shape });
    writeFileSync(
      join(s.staged.storeDir, 'machines.jsonl'),
      [line(NOT_JSON).slice(0, -1), line(NO_FIELD, { launcher: undefined }), line(NO_OWNER, { allowRepos: ['not-a-repo'] }), line(MACHINE)].map((text) => `${text}\n`).join(''),
    );
    // Each id is 16 hex digits, the one shape a branch may name, so the refusal can only be the machine's.
    const idOf = (machine: string): string => `${machine.slice(0, 1)}${ID.slice(1)}`;
    for (const machine of [NOT_JSON, NO_FIELD, NO_OWNER]) hold(s, REPO, `oars-hold/${machine}/${idOf(machine)}`, goodFiles(s, idOf(machine)));
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    const out = await pull(s);
    expect(out.document).toMatchObject({
      admitted: [{ id: ID }],
      refused: [
        { branch: `oars-hold/${NOT_JSON}/${idOf(NOT_JSON)}`, reason: 'unknown_machine' },
        { branch: `oars-hold/${NO_FIELD}/${idOf(NO_FIELD)}`, reason: 'unknown_machine' },
        { branch: `oars-hold/${NO_OWNER}/${idOf(NO_OWNER)}`, reason: 'unknown_machine' },
      ],
    });
    expect(filed(s)).toHaveLength(1);
    // The admitted branch is gone; the three that name no known machine stay.
    expect(branchesOf(s, REPO)).toHaveLength(3);
  }, SLOW);

  it('lets the newest tip of an id speak for it: when it is refused, an older tip of the id is a duplicate and not admitted in its place', async () => {
    const s = await scene([RECORD, { ...RECORD, machine: OTHER_MACHINE }], 'typescript\n');
    const terms = `${termsDigest(s.salt, ['typescript'])}\n`;
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), terms }, 1_700_000_000);
    hold(s, REPO, `oars-hold/${OTHER_MACHINE}/${ID}`, { ...goodFiles(s), terms }, 1_700_000_500);
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [], refused: [{ branch: `oars-hold/${OTHER_MACHINE}/${ID}`, reason: 'a38_term' }, { branch: `oars-hold/${MACHINE}/${ID}`, reason: 'duplicate_id' }] });
    expect(existsSync(s.outbox)).toBe(false);
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

/** Text a branch's stamp carries, which a report must not repeat. */
const STAMP_MARKER = 'markerzq';

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
    hold(s, REPO, `oars-hold/${MACHINE}/${OTHER_ID}`, { ...goodFiles(s, OTHER_ID), stamp: `v99-${STAMP_MARKER}-00000000\n` });
    hold(s, REPO, `oars-hold/${MACHINE}/${third}`, without(goodFiles(s, third), 'stamp'));
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [], refused: [{ branch: `oars-hold/${MACHINE}/${third}`, reason: 'stamp_invalid' }, { branch: `oars-hold/${MACHINE}/${ID}`, reason: 'stamp_invalid' }, { branch: `oars-hold/${MACHINE}/${OTHER_ID}`, reason: 'stamp_invalid' }] });
    expect(out.text).not.toContain(STAMP_MARKER);
    expect(out.text).not.toContain('v99');
    expect(existsSync(s.outbox)).toBe(false);
    expect(branchesOf(s, REPO)).toHaveLength(3);
  }, SLOW);

  it('reports a refused batch of a differing stamp under its own reason with the cause, and a format the pool would refuse stays on its branch', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), stamp: `${OLDER}\n`, 'batch.json': canonicalBytes({ ...BRANCH_BATCH, id: ID, format: 99 }) });
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

const BATCH = { ...BRANCH_BATCH, id: ID };
const OFF_LIST = 'a-value-no-vocabulary-holds';
/** An id the reader accepts (16 hex digits, so the only kind that reaches the comparison with the branch's), unlike ID and OTHER_ID. */
const OFF_ID = 'deadbeefdeadbeef';

/** The fixture with its second tool's status set to `status`, a value the closed list of statuses either holds or does not (the first tool carries an error code and recovery calls, which the reader refuses beside a status it reads as `other`). */
const withStatus = (status: string): unknown => ({ ...BATCH, transcripts: BATCH.transcripts.map((transcript, at) => (at === 0 ? { ...transcript, tools: transcript.tools.map((tool, index) => (index === 1 ? { ...tool, status } : tool)) } : transcript)) });

describe('oars pool hold pull: the branch file is untrusted', () => {
  it.each([
    { what: 'a field outside the batch field list', batch: { ...BATCH, note: OFF_LIST }, reason: 'field_unknown' },
    { what: 'a claimed of its own', batch: { ...BATCH, claimed: { hostClass: 'cloud', launcher: 'ci' } }, reason: 'claimed_present' },
    { what: 'a value off a closed list', batch: withStatus(OFF_LIST), reason: 'off_list' },
    { what: 'an id unlike its branch', batch: { ...BATCH, id: OFF_ID }, reason: 'id_mismatch' },
  ])('refuses $what, writes nothing, never repeats the file\'s own text, and leaves the branch', async ({ batch, reason }) => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), 'batch.json': canonicalBytes(batch) });
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [], refused: [{ repo: REPO, branch: `oars-hold/${MACHINE}/${ID}`, reason }] });
    for (const marker of [OFF_LIST, OFF_ID]) expect(out.text).not.toContain(marker);
    expect(existsSync(s.outbox)).toBe(false);
    expect(branchesOf(s, REPO)).toEqual([`oars-hold/${MACHINE}/${ID}`]);
  }, SLOW);

  it('refuses a branch whose id is not the 16 hex digits the outbox keys by, though its batch names the same text, and the branch after it is still pulled', async () => {
    const s = await scene();
    const NOT_AN_ID = 'not-a-session-id';
    hold(s, REPO, `oars-hold/${MACHINE}/${NOT_AN_ID}`, goodFiles(s, NOT_AN_ID), 1_700_000_100);
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s), 1_700_000_000);
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [{ id: ID }], refused: [{ branch: `oars-hold/${MACHINE}/${NOT_AN_ID}`, reason: 'branch_name' }] });
    expect(filed(s)).toHaveLength(1);
    expect(filed(s)[0]).toMatch(new RegExp(`^${ID}\\.`, 'u'));
    expect(branchesOf(s, REPO)).toEqual([`oars-hold/${MACHINE}/${NOT_AN_ID}`]);
  }, SLOW);

  it('refuses a valid file nested too deeply to walk, and the branches after it are still pulled', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), 'batch.json': `${'['.repeat(200_000)}${']'.repeat(200_000)}` }, 1_700_000_100);
    hold(s, REPO, `oars-hold/${MACHINE}/${OTHER_ID}`, goodFiles(s, OTHER_ID), 1_700_000_000);
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [{ id: OTHER_ID }], refused: [{ branch: `oars-hold/${MACHINE}/${ID}`, reason: 'batch_invalid', detail: 'batch.json is nested too deeply' }] });
    expect(filed(s)).toHaveLength(1);
    expect(branchesOf(s, REPO)).toEqual([`oars-hold/${MACHINE}/${ID}`]);
  }, SLOW);

  it('refuses a branch with no batch.json, writes nothing, and leaves the branch', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, without(goodFiles(s), 'batch.json'));
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [], refused: [{ branch: `oars-hold/${MACHINE}/${ID}`, reason: 'unreadable_file' }] });
    expect(existsSync(s.outbox)).toBe(false);
    expect(branchesOf(s, REPO)).toHaveLength(1);
  }, SLOW);

  it.each([
    { what: 'a string', terms: ['typescript'] },
    { what: 'a key', terms: ['deltaKind'] },
  ])('refuses a batch with an A38 term of this machine\'s own list in $what, and writes nothing', async ({ terms }) => {
    const s = await scene([RECORD], `${terms.join('\n')}\n`);
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), terms: `${termsDigest(s.salt, terms)}\n` });
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [], refused: [{ branch: `oars-hold/${MACHINE}/${ID}`, reason: 'a38_term' }] });
    expect(out.text).not.toContain(terms[0] ?? '');
    expect(existsSync(s.outbox)).toBe(false);
    expect(branchesOf(s, REPO)).toHaveLength(1);
  }, SLOW);
});

/** The batch the outbox holds for `id` under the current stamp. */
const batchOf = (s: Scene, id: string): unknown => {
  const file = filed(s).find((name) => name.startsWith(`${id}.`));
  const batch: unknown = JSON.parse(readFileSync(join(s.outbox, currentStamp(), file ?? 'absent'), 'utf8'));
  return batch;
};

describe('oars pool hold pull: claimed', () => {
  it('writes the host class and launcher of the branch\'s own machine record into each admitted batch', async () => {
    const s = await scene([RECORD, { ...RECORD, machine: OTHER_MACHINE, hostClass: 'vps', launcher: 'scheduled' }]);
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    hold(s, REPO, `oars-hold/${OTHER_MACHINE}/${OTHER_ID}`, goodFiles(s, OTHER_ID));
    const out = await pull(s);
    expect(out.document).toMatchObject({ refused: [] });
    expect(batchOf(s, ID)).toMatchObject({ claimed: { hostClass: 'cloud', launcher: 'orchestrated' } });
    expect(batchOf(s, OTHER_ID)).toMatchObject({ claimed: { hostClass: 'vps', launcher: 'scheduled' } });
  }, SLOW);

  it.each([
    { what: 'a host class', record: { ...RECORD, hostClass: 'mainframe' } },
    { what: 'a launcher', record: { ...RECORD, launcher: 'by-hand' } },
  ])('refuses a branch of a machine whose record holds $what off the closed lists, and writes nothing', async ({ record }) => {
    const s = await scene([record]);
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [], refused: [{ branch: `oars-hold/${MACHINE}/${ID}`, reason: 'machine_record' }] });
    expect(existsSync(s.outbox)).toBe(false);
    expect(branchesOf(s, REPO)).toHaveLength(1);
  }, SLOW);
});

/** Makes every git process this test starts append its trace to a file, and answers the file: it exists only once some git command ran, whatever the command was. */
const traceGit = (s: Scene): string => {
  const trace = join(s.staged.root, 'git-trace.log');
  vi.stubEnv('GIT_TRACE', trace);
  return trace;
};

describe('the command', () => {
  it.each(['GH_TOKEN', 'GITHUB_TOKEN'])('runs through the CLI: the repository record is asked for with %s, a repository that is public now is refused, and nothing is fetched', async (name) => {
    const s = await scene();
    const trace = traceGit(s);
    s.h.deps.env[name] = 'a-test-token';
    const seen: (string | null)[] = [];
    server.use(
      http.get('https://api.github.com/repos/acme/widgets', ({ request }) => {
        seen.push(request.headers.get('authorization'));
        return HttpResponse.json({ private: false });
      }),
    );
    const code = await run(['pool', 'hold', 'pull', '--json'], s.h.deps);
    expect(code).toBe(0);
    expect(seen).toEqual(['Bearer a-test-token']);
    expect(JSON.parse(s.h.out.join(''))).toEqual({ ok: true, admitted: [], refused: [{ repo: REPO, reason: 'repo_public', detail: 'the repository is public now: its branches were not read' }] });
    // The command's scratch folder is gone by now, so the proof of no fetch is that no git process ran at all, not even the `git init` that precedes one.
    expect(existsSync(trace)).toBe(false);
    expect(existsSync(s.outbox)).toBe(false);
  }, SLOW);

  it('shows the git trace the case above relies on: a pull of a private repository runs git, and the trace file appears', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    // After the branch is made: the setup runs git too.
    const trace = traceGit(s);
    expect(existsSync(trace)).toBe(false);
    await pull(s);
    expect(existsSync(trace)).toBe(true);
  }, SLOW);
});

describe('oars pool hold pull: deleting what was admitted', () => {
  it('deletes the branch of an admitted batch once the batch and its pulled.json entry are durable, and keeps the branch of a refused one', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    hold(s, REPO, `oars-hold/${MACHINE}/${OTHER_ID}`, { ...goodFiles(s, OTHER_ID), terms: 'not-the-digest\n' });
    const out = await pull(s);
    expect(out.document).toMatchObject({ admitted: [{ id: ID, branchDeleted: true }], refused: [{ reason: 'terms_stale' }] });
    expect(branchesOf(s, REPO)).toEqual([`oars-hold/${MACHINE}/${OTHER_ID}`]);
    expect(pulledOf(s)).toEqual({ [ID]: currentStamp() });
    expect(filed(s)).toHaveLength(1);
    expect(out.text).toContain(`admitted oars-hold/${MACHINE}/${ID}`);
  }, SLOW);

  it('pulls a repository whose branches were all deleted by the last pull, or that never held one, without reporting it unreadable', async () => {
    const s = await scene([{ ...RECORD, allowRepos: [REPO, OTHER_REPO] }]);
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    hold(s, OTHER_REPO, 'main', { README: 'a repository with no held branch\n' });
    await pull(s);
    expect(branchesOf(s, REPO)).toEqual([]);
    const again = await pull(s);
    expect(again.document).toMatchObject({ ok: true, admitted: [], refused: [] });
    expect(again.text).toContain('Admitted 0 batches; refused 0.');
  }, SLOW);

  it('leaves the branch when a crash comes before pulled.json is written, and the next pull admits the same id again and deletes it', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    // A folder where the staged file is written makes that write throw.
    mkdirSync(join(s.outbox, 'pulled.json.tmp'), { recursive: true });
    await expect(pull(s)).rejects.toThrow();
    expect(branchesOf(s, REPO)).toEqual([`oars-hold/${MACHINE}/${ID}`]);
    expect(s.network.some((line) => line.startsWith('push'))).toBe(false);
    rmSync(join(s.outbox, 'pulled.json.tmp'), { recursive: true });
    const again = await pull(s);
    expect(again.document).toMatchObject({ admitted: [{ id: ID, branchDeleted: true }] });
    expect(filed(s)).toHaveLength(1);
    expect(branchesOf(s, REPO)).toEqual([]);
  }, SLOW);

  it('keeps a branch that moved after it was fetched, so a newer push is not lost, and reports it as kept', async () => {
    const s = await scene();
    const first = hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    const moving: Git = (root, args, stdin) => {
      s.network.push(args.join(' '));
      if (args[0] === 'push') hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, { ...goodFiles(s), stamp: `${currentStamp()}\n` }, 1_700_000_100, first);
      return runNetGit(root, args, stdin);
    };
    const out = await holdPull(s.h.deps, {}, { visibility: PRIVATE, git: runGit, net: moving, remoteOf: (repo) => bareOf(s, repo) });
    expect(out.document).toMatchObject({ admitted: [{ id: ID, branchDeleted: false }], refused: [] });
    expect(branchesOf(s, REPO)).toEqual([`oars-hold/${MACHINE}/${ID}`]);
    expect(gitIn(bareOf(s, REPO), ['rev-parse', `refs/heads/oars-hold/${MACHINE}/${ID}`]).trim()).not.toBe(first);
    expect(out.text).toContain('branch kept');
  }, SLOW);

  it('admits the batch and reports the branch kept when the remote refuses the delete, and never repeats the remote\'s text', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    const refusing: Git = (root, args, stdin) => (args[0] === 'push' ? Promise.reject(new Error('remote: https://x-access-token:secret@github.com/acme/widgets.git deletion refused')) : runNetGit(root, args, stdin));
    const out = await holdPull(s.h.deps, {}, { visibility: PRIVATE, git: runGit, net: refusing, remoteOf: (repo) => bareOf(s, repo) });
    expect(out.document).toMatchObject({ admitted: [{ id: ID, branchDeleted: false }] });
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(filed(s)).toHaveLength(1);
    expect(pulledOf(s)).toEqual({ [ID]: currentStamp() });
    expect(branchesOf(s, REPO)).toEqual([`oars-hold/${MACHINE}/${ID}`]);
  }, SLOW);

  it('merges its entry into the pulled.json a send pass changed after the pull read it, so neither entry is lost before the branch is deleted', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    // A pass that finishes between the pull's read of pulled.json and its write: it files another id, as an earlier pull would have.
    const racing: Git = (root, args, stdin) => {
      if (args[0] === 'fetch') {
        mkdirSync(s.outbox, { recursive: true });
        writeFileSync(join(s.outbox, 'pulled.json'), JSON.stringify({ [OTHER_ID]: currentStamp() }));
      }
      return runNetGit(root, args, stdin);
    };
    const out = await holdPull(s.h.deps, {}, { visibility: PRIVATE, git: runGit, net: racing, remoteOf: (repo) => bareOf(s, repo) });
    expect(out.document).toMatchObject({ admitted: [{ id: ID, branchDeleted: true }] });
    expect(pulledOf(s)).toEqual({ [OTHER_ID]: currentStamp(), [ID]: currentStamp() });
    expect(filed(s)).toHaveLength(1);
  }, SLOW);

  it('writes nothing while a send pass holds the send lock, and admits and deletes once it lets go', async () => {
    const s = await scene();
    hold(s, REPO, `oars-hold/${MACHINE}/${ID}`, goodFiles(s));
    mkdirSync(s.outbox, { recursive: true });
    const lock = join(s.outbox, 'send.lock');
    writeFileSync(lock, 'another-run');
    const pulling = pull(s);
    // The pull has fetched and is waiting on the lock: the push of the delete has not run, and nothing is filed.
    await vi.waitFor(() => { expect(s.network.some((line) => line.startsWith('fetch'))).toBe(true); }, { timeout: 30_000 });
    await new Promise((done) => setTimeout(done, 1500));
    expect(filed(s)).toHaveLength(0);
    expect(existsSync(join(s.outbox, 'pulled.json'))).toBe(false);
    expect(s.network.some((line) => line.startsWith('push'))).toBe(false);
    rmSync(lock);
    expect((await pulling).document).toMatchObject({ admitted: [{ id: ID, branchDeleted: true }] });
    expect(filed(s)).toHaveLength(1);
    expect(branchesOf(s, REPO)).toEqual([]);
  }, SLOW);
});
