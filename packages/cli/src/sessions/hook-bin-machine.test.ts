// The built `dist/hook-bin.js` and `dist/oars-hook.js` (the program the installed command names), run as the hook of a cloud machine runs them. `stop --machine` without `OARS_HOST_CLASS` exits 0, prints nothing, and starts nothing, so a laptop that has the machine hook
// installed keeps its own behavior; with the class set and no session in its input it exits 0 and starts no child; a notice the last child left is printed once. `machine-child <input>`, the detached child a Stop starts, runs to completion over a temp store with a real
// repository on the allow list and builds one batch into the outbox. Like `hook-bin-stop.test.ts` it reads `dist/`, which the root `check` builds before the tests run; without a build it is skipped. APPDATA, HOME, and USERPROFILE are a temp folder, and the test confirms the store path is under it before it runs.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messageOf, noticeFile, recordNotice } from './machine-notice.js';
import { waitUntilFree } from './test-support.js';

// Both programs run: a machine's installed command starts `oars-hook`, which only imports `hook-bin.js`, so a missing import there leaves every Stop a silent exit 0 that `hook-bin.js` alone would never show.
const PROGRAMS = ['hook-bin.js', 'oars-hook.js'] as const;
const programOf = (file: (typeof PROGRAMS)[number]): string => fileURLToPath(new URL(`../../dist/${file}`, import.meta.url));
const built = existsSync(programOf('hook-bin.js'));

const made: string[] = [];
// The detached child has the home folder as its working directory and may still be exiting when its batch and lock are seen, so the folder is removed once nothing holds it (`waitUntilFree`).
afterEach(async () => {
  for (const folder of made.splice(0)) rmSync(await waitUntilFree(folder), { recursive: true, force: true });
});

const home = (): { folder: string; store: string } => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-machine-bin-'));
  made.push(folder);
  const store = join(folder, 'oars', 'sessions');
  if (!store.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  mkdirSync(store, { recursive: true });
  return { folder, store };
};

const stop = (program: string, folder: string, extra: { [name: string]: string }, stdin: string): Promise<{ code: number | null; stdout: string }> =>
  new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, APPDATA: folder, HOME: folder, USERPROFILE: folder, XDG_CONFIG_HOME: folder, OARS_TELEMETRY: '0', ...extra };
    const child = spawn(process.execPath, [program, 'stop', '--machine'], { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], timeout: 30_000 });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout });
    });
    child.stdin.end(stdin);
  });

/** `<program> machine-child <input>` run to completion, as the Stop's detached child runs it: the folder is HOME, as `machineStop` sets the child's cwd to it. The settle wait is real, so this takes the transcript's quiet time (2 s). */
const machineChild = (program: string, folder: string, extra: { [name: string]: string }, input: string): Promise<{ code: number | null; stdout: string }> =>
  new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, APPDATA: folder, HOME: folder, USERPROFILE: folder, XDG_CONFIG_HOME: folder, OARS_TELEMETRY: '0', ...extra };
    const child = spawn(process.execPath, [program, 'machine-child', input], { cwd: folder, env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout });
    });
  });

describe.skipIf(!built)('the built machine Stop hook', () => {
  describe.each(PROGRAMS)('dist/%s', (file) => {
    const program = programOf(file);
    it.each([[{}], [{ OARS_HOST_CLASS: 'local' }]])('exits 0 with no output and starts nothing without a machine class (%j)', async (extra) => {
      const { folder, store } = home();
      const ran = await stop(program, folder, extra, JSON.stringify({ session_id: 's', transcript_path: join(folder, 's.jsonl') }));
      expect(ran).toEqual({ code: 0, stdout: '' });
      expect(readdirSync(store)).toEqual([]);
    });

    it('exits 0 with no output on a machine, and the local hook path did not run (no due mark)', async () => {
      const { folder, store } = home();
      const ran = await stop(program, folder, { OARS_HOST_CLASS: 'cloud' }, '{}');
      expect(ran).toEqual({ code: 0, stdout: '' });
      expect(existsSync(join(store, 'pool-due.json'))).toBe(false);
    });

    it('prints the notice the last child left as one systemMessage, once, and a laptop leaves it alone', async () => {
      const { folder, store } = home();
      await recordNotice(store, 'vocabulary_expired', 1);
      expect(await stop(program, folder, {}, '{}')).toEqual({ code: 0, stdout: '' });
      expect(existsSync(noticeFile(store))).toBe(true);
      const first = await stop(program, folder, { OARS_HOST_CLASS: 'cloud' }, '{}');
      expect(first.code).toBe(0);
      expect(first.stdout).toBe(JSON.stringify({ systemMessage: messageOf([{ code: 'vocabulary_expired', at: 1 }]) }));
      expect(await stop(program, folder, { OARS_HOST_CLASS: 'cloud' }, '{}')).toEqual({ code: 0, stdout: '' });
    });

    // The route a real Stop takes after `machineStop` detaches: every case above sends `{}`, which starts no child, so without this one a hook that never reaches `machine-child` still passes.
    /** A repository on the allow list with one session in the harness's folder, and the Stop's forwarded input for it. */
    const fixture = (folder: string): { extra: { [name: string]: string }; input: string } => {
      const repo = join(folder, 'work', 'widgets');
      mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets']);
      const id = '99999999-9999-4999-8999-000000000001';
      const transcript = join(folder, '.claude', 'projects', 'zz-widgets', `${id}.jsonl`);
      mkdirSync(join(folder, '.claude', 'projects', 'zz-widgets'), { recursive: true });
      writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId: id, cwd: repo, timestamp: '2026-05-01T01:00:00Z', permissionMode: 'default', message: { role: 'user', content: 'a plain request' } })}\n`);
      return { extra: { OARS_HOST_CLASS: 'vps', OARS_ALLOW_REPOS: 'acme/widgets', OARS_EXCLUSION_TERMS_INLINE: 'zorblax' }, input: JSON.stringify({ session_id: id, transcript_path: transcript, cwd: repo }) };
    };
    const outboxNames = (store: string): string[] => {
      const outbox = join(store, 'pool-outbox');
      return existsSync(outbox) ? readdirSync(outbox, { recursive: true, encoding: 'utf8' }) : [];
    };

    it('runs machine-child to completion: a repository on the allow list, with inline terms, builds one batch into the outbox', async () => {
      const { folder, store } = home();
      const { extra, input } = fixture(folder);
      const ran = await machineChild(program, folder, extra, input);
      expect(ran).toEqual({ code: 0, stdout: '' });
      expect(outboxNames(store).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
    }, 60_000);

    // The whole route of a real Stop: the program's own `stop --machine` starts the detached child, which builds the batch after the hook has returned. Waited on its condition (a batch, and the child's lock let go), never a fixed sleep.
    it('a Stop with a real session starts the detached child, which builds one batch', async () => {
      const { folder, store } = home();
      const { extra, input } = fixture(folder);
      expect(await stop(program, folder, extra, input)).toEqual({ code: 0, stdout: '' });
      await vi.waitFor(
        () => {
          const names = outboxNames(store);
          expect(names.filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
          expect(names.some((name) => name.endsWith('send.lock'))).toBe(false);
        },
        { timeout: 60_000, interval: 250 },
      );
    }, 70_000);
  });
});
