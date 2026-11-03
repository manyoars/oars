import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { assertDepositable, checkSession, exclusionPaths, loadTerms, scanStore } from './exclusion.js';
import { cleanup, stage, type Staged } from './test-support.js';

afterEach(() => {
  cleanup();
  removeTestDirs();
});

// An invented term: the real list is a local file that never enters this repository.
const TERM = 'zorblax';
const CLEAN = JSON.stringify({ type: 'user', message: { content: 'fix the build' } });
const DIRTY = JSON.stringify({ type: 'user', message: { content: `working at ${TERM.toUpperCase()} today` } });

const write = (path: string, lines: readonly string[]): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`);
};

const setup = (terms: string | null = `${TERM}\n`): { staged: Staged; termsFile: string; main: (project: string, session: string) => string; agent: (project: string, session: string, name: string) => string } => {
  const staged = stage();
  rmSync(join(staged.projectsRoot, 'proj'), { recursive: true, force: true });
  const termsFile = join(staged.root, 'terms.txt');
  if (terms !== null) writeFileSync(termsFile, terms);
  return {
    staged,
    termsFile,
    main: (project, session) => join(staged.projectsRoot, project, `${session}.jsonl`),
    agent: (project, session, name) => join(staged.projectsRoot, project, session, 'subagents', `${name}.jsonl`),
  };
};

describe('checkSession (A38)', () => {
  it('excludes a session whose main transcript has the term on any line, without regard to case', async () => {
    const t = setup();
    write(t.main('p', 's1'), [CLEAN, DIRTY]);
    const verdict = await checkSession(t.staged.runtime, t.termsFile, 'p', 's1');
    expect(verdict).toEqual({ excluded: true, reason: 'term', hits: [{ key: 's1.jsonl', main: true, source: 'projects' }] });
  });

  it('excludes a session whose subagent transcript has the term, though its main is clean', async () => {
    const t = setup();
    write(t.main('p', 's2'), [CLEAN]);
    write(t.agent('p', 's2', 'agent-a1'), [CLEAN, DIRTY]);
    const verdict = await checkSession(t.staged.runtime, t.termsFile, 'p', 's2');
    expect(verdict.excluded).toBe(true);
    expect(verdict.hits).toEqual([{ key: 's2/subagents/agent-a1.jsonl', main: false, source: 'projects' }]);
  });

  it('excludes a session with no raw to scan', async () => {
    const t = setup();
    expect(await checkSession(t.staged.runtime, t.termsFile, 'p', 'nothing')).toEqual({ excluded: true, reason: 'no-raw', hits: [] });
    write(t.agent('p', 's3', 'agent-a1'), [CLEAN]);
    expect((await checkSession(t.staged.runtime, t.termsFile, 'p', 's3')).reason).toBe('no-raw');
  });

  it('keeps a clean session', async () => {
    const t = setup();
    write(t.main('p', 's4'), [CLEAN]);
    write(t.agent('p', 's4', 'agent-a1'), [CLEAN]);
    expect(await checkSession(t.staged.runtime, t.termsFile, 'p', 's4')).toEqual({ excluded: false, reason: 'clean', hits: [] });
  });

  it('excludes everything when the term file is missing or empty', async () => {
    const missing = setup(null);
    write(missing.main('p', 's5'), [CLEAN]);
    expect((await checkSession(missing.staged.runtime, missing.termsFile, 'p', 's5')).reason).toBe('no-terms');
    const empty = setup('\n  \n');
    write(empty.main('p', 's6'), [CLEAN]);
    expect((await checkSession(empty.staged.runtime, empty.termsFile, 'p', 's6')).excluded).toBe(true);
  });

  it('scans the raw archive when the harness folder no longer has the session', async () => {
    const t = setup();
    write(join(t.staged.storeDir, 'raw', 'p', 's7.jsonl'), [DIRTY]);
    const verdict = await checkSession(t.staged.runtime, t.termsFile, 'p', 's7');
    expect(verdict.hits).toEqual([{ key: 's7.jsonl', main: true, source: 'raw' }]);
  });

  it('excludes a session it cannot read', async () => {
    const t = setup();
    mkdirSync(t.main('p', 's8'), { recursive: true });
    write(join(t.main('p', 's8'), '..', 's8', 'subagents', 'agent-x.jsonl'), [CLEAN]);
    // A directory named like the main file is not a file, so there is no main to scan.
    expect((await checkSession(t.staged.runtime, t.termsFile, 'p', 's8')).reason).toBe('no-raw');
  });
});

describe('loadTerms and exclusionPaths', () => {
  it('lowercases terms, drops blank lines, and gives none for a missing file', async () => {
    const t = setup('Alpha\r\n\r\n beta \n');
    expect(await loadTerms(t.termsFile)).toEqual(['alpha', 'beta']);
    expect(await loadTerms(join(t.staged.root, 'absent'))).toEqual([]);
  });

  it('takes the term file from OARS_EXCLUSION_TERMS and defaults beside the projects folder', () => {
    expect(exclusionPaths('/c/projects', { OARS_EXCLUSION_TERMS: '/x/t.txt' }).terms).toBe('/x/t.txt');
    const fallback = exclusionPaths('/c/projects', { OARS_EXCLUSION_TERMS: '' }, '/o/list');
    expect(fallback.terms.replaceAll('\\', '/')).toBe('/c/session-commons/exclusion-terms.txt');
    expect(fallback.list).toBe('/o/list');
    expect(exclusionPaths('/c/projects', {}).list.replaceAll('\\', '/')).toBe('/c/session-commons/exclusion-list.jsonl');
    expect(exclusionPaths('', {}).terms.replaceAll('\\', '/')).toContain('.claude/session-commons/exclusion-terms.txt');
  });
});

describe('assertDepositable (the pool deposit gate)', () => {
  it('refuses an excluded session and lets a clean one through', async () => {
    const t = setup();
    write(t.main('p', 'bad'), [DIRTY]);
    write(t.main('p', 'good'), [CLEAN]);
    const refused = await assertDepositable(t.staged.runtime, t.termsFile, 'p', 'bad').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CliError);
    expect(String(refused)).toContain('excluded');
    expect(String(refused)).not.toContain(TERM);
    await expect(assertDepositable(t.staged.runtime, t.termsFile, 'p', 'good')).resolves.toBeUndefined();
  });
});

describe('scanStore and oars sessions exclusions', () => {
  const populate = (t: ReturnType<typeof setup>): void => {
    write(t.main('p', 'a'), [DIRTY]);
    write(t.main('p', 'b'), [CLEAN]);
    write(t.agent('p', 'b', 'agent-1'), [DIRTY]);
    write(t.main('q', 'c'), [CLEAN]);
    write(t.agent('q', 'd', 'agent-1'), [CLEAN]);
    write(join(t.staged.storeDir, 'raw', 'p', 'a.jsonl'), [DIRTY]);
  };

  it('counts sessions, reasons, and hit files by source, and labels folders by ordinal', async () => {
    const t = setup();
    populate(t);
    const { counts, excluded } = await scanStore(t.staged.runtime, t.termsFile);
    expect(counts).toMatchObject({
      sessions: 4,
      excluded: 3,
      kept: 1,
      reasons: { term: 2, noRaw: 1, noTerms: 0, unreadable: 0 },
      hitFiles: { main: 1, subagent: 1 },
      bySource: { projects: { main: 1, subagent: 1 }, raw: { main: 1, subagent: 0 } },
    });
    expect(counts.folders).toEqual([
      { folder: 1, sessions: 2, excluded: 2 },
      { folder: 2, sessions: 2, excluded: 1 },
    ]);
    expect(excluded).toEqual([
      { project: 'p', session: 'a' },
      { project: 'p', session: 'b' },
      { project: 'q', session: 'd' },
    ]);
  });

  it('with no term file counts every session under no-terms', async () => {
    const t = setup(null);
    populate(t);
    const { counts } = await scanStore(t.staged.runtime, t.termsFile);
    expect(counts).toMatchObject({ sessions: 4, excluded: 4, kept: 0, reasons: { noTerms: 4, term: 0 } });
  });

  it('prints counts only: neither the term, a transcript line, nor a folder name reaches stdout or --json', async () => {
    const h = harness({ OARS_EXCLUSION_TERMS: '' });
    const t = setup();
    populate(t);
    h.deps.sessions = t.staged.runtime;
    h.deps.env = { ...h.deps.env, OARS_EXCLUSION_TERMS: t.termsFile };
    const list = join(t.staged.root, 'out', 'list.jsonl');
    expect(await run(['sessions', 'exclusions', '--out', list], h.deps)).toBe(ExitCode.OK);
    expect(await run(['sessions', 'exclusions', '--out', list, '--json'], h.deps)).toBe(ExitCode.OK);
    const printed = h.out.join('');
    expect(printed).toContain('3 excluded');
    expect(printed.toLowerCase()).not.toContain(TERM);
    expect(printed).not.toContain('fix the build');
    expect(printed).not.toContain('working at');
    expect(printed).not.toMatch(/"project"|"p"|"q"/);
    expect(readFileSync(list, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('writes an empty list file when nothing is excluded, and refuses a run with no store', async () => {
    const h = harness();
    const t = setup();
    write(t.main('p', 'ok'), [CLEAN]);
    h.deps.sessions = t.staged.runtime;
    h.deps.env = { ...h.deps.env, OARS_EXCLUSION_TERMS: t.termsFile };
    const list = join(t.staged.root, 'empty.jsonl');
    expect(await run(['sessions', 'exclusions', '--out', list], h.deps)).toBe(ExitCode.OK);
    expect(readFileSync(list, 'utf8')).toBe('');
    const bare = harness();
    expect(await run(['sessions', 'exclusions'], bare.deps)).toBe(ExitCode.UNEXPECTED);
  });
});
