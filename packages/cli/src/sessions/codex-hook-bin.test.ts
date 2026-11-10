// The built `dist/sessions/codex-hook-bin.js`, run as Codex runs the recording hook: the event JSON on stdin, in a temp home. It exits 0 and prints nothing whatever it is fed, and writes a row only for a
// payload it can read. Like `hook-bin-stop.test.ts` it reads `dist/`, which the root `check` builds before the tests run; without a build it is skipped.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const hookBin = fileURLToPath(new URL('../../dist/sessions/codex-hook-bin.js', import.meta.url));
const built = existsSync(hookBin);

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
});

/** A temp home with an empty session store; the store path is confirmed to be under the temp folder before the hook runs. */
const home = (): { folder: string; store: string } => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-codex-bin-'));
  made.push(folder);
  const store = join(folder, 'oars', 'sessions');
  if (!store.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  mkdirSync(store, { recursive: true });
  return { folder, store };
};

const record = (folder: string, input: string): Promise<{ code: number | null; stdout: string }> =>
  new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, APPDATA: folder, HOME: folder, USERPROFILE: folder, XDG_CONFIG_HOME: folder, OARS_TELEMETRY: '0' };
    const child = spawn(process.execPath, [hookBin], { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], timeout: 30_000 });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout });
    });
    child.stdin.end(input);
  });

describe.skipIf(!built)('the built Codex recording hook', () => {
  it('exits 0 with no output and writes no row when the input is not JSON', async () => {
    const { folder, store } = home();
    const ran = await record(folder, 'not json');
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe('');
    expect(existsSync(join(store, 'hook-rows.jsonl'))).toBe(false);
  });

  it('exits 0 with no output and appends one row for a tool payload', async () => {
    const { folder, store } = home();
    const ran = await record(folder, JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's1', turn_id: 't1', tool_use_id: 'c1', tool_name: 'Bash', tool_input: { command: 'PRIVATE-COMMAND' }, tool_response: 'Exit code: 0\nOutput:\nPRIVATE-OUTPUT' }));
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe('');
    const text = readFileSync(join(store, 'hook-rows.jsonl'), 'utf8');
    expect(text.split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(text).toContain('"action":"shell.exec"');
    expect(text).not.toContain('PRIVATE');
  });
});
