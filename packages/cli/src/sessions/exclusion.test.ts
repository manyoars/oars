import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../cli.js';
import { CliError, ExitCode } from '../errors.js';
import { harness, removeTestDirs } from '../test-support.js';
import { assertDepositable, checkSession, exclusionPaths, loadTerms, scanStore } from './exclusion.js';
import { deposit } from './store.js';
import { cleanup, NOW, stage, type Staged } from './test-support.js';

afterEach(() => {
  cleanup();
  removeTestDirs();
});

// An invented term: the real list is a local file that never enters this repository.
const TERM = 'zorblax';
const CLEAN = JSON.stringify({ type: 'user', message: { content: 'fix the build' } });
const DIRTY = JSON.stringify({ type: 'user', message: { content: `working at ${TERM.toUpperCase()} today` } });

// The harness names a session folder with a UUID; a folder with another name is not a session.
const S_D = '33333333-3333-4333-8333-333333333333';

const write = (path: string, lines: readonly string[]): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`);
};

type LinkType = 'dir' | 'file';

/** Makes a link; false only where the account lacks the privilege (EPERM), so a broken path fails the test instead of skipping it. */
const makeLink = (target: string, path: string, type: LinkType): boolean => {
  mkdirSync(join(path, '..'), { recursive: true });
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return false;
    throw error;
  }
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

  it('treats a directory in place of the main file as no raw', async () => {
    const t = setup();
    mkdirSync(t.main('p', 's8'), { recursive: true });
    write(join(t.main('p', 's8'), '..', 's8', 'subagents', 'agent-x.jsonl'), [CLEAN]);
    // A directory named like the main file is not a file, so there is no main to scan.
    expect((await checkSession(t.staged.runtime, t.termsFile, 'p', 's8')).reason).toBe('no-raw');
  });

  it('counts a hit in a subagent file of a session with no main transcript as a term hit', async () => {
    const t = setup();
    write(t.agent('p', 's9', 'agent-a1'), [DIRTY]);
    const verdict = await checkSession(t.staged.runtime, t.termsFile, 'p', 's9');
    expect(verdict).toEqual({ excluded: true, reason: 'term', hits: [{ key: 's9/subagents/agent-a1.jsonl', main: false, source: 'projects' }] });
  });

  it('scans a symlinked subagent transcript, and excludes a broken link as unreadable', async (ctx) => {
    const t = setup();
    write(t.main('p', 's10'), [CLEAN]);
    const real = join(t.staged.root, 'outside.jsonl');
    write(real, [DIRTY]);
    mkdirSync(join(t.staged.projectsRoot, 'p', 's10', 'subagents'), { recursive: true });
    if (!makeLink(real, t.agent('p', 's10', 'agent-link'), 'file')) return ctx.skip();
    expect(statSync(t.agent('p', 's10', 'agent-link')).isFile()).toBe(true);
    expect((await checkSession(t.staged.runtime, t.termsFile, 'p', 's10')).hits).toEqual([{ key: 's10/subagents/agent-link.jsonl', main: false, source: 'projects' }]);
    rmSync(real);
    expect((await checkSession(t.staged.runtime, t.termsFile, 'p', 's10')).reason).toBe('unreadable');
  });
});

describe('links to folders (a transcript that was not scanned never reads as clean)', () => {
  const link = (target: string, path: string): boolean => makeLink(target, path, 'dir');

  it('follows a link to a directory under subagents', async (ctx) => {
    const t = setup();
    write(t.main('p', 's11'), [CLEAN]);
    const elsewhere = join(t.staged.root, 'elsewhere');
    write(join(elsewhere, 'agent-x.jsonl'), [DIRTY]);
    if (!link(elsewhere, join(t.staged.projectsRoot, 'p', 's11', 'subagents', 'linked'))) return ctx.skip();
    const verdict = await checkSession(t.staged.runtime, t.termsFile, 'p', 's11');
    expect(verdict).toEqual({ excluded: true, reason: 'term', hits: [{ key: 's11/subagents/linked/agent-x.jsonl', main: false, source: 'projects' }] });
  });

  it('excludes a session whose subagents link leads nowhere as unreadable', async (ctx) => {
    const t = setup();
    write(t.main('p', 's12'), [CLEAN]);
    if (!link(join(t.staged.root, 'gone'), join(t.staged.projectsRoot, 'p', 's12', 'subagents', 'linked'))) return ctx.skip();
    expect((await checkSession(t.staged.runtime, t.termsFile, 'p', 's12')).reason).toBe('unreadable');
  });

  it('excludes a session whose own path holds a link that leads nowhere or to a file, though its main is clean', async (ctx) => {
    const t = setup();
    const gone = join(t.staged.root, 'gone');
    // subagents as a broken link
    write(t.main('p', 's14'), [CLEAN]);
    if (!link(gone, join(t.staged.projectsRoot, 'p', 's14', 'subagents'))) return ctx.skip();
    expect((await checkSession(t.staged.runtime, t.termsFile, 'p', 's14')).reason).toBe('unreadable');
    // subagents as a link to a file holding the term: not a directory, so it was not scanned
    write(t.main('p', 's15'), [CLEAN]);
    const file = join(t.staged.root, 'agent.jsonl');
    write(file, [DIRTY]);
    mkdirSync(join(t.staged.projectsRoot, 'p', 's15'), { recursive: true });
    if (!makeLink(file, join(t.staged.projectsRoot, 'p', 's15', 'subagents'), 'file')) return ctx.skip();
    expect((await checkSession(t.staged.runtime, t.termsFile, 'p', 's15')).reason).toBe('unreadable');
    // the session folder as a broken link
    write(t.main('p', 's16'), [CLEAN]);
    if (!link(gone, join(t.staged.projectsRoot, 'p', 's16'))) return ctx.skip();
    expect((await checkSession(t.staged.runtime, t.termsFile, 'p', 's16')).reason).toBe('unreadable');
    // the project folder as a broken link, with a clean raw main
    const raw = join(t.staged.storeDir, 'raw', 'q', 's17.jsonl');
    write(raw, [CLEAN]);
    if (!link(gone, join(t.staged.projectsRoot, 'q'))) return ctx.skip();
    expect((await checkSession(t.staged.runtime, t.termsFile, 'q', 's17')).reason).toBe('unreadable');
    // the assert gate refuses s14
    await expect(assertDepositable(t.staged.runtime, t.termsFile, 'p', 's14')).rejects.toBeInstanceOf(CliError);
  });

  it('aborts naming the ordinal when a link that is not named like a session leads nowhere', async (ctx) => {
    const t = setup();
    write(t.main('p', 's18'), [CLEAN]);
    if (!link(join(t.staged.root, 'gone'), join(t.staged.projectsRoot, 'p', 'notes'))) return ctx.skip();
    const failure = await scanStore(t.staged.runtime, t.termsFile).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliError);
    const message = failure instanceof CliError ? failure.message : '';
    expect(message).toMatch(/folder 1 .*no list was written/);
    expect(message).not.toContain('notes');
  });

  it('counts a linked project folder and a linked session folder, and aborts on a broken project link', async (ctx) => {
    const t = setup();
    const outside = join(t.staged.root, 'outside-proj');
    write(join(outside, 's13.jsonl'), [DIRTY]);
    if (!link(outside, join(t.staged.projectsRoot, 'linkedproj'))) return ctx.skip();
    const sessionOutside = join(t.staged.root, 'outside-session');
    write(join(sessionOutside, 'subagents', 'agent-y.jsonl'), [DIRTY]);
    write(t.main('q', 'ignored'), [CLEAN]);
    if (!link(sessionOutside, join(t.staged.projectsRoot, 'q', S_D))) return ctx.skip();
    const { counts } = await scanStore(t.staged.runtime, t.termsFile);
    expect(counts).toMatchObject({ sessions: 3, excluded: 2, notSessions: 0 });
    expect(counts.folders).toHaveLength(2);
    expect(counts.reasons).toMatchObject({ term: 2 });
    link(join(t.staged.root, 'gone'), join(t.staged.projectsRoot, 'brokenproj'));
    const failure = await scanStore(t.staged.runtime, t.termsFile).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliError);
    expect(failure instanceof CliError ? failure.message : '').toContain('no list was written');
    expect(failure instanceof CliError ? failure.message : '').not.toContain('brokenproj');
  });
});

describe('a link at any level that leads nowhere or to the wrong kind of entry is never clean', () => {
  type Level = 'projects root' | 'store dir' | 'raw root' | 'project folder' | 'session folder' | 'subagents' | 'main';
  type Target = 'broken' | 'file' | 'directory';
  // A root or project folder stops the scan; below that the session reads unreadable.
  const levels: { level: Level; targets: Target[]; stops: boolean }[] = [
    { level: 'projects root', targets: ['broken', 'file'], stops: true },
    { level: 'store dir', targets: ['broken', 'file'], stops: true },
    { level: 'raw root', targets: ['broken', 'file'], stops: true },
    { level: 'project folder', targets: ['broken', 'file'], stops: true },
    { level: 'session folder', targets: ['broken', 'file'], stops: false },
    { level: 'subagents', targets: ['broken', 'file'], stops: false },
    { level: 'main', targets: ['broken', 'directory'], stops: false },
  ];
  // The roots do not depend on the source: one row each, in `projects`.
  const cases = levels.flatMap(({ level, targets, stops }) =>
    targets.flatMap((target) => (['projects', 'raw'] as const).filter((source) => source === 'projects' || !level.endsWith('root') && level !== 'store dir').map((source) => ({ level, target, stops, source }))),
  );

  it.for(cases)('$level as a $target link in $source reads unreadable (stops the scan: $stops)', async ({ level, target, stops, source }, ctx) => {
      const t = setup();
    const { staged } = t;
    const root = source === 'projects' ? staged.projectsRoot : join(staged.storeDir, 'raw');
    const other = source === 'projects' ? join(staged.storeDir, 'raw') : staged.projectsRoot;
    // A clean copy in the other source, and a term-holding file for a link to a file to point at, so a link that is not followed reads clean.
    write(join(other, 'p', `${S_D}.jsonl`), [CLEAN]);
    const decoy = join(staged.root, 'decoy', target === 'directory' ? 'dir' : 'file.jsonl');
    if (target === 'directory') write(join(decoy, 'x.jsonl'), [DIRTY]);
    else write(decoy, [DIRTY]);
    const aim = target === 'broken' ? join(staged.root, 'nowhere') : decoy;
    const type: LinkType = target === 'file' ? 'file' : 'dir';
    const place: Record<Level, string> = {
      'projects root': staged.projectsRoot,
      'store dir': staged.storeDir,
      'raw root': join(staged.storeDir, 'raw'),
      'project folder': join(root, 'p'),
      'session folder': join(root, 'p', S_D),
      subagents: join(root, 'p', S_D, 'subagents'),
      main: join(root, 'p', `${S_D}.jsonl`),
    };
    const at = place[level];
    // Levels below the project folder need their parents, with a clean main so the session exists in this source.
    if (level === 'session folder' || level === 'subagents') write(join(root, 'p', `${S_D}.jsonl`), [CLEAN]);
    if (level === 'projects root' || level === 'store dir' || level === 'raw root') {
      // Roots: a clean harness main stays in place unless the root is the projects root itself.
      write(join(staged.projectsRoot, 'p', `${S_D}.jsonl`), [CLEAN]);
      if (level === 'projects root') rmSync(at, { recursive: true, force: true });
      if (level === 'store dir') rmSync(at, { recursive: true, force: true });
      if (level === 'raw root') rmSync(at, { recursive: true, force: true });
    }
    if (level === 'main' || level === 'project folder') rmSync(at, { recursive: true, force: true });
    if (!makeLink(aim, at, type)) return ctx.skip();
    expect((await checkSession(staged.runtime, t.termsFile, 'p', S_D)).reason).toBe('unreadable');
    const scan = await scanStore(staged.runtime, t.termsFile).then(
      (done) => done,
      (error: unknown) => error,
    );
    if (stops) {
      expect(scan).toBeInstanceOf(CliError);
      expect(scan instanceof CliError ? scan.message : '').toContain('no list was written');
    } else {
      expect(scan).not.toBeInstanceOf(Error);
      expect(scan).toMatchObject({ counts: { reasons: { unreadable: 1, noRaw: 0 }, kept: 0 } });
    }
  });

  type Entry = 'broken' | 'file without .jsonl' | 'directory named .jsonl' | 'directory named .jsonl holding a non-jsonl file';
  const entries: Entry[] = ['broken', 'file without .jsonl', 'directory named .jsonl', 'directory named .jsonl holding a non-jsonl file'];

  it.for(entries.flatMap((entry) => (['projects', 'raw'] as const).map((source) => ({ entry, source }))))('subagent entry as a $entry link in $source reads unreadable', async ({ entry, source }, ctx) => {
    const t = setup();
    const { staged } = t;
    const root = source === 'projects' ? staged.projectsRoot : join(staged.storeDir, 'raw');
    const other = source === 'projects' ? join(staged.storeDir, 'raw') : staged.projectsRoot;
    write(join(other, 'p', `${S_D}.jsonl`), [CLEAN]);
    write(join(root, 'p', `${S_D}.jsonl`), [CLEAN]);
    const subagents = join(root, 'p', S_D, 'subagents');
    mkdirSync(subagents, { recursive: true });
    const decoy = join(staged.root, 'entry-decoy');
    if (entry === 'file without .jsonl') write(decoy, [DIRTY]);
    if (entry === 'directory named .jsonl') mkdirSync(decoy, { recursive: true });
    if (entry === 'directory named .jsonl holding a non-jsonl file') write(join(decoy, 'notes.txt'), [DIRTY]);
    const aim = entry === 'broken' ? join(staged.root, 'nowhere') : decoy;
    const name = entry === 'file without .jsonl' ? 'agent-x' : 'agent-x.jsonl';
    if (!makeLink(aim, join(subagents, name), entry === 'file without .jsonl' ? 'file' : 'dir')) return ctx.skip();
    expect((await checkSession(staged.runtime, t.termsFile, 'p', S_D)).reason).toBe('unreadable');
  });

  it('aborts with no list when the store log is a link that leads nowhere', async (ctx) => {
    const t = setup();
    write(t.main('p', 's20'), [CLEAN]);
    if (!makeLink(join(t.staged.root, 'nowhere'), join(t.staged.storeDir, 'observations.jsonl'), 'file')) return ctx.skip();
    const failure = await scanStore(t.staged.runtime, t.termsFile).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CliError);
    expect(failure instanceof CliError ? failure.message : '').toContain('no list was written');
  });

  it('lists a session-named link to a file, as the gate reads it', async (ctx) => {
    const t = setup();
    write(t.main('p', 's19'), [CLEAN]);
    const file = join(t.staged.root, 'a-file');
    write(file, [DIRTY]);
    if (!makeLink(file, join(t.staged.projectsRoot, 'p', S_D), 'file')) return ctx.skip();
    const { counts } = await scanStore(t.staged.runtime, t.termsFile);
    expect(counts).toMatchObject({ sessions: 2, notSessions: 0, reasons: { unreadable: 1 } });
    expect((await checkSession(t.staged.runtime, t.termsFile, 'p', S_D)).reason).toBe('unreadable');
  });
});

describe('loadTerms and exclusionPaths', () => {
  it('counts a file that decodes to garbage (UTF-16, or bytes that are not UTF-8) as holding no terms', async () => {
    const t = setup(null);
    writeFileSync(t.termsFile, Buffer.from(String.fromCharCode(0xfeff) + TERM + String.fromCharCode(10), 'utf16le'));
    expect(await loadTerms(t.termsFile)).toEqual([]);
    writeFileSync(t.termsFile, Buffer.concat([Buffer.from(TERM), Buffer.from([0x0a, 0xff, 0xfe, 0x0a])]));
    expect(await loadTerms(t.termsFile)).toEqual([]);
  });

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
  it('lists a session whose only main is a link, scans it, and fails closed on a broken one', async (ctx) => {
    const t = setup();
    const real = join(t.staged.root, 'outside.jsonl');
    write(real, [DIRTY]);
    if (!makeLink(real, t.main('p', 'linked'), 'file') || !makeLink(join(t.staged.root, 'nowhere.jsonl'), t.main('p', 'broken'), 'file')) return ctx.skip();
    const { counts, excluded } = await scanStore(t.staged.runtime, t.termsFile);
    expect(counts.sessions).toBe(2);
    expect(counts.reasons).toMatchObject({ term: 1, noRaw: 0, unreadable: 1 });
    expect(excluded.map((entry) => entry.session).sort()).toEqual(['broken', 'linked']);
  });

  const populate = (t: ReturnType<typeof setup>): void => {
    write(t.main('p', 'a'), [DIRTY]);
    write(t.main('p', 'b'), [CLEAN]);
    write(t.agent('p', 'b', 'agent-1'), [DIRTY]);
    write(t.main('q', 'c'), [CLEAN]);
    write(t.agent('q', S_D, 'agent-1'), [CLEAN]);
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
      bySource: { projects: { main: 1, subagent: 1, sessions: 2 }, raw: { main: 1, subagent: 0, sessions: 1 } },
      notSessions: 0,
    });
    expect(counts.folders).toEqual([
      { folder: 1, sessions: 2, excluded: 2, hits: { projects: { main: 1, subagent: 1 }, raw: { main: 1, subagent: 0 } } },
      { folder: 2, sessions: 2, excluded: 1, hits: { projects: { main: 0, subagent: 0 }, raw: { main: 0, subagent: 0 } } },
    ]);
    expect(excluded).toEqual([
      { project: 'p', session: 'a' },
      { project: 'p', session: 'b' },
      { project: 'q', session: S_D },
    ]);
  });

  it('counts a folder that is not a session in neither the list nor the sessions', async () => {
    const t = setup();
    populate(t);
    mkdirSync(join(t.staged.projectsRoot, 'q', 'memory'), { recursive: true });
    write(join(t.staged.projectsRoot, 'q', 'memory', 'note.jsonl'), [DIRTY]);
    const { counts, excluded } = await scanStore(t.staged.runtime, t.termsFile);
    expect(counts).toMatchObject({ sessions: 4, excluded: 3, notSessions: 1 });
    expect(excluded.map((entry) => entry.session)).not.toContain('memory');
  });

  it('lists a session the store logged whose raw is gone everywhere as no raw', async () => {
    const staged = stage();
    const termsFile = join(staged.root, 'terms.txt');
    writeFileSync(termsFile, TERM);
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    rmSync(staged.projectsRoot, { recursive: true, force: true });
    rmSync(join(staged.storeDir, 'raw'), { recursive: true, force: true });
    const { counts, excluded } = await scanStore(staged.runtime, termsFile);
    expect(counts.sessions).toBeGreaterThan(0);
    expect(counts.reasons.noRaw).toBe(counts.sessions);
    expect(excluded).toHaveLength(counts.sessions);
    expect(excluded.every((entry) => entry.project === 'proj')).toBe(true);
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
    if (process.platform !== 'win32') expect(statSync(list).mode % 0o1000).toBe(0o600);
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
