import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { MISS_TEXT } from './recall-render.js';
import { cleanup, stage } from './test-support.js';
import { DEMO_CWD, DEMO_ERROR } from './try-demo.js';
import { SYNTHETIC_LABEL, TRY_PREFIX } from './try.js';

const homes: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  cleanup();
  removeTestDirs();
});

const leftovers = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith(TRY_PREFIX));

describe('oars sessions try', () => {
  it('runs recall, books, and the hook line over made-up sessions, labels them, leaves the real store alone, and removes its own store', async () => {
    // A machine with a real store: the config and home folders point at temp paths, and so does the runtime the command is handed.
    const appdata = mkdtempSync(join(tmpdir(), 'oars-try-appdata-'));
    const home = mkdtempSync(join(tmpdir(), 'oars-try-home-'));
    homes.push(appdata, home);
    vi.stubEnv('APPDATA', appdata);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const staged = stage();
    const h = harness();
    h.deps.sessions = staged.runtime;
    const before = leftovers();

    expect(await run(['sessions', 'try'], h.deps)).toBe(ExitCode.OK);

    const text = h.out.join('');
    expect(text).toContain(SYNTHETIC_LABEL);
    // Every section is headed as synthetic, not only the first line.
    expect(text.match(new RegExp(`== (Deposit|Recall|Books|Hook line) \\(${SYNTHETIC_LABEL}\\) ==`, 'g'))).toHaveLength(4);
    expect(text).toContain('Deposited 3 sessions');
    expect(text).toContain(`oars sessions recall --error "${DEMO_ERROR}"`);
    expect(text).not.toContain(MISS_TEXT);
    expect(text).not.toContain('No matching signature in the store.');
    expect(text).not.toContain('Nothing recurs in this repository yet.');
    expect(text).toContain(`--cwd ${DEMO_CWD}`);
    // The real store, the config folder, and the home folder are untouched, and no throwaway store is left behind.
    expect(existsSync(staged.storeDir)).toBe(false);
    expect(readdirSync(appdata)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
    expect(leftovers()).toEqual(before);
  });

  it('prints one JSON document that says it is synthetic', async () => {
    const h = harness();
    expect(await run(['--json', 'sessions', 'try'], h.deps)).toBe(ExitCode.OK);
    const document: unknown = JSON.parse(h.out.join(''));
    expect(document).toMatchObject({ ok: true, synthetic: true, label: SYNTHETIC_LABEL });
    expect(leftovers()).toEqual([]);
  });
});
