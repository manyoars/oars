// A transcript or folder that cannot be read is never read as clean: the session is excluded as `unreadable`.
import type * as fs from 'node:fs';
import type * as fsp from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';

// The streams the scan opens, so a test can see that a file which returned early on a hit was closed.
const opened = vi.hoisted((): { destroyed: boolean }[] => []);

// A real unreadable file or folder (EACCES, EBUSY) cannot be made portably, so the reads fail for named paths (the stream opens a path that is not there, and a stat or listing is refused).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  const readdir = vi.fn(actual.readdir);
  readdir.mockImplementation((dir, options) =>
    typeof dir === 'string' && (dir.endsWith(join('locked', 'subagents')) || dir.endsWith(join('subagents', 'a-locked')) || dir.endsWith('lockedproj') || dir.endsWith('lockedroot') || dir.endsWith(join('lockedstore', 'raw')))
      ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, scandir '${dir}'`), { code: 'EACCES' }))
      : actual.readdir(dir, options),
  );
  // A main file that cannot be examined (EACCES), in the harness's folder only; the raw copy of it is fine.
  const stat = vi.fn(actual.stat);
  stat.mockImplementation((path, options) =>
    typeof path === 'string' && path.endsWith('nostat.jsonl') && !path.includes(`${sep}raw${sep}`)
      ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, stat '${path}'`), { code: 'EACCES' }))
      : actual.stat(path, options),
  );
  // The final rename of a list named `norename` is refused (EPERM, as a virus scanner or an open handle can on Windows).
  const rename = vi.fn(actual.rename);
  rename.mockImplementation((from, to) =>
    typeof to === 'string' && to.endsWith('norename.jsonl') ? Promise.reject(Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${to}'`), { code: 'EPERM' })) : actual.rename(from, to),
  );
  // A path that cannot be examined without following it (EACCES), named `nolstat`.
  const lstat = vi.fn(actual.lstat);
  lstat.mockImplementation((path, options) =>
    typeof path === 'string' && path.endsWith('nolstat.jsonl') && !path.includes(`${sep}raw${sep}`)
      ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, lstat '${path}'`), { code: 'EACCES' }))
      : actual.lstat(path, options),
  );
  return { ...actual, readdir, stat, rename, lstat };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const createReadStream = vi.fn(actual.createReadStream);
  createReadStream.mockImplementation((path, options) => {
    const stream = typeof path === 'string' && path.endsWith('busy.jsonl') ? actual.createReadStream(join(path, 'gone'), options) : actual.createReadStream(path, options);
    opened.push(stream);
    return stream;
  });
  return { ...actual, createReadStream };
});

const { checkSession, scanStore, sessionsExclusions } = await import('./exclusion.js');
const { cleanup, stage } = await import('./test-support.js');

afterEach(() => {
  cleanup();
  removeTestDirs();
  opened.length = 0;
});

const TERM = 'zorblax';
const CLEAN = JSON.stringify({ type: 'user', message: { content: 'fix the build' } });
const DIRTY = JSON.stringify({ type: 'user', message: { content: `at ${TERM}` } });

const setup = () => {
  const staged = stage();
  rmSync(join(staged.projectsRoot, 'proj'), { recursive: true, force: true });
  const termsFile = join(staged.root, 'terms.txt');
  writeFileSync(termsFile, `${TERM}\n`);
  const put = (relative: string, line: string): void => {
    const file = join(staged.projectsRoot, 'p', relative);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `${line}\n`);
  };
  return { staged, termsFile, put };
};

describe('an unreadable part of a session', () => {
  it('excludes a session whose subagents folder cannot be listed, though its main is clean', async () => {
    const t = setup();
    t.put('locked.jsonl', CLEAN);
    mkdirSync(join(t.staged.projectsRoot, 'p', 'locked', 'subagents'), { recursive: true });
    expect(await checkSession(t.staged.runtime, t.termsFile, 'p', 'locked')).toEqual({ excluded: true, reason: 'unreadable', hits: [] });
  });

  it('keeps a term hit listed after a nested folder that cannot be listed', async () => {
    const t = setup();
    t.put('s41.jsonl', CLEAN);
    // `a-locked` sorts before `z.jsonl`, so a walk that stopped at the failure would lose the hit.
    mkdirSync(join(t.staged.projectsRoot, 'p', 's41', 'subagents', 'a-locked'), { recursive: true });
    t.put('s41/subagents/z.jsonl', DIRTY);
    const verdict = await checkSession(t.staged.runtime, t.termsFile, 'p', 's41');
    expect(verdict.reason).toBe('term');
    expect(verdict.hits).toHaveLength(1);
  });

  it('excludes a session with a transcript that fails to open, and a hit in another file still gives term', async () => {
    const t = setup();
    t.put('busy.jsonl', CLEAN);
    expect((await checkSession(t.staged.runtime, t.termsFile, 'p', 'busy')).reason).toBe('unreadable');
    t.put('busy/subagents/agent-a.jsonl', DIRTY);
    const verdict = await checkSession(t.staged.runtime, t.termsFile, 'p', 'busy');
    expect(verdict.reason).toBe('term');
    expect(verdict.hits).toHaveLength(1);
  });

  it('counts both under unreadable in the store scan', async () => {
    const t = setup();
    t.put('busy.jsonl', CLEAN);
    t.put('locked.jsonl', CLEAN);
    mkdirSync(join(t.staged.projectsRoot, 'p', 'locked', 'subagents'), { recursive: true });
    const { counts } = await scanStore(t.staged.runtime, t.termsFile);
    expect(counts.reasons).toMatchObject({ unreadable: 2, term: 0 });
  });

  it('excludes a session whose harness main cannot be examined, though the raw copy is clean', async () => {
    const t = setup();
    t.put('nostat.jsonl', CLEAN);
    const raw = join(t.staged.storeDir, 'raw', 'p', 'nostat.jsonl');
    mkdirSync(join(raw, '..'), { recursive: true });
    writeFileSync(raw, `${CLEAN}\n`);
    expect(await checkSession(t.staged.runtime, t.termsFile, 'p', 'nostat')).toEqual({ excluded: true, reason: 'unreadable', hits: [] });
  });

  it('excludes a session whose main cannot be examined by lstat, though the raw copy is clean', async () => {
    const t = setup();
    t.put('nolstat.jsonl', CLEAN);
    const raw = join(t.staged.storeDir, 'raw', 'p', 'nolstat.jsonl');
    mkdirSync(join(raw, '..'), { recursive: true });
    writeFileSync(raw, `${CLEAN}\n`);
    expect(await checkSession(t.staged.runtime, t.termsFile, 'p', 'nolstat')).toEqual({ excluded: true, reason: 'unreadable', hits: [] });
  });

  it('closes the file it stopped reading at a hit', async () => {
    const t = setup();
    t.put('early.jsonl', `${DIRTY}\n${CLEAN}`);
    expect((await checkSession(t.staged.runtime, t.termsFile, 'p', 'early')).reason).toBe('term');
    expect(opened.length).toBeGreaterThan(0);
    for (const stream of opened) expect(stream.destroyed).toBe(true);
  });
});

describe('a project folder that cannot be listed', () => {
  it('aborts the scan with the folder ordinal only, writes no list, and prints no folder name', async () => {
    const t = setup();
    t.put('a.jsonl', CLEAN);
    mkdirSync(join(t.staged.projectsRoot, 'lockedproj'), { recursive: true });
    const failure = await scanStore(t.staged.runtime, t.termsFile).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliError);
    const message = failure instanceof CliError ? failure.message : '';
    expect(message).toMatch(/folder 1 .*no list was written/);
    expect(message).not.toContain('lockedproj');
    const h = harness();
    h.deps.sessions = t.staged.runtime;
    h.deps.env = { ...h.deps.env, OARS_EXCLUSION_TERMS: t.termsFile };
    const list = join(t.staged.root, 'out', 'never.jsonl');
    expect(await run(['sessions', 'exclusions', '--out', list], h.deps)).toBe(ExitCode.INVALID);
    expect(h.err.join('')).not.toContain('lockedproj');
    expect(h.err.join('')).toContain('no list was written');
    expect(existsSync(list)).toBe(false);
  });
});

describe('a root that cannot be listed', () => {
  const abort = async (runtime: Parameters<typeof scanStore>[0], termsFile: string): Promise<string> => {
    const failure = await scanStore(runtime, termsFile).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliError);
    return failure instanceof CliError ? failure.message : '';
  };

  it('aborts with no list when the projects root is refused, naming no folder', async () => {
    const t = setup();
    const message = await abort({ ...t.staged.runtime, projectsRoot: join(t.staged.root, 'lockedroot') }, t.termsFile);
    expect(message).toContain('no list was written');
    expect(message).not.toContain('lockedroot');
  });

  it('aborts with no list when the raw archive root is refused', async () => {
    const t = setup();
    mkdirSync(join(t.staged.root, 'lockedstore', 'raw'), { recursive: true });
    const message = await abort({ ...t.staged.runtime, storeDir: join(t.staged.root, 'lockedstore') }, t.termsFile);
    expect(message).toContain('no list was written');
    expect(message).not.toContain('lockedstore');
  });
});

describe('a session with no readable main', () => {
  it('reads unreadable, not no-raw, when the harness main cannot be examined and there is no raw copy', async () => {
    const t = setup();
    t.put('nostat.jsonl', CLEAN);
    expect(await checkSession(t.staged.runtime, t.termsFile, 'p', 'nostat')).toEqual({ excluded: true, reason: 'unreadable', hits: [] });
  });
});

describe('a list that cannot be moved into place', () => {
  it('leaves an earlier list unchanged and no temp file holding folder names behind, and rethrows', async () => {
    const t = setup();
    t.put('a.jsonl', DIRTY);
    const list = join(t.staged.root, 'out', 'norename.jsonl');
    mkdirSync(join(list, '..'), { recursive: true });
    writeFileSync(list, 'earlier-list');
    await expect(sessionsExclusions(t.staged.runtime, { terms: t.termsFile, list })).rejects.toThrow(/EPERM/);
    expect(readFileSync(list, 'utf8')).toBe('earlier-list');
    expect(existsSync(`${list}.tmp`)).toBe(false);
  });
});
