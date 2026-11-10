// The built `dist/hook-bin.js stop`, run as the SessionEnd hook runs it, in a temp home that holds a session store: it exits 0, prints nothing, and leaves the due mark behind, which is the proof
// that the hook started the check. The detached sender it starts runs in the same temp home with telemetry off and no sign-in, so it sends nothing. Like `hook-bin-nightly.test.ts` it reads `dist/`,
// which the root `check` builds before the tests run; without a build it is skipped.
//
// The sender's working folder is the home folder (`homedir()`), which here is the temp home the test removes, and Windows cannot remove a folder that a running process has as its working
// directory. The sender is still exiting for a few milliseconds after it writes `pool-nightly.json`, so the test waits on the sender's own exit: a preload, passed in `NODE_OPTIONS`, writes
// the pid of the process started as `nightly` outside the temp home, and the test waits until that pid is gone.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitUntilFree } from './test-support.js';

const hookBin = fileURLToPath(new URL('../../dist/hook-bin.js', import.meta.url));
const built = existsSync(hookBin);

const made: string[] = [];

afterEach(async () => {
  for (const folder of made.splice(0)) rmSync(await waitUntilFree(folder), { recursive: true, force: true });
});

/** Whether a process with this pid is still running (signal 0 only tests for it). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A folder outside the temp home holding the preload and the pid file it writes, so nothing the sender holds is in the folder the test removes first. */
const probe = (): { preload: string; pidFile: string } => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-stop-probe-'));
  made.push(folder);
  const pidFile = join(folder, 'sender.pid');
  const preload = join(folder, 'preload.cjs');
  writeFileSync(preload, `if (process.argv[2] === 'nightly') require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`);
  return { preload, pidFile };
};

/** A temp home whose session store holds a `state.json`, so the check counts the store as the person's own. */
const home = (): { folder: string; store: string } => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-stop-bin-'));
  made.push(folder);
  const store = join(folder, 'oars', 'sessions');
  if (!store.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'state.json'), '{}');
  return { folder, store };
};

const stop = (folder: string, preload?: string): Promise<{ code: number | null; stdout: string }> =>
  new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, APPDATA: folder, HOME: folder, USERPROFILE: folder, XDG_CONFIG_HOME: folder, OARS_TELEMETRY: '0', ...(preload === undefined ? {} : { NODE_OPTIONS: `--require="${preload.replaceAll(sep, '/')}"` }) };
    const child = spawn(process.execPath, [hookBin, 'stop'], { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], timeout: 30_000 });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout });
    });
    child.stdin.end('{}');
  });

describe.skipIf(!built)('the built session-end hook', () => {
  it('exits 0 with no output and starts the due check, which leaves its mark', async () => {
    const { folder, store } = home();
    const { preload, pidFile } = probe();
    const ran = await stop(folder, preload);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe('');
    const mark: unknown = JSON.parse(readFileSync(join(store, 'pool-due.json'), 'utf8'));
    expect(typeof mark === 'object' && mark !== null ? typeof Reflect.get(mark, 'startedAt') : undefined).toBe('number');
    // The detached sender writes `pool-nightly.json` as its last step and then exits; waiting for its pid to be gone (a condition, not a sleep) lets the folder be removed with no process in it.
    // The preload creates the file and then writes it, so a read between the two sees an empty file: a pid counts only once it is positive (`process.kill(0, 0)` succeeds for the process group, which would never turn false).
    const pid = await vi.waitFor(() => {
      const written = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
      expect(written).toBeGreaterThan(0);
      return written;
    }, { timeout: 30_000, interval: 50 });
    await vi.waitFor(() => {
      expect(alive(pid)).toBe(false);
    }, { timeout: 30_000, interval: 50 });
    expect(existsSync(join(store, 'pool-nightly.json'))).toBe(true);
  }, 45_000);

  it('writes no mark where the person opted out', async () => {
    const { folder, store } = home();
    writeFileSync(join(store, 'schedule.json'), '{"schedule":"off"}\n');
    const ran = await stop(folder);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe('');
    expect(existsSync(join(store, 'pool-due.json'))).toBe(false);
  });
});
