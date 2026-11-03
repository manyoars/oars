// A transcript or folder that cannot be read is never read as clean (t763 fix round): the session is excluded as `unreadable`.
import type * as fs from 'node:fs';
import type * as fsp from 'node:fs/promises';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { harness } from '../test-support.js';

// The streams the scan opens, so a test can see that a file which returned early on a hit was closed.
const opened = vi.hoisted((): { destroyed: boolean }[] => []);

// A real unreadable file or folder (EACCES, EBUSY) cannot be made portably, so the reads fail for named paths (the stream opens a path that is not there, and a stat or listing is refused).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  const readdir = vi.fn(actual.readdir);
  readdir.mockImplementation((dir, options) =>
    typeof dir === 'string' && (dir.endsWith(join('locked', 'subagents')) || dir.endsWith('lockedproj'))
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
  return { ...actual, readdir, stat };
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

const { checkSession, scanStore } = await import('./exclusion.js');
const { cleanup, stage } = await import('./test-support.js');

afterEach(() => {
  cleanup();
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
    writeFileSync(raw, `${CLEAN}
`);
    expect(await checkSession(t.staged.runtime, t.termsFile, 'p', 'nostat')).toEqual({ excluded: true, reason: 'unreadable', hits: [] });
  });

  it('closes the file it stopped reading at a hit', async () => {
    const t = setup();
    t.put('early.jsonl', `${DIRTY}
${CLEAN}`);
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
