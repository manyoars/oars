// The built `dist/bin.js` run as the harness runs it: `gate hook` with a payload on stdin, in a temp home. It proves the dispatch in `bin.ts` and the process-level exit 0 with
// empty stdout, which the in-process tests cannot. Like `pack.test.ts` it reads `dist/`, which the root `check` builds before the tests run; without a build it is skipped.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startFill, type FillAsk } from './hook-fill.js';
import { folderKey } from './record.js';

const bin = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));
const helperBin = fileURLToPath(new URL('../../dist/gate/hook-fill-main.js', import.meta.url));
const made: string[] = [];
// A process the hook left behind (the cut ask's shell, a helper's manager) can still hold a folder for a moment on Windows, so a removal that fails with EPERM or EBUSY is tried
// again: `rmSync` waits `retryDelay` longer after each failure, so four retries at 200 ms wait 0.2, 0.4, 0.6, and 0.8 s, two seconds in all. One that still fails throws: cleanup never
// hides what the test itself found.
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
});

// A store holding a not-found answer for `ghost-lib` read just now in this payload's folder, so the hook reads it from the cache and the test never races the 650 ms cut.
const seededStore = (home: string): string => {
  const store = join(home, 'oars', 'sessions');
  mkdirSync(store, { recursive: true });
  const now = new Date();
  const answer = { kind: 'registry', v: 1, day: now.toISOString().slice(0, 10), ts: now.toISOString(), folder: folderKey(tmpdir()), class: 'npm-package', state: 'not-found', created: null, name: 'ghost-lib', latest: null };
  writeFileSync(join(store, 'gate-registry.jsonl'), `${JSON.stringify(answer)}\n`);
  return store;
};

const envFor = (home: string, pathHead?: string): NodeJS.ProcessEnv => ({
  PATH: [pathHead, process.env.PATH].filter((part) => part !== undefined && part !== '').join(delimiter),
  APPDATA: home,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: home,
});

const runHook = (input: string, extra: readonly string[] = [], pathHead?: string, given?: string): { status: number | null; stdout: string; home: string } => {
  const home = given ?? mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
  if (given === undefined) made.push(home);
  const result = spawnSync(process.execPath, [bin, 'gate', 'hook', ...extra], { input, encoding: 'utf8', timeout: 30_000, cwd: home, env: envFor(home, pathHead) });
  return { status: result.status, stdout: result.stdout, home };
};

// A folder holding `npm` and `npm.cmd` that only write a marker. First on PATH, it shows whether the hook starts an `npm view` child: the marker exists if it did.
const fakeNpm = (): { folder: string; marker: string } => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-gate-fakenpm-'));
  made.push(folder);
  const marker = join(folder, 'npm-started');
  writeFileSync(join(folder, 'npm'), `#!/bin/sh\necho started > "${marker}"\n`);
  chmodSync(join(folder, 'npm'), 0o755);
  writeFileSync(join(folder, 'npm.cmd'), `@echo off\r\necho started> "${marker}"\r\n`);
  return { folder, marker };
};

// A manager that answers 2 s late, past the hook's 650 ms cut: a script that sleeps, then prints what `npm view` prints. It logs each start and each finish, one line apiece, so a
// run that was killed leaves a start and no finish.
const slowNpm = (): { folder: string; log: string } => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-gate-slownpm-'));
  made.push(folder);
  const log = join(folder, 'npm-starts');
  const answer = '{"dist-tags.latest":"1.0.0","time.created":"2020-01-01T00:00:00.000Z"}';
  writeFileSync(join(folder, 'npm'), `#!/bin/sh\necho started >> "${log}"\nsleep 2\necho ended >> "${log}"\necho '${answer}'\n`);
  chmodSync(join(folder, 'npm'), 0o755);
  writeFileSync(join(folder, 'npm.cmd'), `@echo off\r\necho started>> "${log}"\r\nping -n 3 127.0.0.1 >nul\r\necho ended>> "${log}"\r\necho ${answer}\r\n`);
  return { folder, log };
};

// A manager that is down: it takes 2 s, then fails the way `npm view` does against an unreachable registry. Same log as `slowNpm`.
const downNpm = (): { folder: string; log: string } => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-gate-downnpm-'));
  made.push(folder);
  const log = join(folder, 'npm-starts');
  writeFileSync(join(folder, 'npm'), `#!/bin/sh\necho started >> "${log}"\nsleep 2\necho ended >> "${log}"\necho 'npm error code ECONNREFUSED' >&2\nexit 1\n`);
  chmodSync(join(folder, 'npm'), 0o755);
  writeFileSync(join(folder, 'npm.cmd'), `@echo off\r\necho started>> "${log}"\r\nping -n 3 127.0.0.1 >nul\r\necho ended>> "${log}"\r\necho npm error code ECONNREFUSED 1>&2\r\nexit /b 1\r\n`);
  return { folder, log };
};

// The `start` `startFill` is given, run as the hook runs it but to its end: the built helper asks the manager on PATH and writes what it learns, and has finished when this returns.
// `startFill` is the code the hook calls to take the name's lock and start the helper, so this hand-off is the real one without the race for the hook's 650 ms cut: under load a
// hook can end before its cut (no lock, no helper) or skip its own ask, and a test that depends on the first sight reaching the lock then says nothing about what follows it.
// `startFill` swallows what `start` throws, so the helper's exit status is recorded for the test to assert after the hand-off: an assertion inside `start` could never fail it, and
// an empty list shows `start` never ran.
const helperRun = (home: string, pathHead: string, statuses: (number | null)[]) => (storeDir: string, ask: FillAsk): void => {
  const helper = spawnSync(process.execPath, [helperBin, storeDir, ask.class, ask.name, ask.cwd], { encoding: 'utf8', timeout: 30_000, cwd: home, env: envFor(home, pathHead) });
  statuses.push(helper.status);
};

/** Waits, by polling, until `done` holds or `ms` have passed; the caller asserts what it waited for, so a timeout reads as that assertion failing. */
const until = async (done: () => boolean, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise<void>((resolve) => setTimeout(resolve, 50));
};

const lockFiles = (store: string): string[] => (existsSync(store) ? readdirSync(store).filter((name) => name.endsWith('.lock')) : []);

const rowsOf = (home: string): unknown[] => {
  const [file] = crossingFiles(home);
  return file === undefined
    ? []
    : readFileSync(join(home, file), 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line): unknown => JSON.parse(line));
};

/** How many built-hook sights a case runs before it says no hand-off happened. */
const MAX_SIGHTS = 10;

// Runs the built hook's sights of one name until one hands the name off. A sight ends one of three ways: it takes the name's lock and starts the helper (the lock, or the answer the helper
// kept, is on disk when the hook exits); it ends at its own deadline with the ask stopped (no lock, no helper, no answer: node's start or the blocking spawn used the budget); or it is
// cut before it asks at all. The second and third leave the name unasked, and the next sight asks once itself, so a store with no lock and no kept answer sends the case to its next
// sight, at most MAX_SIGHTS, and then fails. Returns the number of sights run, the last of which handed off.
const sightsToHandOff = (payload: string, npm: { folder: string }, home: string, store: string): number => {
  for (let sight = 1; sight <= MAX_SIGHTS; sight += 1) {
    const result = runHook(payload.replace('"u1"', `"u${String(sight)}"`), [], npm.folder, home);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    if (lockFiles(store).length > 0 || existsSync(join(store, 'gate-registry.jsonl'))) return sight;
  }
  return expect.unreachable(`no sight of ${String(MAX_SIGHTS)} took the lock or started the helper`);
};

// One sight after the hand-off, run again if the box was so loaded that the hook was ended before it wrote its row (or, when `printed` is set, before it printed): with the lock or the
// answer kept it asks nothing, so a repeat can start no manager. At most MAX_SIGHTS, then the case fails. Returns the sight's stdout, so a case that expects a note or a deny reads it.
const sightWithRow = (payload: string, id: string, npm: { folder: string }, home: string, printed = false): string => {
  for (let tries = 0; tries < MAX_SIGHTS; tries += 1) {
    const before = rowsOf(home).length;
    const result = runHook(payload.replace('"u1"', `"${id}"`), [], npm.folder, home);
    expect(result.status).toBe(0);
    if (!printed) expect(result.stdout).toBe('');
    if (rowsOf(home).length > before && (!printed || result.stdout !== '')) return result.stdout;
  }
  return expect.unreachable(`no row or no output in ${String(MAX_SIGHTS)} sights`);
};

/** How many lines of the manager's log read `word`. */
const logged = (log: string, word: 'started' | 'ended'): number => (existsSync(log) ? readFileSync(log, 'utf8').split(/\r?\n/).filter((line) => line.trim() === word).length : 0);

// A manager that answers an `E404` at once, as `npm view` does for a name the registry it is configured for does not have.
const missingNpm = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-gate-missingnpm-'));
  made.push(folder);
  writeFileSync(join(folder, 'npm'), `#!/bin/sh\necho 'npm error code E404' >&2\nexit 1\n`);
  chmodSync(join(folder, 'npm'), 0o755);
  writeFileSync(join(folder, 'npm.cmd'), `@echo off\r\necho npm error code E404 1>&2\r\nexit /b 1\r\n`);
  return folder;
};

const crossingFiles = (home: string): string[] => readdirSync(home, { recursive: true, encoding: 'utf8' }).filter((path) => path.endsWith('crossings.jsonl'));

describe.skipIf(!existsSync(bin))('the built oars gate hook', () => {
  it('exits 0 with empty stdout on bad stdin, and writes no record', () => {
    for (const input of ['', 'not json', '{"tool_name":', '[]']) {
      const result = runHook(input);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(crossingFiles(result.home)).toEqual([]);
    }
  });

  it('shows the command description for `gate hook --help`, as it does for any other command', () => {
    // Only the bare `oars gate hook` goes to the hook entry; an argument sends it to the full CLI, whose help names the hook.
    const result = runHook('', ['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PreToolUse hook');
    expect(crossingFiles(result.home)).toEqual([]);
  });

  it('records one row for a crossing, still with empty stdout and exit 0', () => {
    // yarn is never asked of the registry (ASKED_PROGRAMS), so no `npm view` child outlives the test and writes into the temp home after its cleanup.
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'yarn add left-pad' }, cwd: tmpdir(), permission_mode: 'default' });
    const npm = fakeNpm();
    const home = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
    made.push(home);
    // Run again when a loaded box ended the hook before it wrote: nothing here asks the manager, so a repeat can start none.
    expect(sightWithRow(payload, 'u1', npm, home)).toBe('');
    expect(existsSync(npm.marker)).toBe(false);
    const rows = rowsOf(home);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'crossing', via: 'hook', name: 'left-pad', registryState: 'not-read' });
  });

  // The built hook takes the sight and starts the helper itself, as the harness runs it. `sightsToHandOff` (above) runs sights until one hands off and says what a sight can be, so the cases pin
  // what follows exactly: at most two starts a sight, the helper's single finish, the lock or the cache it leaves, no start after the hand-off, and a row on every sight after it.
  it('fills the cache after a cut ask: the built hook starts the helper, and the sight after it reads found and asks nothing', async () => {
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install slow-lib' }, cwd: tmpdir(), permission_mode: 'default' });
    const npm = slowNpm();
    const home = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
    made.push(home);
    const store = join(home, 'oars', 'sessions');
    const sights = sightsToHandOff(payload, npm, home, store);
    // The helper is detached: it has finished when it has logged its end, kept its answer, and let go of the lock.
    await until(() => logged(npm.log, 'ended') >= 1 && existsSync(join(store, 'gate-registry.jsonl')) && lockFiles(store).length === 0);
    expect(logged(npm.log, 'ended')).toBe(1);
    expect(existsSync(join(store, 'gate-registry.jsonl'))).toBe(true);
    expect(lockFiles(store)).toEqual([]);
    const asked = logged(npm.log, 'started');
    expect(asked).toBeGreaterThanOrEqual(1);
    expect(asked).toBeLessThanOrEqual(2 * sights);
    sightWithRow(payload, 'u-after', npm, home);
    expect(logged(npm.log, 'started')).toBe(asked);
    // A sight ended by its deadline may leave no row, so the count is a range; the sight after the hand-off wrote one, which reads the kept answer.
    const rows = rowsOf(home);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.length).toBeLessThanOrEqual(sights + 1);
    for (const row of rows.slice(0, -1)) expect(row).toMatchObject({ registryState: 'not-read' });
    expect(rows.at(-1)).toMatchObject({ registryState: 'found' });
  }, 60_000);

  it('starts no new ask on later sights while the lock is held, after a down manager', async () => {
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install down-lib' }, cwd: tmpdir(), permission_mode: 'default' });
    const npm = downNpm();
    const home = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
    made.push(home);
    const store = join(home, 'oars', 'sessions');
    const sights = sightsToHandOff(payload, npm, home, store);
    // A failed ask keeps its lock, so the helper is done when it has logged its end with the lock still there.
    await until(() => logged(npm.log, 'ended') >= 1 && lockFiles(store).length === 1);
    expect(logged(npm.log, 'ended')).toBe(1);
    expect(lockFiles(store)).toHaveLength(1);
    const asked = logged(npm.log, 'started');
    expect(asked).toBeGreaterThanOrEqual(1);
    expect(asked).toBeLessThanOrEqual(2 * sights);
    // The lock is held and fresh, so neither later sight asks the manager: the log shows no start beyond the sights up to the hand-off.
    sightWithRow(payload, 'u-after-1', npm, home);
    sightWithRow(payload, 'u-after-2', npm, home);
    expect(logged(npm.log, 'started')).toBe(asked);
    expect(lockFiles(store)).toHaveLength(1);
    // A sight ended by its deadline may leave no row, so the count is a range; the two sights after the hand-off each wrote one.
    const rows = rowsOf(home);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThanOrEqual(sights + 2);
    for (const row of rows) expect(row).toMatchObject({ registryState: 'not-read' });
  }, 60_000);

  // The same two outcomes through `startFill` and the built helper, without the hook's first sight: the hand-off is the code the hook calls, and this holds even on a box so loaded that the
  // first sight never reaches its cut.
  it('hands a cut ask to the built helper through startFill, which fills the cache and lets go of the lock', async () => {
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install slow-lib' }, cwd: tmpdir(), permission_mode: 'default' });
    const npm = slowNpm();
    const home = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
    made.push(home);
    const store = join(home, 'oars', 'sessions');
    const statuses: (number | null)[] = [];
    await startFill(store, { class: 'npm-package', name: 'slow-lib', cwd: tmpdir() }, Date.now(), helperRun(home, npm.folder, statuses));
    expect(statuses).toEqual([0]);
    // One ask for the name: the helper's, which finished and kept its answer, and let go of the lock.
    expect(existsSync(join(store, 'gate-registry.jsonl'))).toBe(true);
    expect(logged(npm.log, 'started')).toBe(1);
    expect(logged(npm.log, 'ended')).toBe(1);
    expect(lockFiles(store)).toEqual([]);
    sightWithRow(payload, 'u1', npm, home);
    expect(logged(npm.log, 'started')).toBe(1);
    expect(rowsOf(home)).toMatchObject([{ registryState: 'found' }]);
  }, 60_000);

  it('keeps the lock after a down manager answers the helper startFill started, so later sights start no ask', async () => {
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install down-lib' }, cwd: tmpdir(), permission_mode: 'default' });
    const npm = downNpm();
    const home = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
    made.push(home);
    const store = join(home, 'oars', 'sessions');
    const statuses: (number | null)[] = [];
    await startFill(store, { class: 'npm-package', name: 'down-lib', cwd: tmpdir() }, Date.now(), helperRun(home, npm.folder, statuses));
    expect(statuses).toEqual([0]);
    expect(logged(npm.log, 'started')).toBe(1);
    expect(logged(npm.log, 'ended')).toBe(1);
    expect(lockFiles(store)).toHaveLength(1);
    sightWithRow(payload, 'u2', npm, home);
    sightWithRow(payload, 'u3', npm, home);
    expect(logged(npm.log, 'started')).toBe(1);
    expect(lockFiles(store)).toHaveLength(1);
    expect(rowsOf(home)).toMatchObject([{ registryState: 'not-read' }, { registryState: 'not-read' }]);
  }, 60_000);

  it('prints a labeled deny on stdout and exits 0 when the policy says block and the manager answered not found', () => {
    const home = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
    made.push(home);
    const store = seededStore(home);
    writeFileSync(join(store, 'gate-policy.json'), '{"classes":{"not-found":"block"}}');
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install ghost-lib' }, cwd: tmpdir(), permission_mode: 'default' });
    const stdout = sightWithRow(payload, 'u1', { folder: missingNpm() }, home, true);
    const output: unknown = JSON.parse(stdout);
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Blocked by your gate policy: ghost-lib was not found in the registry your package manager uses.',
      },
    });
    expect(rowsOf(home).at(-1)).toMatchObject({ name: 'ghost-lib', registryState: 'not-found', arm: 'none', lineShown: 'not-found-block', policy: 'file' });
  });

  it('does not deny the same name under the default policy: it notes it, with the holdback off so the note always shows', () => {
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install ghost-lib' }, cwd: tmpdir(), permission_mode: 'default' });
    const npm = { folder: missingNpm() };
    // A hook ended after it noted the name but before it printed leaves the name noted, so a repeat in the same home stays silent: each try is a fresh home.
    let stdout = '';
    for (let tries = 0; tries < MAX_SIGHTS && stdout === ''; tries += 1) {
      const home = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
      made.push(home);
      writeFileSync(join(seededStore(home), 'gate-policy.json'), '{"holdbackPercent":0}');
      const result = runHook(payload, [], npm.folder, home);
      expect(result.status).toBe(0);
      stdout = result.stdout;
    }
    expect(stdout).not.toBe('');
    expect(stdout).not.toContain('deny');
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Registry note: ghost-lib was not found in the registry your package manager uses.' },
    });
  });
});
