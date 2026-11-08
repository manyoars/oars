import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { markNoticeShown } from '../telemetry/consent.js';
import { harness, removeTestDirs } from '../test-support.js';
import { MISS_TEXT } from './recall-render.js';
import { cleanup, stage } from './test-support.js';
import { DEMO_CWD, DEMO_ERROR } from './try-demo.js';
import { SYNTHETIC_LABEL, sessionsTry, TRY_PREFIX } from './try.js';

const scratches: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
  cleanup();
  removeTestDirs();
});

interface Scratch {
  /** What `os.tmpdir()` answers while the test runs: only this run's own folders can appear in it. */
  temp: string;
  appdata: string;
  home: string;
}

/** A per-test OS temp folder, config folder, and home folder, with the environment pointing at them; none of the names carries the `try` prefix. */
const isolate = (): Scratch => {
  const base = mkdtempSync(join(tmpdir(), 'oars-scratch-'));
  scratches.push(base);
  const scratch = { temp: join(base, 'temp'), appdata: join(base, 'appdata'), home: join(base, 'home') };
  for (const dir of Object.values(scratch)) mkdirSync(dir);
  vi.stubEnv('TEMP', scratch.temp);
  vi.stubEnv('TMP', scratch.temp);
  vi.stubEnv('TMPDIR', scratch.temp);
  vi.stubEnv('APPDATA', scratch.appdata);
  vi.stubEnv('HOME', scratch.home);
  vi.stubEnv('USERPROFILE', scratch.home);
  return scratch;
};

const leftovers = (scratch: Scratch): string[] => readdirSync(scratch.temp).filter((name) => name.startsWith(TRY_PREFIX));

describe('oars sessions try', () => {
  it('runs recall, books, and the hook line over made-up sessions, labels them, leaves the real store alone, and removes its own store', async () => {
    const scratch = isolate();
    const staged = stage();
    // The real store already holds a file: the command is handed its runtime and must leave the bytes as they were.
    mkdirSync(staged.storeDir);
    writeFileSync(join(staged.storeDir, 'sentinel'), 'keep');
    const h = harness();
    h.deps.sessions = staged.runtime;

    expect(await run(['sessions', 'try'], h.deps)).toBe(ExitCode.OK);

    const text = h.out.join('');
    expect(text).toContain(SYNTHETIC_LABEL);
    // Every section is headed as synthetic, not only the first line.
    expect(text.split(`(${SYNTHETIC_LABEL}) ==`)).toHaveLength(5);
    expect(text).toContain('Deposited 3 sessions');
    expect(text).toContain(`oars sessions recall --error "${DEMO_ERROR}"`);
    expect(text).not.toContain(MISS_TEXT);
    expect(text).not.toContain('No matching signature in the store.');
    expect(text).not.toContain('Nothing recurs in this repository yet.');
    expect(text).toContain(`--cwd ${DEMO_CWD}`);
    // The real store, the config folder, and the home folder are untouched, and no throwaway store is left behind.
    expect(readdirSync(staged.storeDir)).toEqual(['sentinel']);
    expect(readFileSync(join(staged.storeDir, 'sentinel'), 'utf8')).toBe('keep');
    expect(readdirSync(scratch.appdata)).toEqual([]);
    expect(readdirSync(scratch.home)).toEqual([]);
    expect(leftovers(scratch)).toEqual([]);
  });

  it('prints one JSON document that says it is synthetic', async () => {
    const scratch = isolate();
    const h = harness();
    expect(await run(['--json', 'sessions', 'try'], h.deps)).toBe(ExitCode.OK);
    const document: unknown = JSON.parse(h.out.join(''));
    expect(document).toMatchObject({ ok: true, synthetic: true, label: SYNTHETIC_LABEL });
    expect(leftovers(scratch)).toEqual([]);
  });

  it('removes its store when a step throws', async () => {
    const scratch = isolate();
    await expect(
      sessionsTry({
        now: () => {
          throw new Error('clock failed');
        },
      }),
    ).rejects.toThrow('clock failed');
    expect(leftovers(scratch)).toEqual([]);
  });

  it('starts no daily telemetry send, so it makes no network call even with telemetry on, the notice shown, and a send due', async () => {
    isolate();
    const spawned: string[] = [];
    const h = harness();
    const dir = mkdtempSync(join(tmpdir(), 'oars-telemetry-'));
    scratches.push(dir);
    expect(markNoticeShown(dir, () => 0)).toBe(true);
    const telemetry = { dir, platform: 'linux' as const, spawnSend: (target: string) => spawned.push(target) };
    h.deps.telemetry = telemetry;

    expect(await run(['sessions', 'try'], h.deps)).toBe(ExitCode.OK);
    expect(spawned).toEqual([]);

    // The same setup starts a send for another command, so the empty list above is the command's doing and not the setup's.
    expect(await run(['telemetry', 'status'], { ...h.deps, telemetry })).toBe(ExitCode.OK);
    expect(spawned).toEqual([dir]);
  });
});
