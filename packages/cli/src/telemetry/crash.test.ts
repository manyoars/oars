// Crash reports: the error's class and a hash of its stack with every path hashed, never its message. Every test sets APPDATA to a temp folder.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../cli.js';
import { defaultConfigDir } from '../credentials.js';
import { ExitCode } from '../errors.js';
import { harness } from '../test-support.js';
import { crashClassOf, stackHashOf } from './crash.js';
import { spoolEvents } from './read-events.js';
import { readSpool, spoolPaths } from './spool.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HOME = 'C:\\Users\\someone\\source\\acme-billing';
const POSIX = '/home/someone/work/acme-billing';

const stackIn = (home: string, separator: string): string =>
  [
    `TypeError: cannot read ${home}${separator}secret.env`,
    `    at readSecret (${home}${separator}packages${separator}cli${separator}dist${separator}sessions${separator}store.js:41:9)`,
    `    at async Command.<anonymous> (file:///${home.replaceAll('\\', '/')}/packages/cli/dist/cli.js:120:5)`,
    `    at new Thing (node:internal/modules/run_main:12:3)`,
  ].join('\n');

describe('crash class and stack hash', () => {
  it('names a built-in class, and anything else other', () => {
    expect(crashClassOf(new TypeError('x'))).toBe('TypeError');
    expect(crashClassOf(new RangeError('x'))).toBe('RangeError');
    class Custom extends Error {
      readonly extra = 1;
    }
    expect(crashClassOf(new Custom('x'))).toBe('Error');
    const renamed = new Error('x');
    renamed.name = `${HOME}\\evil`;
    // The class comes from the constructor chain, so text set as a name is never read, let alone recorded.
    expect(crashClassOf(renamed)).toBe('Error');
    // A value that is not an error at all is `other`, whatever it looks like.
    expect(crashClassOf({ name: 'TypeError', message: 'x', stack: 'x' })).toBe('other');
    expect(crashClassOf(Object.create(null))).toBe('other');
    expect(crashClassOf('a string')).toBe('other');
    expect(crashClassOf(undefined)).toBe('other');
  });

  it('hashes the stack without the message or any path', () => {
    const error = new TypeError(`cannot read ${HOME}\\secret.env`);
    error.stack = stackIn(HOME, '\\');
    const hash = stackHashOf(error);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    // The same code on another machine (another home folder, another separator) is the same crash.
    const other = new TypeError('another message');
    other.stack = stackIn('/opt/elsewhere/checkout', '/');
    expect(stackHashOf(other)).toBe(hash);
    // A different frame is a different crash.
    const different = new TypeError('x');
    different.stack = stackIn(HOME, '\\').replace('store.js:41:9', 'store.js:42:9');
    expect(stackHashOf(different)).not.toBe(hash);
  });

  it('hashes a non-error and an error with no stack', () => {
    expect(stackHashOf('boom')).toMatch(/^[0-9a-f]{16}$/);
    const bare = new Error('x');
    bare.stack = undefined;
    expect(stackHashOf(bare)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the top-level catch', () => {
  it('records the class and hash, leaves no path in the spool, and the exit code is unchanged', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'oars-crash-'));
    roots.push(appData);
    const made = harness({ APPDATA: appData });
    expect(defaultConfigDir(made.deps.env, 'win32', 'C:\\unused-home')).toBe(appData);
    const dir = join(appData, 'oars', 'telemetry');
    made.deps.telemetry = { dir, platform: 'linux' };

    const failure = new TypeError(`cannot read ${HOME}\\secret.env and ${POSIX}/.env`);
    failure.stack = stackIn(HOME, '\\') + `\n    at x (${POSIX}/node_modules/foo/index.js:1:1)`;
    made.deps.store = {
      read: () => Promise.reject(failure),
      write: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };

    // The same run without telemetry is the reference for the exit code and the printed failure.
    const bare = harness({ APPDATA: appData });
    bare.deps.store = made.deps.store;
    const reference = await run(['logout'], bare.deps);
    expect(reference).toBe(ExitCode.UNEXPECTED);

    expect(await run(['logout'], made.deps)).toBe(reference);
    expect(made.err.join('')).toContain('Unexpected error:');

    const spool = readSpool(dir).join('\n');
    for (const secret of ['someone', 'acme-billing', 'secret.env', 'Users', '/home', 'node_modules/foo']) expect(spool).not.toContain(secret);
    expect(readFileSync(spoolPaths(dir).current, 'utf8')).not.toContain('cannot read');
    const [crash] = spoolEvents(dir, 'crash');
    expect(crash).toMatchObject({ data: { errorClass: 'TypeError' } });
    expect(crash?.data.stackHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('records nothing for a failure the program meant (a usage error)', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'oars-crash-'));
    roots.push(appData);
    const made = harness({ APPDATA: appData });
    made.deps.telemetry = { dir: join(appData, 'oars', 'telemetry'), platform: 'linux' };
    await run(['--bogus'], made.deps);
    expect(spoolEvents(join(appData, 'oars', 'telemetry')).map((event) => event.type)).toEqual(['command']);
  });
});
