// The built `dist/bin.js` run as the harness runs it: `gate hook` with a payload on stdin, in a temp home. It proves the dispatch in `bin.ts` and the process-level exit 0 with
// empty stdout, which the in-process tests cannot. Like `pack.test.ts` it reads `dist/`, which the root `check` builds before the tests run; without a build it is skipped.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DEADLINE_ENV, HANDOFF_MARK_ENV } from './hook.js';
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

// A built hook counts node's own start inside its 800 ms, and a loaded box can spend all of it there, so no sight would reach the code a case is about. Each hook is given this much
// instead. The cases that need no ask (a kept answer, a held lock, a command that is never asked) end at once whatever it is. The one that hands a name off asks a manager that
// cannot answer (`gatedNpm` waits for the test) and starts the hand-off at `HANDOFF_MARK_MS`, so the test, not this deadline, ends that hook once the hand-off is seen: node
// would have to take about 29 s to start for the hand-off to be missed, where the slowest start seen on a loaded box is under 5 s.
const HOOK_DEADLINE_MS = 30_000;
// Where the hand-off starts in a hook given `HOOK_DEADLINE_MS`, on the hook's own clock (`HANDOFF_MARK_ENV`): early, so the lock and the helper's spawn have the rest of the deadline.
const HANDOFF_MARK_MS = 1_000;

const envFor = (home: string, pathHead?: string): NodeJS.ProcessEnv => ({
  [DEADLINE_ENV]: String(HOOK_DEADLINE_MS),
  [HANDOFF_MARK_ENV]: String(HANDOFF_MARK_MS),
  PATH: [pathHead, process.env.PATH].filter((part) => part !== undefined && part !== '').join(delimiter),
  APPDATA: home,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: home,
});

const runHook = (input: string, extra: readonly string[] = [], pathHead?: string, given?: string): { status: number | null; stdout: string; home: string } => {
  const home = given ?? mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
  if (given === undefined) made.push(home);
  const result = spawnSync(process.execPath, [bin, 'gate', 'hook', ...extra], { input, encoding: 'utf8', timeout: HOOK_DEADLINE_MS + 15_000, cwd: home, env: envFor(home, pathHead) });
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

// A manager that cannot answer until the test lets it: a script that logs its start, waits for the `release` file (30 s at most, so a stub the hook failed to stop does not outlive the
// run), logs its finish, and then prints what `npm view` prints (`answer`) or fails the way it does against an unreachable registry (`down`). One line a start and a finish, so a
// run that was killed leaves a start and no finish. Nothing but the test writing `release` ends the wait, so the hook's cut ask is cut however slowly the box runs it.
const gatedNpm = (kind: 'answer' | 'down'): { folder: string; log: string; release: string } => {
  const folder = mkdtempSync(join(tmpdir(), `oars-gate-${kind}npm-`));
  made.push(folder);
  const log = join(folder, 'npm-starts');
  const release = join(folder, 'release');
  const answer = '{"dist-tags.latest":"1.0.0","time.created":"2020-01-01T00:00:00.000Z"}';
  const posixEnd = kind === 'answer' ? `echo '${answer}'
` : `echo 'npm error code ECONNREFUSED' >&2
exit 1
`;
  const cmdEnd = kind === 'answer' ? `echo ${answer}
` : `echo npm error code ECONNREFUSED 1>&2
exit /b 1
`;
  writeFileSync(join(folder, 'npm'), `#!/bin/sh
echo started >> "${log}"
n=0
while [ ! -f "${release}" ] && [ "$n" -lt 30 ]; do sleep 1; n=$((n+1)); done
echo ended >> "${log}"
${posixEnd}`);
  chmodSync(join(folder, 'npm'), 0o755);
  writeFileSync(
    join(folder, 'npm.cmd'),
    `@echo off
echo started>> "${log}"
set /a n=0
:wait
if exist "${release}" goto done
set /a n+=1
if %n% geq 30 goto done
ping -n 2 127.0.0.1 >nul
goto wait
:done
echo ended>> "${log}"
${cmdEnd}`,
  );
  return { folder, log, release };
};

// The `start` `startFill` is given, run as the hook runs it but to its end: the built helper asks the manager on PATH and writes what it learns, and has finished when this returns.
// `startFill` is the code the hook calls to take the name's lock and start the helper, so this hand-off is the real one without the hook's cut in front of it: the cases that go through the hook give it the longer deadline `HOOK_DEADLINE_MS` instead, and these two hold on a box too loaded for even that.
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

// Runs one built-hook sight of a name whose manager cannot answer (`gatedNpm`) and checks it handed the name off: the hook asked the manager, the helper asked it too, and the lock or the
// helper's answer is on disk. The hook is ended by the test once the helper has started (its own ask is left waiting on the gate until `release`), so what the case asserts is the
// hand-off the hook makes at its mark, with `HOOK_DEADLINE_MS` far enough off that the mark, not the deadline, is what starts it. Nothing counts sights or reads a wall-clock window.
const sightHandsOff = async (payload: string, npm: { folder: string; log: string }, home: string, store: string): Promise<void> => {
  const hook = spawn(process.execPath, [bin, 'gate', 'hook'], { cwd: home, env: envFor(home, npm.folder), stdio: ['pipe', 'ignore', 'ignore'] });
  const ended = new Promise<void>((resolve) => { hook.once('close', () => { resolve(); }); });
  hook.stdin.end(payload);
  await until(() => logged(npm.log, 'started') >= 2, HOOK_DEADLINE_MS);
  const left = `${String(logged(npm.log, 'started'))} manager starts, ${String(lockFiles(store).length)} locks, hook deadline ${String(HOOK_DEADLINE_MS)} ms, mark ${String(HANDOFF_MARK_MS)} ms`;
  hook.kill('SIGKILL');
  await ended;
  expect(logged(npm.log, 'started'), `the hook and the helper it started did not both ask the manager (${left})`).toBe(2);
  expect(lockFiles(store).length > 0 || existsSync(join(store, 'gate-registry.jsonl')), `the sight left no lock and no kept answer (${left})`).toBe(true);
};

// One sight after the hand-off: the lock or the answer kept means the hook asks nothing and ends at once, so it writes its row (and, when `printed` is set, prints) in the one run. Returns the
// sight's stdout, so a case that expects a note or a deny reads it.
const sightWithRow = (payload: string, id: string, npm: { folder: string }, home: string, printed = false): string => {
  const before = rowsOf(home).length;
  const result = runHook(payload.replace('"u1"', `"${id}"`), [], npm.folder, home);
  expect(result.status).toBe(0);
  if (!printed) expect(result.stdout).toBe('');
  expect(rowsOf(home).length, 'the hook wrote no row').toBe(before + 1);
  if (printed) expect(result.stdout, 'the hook printed nothing').not.toBe('');
  return result.stdout;
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
    expect(sightWithRow(payload, 'u1', npm, home)).toBe('');
    expect(existsSync(npm.marker)).toBe(false);
    const rows = rowsOf(home);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'crossing', via: 'hook', name: 'left-pad', registryState: 'not-read' });
  });

  // The built hook takes the sight and starts the helper itself, as the harness runs it. `sightHandsOff` (above) runs the one sight that hands off, so the cases pin
  // what follows exactly: two starts (the hook's ask and the helper's), the helper finishing, the lock or the cache left, no start after the hand-off, and a row on every sight after it.
  it('fills the cache after a cut ask: the built hook starts the helper, and the sight after it reads found and asks nothing', async () => {
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install slow-lib' }, cwd: tmpdir(), permission_mode: 'default' });
    const npm = gatedNpm('answer');
    const home = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
    made.push(home);
    const store = join(home, 'oars', 'sessions');
    await sightHandsOff(payload, npm, home, store);
    // The hook is gone; the helper's manager, still waiting, answers now (the hook's own ask ends with it on Windows and may still be waiting elsewhere, so only the helper's end is counted on).
    writeFileSync(npm.release, '');
    // The helper is detached: it has finished when it has logged its end, kept its answer, and let go of the lock.
    await until(() => logged(npm.log, 'ended') >= 1 && existsSync(join(store, 'gate-registry.jsonl')) && lockFiles(store).length === 0);
    expect(logged(npm.log, 'ended')).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(store, 'gate-registry.jsonl'))).toBe(true);
    expect(lockFiles(store)).toEqual([]);
    sightWithRow(payload, 'u-after', npm, home);
    expect(logged(npm.log, 'started')).toBe(2);
    // The hook that handed off was ended before it wrote a row; the sight after the hand-off wrote the only one, which reads the kept answer.
    expect(rowsOf(home)).toMatchObject([{ registryState: 'found' }]);
  }, 60_000);

  it('starts no new ask on later sights while the lock is held, after a down manager', async () => {
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install down-lib' }, cwd: tmpdir(), permission_mode: 'default' });
    const npm = gatedNpm('down');
    const home = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
    made.push(home);
    const store = join(home, 'oars', 'sessions');
    await sightHandsOff(payload, npm, home, store);
    // The hook is gone; the helper's manager, still waiting, fails now (the hook's own ask ends with it on Windows and may still be waiting elsewhere, so only the helper's end is counted on).
    writeFileSync(npm.release, '');
    // A failed ask keeps its lock, so the helper is done when it has logged its end with the lock still there.
    await until(() => logged(npm.log, 'ended') >= 1 && lockFiles(store).length === 1);
    expect(logged(npm.log, 'ended')).toBeGreaterThanOrEqual(1);
    expect(lockFiles(store)).toHaveLength(1);
    // The lock is held and fresh, so neither later sight asks the manager: the log shows no start beyond the hook's own ask and the helper's.
    sightWithRow(payload, 'u-after-1', npm, home);
    sightWithRow(payload, 'u-after-2', npm, home);
    expect(logged(npm.log, 'started')).toBe(2);
    expect(lockFiles(store)).toHaveLength(1);
    // The hook that handed off was ended before it wrote a row; the two sights after the hand-off each wrote one.
    expect(rowsOf(home)).toMatchObject([{ registryState: 'not-read' }, { registryState: 'not-read' }]);
  }, 60_000);

  // The same two outcomes through `startFill` and the built helper, without the hook's first sight: the hand-off is the code the hook calls, and this holds even on a box so loaded that the
  // first sight never reaches its cut.
  it('hands a cut ask to the built helper through startFill, which fills the cache and lets go of the lock', async () => {
    const payload = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install slow-lib' }, cwd: tmpdir(), permission_mode: 'default' });
    const npm = gatedNpm('answer');
    writeFileSync(npm.release, '');
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
    const npm = gatedNpm('down');
    writeFileSync(npm.release, '');
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
    const home = mkdtempSync(join(tmpdir(), 'oars-gate-bin-'));
    made.push(home);
    writeFileSync(join(seededStore(home), 'gate-policy.json'), '{"holdbackPercent":0}');
    const result = runHook(payload, [], npm.folder, home);
    expect(result.status).toBe(0);
    const stdout = result.stdout;
    expect(stdout).not.toBe('');
    expect(stdout).not.toContain('deny');
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'Registry note: ghost-lib was not found in the registry your package manager uses.' },
    });
  });
});
