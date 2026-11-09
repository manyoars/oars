// The built `dist/hook-bin.js stop --machine` and `dist/oars-hook.js stop --machine` (the program the installed command names), run as the Stop hook of a cloud machine runs it: without `OARS_HOST_CLASS` it exits 0, prints nothing, and starts nothing, so a laptop that has the machine hook installed keeps its own
// behaviour. With the class set it exits 0 and prints nothing too, and the detached child it starts is `machine-child`, which a missing transcript ends at once. Like `hook-bin-stop.test.ts` it reads `dist/`, which the root
// `check` builds before the tests run; without a build it is skipped. APPDATA and HOME are a temp folder, and the test confirms the store path is under it before it runs.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { messageOf, noticeFile, recordNotice } from './machine-notice.js';

// Both programs run: a machine's installed command starts `oars-hook`, which only imports `hook-bin.js`, so a missing import there leaves every Stop a silent exit 0 that `hook-bin.js` alone would never show.
const PROGRAMS = ['hook-bin.js', 'oars-hook.js'] as const;
const programOf = (file: (typeof PROGRAMS)[number]): string => fileURLToPath(new URL(`../../dist/${file}`, import.meta.url));
const built = existsSync(programOf('hook-bin.js'));

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
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
  });
});
