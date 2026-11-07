// Telemetry through `run()`: the notice, the off switches, the hook rule, and the command events. Every test sets APPDATA to a temp folder and
// confirms the telemetry folder is under it (the store follows it), so no test touches the real one.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { run, type RunDeps } from '../cli.js';
import { defaultConfigDir } from '../credentials.js';
import { folderKey } from '../gate/record.js';
import { harness } from '../test-support.js';
import { NOTICE, consentOf } from './consent.js';
import { readSpool, spoolPaths } from './spool.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Made {
  deps: RunDeps;
  out: string[];
  err: string[];
  dir: string;
}

/** A run whose config folder is a temp APPDATA, with the telemetry folder where main.ts puts it. */
const setup = (env: NodeJS.ProcessEnv = {}): Made => {
  const appData = mkdtempSync(join(tmpdir(), 'oars-telemetry-run-'));
  roots.push(appData);
  const made = harness({ APPDATA: appData, ...env });
  const configDir = defaultConfigDir(made.deps.env, 'win32', 'C:\\unused-home');
  expect(configDir).toBe(appData);
  const dir = join(configDir, 'oars', 'telemetry');
  made.deps.telemetry = { dir, platform: 'linux' };
  return { deps: made.deps, out: made.out, err: made.err, dir };
};

const events = (dir: string): unknown[] => readSpool(dir).map((line): unknown => JSON.parse(line));

/** Walks `keys` down an untyped JSON value. */
const field = (value: unknown, ...keys: string[]): unknown => keys.reduce((found, key): unknown => (typeof found === 'object' && found !== null ? Reflect.get(found, key) : undefined), value);

/** A folder that cannot be created: a file stands where it should be. */
const block = (dir: string): void => {
  mkdirSync(join(dir, '..'), { recursive: true });
  writeFileSync(dir, 'a file where the folder should be');
};

describe('the first-run notice', () => {
  it('prints once on stderr, leaves stdout alone, and is recorded as shown', async () => {
    const first = setup();
    expect(await run(['--version'], first.deps)).toBe(0);
    expect(first.out.join('')).toBe('9.9.9\n');
    expect(first.err.join('')).toBe(`${NOTICE}\n`);
    expect(consentOf({}, first.dir).noticeShown).toBe(true);
    first.err.length = 0;
    first.out.length = 0;
    await run(['--version'], first.deps);
    expect(first.err.join('')).toBe('');
  });

  it('keeps a --json document parseable on stdout, with the notice on stderr only', async () => {
    const { deps, out, err } = setup();
    await run(['telemetry', 'status', '--json'], deps);
    expect(JSON.parse(out.join(''))).toMatchObject({ ok: true, enabled: true });
    expect(err.join('')).toBe(`${NOTICE}\n`);
  });

  it('is not printed for a hook, and a hook run leaves a non-empty stdout exactly as it is without telemetry', async () => {
    // A cached not-found answer and a block policy: the hook answers with a deny, so the comparison is between real output, not two empty ones.
    const hookRun = async (withTelemetry: boolean): Promise<Made & { code: number }> => {
      const made = setup();
      if (!withTelemetry) made.deps.telemetry = undefined;
      const storeDir = join(made.dir, '..', 'sessions');
      mkdirSync(storeDir, { recursive: true });
      writeFileSync(join(storeDir, 'gate-policy.json'), '{"classes":{"not-found":"block"}}');
      const now = new Date(made.deps.now());
      const answer = { kind: 'registry', v: 1, day: now.toISOString().slice(0, 10), ts: now.toISOString(), folder: folderKey(tmpdir()), class: 'npm-package', state: 'not-found', created: null, name: 'ghost-lib', latest: null };
      writeFileSync(join(storeDir, 'gate-registry.jsonl'), `${JSON.stringify(answer)}\n`);
      const call = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install ghost-lib' }, cwd: tmpdir(), permission_mode: 'default', hook_event_name: 'PreToolUse' });
      made.deps.sessions = { storeDir, projectsRoot: join(made.dir, 'projects'), stdin: Readable.from([call]), stdout: { write: () => true } };
      return { ...made, code: await run(['gate', 'hook'], made.deps) };
    };
    const withTelemetry = await hookRun(true);
    const without = await hookRun(false);
    expect(withTelemetry.out.join('')).toContain('"permissionDecision":"deny"');
    expect(withTelemetry.out).toEqual(without.out);
    expect(withTelemetry.code).toBe(without.code);
    expect(withTelemetry.err).toEqual([]);
    expect(consentOf({}, withTelemetry.dir).noticeShown).toBe(false);
  });

  it('is not printed for a hook that fails to parse its arguments either', async () => {
    const { deps, err } = setup();
    await run(['gate', 'hook', '--bogus'], deps);
    expect(err.join('')).not.toContain(NOTICE);
  });

  it('is not claimed when the folder cannot be written, and the run is unaffected', async () => {
    const { deps, out, err, dir } = setup();
    block(dir);
    expect(await run(['--version'], deps)).toBe(0);
    expect(out.join('')).toBe('9.9.9\n');
    expect(err.join('')).toBe('');
  });
});

describe('the off switches', () => {
  it.each([
    ['OARS_TELEMETRY=0', { OARS_TELEMETRY: '0' }],
    ['DO_NOT_TRACK=1', { DO_NOT_TRACK: '1' }],
  ])('%s: no notice, no event, nothing written', async (_name, env) => {
    const { deps, err, dir } = setup(env);
    await run(['--version'], deps);
    expect(err.join('')).toBe('');
    expect(existsSync(dir)).toBe(false);
  });

  it('`off` stops recording and the notice, `on` resumes and prints the notice', async () => {
    const { deps, out, err, dir } = setup();
    await run(['telemetry', 'off'], deps);
    expect(out.join('')).toContain('Telemetry is off');
    expect(err.join('')).toBe('');
    await run(['--version'], deps);
    expect(readSpool(dir)).toEqual([]);
    expect(err.join('')).toBe('');
    out.length = 0;
    await run(['telemetry', 'on'], deps);
    expect(out.join('')).toContain(NOTICE);
    expect(consentOf({}, dir).noticeShown).toBe(true);
    await run(['--version'], deps);
    expect(events(dir).map((event) => field(event, 'data', 'path'))).toEqual([['telemetry', 'on'], []]);
  });

  it('`--json on` carries the notice it records as shown, so a reader of the document sees it', async () => {
    const { deps, out, dir } = setup();
    await run(['--json', 'telemetry', 'on'], deps);
    expect(field(JSON.parse(out.join('')), 'notice')).toBe(NOTICE);
    expect(consentOf({}, dir).noticeShown).toBe(true);
  });

  it('`on` says so when the environment keeps it off', async () => {
    const { deps, out } = setup({ OARS_TELEMETRY: '0' });
    await run(['telemetry', 'on'], deps);
    expect(out.join('')).toContain('stays off in this shell: OARS_TELEMETRY');
  });

  it('`off` reports a folder it cannot write, with the usual exit code', async () => {
    const { deps, err, dir } = setup();
    block(dir);
    expect(await run(['telemetry', 'off'], deps)).toBe(1);
    expect(err.join('')).toContain('Could not save the telemetry setting');
  });
});

describe('oars telemetry status and show', () => {
  it('status reports the switch, the notice, and the spool', async () => {
    const { deps, out } = setup();
    await run(['--version'], deps);
    out.length = 0;
    await run(['telemetry', 'status'], deps);
    const text = out.join('');
    expect(text).toContain('Telemetry is on (on by default).');
    expect(text).toContain('The notice has been shown.');
    expect(text).toMatch(/\d+ events \(\d+ bytes\)/);
    expect(text).toContain('Events are sent to the Many Oars pool or the pool server in OARS_POOL_URL');
  });

  it('status names the switch that turned it off', async () => {
    const { deps, out } = setup({ DO_NOT_TRACK: '1' });
    await run(['telemetry', 'status'], deps);
    expect(out.join('')).toContain('Telemetry is off (by DO_NOT_TRACK).');
  });

  it('show prints the spool exactly as stored, and the same events under --json', async () => {
    const { deps, out, dir } = setup();
    await run(['--version'], deps);
    await run(['--version'], deps);
    const stored = readFileSync(spoolPaths(dir).current, 'utf8');
    out.length = 0;
    await run(['telemetry', 'show'], deps);
    expect(out.join('')).toBe(stored);
    out.length = 0;
    await run(['telemetry', 'show', '--json'], deps);
    expect(field(JSON.parse(out.join('')), 'events')).toHaveLength(stored.trimEnd().split('\n').length + 1);
  });

  it('show says so when the spool is empty', async () => {
    const { deps, out } = setup({ OARS_TELEMETRY: '0' });
    await run(['telemetry', 'show'], deps);
    expect(out.join('')).toContain('The spool is empty');
  });

  it('the telemetry commands need a configured folder', async () => {
    const { deps, err } = setup();
    deps.telemetry = undefined;
    expect(await run(['telemetry', 'status'], deps)).toBe(1);
    expect(err.join('')).toContain('not configured');
  });
});

describe('command events', () => {
  it('records the command path, flag names, duration, exit code, and error class', async () => {
    const { deps, dir } = setup();
    let tick = Date.parse('2026-11-06T10:00:00Z');
    deps.now = () => (tick += 7);
    expect(await run(['sessions', 'recall', '--error', 'x', '--json'], deps)).toBe(1);
    const [event] = events(dir);
    expect(field(event, 'data')).toMatchObject({ path: ['sessions', 'recall'], flags: ['error', 'json'], exitCode: 1, errorClass: 'unexpected' });
    expect(Number(field(event, 'data', 'durationMs'))).toBeGreaterThan(0);
  });

  it('records a successful command with no error class, and a usage error with no path', async () => {
    const { deps, dir } = setup();
    await run(['telemetry', 'status'], deps);
    await run(['not-a-command', '/home/someone/private'], deps);
    const [ok, usage] = events(dir);
    expect(field(ok, 'data')).toMatchObject({ path: ['telemetry', 'status'], flags: [], exitCode: 0 });
    expect(field(ok, 'data', 'errorClass')).toBeUndefined();
    expect(field(usage, 'data')).toMatchObject({ path: [], exitCode: 2, errorClass: 'usage' });
    expect(field(ok, 'dropped')).toBeUndefined();
  });

  it('leaves a path, a URL, and a free-text argument out of the spool', async () => {
    const { deps, dir } = setup();
    const pathValue = 'C:\\Users\\someone\\secret-project\\src\\main.ts';
    const urlValue = 'https://internal.example.com/tenants/42?token=abc123';
    const textValue = 'fix the login bug in the billing service for Acme Corp';
    await run(['--api-url', urlValue, 'sessions', 'recall', '--path', pathValue, '--error', textValue, '--entity', urlValue, '--cwd', pathValue], deps);
    await run(['sessions', 'recall', pathValue, urlValue, textValue], deps);
    const spool = readSpool(dir).join('\n');
    expect(spool).toContain('"apiUrl"');
    for (const secret of ['someone', 'secret-project', 'main.ts', 'internal.example.com', 'tenants', 'abc123', 'login', 'billing', 'Acme']) expect(spool).not.toContain(secret);
  });

  it('leaves the exit code and every byte of output unchanged when the spool cannot be written', async () => {
    const broken = setup();
    block(broken.dir);
    const off = setup({ OARS_TELEMETRY: '0' });
    for (const argv of [['--version'], ['sessions', 'recall', '--error', 'x', '--json'], ['sessions', 'recall'], ['bogus']]) {
      expect(await run(argv, broken.deps)).toBe(await run(argv, off.deps));
    }
    expect(broken.out).toEqual(off.out);
    expect(broken.err).toEqual(off.err);
  });

  it('also holds when the spool file itself is a directory', async () => {
    const broken = setup();
    mkdirSync(spoolPaths(broken.dir).current, { recursive: true });
    const off = setup({ OARS_TELEMETRY: '0' });
    expect(await run(['--version'], broken.deps)).toBe(await run(['--version'], off.deps));
    expect(broken.out).toEqual(off.out);
  });
});
