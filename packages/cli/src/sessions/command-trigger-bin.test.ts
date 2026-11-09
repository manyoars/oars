// The built `dist/bin.js`, run as a person runs any oars command, in a temp home that holds a session store: it exits 0 with the command's own output, and it leaves the due mark behind, which is
// the proof that `main.ts` wires the command trigger (the one that sweeps harnesses with no session-end hook). The detached sender it starts runs in the same temp home with telemetry off and no
// sign-in, so it sends nothing. Like `hook-bin-stop.test.ts` it reads `dist/`, which the root `check` builds before the tests run; without a build it is skipped.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bin = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const pkg = fileURLToPath(new URL('../../package.json', import.meta.url));
const built = existsSync(bin);

const made: string[] = [];
// The detached sender writes its last file and then exits, and on Windows the folder stays held until the process is gone, which a loaded machine delays past any fixed retry count: wait for the condition that matters, the folder can be removed.
afterEach(async () => {
  for (const folder of made.splice(0)) {
    await vi.waitFor(() => {
      rmSync(folder, { recursive: true, force: true });
    }, { timeout: 30_000, interval: 250 });
  }
}, 45_000);

const version = (): string => {
  const parsed: unknown = JSON.parse(readFileSync(pkg, 'utf8'));
  const value: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'version') : undefined;
  if (typeof value !== 'string') throw new Error('package.json has no version');
  return value;
};

const home = (): { folder: string; store: string } => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-cmd-bin-'));
  made.push(folder);
  const store = join(folder, 'oars', 'sessions');
  if (!store.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'state.json'), '{}');
  return { folder, store };
};

const command = (folder: string): Promise<{ code: number | null; stdout: string }> =>
  new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, APPDATA: folder, HOME: folder, USERPROFILE: folder, XDG_CONFIG_HOME: folder, OARS_TELEMETRY: '0' };
    const child = spawn(process.execPath, [bin, '--version'], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout });
    });
  });

describe.skipIf(!built)('the built oars command', () => {
  it('exits 0 with its own output and starts the due check, which leaves its mark', async () => {
    const { folder, store } = home();
    const ran = await command(folder);
    expect(ran.code).toBe(0);
    expect(ran.stdout.trim()).toBe(version());
    const mark: unknown = JSON.parse(readFileSync(join(store, 'pool-due.json'), 'utf8'));
    expect(typeof mark === 'object' && mark !== null ? typeof Reflect.get(mark, 'startedAt') : undefined).toBe('number');
    // The detached sender writes `pool-nightly.json` as its last step; waiting for that file (a condition, not a sleep) lets the folder be removed with no process still in it.
    await vi.waitFor(() => {
      expect(existsSync(join(store, 'pool-nightly.json'))).toBe(true);
    }, { timeout: 30_000, interval: 100 });
  }, 45_000);
});
