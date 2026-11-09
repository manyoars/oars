// The first-run event: one per install, sent where the first-run notice is shown, through the same spool and the same opt-out. Every test sets APPDATA to a
// temp folder and confirms the telemetry folder is under it (the store follows it), so no test touches the real one.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run, type RunDeps } from '../cli.js';
import { defaultConfigDir } from '../credentials.js';
import { harness } from '../test-support.js';
import { readSpool } from './spool.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Made {
  deps: RunDeps;
  dir: string;
}

const setup = (env: NodeJS.ProcessEnv = {}): Made => {
  const appData = mkdtempSync(join(tmpdir(), 'oars-first-run-'));
  roots.push(appData);
  const made = harness({ APPDATA: appData, ...env });
  const configDir = defaultConfigDir(made.deps.env, 'win32', 'C:\\unused-home');
  expect(configDir).toBe(appData);
  const dir = join(configDir, 'oars', 'telemetry');
  made.deps.telemetry = { dir, platform: 'linux' };
  return { deps: made.deps, dir };
};

const spooled = (dir: string): { type: string; data: object }[] =>
  readSpool(dir).map((line) => {
    const event: unknown = JSON.parse(line);
    const type: unknown = typeof event === 'object' && event !== null ? Reflect.get(event, 'type') : undefined;
    const data: unknown = typeof event === 'object' && event !== null ? Reflect.get(event, 'data') : undefined;
    return { type: String(type), data: typeof data === 'object' && data !== null ? data : {} };
  });

const firstRuns = (dir: string): object[] => spooled(dir).filter((event) => event.type === 'first-run').map((event) => event.data);

describe('the first-run event', () => {
  it('is spooled once, by the run that shows the notice, before that run\'s command event', async () => {
    const { deps, dir } = setup();
    expect(await run(['--version'], deps)).toBe(0);
    expect(spooled(dir).map((event) => event.type)).toEqual(['first-run', 'command']);
  });

  it('is not spooled again by a second run, or a third', async () => {
    const { deps, dir } = setup();
    await run(['--version'], deps);
    await run(['--version'], deps);
    await run(['--version'], deps);
    expect(firstRuns(dir)).toHaveLength(1);
    expect(spooled(dir).map((event) => event.type)).toEqual(['first-run', 'command', 'command', 'command']);
  });

  it.each([
    ['OARS_TELEMETRY=0', { OARS_TELEMETRY: '0' }],
    ['DO_NOT_TRACK=1', { DO_NOT_TRACK: '1' }],
  ])('is not spooled by an install that opted out with %s', async (_name, env) => {
    const { deps, dir } = setup(env);
    await run(['--version'], deps);
    expect(spooled(dir)).toEqual([]);
  });

  it('is not spooled by an install that turned telemetry off with `oars telemetry off`, and not after more runs', async () => {
    const { deps, dir } = setup();
    await run(['telemetry', 'off'], deps);
    await run(['--version'], deps);
    await run(['--version'], deps);
    expect(spooled(dir)).toEqual([]);
  });

  it('is not spooled by a hook, which shows no notice', async () => {
    const { deps, dir } = setup();
    await run(['gate', 'hook', '--bogus'], deps);
    expect(firstRuns(dir)).toEqual([]);
  });

  it('is not spooled when the telemetry folder cannot be written, so the notice is not claimed either', async () => {
    const { deps, dir } = setup();
    mkdirSync(join(dir, '..'), { recursive: true });
    writeFileSync(dir, 'a file where the folder should be');
    expect(await run(['--version'], deps)).toBe(0);
    expect(readSpool(dir)).toEqual([]);
  });

  it('is not spooled when the run has no telemetry folder', async () => {
    const { deps, dir } = setup();
    deps.telemetry = undefined;
    await run(['--version'], deps);
    expect(readSpool(dir)).toEqual([]);
  });
});
