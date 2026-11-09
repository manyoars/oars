// The machine's skeleton `id` and the derived salts: one session is one id however the cloud names it, and a local capture and a VM key one repository the same way.
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { derivedSalt, machineIdOf } from './machine-ids.js';
import { machineOf } from './machine.js';
import { machineKeyOf } from './pool-command.js';
import { makeRedactor } from './redact.js';
import { depositSession, localSalt, paths } from './store.js';
import { addProject, cleanup, NOW, stage } from './test-support.js';

const made: string[] = [];
afterEach(() => {
  cleanup();
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const SALT = 'a-derived-session-salt';
const machine = (env: { [name: string]: string }): NonNullable<ReturnType<typeof machineOf>> => {
  const found = machineOf({ OARS_HOST_CLASS: 'cloud', OARS_MACHINE: 'm-1', ...env });
  if (found === undefined) throw new Error('not a machine');
  return found;
};

describe('machineIdOf', () => {
  it('gives cse_x, session_x, and x one id of 16 hex digits, the HMAC of the bare name under the salt', () => {
    const id = machineIdOf(SALT, 'x');
    expect(machineIdOf(SALT, 'cse_x')).toBe(id);
    expect(machineIdOf(SALT, 'session_x')).toBe(id);
    expect(id).toBe(createHmac('sha256', SALT).update('x').digest('hex').slice(0, 16));
    expect(machineIdOf(SALT, 'y')).not.toBe(id);
    expect(machineIdOf('another-salt', 'x')).not.toBe(id);
  });
});

describe('machineKeyOf', () => {
  it('is the salted id of CLAUDE_CODE_REMOTE_SESSION_ID where set, else of the hook session, and the same for every machine id of one environment', () => {
    const remote = machine({ OARS_SESSION_SALT: SALT, CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_abc' });
    expect(machineKeyOf(remote, 'a-hook-uuid')).toBe(machineIdOf(SALT, 'abc'));
    expect(machineKeyOf(machine({ OARS_SESSION_SALT: SALT }), 'session_abc')).toBe(machineIdOf(SALT, 'abc'));
    expect(machineKeyOf(machine({ OARS_SESSION_SALT: SALT, OARS_MACHINE: 'm-2' }), 'cse_abc')).toBe(machineIdOf(SALT, 'abc'));
  });

  it('keeps the machine-named key where the enrollment gave no session salt', () => {
    expect(machineKeyOf(machine({}), 'abc')).toMatch(/^[0-9a-f]{16}$/u);
    expect(machineKeyOf(machine({}), 'abc')).not.toBe(machineIdOf(SALT, 'abc'));
  });
});

describe('the repository key', () => {
  const transcript = (root: string): string => `${JSON.stringify({ type: 'user', sessionId: 's', cwd: root, timestamp: '2026-05-01T01:00:00Z', message: { role: 'user', content: 'hi' } })}\n`;
  const repoOf = (store: string, repoSalt: string | undefined): string | null =>
    captureSession({ text: transcript('/w/app'), session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: makeRedactor(), salt: store, ...(repoSalt === undefined ? {} : { repoSalt }), repoRoot: () => '/w/app', repoIdentity: () => 'origin:github.com/org/app' }).session.repo;

  it('is the same on a VM with a fresh store salt and the enrollment\'s derived salt as on the trusted machine, and moves with that salt', () => {
    const local = derivedSalt('trusted-store-salt', 'repoKey/1');
    expect(repoOf('fresh-vm-store-salt', local)).toBe(repoOf('trusted-store-salt', local));
    expect(repoOf('fresh-vm-store-salt', local)).not.toBe(repoOf('fresh-vm-store-salt', derivedSalt('another-store-salt', 'repoKey/1')));
    expect(derivedSalt('trusted-store-salt', 'sessionId/1')).not.toBe(local);
  });
});

describe('the repository key through a deposit', () => {
  /** A folder whose .git/config names `origin`, which is all the repository identity reads; no git process runs. */
  const clone = (): string => {
    const folder = mkdtempSync(join(tmpdir(), 'oars-machine-ids-'));
    made.push(folder);
    mkdirSync(join(folder, '.git'));
    writeFileSync(join(folder, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/org/app\n');
    return folder;
  };

  /** One store that deposits a session whose folder is `folder`, and the `repo` its log then holds. */
  const depositedRepo = async (runtimeOf: (staged: ReturnType<typeof stage>) => ReturnType<typeof stage>['runtime'], folder: string): Promise<{ repo: unknown; storeSalt: string }> => {
    const staged = stage();
    const line = JSON.stringify({ type: 'user', sessionId: 's', cwd: folder, timestamp: '2026-05-01T01:00:00Z', message: { role: 'user', content: 'hi' } });
    const transcript = addProject(staged, 'zz-ids', 's', [line]);
    await depositSession(runtimeOf(staged), transcript, () => NOW);
    const records = readFileSync(paths(staged.storeDir).observations, 'utf8').split('\n').filter((entry) => entry !== '').map((entry): unknown => JSON.parse(entry));
    const session = records.find((record) => typeof record === 'object' && record !== null && Reflect.get(record, 'kind') === 'session');
    const repo: unknown = typeof session === 'object' && session !== null ? Reflect.get(session, 'repo') : undefined;
    return { repo, storeSalt: (await localSalt(staged.storeDir)).salt };
  };

  it('is one value for one repository on the trusted machine (its store salt, no repoSalt) and on a VM (another store salt, the derived repoSalt)', async () => {
    const folder = clone();
    const trusted = await depositedRepo((staged) => staged.runtime, folder);
    const derived = derivedSalt(trusted.storeSalt, 'repoKey/1');
    const vm = await depositedRepo((staged) => ({ ...staged.runtime, repoSalt: derived }), folder);
    expect(vm.storeSalt).not.toBe(trusted.storeSalt);
    expect(trusted.repo).toBe(createHash('sha256').update(`${derived}\nrepo:origin:github.com/org/app`).digest('hex').slice(0, 16));
    expect(vm.repo).toBe(trusted.repo);
  }, 30_000);
});
