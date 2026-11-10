// The first-run event: one per install, sent where the first-run notice is shown, through the same spool and the same opt-out. Every test sets APPDATA to a
// temp folder and confirms the telemetry folder is under it (the store follows it), so no test touches the real one.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run, type RunDeps } from '../cli.js';
import { defaultConfigDir } from '../credentials.js';
import { harness } from '../test-support.js';
import { NOTICE_VERSION, shownNoticeVersion } from './consent.js';
import { finishTelemetry } from './observe.js';
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

const dataField = (event: { data: object }, name: string): unknown => Reflect.get(event.data, name);

const firstRuns = (dir: string): object[] => spooled(dir).filter((event) => event.type === 'first-run').map((event) => event.data);

describe('the first-run event', () => {
  it('waits for a command: --version prints one line and no notice, --help prints no notice, and the next command shows it once', async () => {
    const made = setup();
    const out: string[] = [];
    const err: string[] = [];
    made.deps.io = { stdout: (text) => out.push(text), stderr: (text) => err.push(text) };
    expect(await run(['--version'], made.deps)).toBe(0);
    expect(out.join('').trimEnd().split('\n')).toEqual(['9.9.9']);
    expect(err).toEqual([]);
    await run(['--help'], made.deps);
    await run(['sessions', '--help'], made.deps);
    expect(err).toEqual([]);
    expect(firstRuns(made.dir)).toEqual([]);
    await run(['logout'], made.deps);
    expect(err.join('')).toContain('telemetry');
    expect(firstRuns(made.dir)).toHaveLength(1);
  });

  it('is spooled once, by the run that shows the notice, before that run\'s command event', async () => {
    const { deps, dir } = setup();
    expect(await run(['logout'], deps)).toBe(0);
    expect(spooled(dir).map((event) => event.type)).toEqual(['first-run', 'command']);
  });

  it('is not spooled again by a second run, or a third', async () => {
    const { deps, dir } = setup();
    await run(['logout'], deps);
    await run(['logout'], deps);
    await run(['logout'], deps);
    expect(firstRuns(dir)).toHaveLength(1);
    expect(spooled(dir).map((event) => event.type)).toEqual(['first-run', 'command', 'command', 'command']);
  });

  it.each([
    ['OARS_TELEMETRY=0', { OARS_TELEMETRY: '0' }],
    ['DO_NOT_TRACK=1', { DO_NOT_TRACK: '1' }],
  ])('is not spooled by an install that opted out with %s', async (_name, env) => {
    const { deps, dir } = setup(env);
    await run(['logout'], deps);
    expect(spooled(dir)).toEqual([]);
  });

  it('is not spooled by an install that turned telemetry off with `oars telemetry off`, and not after more runs', async () => {
    const { deps, dir } = setup();
    await run(['telemetry', 'off'], deps);
    await run(['logout'], deps);
    await run(['logout'], deps);
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
    expect(await run(['logout'], deps)).toBe(0);
    expect(readSpool(dir)).toEqual([]);
  });

  it('is not spooled when the run has no telemetry folder', async () => {
    const { deps, dir } = setup();
    deps.telemetry = undefined;
    await run(['logout'], deps);
    expect(readSpool(dir)).toEqual([]);
  });
});

describe('`oars telemetry on` as the first command', () => {
  // `on` prints the notice itself and records it shown, so the run that follows finds the notice already shown: the event has to be sent from `on`.
  it('is spooled once, before that run\'s command event, as it is by any other first command', async () => {
    const { deps, dir } = setup();
    expect(await run(['telemetry', 'on'], deps)).toBe(0);
    expect(spooled(dir).map((event) => event.type)).toEqual(['first-run', 'command']);
    expect(firstRuns(dir)).toEqual([{ ci: 'none', surface: 'unknown' }]);
  });

  it('is not spooled again by later runs, or by `on` run again', async () => {
    const { deps, dir } = setup();
    await run(['telemetry', 'on'], deps);
    await run(['telemetry', 'on'], deps);
    await run(['logout'], deps);
    expect(firstRuns(dir)).toHaveLength(1);
  });

  it('is not spooled when an earlier run already showed the notice', async () => {
    const { deps, dir } = setup();
    await run(['logout'], deps);
    await run(['telemetry', 'on'], deps);
    expect(firstRuns(dir)).toHaveLength(1);
    expect(spooled(dir).map((event) => event.type)).toEqual(['first-run', 'command', 'command']);
  });

  it('is not spooled again for an install that saw an older notice, which telemetry on re-marks with the current version', async () => {
    const { deps, dir } = setup();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ noticeShownAt: '2026-11-01T00:00:00.000Z' }));
    expect(await run(['telemetry', 'on'], deps)).toBe(0);
    expect(firstRuns(dir)).toEqual([]);
    expect(spooled(dir).map((event) => event.type)).toEqual(['command']);
    expect(shownNoticeVersion(dir)).toBe(NOTICE_VERSION);
  });

  it('is spooled when `off` came first and `on` turns telemetry back on, since `off` shows no notice', async () => {
    const { deps, dir } = setup();
    await run(['telemetry', 'off'], deps);
    await run(['telemetry', 'on'], deps);
    expect(firstRuns(dir)).toHaveLength(1);
  });

  it.each([
    ['OARS_TELEMETRY=0', { OARS_TELEMETRY: '0' }],
    ['DO_NOT_TRACK=1', { DO_NOT_TRACK: '1' }],
  ])('is not spooled when %s keeps telemetry off in this shell', async (_name, env) => {
    const { deps, dir } = setup(env);
    expect(await run(['telemetry', 'on'], deps)).toBe(0);
    expect(spooled(dir)).toEqual([]);
  });
});

describe('the ci field', () => {
  it('rides on the first-run event and on every command event, as a closed word', async () => {
    const { deps, dir } = setup({ GITHUB_ACTIONS: 'true' });
    await run(['logout'], deps);
    await run(['logout'], deps);
    expect(spooled(dir).map((event) => [event.type, dataField(event, 'ci')])).toEqual([
      ['first-run', 'github-actions'],
      ['command', 'github-actions'],
      ['command', 'github-actions'],
    ]);
  });

  it('reads none when no CI variable is set', async () => {
    const { deps, dir } = setup();
    await run(['logout'], deps);
    expect(spooled(dir).map((event) => dataField(event, 'ci'))).toEqual(['none', 'none']);
  });

  it('never puts the value of the variable in the spool', async () => {
    const { deps, dir } = setup({ CI: '/home/someone/secret-value' });
    await run(['logout'], deps);
    expect(readSpool(dir).join(' ')).not.toContain('secret-value');
    expect(spooled(dir).map((event) => dataField(event, 'ci'))).toEqual(['other', 'other']);
  });
});

describe('the surface field', () => {
  const finish = (made: Made, installPath: string): void => {
    finishTelemetry(made.deps, ['logout'], { path: [], flags: [] }, made.deps.now(), 0, installPath);
  };

  it('rides on the first-run event only, as the word for where this copy was installed', () => {
    const made = setup();
    finish(made, '/usr/lib/node_modules/@manyoars/oars/dist/bin.js');
    finish(made, '/usr/lib/node_modules/@manyoars/oars/dist/bin.js');
    expect(spooled(made.dir).map((event) => [event.type, dataField(event, 'surface')])).toEqual([
      ['first-run', 'npm-global'],
      ['command', undefined],
      ['command', undefined],
    ]);
  });

  it('reads the package manager agent from the run environment, so a package runner reads as npx', () => {
    const made = setup({ npm_config_user_agent: 'pnpm/9.12.0 npm/? node/v22.11.0 linux x64' });
    finish(made, '/home/someone/.cache/pnpm/dlx/abc123/19c2/node_modules/@manyoars/oars/dist/bin.js');
    expect(firstRuns(made.dir)).toEqual([{ ci: 'none', surface: 'npx' }]);
  });

  it('reads unknown for a copy it cannot place, which is what a run from this source tree is', async () => {
    const made = setup();
    await run(['logout'], made.deps);
    expect(firstRuns(made.dir)).toEqual([{ ci: 'none', surface: 'unknown' }]);
  });

  it('never puts the path or the agent in the spool', () => {
    const made = setup({ npm_config_user_agent: 'npm/10.9.0 node/v22.11.0 secret-agent-text' });
    finish(made, '/home/someone-private/.npm/_npx/abc/node_modules/@manyoars/oars/dist/bin.js');
    const spool = readSpool(made.dir).join(' ');
    expect(spool).not.toContain('someone-private');
    expect(spool).not.toContain('secret-agent-text');
    expect(firstRuns(made.dir)).toEqual([{ ci: 'none', surface: 'npx' }]);
  });
});

