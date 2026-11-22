// The built `dist/hook-bin.js <event> --harness <name>`, run as the Copilot manifest runs it, in a temp home: the flag names the dialect the hook answers in, and a name with no dialect runs
// nothing and prints nothing. Like `hook-bin-nightly.test.ts` it reads `dist/`, which the root `check` builds before the tests run; without a build it is skipped.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { slugOf } from './allow.js';
import { indexPath, readIndex } from './hook-index.js';
import { indexAtOf } from './next-fixtures.js';
import { armOf } from './recall-object.js';
import { frameKeyOf, type RecoveryEdge } from './recall-next.js';
import { deposit } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);

const hookBin = fileURLToPath(new URL('../../dist/hook-bin.js', import.meta.url));
const built = existsSync(hookBin);

const REPO = 'work/app';
const KEY = 'shell.exec/1';
const edge: RecoveryEdge = { next: 'file.read', followed: 12, of: 20, clusters: 1, readId: 'read:0123456789abcdef', day: '2026-11-01' };

/** A home whose session store (where the hook looks, under the config directory) holds a deposit and a copilot-frame recovery read, and a session id whose arm shows the recall. */
const homeWithRecall = async (): Promise<{ home: string; session: string }> => {
  const made = stage(slugOf(REPO));
  const runtime = { ...made.runtime, storeDir: join(made.root, 'oars', 'sessions') };
  await deposit(runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
  const index = await readIndex(runtime.storeDir);
  writeFileSync(indexPath(runtime.storeDir), JSON.stringify({ ...index, recoveryByFrame: { [frameKeyOf({ harness: 'copilot', harnessVersion: null })]: { [KEY]: [edge] } } }));
  const at = indexAtOf(runtime.storeDir);
  for (let i = 0; i < 1000; i++) if (armOf(`c${String(i)}`, [KEY], at) === 'shown') return { home: made.root, session: `c${String(i)}` };
  throw new Error('no session found');
};

const run = (home: string, args: readonly string[], payload: object): Promise<{ stdout: string; code: number | null }> =>
  new Promise((resolve, reject) => {
    // Telemetry is off so the only output is the hook's answer; every config location points at the temp home.
    const env = { PATH: process.env.PATH, APPDATA: home, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, COPILOT_HOME: join(home, '.copilot'), OARS_TELEMETRY: '0' };
    const child = spawn(process.execPath, [hookBin, ...args], { cwd: home, env, stdio: ['pipe', 'pipe', 'ignore'], timeout: 30_000 });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, code });
    });
    child.stdin.end(JSON.stringify(payload));
  });

describe.skipIf(!built)('the built hook with --harness', () => {
  it('answers a snake_case Copilot failure in Copilot’s shape: a top-level additionalContext carrying the recall', async () => {
    const { home, session } = await homeWithRecall();
    const result = await run(home, ['post-tool', '--harness', 'copilot'], { session_id: session, cwd: REPO, tool_name: 'Bash', tool_input: { command: 'ls' }, error: 'Exit code 1\nx' });
    expect(result.code).toBe(0);
    const answer: unknown = JSON.parse(result.stdout);
    expect(typeof answer === 'object' && answer !== null ? Object.keys(answer) : []).toEqual(['additionalContext']);
    expect(String(typeof answer === 'object' && answer !== null ? Reflect.get(answer, 'additionalContext') : '')).toContain('file.read x12');
  });

  it('prints nothing and exits 0 for a harness name with no dialect, with the same payload', async () => {
    const { home, session } = await homeWithRecall();
    const result = await run(home, ['post-tool', '--harness', 'mystery'], { session_id: session, cwd: REPO, tool_name: 'Bash', tool_input: { command: 'ls' }, error: 'Exit code 1\nx' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });
});
