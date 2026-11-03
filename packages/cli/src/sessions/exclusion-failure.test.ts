// A transcript or folder that cannot be read is never read as clean (t763 fix round): the session is excluded as `unreadable`.
import type * as fs from 'node:fs';
import type * as fsp from 'node:fs/promises';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A real unreadable file or folder (EACCES, EBUSY) cannot be made portably, so the reads fail for named paths (the stream opens a path that is not there).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  const readdir = vi.fn(actual.readdir);
  readdir.mockImplementation((dir, options) =>
    typeof dir === 'string' && dir.endsWith(join('locked', 'subagents')) ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })) : actual.readdir(dir, options),
  );
  return { ...actual, readdir };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const createReadStream = vi.fn(actual.createReadStream);
  createReadStream.mockImplementation((path, options) =>
    typeof path === 'string' && path.endsWith('busy.jsonl') ? actual.createReadStream(join(path, 'gone'), options) : actual.createReadStream(path, options),
  );
  return { ...actual, createReadStream };
});

const { checkSession, scanStore } = await import('./exclusion.js');
const { cleanup, stage } = await import('./test-support.js');

afterEach(cleanup);

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

  it('excludes a session with a transcript that fails mid-read, and a hit in another file still gives term', async () => {
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
});
