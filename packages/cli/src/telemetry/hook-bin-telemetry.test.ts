// The built `dist/bin.js gate hook` and `dist/hook-bin.js`, run as the harness runs them, in a temp home: each fire leaves one `hook` event in the spool, and stdout is the same
// bytes with telemetry off. Like `pack.test.ts` it reads `dist/`, which the root `check` builds before the tests run; without a build it is skipped.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { folderKey } from '../gate/record.js';
import { readSpool } from './spool.js';

const bin = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const hookBin = fileURLToPath(new URL('../../dist/hook-bin.js', import.meta.url));
const built = existsSync(bin) && existsSync(hookBin);

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
});

/** A temp home that the config folder follows on every platform, holding a block policy and a cached not-found answer for `ghost-lib`, so the hook answers with a deny. */
const home = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-hook-telemetry-bin-'));
  made.push(folder);
  const store = join(folder, 'oars', 'sessions');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, 'gate-policy.json'), '{"classes":{"not-found":"block"}}');
  const now = new Date();
  const answer = { kind: 'registry', v: 1, day: now.toISOString().slice(0, 10), ts: now.toISOString(), folder: folderKey(tmpdir()), class: 'npm-package', state: 'not-found', created: null, name: 'ghost-lib', latest: null };
  writeFileSync(join(store, 'gate-registry.jsonl'), `${JSON.stringify(answer)}\n`);
  return folder;
};

const envFor = (folder: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, APPDATA: folder, HOME: folder, USERPROFILE: folder, XDG_CONFIG_HOME: folder, ...extra });
const DENY = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install ghost-lib' }, cwd: tmpdir(), permission_mode: 'default', hook_event_name: 'PreToolUse' });

interface Logged {
  type: string;
  cli: string;
  data: { [field: string]: unknown };
}
const isLogged = (value: unknown): value is Logged => typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string' && typeof Reflect.get(value, 'cli') === 'string' && typeof Reflect.get(value, 'data') === 'object';
/** One spool line as an event; a line that is not one fails the test that read it. */
const eventOf = (line: string): Logged => {
  const value: unknown = JSON.parse(line);
  if (!isLogged(value)) throw new Error(`not an event: ${line}`);
  return value;
};


const hooks = (folder: string): Logged[] =>
  readSpool(join(folder, 'oars', 'telemetry')).map(eventOf);

describe.skipIf(!built)('the built hooks', () => {
  it('the bare `oars gate hook` records one hook event and prints what it prints with telemetry off', () => {
    const on = home();
    const off = home();
    const first = spawnSync(process.execPath, [bin, 'gate', 'hook'], { input: DENY, encoding: 'utf8', timeout: 30_000, cwd: on, env: envFor(on) });
    const second = spawnSync(process.execPath, [bin, 'gate', 'hook'], { input: DENY, encoding: 'utf8', timeout: 30_000, cwd: off, env: envFor(off, { OARS_TELEMETRY: '0' }) });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('"permissionDecision":"deny"');
    expect(first.stdout).toBe(second.stdout);
    expect(first.status).toBe(second.status);
    const [event, ...rest] = hooks(on);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({ type: 'hook', data: { name: 'gate', outcome: 'hit', bytes: Buffer.byteLength(first.stdout) } });
    expect(event?.cli).toMatch(/^\d+\.\d+\.\d+/);
    expect(hooks(off)).toEqual([]);
  });

  it('hook-bin.js records the session hook it ran, and prints nothing different with telemetry off', () => {
    const on = home();
    const off = home();
    const input = JSON.stringify({ session_id: 's', cwd: tmpdir() });
    const first = spawnSync(process.execPath, [hookBin, 'session-start'], { input, encoding: 'utf8', timeout: 30_000, cwd: on, env: envFor(on) });
    const second = spawnSync(process.execPath, [hookBin, 'session-start'], { input, encoding: 'utf8', timeout: 30_000, cwd: off, env: envFor(off, { OARS_TELEMETRY: '0' }) });
    expect(first.status).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(hooks(on).map((event) => [event.type, event.data.name, event.data.outcome])).toEqual([['hook', 'session-start', 'miss']]);
    expect(hooks(off)).toEqual([]);
  });
});
