// The machine child end to end over a real store and a real git repository: the repository `origin` names must be on `OARS_ALLOW_REPOS` for a session to be captured and built, the terms in `OARS_EXCLUSION_TERMS_INLINE` gate it, and an
// expired client builds nothing. The store is a temp folder and APPDATA is the same folder; each test confirms the store path is under the temp folder before it runs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { derivedSalt, machineIdOf } from './machine-ids.js';
import { inlineTermsFile } from './machine.js';
import { runMachineChild } from './machine-child-deps.js';
import { messageOf, noticeFile } from './machine-notice.js';
import { machineStop } from './machine-stop.js';
import { localSalt, paths } from './store.js';
import { addProject, cleanup, stage, type Staged } from './test-support.js';

const made: string[] = [];
afterEach(() => {
  cleanup();
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const SESSION = '99999999-9999-4999-8999-000000000001';
const NO_WAIT = { quietMs: 0, maxMs: 0, pollMs: 1 };

const lineOf = (content: string, cwd = '/w'): string => JSON.stringify({ type: 'user', sessionId: SESSION, cwd, timestamp: '2026-05-01T01:00:00Z', permissionMode: 'default', message: { role: 'user', content } });

interface Scene {
  staged: Staged;
  transcript: string;
  repo: string;
}

/** A store holding one session's transcript, and a repository (the session's folder) whose `origin` is `remote`. */
const scene = (remote: string, content = 'a plain request'): Scene => {
  const staged = stage();
  if (!staged.root.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  rmSync(join(staged.projectsRoot, 'proj'), { recursive: true, force: true });
  const transcript = addProject(staged, 'zz-machine-child', SESSION, [lineOf(content)]);
  const repo = mkdtempSync(join(tmpdir(), 'oars-machine-child-'));
  made.push(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  return { staged, transcript, repo };
};

const stopText = (given: Scene): string => JSON.stringify({ session_id: SESSION, transcript_path: given.transcript, cwd: given.repo });

const run = (given: Scene, env: { [name: string]: string }, now: () => number = Date.now): Promise<void> =>
  runMachineChild({ OARS_HOST_CLASS: 'cloud', OARS_MACHINE: 'm-1', APPDATA: given.staged.root, ...env }, given.staged.runtime, '0.0.0-test', now, stopText(given), NO_WAIT);

const batches = (staged: Staged): string[] => {
  const root = join(staged.storeDir, 'pool-outbox');
  return existsSync(root) ? readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.jsonl')) : [];
};

const TERMS = { OARS_EXCLUSION_TERMS_INLINE: 'zorblax\n' };

describe('runMachineChild: the repository allow list', () => {
  it.each([['https://github.com/owner/name'], ['git@github.com:Owner/Name.git'], ['ssh://git@github.com/owner/name.git']])('builds the session of a repository on the list, whose origin is %s', async (remote) => {
    const given = scene(remote);
    await run(given, { OARS_ALLOW_REPOS: 'owner/name', ...TERMS });
    expect(batches(given.staged)).toHaveLength(1);
    expect(existsSync(join(given.staged.storeDir, 'raw'))).toBe(true);
    expect(existsSync(join(given.staged.storeDir, 'pool-send.log'))).toBe(false);
    // This enrollment gave no machine salt, so nothing is held and the person is told once; the batch is built all the same.
    expect(JSON.parse(readFileSync(noticeFile(given.staged.storeDir), 'utf8'))).toMatchObject({ entries: [{ code: 'hold_unconfigured' }] });
  });

  it('builds nothing for a repository off the list, and does not capture the session either', async () => {
    const given = scene('https://github.com/owner/name');
    await run(given, { OARS_ALLOW_REPOS: 'owner/other another/one', ...TERMS });
    expect(batches(given.staged)).toEqual([]);
    expect(existsSync(join(given.staged.storeDir, 'raw'))).toBe(false);
    expect(existsSync(join(given.staged.storeDir, 'pool-send.log'))).toBe(false);
  });

  it('builds nothing with no list at all', async () => {
    const given = scene('https://github.com/owner/name');
    await run(given, { ...TERMS });
    expect(batches(given.staged)).toEqual([]);
  });

  it('builds nothing for a folder that is not a repository', async () => {
    const given = scene('https://github.com/owner/name');
    const plain = mkdtempSync(join(tmpdir(), 'oars-machine-plain-'));
    made.push(plain);
    mkdirSync(join(plain, 'work'));
    await runMachineChild({ OARS_HOST_CLASS: 'cloud', OARS_ALLOW_REPOS: 'owner/name', APPDATA: given.staged.root, ...TERMS }, given.staged.runtime, '0.0.0-test', Date.now, JSON.stringify({ session_id: SESSION, transcript_path: given.transcript, cwd: join(plain, 'work') }), NO_WAIT);
    expect(batches(given.staged)).toEqual([]);
  });
});

describe('runMachineChild: the inline exclusion terms', () => {
  it('writes them owner-only into the store, and they gate the session', async () => {
    const given = scene('https://github.com/owner/name', 'the Zorblax project');
    await run(given, { OARS_ALLOW_REPOS: 'owner/name', ...TERMS });
    const file = inlineTermsFile(given.staged.storeDir);
    expect(existsSync(file)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(batches(given.staged)).toEqual([]);
  });

  it('builds a session the terms do not name', async () => {
    const given = scene('https://github.com/owner/name');
    await run(given, { OARS_ALLOW_REPOS: 'owner/name', ...TERMS });
    expect(batches(given.staged)).toHaveLength(1);
  });

  it('fails closed with no terms at all: nothing is built', async () => {
    const given = scene('https://github.com/owner/name');
    await run(given, { OARS_ALLOW_REPOS: 'owner/name' });
    expect(batches(given.staged)).toEqual([]);
  });
});

describe('runMachineChild: an expired client', () => {
  // Far past the vocabulary's age limit, whatever the day the suite runs.
  const EXPIRED = Date.parse('2099-01-01T00:00:00Z');

  it('writes the notice, builds and captures nothing, and the next Stop prints one systemMessage and starts its child', async () => {
    const given = scene('https://github.com/owner/name');
    await run(given, { OARS_ALLOW_REPOS: 'owner/name', ...TERMS }, () => EXPIRED);
    expect(batches(given.staged)).toEqual([]);
    expect(existsSync(join(given.staged.storeDir, 'raw'))).toBe(false);
    expect(existsSync(noticeFile(given.staged.storeDir))).toBe(true);

    const printed: string[] = [];
    const spawned: string[][] = [];
    const result = machineStop({
      env: { OARS_HOST_CLASS: 'cloud' },
      stdin: JSON.stringify({ session_id: SESSION, transcript_path: given.transcript, cwd: given.repo }),
      hookBin: '/pkg/dist/hook-bin.js',
      home: tmpdir(),
      storeDir: given.staged.storeDir,
      write: (text) => printed.push(text),
      spawn: (_command, args) => {
        spawned.push([...args]);
        return { on: () => undefined, unref: () => undefined };
      },
    });
    expect(result).toBe('started');
    expect(printed).toEqual([JSON.stringify({ systemMessage: messageOf([{ code: 'vocabulary_expired', at: EXPIRED }]) })]);
    expect(spawned).toHaveLength(1);
    expect(existsSync(noticeFile(given.staged.storeDir))).toBe(false);
  });

  it('writes one entry however many Stops find it expired', async () => {
    const given = scene('https://github.com/owner/name');
    await run(given, { OARS_ALLOW_REPOS: 'owner/name', ...TERMS }, () => EXPIRED);
    await run(given, { OARS_ALLOW_REPOS: 'owner/name', ...TERMS }, () => EXPIRED + 1);
    const written: unknown = JSON.parse(readFileSync(noticeFile(given.staged.storeDir), 'utf8'));
    expect(written).toEqual({ entries: [{ code: 'vocabulary_expired', at: EXPIRED + 1 }] });
  });
});

/** A bare repository the session's repository pushes to instead of GitHub: `origin` still names GitHub (the allow list reads it), and only the push URL is rewritten, so nothing here reaches a network. */
const withBare = (given: Scene): string => {
  const bare = mkdtempSync(join(tmpdir(), 'oars-machine-child-bare-'));
  made.push(bare);
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['-C', given.repo, 'config', `url.${bare}.pushInsteadOf`, 'https://github.com/owner/name']);
  return bare;
};

const branchesIn = (bare: string): string[] => execFileSync('git', ['-C', bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).split(/\r?\n/u).filter((ref) => ref !== '');

const HOLD = { OARS_ALLOW_REPOS: 'owner/name', OARS_SESSION_SALT: 'a-derived-session-salt', ...TERMS };

describe('runMachineChild: the holding route', () => {
  it('pushes the batch it built to oars-hold/<machine>/<id>, with its stamp and a terms digest, and leaves the batch in the outbox', async () => {
    const given = scene('https://github.com/owner/name');
    const bare = withBare(given);
    await run(given, HOLD);
    const [file = ''] = batches(given.staged);
    const [, stamp = '', name = ''] = file.split(/[/\\]/u);
    expect(name).toMatch(/^[0-9a-f]{16}\.[0-9a-f]{64}\.jsonl$/u);
    const id = name.slice(0, 16);
    expect(id).toBe(machineIdOf('a-derived-session-salt', SESSION));
    expect(branchesIn(bare)).toEqual([`refs/heads/oars-hold/m-1/${id}`]);
    const show = (path: string): string => execFileSync('git', ['-C', bare, 'show', `refs/heads/oars-hold/m-1/${id}:${path}`], { encoding: 'utf8' });
    expect(readFileSync(join(given.staged.storeDir, 'pool-outbox', file), 'utf8')).toBe(show('batch.json'));
    expect(show('stamp')).toBe(`${stamp}\n`);
    expect(show('terms')).toMatch(/^[0-9a-f]{64}\n$/u);
    expect(existsSync(join(given.staged.storeDir, 'pool-send.log'))).toBe(false);
  }, 60_000);

  it('holds nothing without OARS_SESSION_SALT, or without OARS_MACHINE, and the batch is built all the same', async () => {
    const noSalt = scene('https://github.com/owner/name');
    const noSaltBare = withBare(noSalt);
    await run(noSalt, { OARS_ALLOW_REPOS: 'owner/name', ...TERMS });
    expect(batches(noSalt.staged)).toHaveLength(1);
    expect(branchesIn(noSaltBare)).toEqual([]);
    expect(JSON.parse(readFileSync(noticeFile(noSalt.staged.storeDir), 'utf8'))).toMatchObject({ entries: [{ code: 'hold_unconfigured' }] });
    const noMachine = scene('https://github.com/owner/name');
    const noMachineBare = withBare(noMachine);
    await run(noMachine, { ...HOLD, OARS_MACHINE: '' });
    expect(batches(noMachine.staged)).toHaveLength(1);
    expect(branchesIn(noMachineBare)).toEqual([]);
    expect(JSON.parse(readFileSync(noticeFile(noMachine.staged.storeDir), 'utf8'))).toMatchObject({ entries: [{ code: 'hold_unconfigured' }] });
  }, 60_000);

  it('tells the person once for a machine with OARS_HOST_CLASS alone, before any gate: no list, no id, no salt, and nothing built or logged', async () => {
    const given = scene('https://github.com/owner/name');
    await runMachineChild({ OARS_HOST_CLASS: 'cloud', APPDATA: given.staged.root }, given.staged.runtime, '0.0.0-test', Date.now, stopText(given), NO_WAIT);
    expect(JSON.parse(readFileSync(noticeFile(given.staged.storeDir), 'utf8'))).toMatchObject({ entries: [{ code: 'hold_unconfigured' }] });
    expect(batches(given.staged)).toEqual([]);
    expect(existsSync(join(given.staged.storeDir, 'pool-send.log'))).toBe(false);
  });

  it('holds nothing of a session a gate kept out', async () => {
    const given = scene('https://github.com/owner/name', 'a request naming zorblax');
    const bare = withBare(given);
    await run(given, HOLD);
    expect(batches(given.staged)).toEqual([]);
    expect(branchesIn(bare)).toEqual([]);
  }, 60_000);
});

/** The `repo` of the session the child captured, read from the store's log. */
const capturedRepo = (storeDir: string): unknown => {
  const records = readFileSync(paths(storeDir).observations, 'utf8').split('\n').filter((entry) => entry !== '').map((entry): unknown => JSON.parse(entry));
  const session = records.find((record) => typeof record === 'object' && record !== null && Reflect.get(record, 'kind') === 'session');
  return typeof session === 'object' && session !== null ? Reflect.get(session, 'repo') : undefined;
};

const keyUnder = (salt: string): string => createHash('sha256').update(`${salt}\nrepo:origin:github.com/owner/name`).digest('hex').slice(0, 16);

describe('runMachineChild: the repository key', () => {
  it("hashes the session's repository under OARS_REPO_SALT, the enrollment's derived salt, and not under the store's own", async () => {
    const given = scene('https://github.com/owner/name');
    writeFileSync(given.transcript, `${lineOf('a plain request', given.repo)}\n`);
    await run(given, { OARS_ALLOW_REPOS: 'owner/name', OARS_REPO_SALT: 'an-enrollment-repo-salt', ...TERMS });
    expect(capturedRepo(given.staged.storeDir)).toBe(keyUnder('an-enrollment-repo-salt'));
  });

  it('with no OARS_REPO_SALT, or a blank one, hashes it under the salt derived from its own store salt', async () => {
    for (const env of [{}, { OARS_REPO_SALT: '  ' }]) {
      const given = scene('https://github.com/owner/name');
      writeFileSync(given.transcript, `${lineOf('a plain request', given.repo)}\n`);
      await run(given, { OARS_ALLOW_REPOS: 'owner/name', ...env, ...TERMS });
      expect(capturedRepo(given.staged.storeDir)).toBe(keyUnder(derivedSalt((await localSalt(given.staged.storeDir)).salt, 'repoKey/1')));
    }
  });
});
