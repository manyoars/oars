// The built `dist/hook-bin.js stop`, run as the SessionEnd hook runs it, in a temp home that holds a session store: it exits 0, prints nothing, and leaves the due mark behind, which is the proof
// that the hook started the check. The detached sender it starts runs in the same temp home with telemetry off and no sign-in, so it sends nothing. Like `hook-bin-nightly.test.ts` it reads `dist/`,
// which the root `check` builds before the tests run; without a build it is skipped.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hookBin = fileURLToPath(new URL('../../dist/hook-bin.js', import.meta.url));
const built = existsSync(hookBin);

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
});

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

const stop = (folder: string): Promise<{ code: number | null; stdout: string }> =>
  new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, APPDATA: folder, HOME: folder, USERPROFILE: folder, XDG_CONFIG_HOME: folder, OARS_TELEMETRY: '0' };
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
    const ran = await stop(folder);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe('');
    const mark: unknown = JSON.parse(readFileSync(join(store, 'pool-due.json'), 'utf8'));
    expect(typeof mark === 'object' && mark !== null ? typeof Reflect.get(mark, 'startedAt') : undefined).toBe('number');
    // The detached sender it started writes `pool-nightly.json` as its last step; waiting for that file (a condition, not a sleep) lets the folder be removed with no process still in it.
    await vi.waitFor(() => {
      expect(existsSync(join(store, 'pool-nightly.json'))).toBe(true);
    }, { timeout: 30_000, interval: 100 });
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
