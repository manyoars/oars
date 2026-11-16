// Shared by the v1 checks. A check is `node checks/<task-id>.mjs <run folder>`: exit 0 is a pass, exit 1 a fail, and it
// prints one line saying why. No check needs the network or a browser. A check that needs the app's data builds its own
// database in a temp folder with the run folder's own `scripts/build-db.ts`, so it never reads or changes the run's database
// unless the task is about that database.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export class CheckFailed extends Error {}

export const fail = (message) => {
  throw new CheckFailed(message);
};

export const expect = (condition, message) => {
  if (!condition) fail(message);
};

const temps = [];
const cleanups = [];

export const tempFolder = (prefix) => {
  const folder = mkdtempSync(join(tmpdir(), `v1-check-${prefix}-`));
  temps.push(folder);
  return folder;
};

/** Runs `body(runFolder)`; prints PASS or FAIL with the reason and exits 0 or 1. Temp folders and servers are always cleaned up. */
export const check = async (taskId, body) => {
  let code = 1;
  try {
    const arg = process.argv[2];
    if (!arg) fail('usage: node <check> <run folder>');
    const run = resolve(arg);
    expect(existsSync(join(run, 'package.json')), `${run} is not a fixture checkout`);
    const detail = await body(run);
    console.log(`PASS ${taskId}${detail ? `: ${detail}` : ''}`);
    code = 0;
  } catch (error) {
    console.log(`FAIL ${taskId}: ${error instanceof CheckFailed ? error.message : (error?.stack ?? String(error))}`);
  } finally {
    await cleanUp();
  }
  process.exit(code);
};

/** Stops every server and closes every database a helper opened, then deletes the temp folders. `check` calls it; a solution script calls it too. */
export const cleanUp = async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const folder of temps.splice(0)) rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
};

/** Imports a module from the run folder (TypeScript runs directly on Node 24). A module that fails to load is a fail. */
export const importFrom = async (run, relativePath) => {
  const path = join(run, relativePath);
  expect(existsSync(path), `${relativePath} is missing`);
  try {
    return await import(pathToFileURL(path).href);
  } catch (error) {
    return fail(`${relativePath} does not load: ${error.message}`);
  }
};

export const readText = (run, relativePath) => {
  const path = join(run, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
};

/** The trimmed text of an answer file, or a fail when it is missing or empty. */
export const answer = (run, relativePath) => {
  const text = readText(run, relativePath);
  expect(text !== null && text.trim() !== '', `${relativePath} is missing or empty`);
  return text.trim();
};

/** Builds a database from the run folder's seed and migrations into a temp folder with the run's own build script. */
export const buildDb = (run) => {
  const path = join(tempFolder('db'), 'app.db');
  const result = spawnSync(process.execPath, ['scripts/build-db.ts'], { cwd: run, env: { ...process.env, DB_PATH: path }, encoding: 'utf8', timeout: 60_000 });
  expect(result.status === 0, `the database does not build: ${(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
  return { path, output: `${result.stdout}${result.stderr}` };
};

/** Opens a database (read-write unless asked); foreign keys stay off so the check sees the data as it is. */
export const openDb = (path, readOnly = false) => {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false, readOnly });
  cleanups.push(() => db.close());
  return db;
};

/**
 * Starts the run folder's own server (`node src/server.ts`) on a port the system picks (PORT=0) against the database at
 * `dbPath`, and waits for its own ready line, `listening on http://127.0.0.1:<port>`. No sleep, no retry.
 */
export const startServer = (run, dbPath) =>
  new Promise((resolveStart, rejectStart) => {
    const child = spawn(process.execPath, ['src/server.ts'], { cwd: run, env: { ...process.env, PORT: '0', DB_PATH: dbPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectStart(new CheckFailed(`the server printed no ready line in 30 s: ${output.trim().slice(-300)}`));
    }, 30_000);
    const stopped = new Promise((resolveStop) => child.once('exit', resolveStop));
    cleanups.push(async () => {
      if (child.exitCode === null) child.kill();
      await stopped;
    });
    const onData = (data) => {
      output += data;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolveStart(match[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectStart(new CheckFailed(`the server exited (${code}) before it was ready: ${output.trim().slice(-300)}`));
    });
  });

export const getJson = async (base, path) => {
  const res = await fetch(`${base}${path}`);
  expect(res.ok, `GET ${path} answered ${res.status}`);
  return res.json();
};

/** Runs `node --test` on the given test files in `cwd`; returns the exit status and the last lines of output. */
export const runTests = (cwd, files) => {
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd, encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, tail: `${result.stdout}${result.stderr}`.trim().split('\n').slice(-6).join(' | ') };
};

/** Test files under test/ (relative paths, forward slashes) whose text matches `pattern`. */
export const testFilesMatching = (run, pattern) => {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'test'], { cwd: run, encoding: 'utf8' });
  expect(result.status === 0, 'git ls-files failed in the run folder');
  return result.stdout
    .split('\n')
    .filter((file) => /\.test\.(ts|mjs|js)$/.test(file))
    .filter((file) => pattern.test(readFileSync(join(run, file), 'utf8')));
};

export const sameRows = (left, right) => JSON.stringify(left.map((row) => ({ ...row }))) === JSON.stringify(right.map((row) => ({ ...row })));
