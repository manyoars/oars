// The machine child end to end over a real store and a real git repository: the repository `origin` names must be on `OARS_ALLOW_REPOS` for a session to be captured and built, the terms in `OARS_EXCLUSION_TERMS_INLINE` gate it, and an
// expired client builds nothing. The store is a temp folder and APPDATA is the same folder; each test confirms the store path is under the temp folder before it runs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inlineTermsFile } from './machine.js';
import { runMachineChild } from './machine-child-deps.js';
import { messageOf, noticeFile } from './machine-notice.js';
import { machineStop } from './machine-stop.js';
import { addProject, cleanup, stage, type Staged } from './test-support.js';

const made: string[] = [];
afterEach(() => {
  cleanup();
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const SESSION = '99999999-9999-4999-8999-000000000001';
const NO_WAIT = { quietMs: 0, maxMs: 0, pollMs: 1 };

const lineOf = (content: string): string => JSON.stringify({ type: 'user', sessionId: SESSION, cwd: '/w', timestamp: '2026-05-01T01:00:00Z', permissionMode: 'default', message: { role: 'user', content } });

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
    expect(existsSync(noticeFile(given.staged.storeDir))).toBe(false);
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

  it('writes one entry, and only once a day, however many Stops find it expired', async () => {
    const given = scene('https://github.com/owner/name');
    await run(given, { OARS_ALLOW_REPOS: 'owner/name', ...TERMS }, () => EXPIRED);
    await run(given, { OARS_ALLOW_REPOS: 'owner/name', ...TERMS }, () => EXPIRED + 1);
    const written: unknown = JSON.parse(readFileSync(noticeFile(given.staged.storeDir), 'utf8'));
    expect(written).toEqual({ entries: [{ code: 'vocabulary_expired', at: EXPIRED }] });
  });

  it('a failure is one line in pool-send.log, never a throw', async () => {
    const given = scene('https://github.com/owner/name');
    // A pool address that is plain http to another host is refused where the child names its outbox: a failure the child has to survive.
    await run(given, { OARS_ALLOW_REPOS: 'owner/name', ...TERMS, OARS_POOL_URL: 'http://pool.example' });
    const log = readFileSync(join(given.staged.storeDir, 'pool-send.log'), 'utf8');
    expect(log.trimEnd().split(/\r?\n/)).toHaveLength(1);
    expect(log).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z .*http/);
    expect(batches(given.staged)).toEqual([]);
  });
});
