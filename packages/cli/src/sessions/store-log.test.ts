import { appendFileSync, existsSync, mkdirSync, promises, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES, NOW, addProject, cleanup, stage, type Staged } from './test-support.js';

// The log's real limit is 536,870,888 characters, and a file that size is too slow for the suite. So a text read of the log fails here past
// an injected size, the way Node fails past the real one; the proof over a real 540 MB log is in the t767 report.
interface Seams {
  logChars: number;
  rename: ((to: string) => Promise<void>) | undefined;
  open: ((file: string) => void) | undefined;
}
const seams = vi.hoisted((): Seams => ({ logChars: Number.POSITIVE_INFINITY, rename: undefined, open: undefined }));

vi.mock('node:fs/promises', () => ({
  ...promises,
  readFile: async (file: string, encoding: 'utf8') => {
    const text = await promises.readFile(file, encoding);
    if (file.endsWith('observations.jsonl') && text.length > seams.logChars) throw new RangeError('Invalid string length');
    return text;
  },
  rename: async (from: string, to: string) => {
    if (to.endsWith('observations.jsonl')) await seams.rename?.(to);
    await promises.rename(from, to);
  },
  open: (file: string, ...rest: [string, number]) => {
    seams.open?.(file);
    return promises.open(file, ...rest);
  },
}));

const { compactLog, deposit, depositSession, loadStore, paths, withLock } = await import('./store.js');
const { extractSession } = await import('./derive.js');
const { makeRedactor } = await import('./redact.js');

beforeEach(() => {
  seams.logChars = Number.POSITIVE_INFINITY;
  seams.rename = undefined;
  seams.open = undefined;
});
afterEach(cleanup);

const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

type Line = { [key: string]: unknown };
const asLine = (value: unknown): Line => {
  if (typeof value !== 'object' || value === null) throw new Error('not a record');
  return Object.fromEntries(Object.entries(value));
};
const toLines = (text: string): Line[] => text.split('\n').filter((line) => line !== '').map((line) => asLine(JSON.parse(line)));
const jsonl = (records: readonly unknown[]): string => records.map((record) => `${JSON.stringify(record)}\n`).join('');

/** One transcript's records under `session` at `rev`, by the same extraction a version-2 deposit used, so the fixture needs no salt. */
const recordsOf = (fixture: string, session: string, rev: number): Line[] => {
  const extract = extractSession({ text: readFileSync(join(FIXTURES, 'proj', fixture), 'utf8'), session, project: 'proj', rev, at: '', bytes: 0, redact: makeRedactor() });
  return [extract.session, ...extract.prompts, ...extract.tools, ...extract.errors].map(asLine);
};

/** Two sessions, one superseded, with what a real log can hold: blank lines, unparsable lines, a record of no known kind, and a torn last line. */
const syntheticLog = (): string =>
  [
    jsonl(recordsOf('errors-a.jsonl', 'alpha', 1)),
    '\n',
    'not json at all\n',
    jsonl(recordsOf('tldr.jsonl', 'bravo', 1)),
    jsonl([{ kind: 'from-a-later-oars', session: 'alpha', rev: 99 }]),
    jsonl(recordsOf('errors-b.jsonl', 'alpha', 2)),
    '{"kind":"session","session":"alpha","rev":',
  ].join('');

const writeLog = (staged: Staged, text: string): void => {
  mkdirSync(staged.storeDir, { recursive: true });
  writeFileSync(paths(staged.storeDir).observations, text);
};

/** What a reader sees, without the derived rule output a later EXTRACTOR_VERSION may change. */
const shape = (store: Awaited<ReturnType<typeof loadStore>>) => ({
  sessions: store.sessions.map((session) => `${session.session}:${String(session.rev)}`),
  subagents: store.subagents.map((session) => `${session.session}:${String(session.rev)}`),
  prompts: store.prompts.map((prompt) => `${prompt.session}#${String(prompt.index)}`),
  errors: store.errors.map((error) => error.session),
  tools: store.tools.length,
  newerCaptures: store.newerCaptures,
});

describe('a log past the string limit', () => {
  it('loads: loadStore reads no whole-file string of the log', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const before = await loadStore(staged.storeDir);
    seams.logChars = 1;
    expect(await loadStore(staged.storeDir)).toEqual(before);
  });

  it('deposits: a raw-only subagent still finds its logged origin', async () => {
    const staged = stage();
    const agents = join(staged.projectsRoot, 'proj', 'tldr', 'subagents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'agent-x.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00Z', cwd: '/w', message: { role: 'user', content: 'go' } })}\n`);
    writeFileSync(join(agents, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'tu9' }));
    await deposit(staged.runtime, options);
    const state = asLine(JSON.parse(readFileSync(paths(staged.storeDir).state, 'utf8')));
    writeFileSync(paths(staged.storeDir).state, JSON.stringify({ ...state, files: {} }));
    rmSync(join(staged.projectsRoot, 'proj', 'tldr'), { recursive: true });
    seams.logChars = 1;
    await deposit(staged.runtime, options);
    expect((await loadStore(staged.storeDir)).subagents).toEqual([expect.objectContaining({ session: 'tldr~agent-x', parent: 'tldr', agentType: 'Explore', spawnedBy: 'tu9' })]);
  });
});

describe('reading the log line by line', () => {
  it('returns what the whole-file read returned on one synthetic log', async () => {
    const staged = stage();
    writeLog(staged, syntheticLog());
    // Captured from the whole-file read this replaced: the same test passed on it, before the change.
    expect(shape(await loadStore(staged.storeDir))).toEqual({
      sessions: ['bravo:1', 'alpha:2'],
      subagents: [],
      prompts: ['bravo#0', 'bravo#1', 'alpha#0'],
      errors: ['alpha', 'alpha'],
      tools: 8,
      newerCaptures: 0,
    });
  });

  it('splits on newlines only: a line separator inside a value does not end the line', async () => {
    const staged = stage();
    const separator = String.fromCharCode(0x2028);
    const [session = {}, ...rest] = recordsOf('tldr.jsonl', 'bravo', 1);
    writeLog(staged, jsonl([{ ...session, project: `pro${separator}j` }, ...rest]));
    expect((await loadStore(staged.storeDir)).sessions).toEqual([expect.objectContaining({ session: 'bravo', project: `pro${separator}j` })]);
  });

  it('keeps a character that straddles a read boundary whole, at every offset', async () => {
    const value = '€'.repeat(400_000);
    const [session = {}, ...rest] = recordsOf('tldr.jsonl', 'bravo', 1);
    for (const padding of ['', 'x', 'xx']) {
      const staged = stage();
      writeLog(staged, `${padding}\n${jsonl([{ ...session, project: value }, ...rest])}`);
      expect((await loadStore(staged.storeDir)).sessions.map((entry) => entry.project)).toEqual([value]);
    }
  });

  it('reads a complete last line with no newline, and an empty or missing log as empty', async () => {
    const staged = stage();
    const empty = { sessions: [], prompts: [], errors: [], subagents: [], tools: [], newerCaptures: 0 };
    expect(await loadStore(staged.storeDir)).toEqual(empty);
    writeLog(staged, '');
    expect(await loadStore(staged.storeDir)).toEqual(empty);
    writeLog(staged, jsonl(recordsOf('tldr.jsonl', 'bravo', 1)).trimEnd());
    expect((await loadStore(staged.storeDir)).sessions.map((session) => session.session)).toEqual(['bravo']);
  });
});

const logOf = (staged: Staged): string => readFileSync(paths(staged.storeDir).observations, 'utf8');
const compact = (staged: Staged, renameWaitMs?: number): Promise<void> => withLock(staged.storeDir, () => compactLog(staged.storeDir, renameWaitMs));
const leftovers = (staged: Staged): string[] => readdirSync(staged.storeDir).filter((name) => name.endsWith('.tmp'));

/** Changes a transcript so the next deposit captures it again under a higher rev. */
const touchTranscript = (staged: Staged, name: string, seconds: number): void => {
  const file = join(staged.projectsRoot, 'proj', name);
  appendFileSync(file, `${JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: 'one more prompt' } })}\n`);
  const later = new Date(Date.now() + seconds * 1000);
  utimesSync(file, later, later);
};

const revsBySession = (staged: Staged): Map<unknown, Set<unknown>> => {
  const revs = new Map<unknown, Set<unknown>>();
  for (const line of toLines(logOf(staged))) revs.set(line.session, (revs.get(line.session) ?? new Set()).add(line.rev));
  return revs;
};

describe('compacting the log', () => {
  it('keeps what a reader sees and drops only superseded lines', async () => {
    const staged = stage();
    writeLog(staged, syntheticLog().replace('{"kind":"session","session":"alpha","rev":', ''));
    appendFileSync(paths(staged.storeDir).observations, '\n{"torn":');
    const before = await loadStore(staged.storeDir);
    const size = statSync(paths(staged.storeDir).observations).size;
    await compact(staged);
    expect(await loadStore(staged.storeDir)).toEqual(before);
    expect(statSync(paths(staged.storeDir).observations).size).toBeLessThan(size);
    const lines = logOf(staged).split('\n');
    // Every line of alpha's first rev is gone; an unreadable line, a record of no known kind, and a torn line (now ended) stay, byte for byte.
    expect(lines.filter((line) => line.includes('"session":"alpha"') && line.includes('"rev":1,'))).toEqual([]);
    expect(lines).toContain('not json at all');
    expect(lines).toContain('{"kind":"from-a-later-oars","session":"alpha","rev":99}');
    expect(lines.slice(-2)).toEqual(['{"torn":', '']);
    expect(lines.filter((line) => line === '')).toHaveLength(1);
    expect(leftovers(staged)).toEqual([]);
  });

  it('leaves a log with nothing superseded alone, and a missing log missing', async () => {
    const staged = stage();
    seams.rename = () => Promise.reject(new Error('nothing to rewrite'));
    mkdirSync(staged.storeDir, { recursive: true });
    await compact(staged);
    expect(existsSync(paths(staged.storeDir).observations)).toBe(false);
    writeLog(staged, jsonl(recordsOf('tldr.jsonl', 'bravo', 1)));
    const text = logOf(staged);
    await compact(staged);
    expect(logOf(staged)).toBe(text);
  });

  it('runs at the end of a deposit that re-captures, and readers see what they saw', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    touchTranscript(staged, 'tldr.jsonl', 5);
    let before: Awaited<ReturnType<typeof loadStore>> | undefined;
    let revsBefore: number | undefined;
    seams.rename = async () => {
      before = await loadStore(staged.storeDir);
      revsBefore = revsBySession(staged).get('tldr')?.size;
    };
    const again = await deposit(staged.runtime, options);
    expect(again).toMatchObject({ sessions: 1, unchanged: 3 });
    expect(revsBefore).toBe(2);
    expect(before?.sessions).toHaveLength(4);
    expect(await loadStore(staged.storeDir)).toEqual(before);
    for (const revs of revsBySession(staged).values()) expect(revs.size).toBe(1);
    // The file keeps the store's private mode through the rename.
    if (process.platform !== 'win32') expect(statSync(paths(staged.storeDir).observations).mode & 0o777).toBe(0o600);
  });

  it('does not run on the hook path, which has seconds', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    touchTranscript(staged, 'tldr.jsonl', 5);
    seams.rename = () => Promise.reject(new Error('the hook path compacted'));
    expect(await depositSession(staged.runtime, join(staged.projectsRoot, 'proj', 'tldr.jsonl'), () => NOW)).toBe('deposited');
    expect(revsBySession(staged).get('tldr')?.size).toBe(2);
  });

  it('loses no line of a hook that appends while it runs: the hook waits for the lock', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    touchTranscript(staged, 'tldr.jsonl', 5);
    let hook: Promise<unknown> | undefined;
    let appendedEarly: boolean | undefined;
    seams.rename = async () => {
      // The temp file is complete and the rename is next, the worst moment: a line appended now would be overwritten without the lock.
      const late = addProject(staged, 'proj', 'late-session', [JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00Z', message: { role: 'user', content: 'a late prompt' } })]);
      hook = depositSession(staged.runtime, late, () => NOW);
      await new Promise((done) => setTimeout(done, 200));
      appendedEarly = logOf(staged).includes('late-session');
    };
    await deposit(staged.runtime, options);
    // Read here, not asserted in the seam: a throw there is a failed compaction, which the deposit outlives.
    expect(appendedEarly).toBe(false);
    expect(await hook).toBe('deposited');
    expect(logOf(staged)).toContain('late-session');
    const sessions = (await loadStore(staged.storeDir)).sessions.map((session) => session.session);
    expect(sessions).toContain('late-session');
    expect(sessions).toContain('tldr');
  });

  it('gives up with the log intact when a writer that broke the lock appended during the rewrite', async () => {
    const staged = stage();
    writeLog(staged, syntheticLog());
    const rogue = jsonl(recordsOf('tldr.jsonl', 'charlie', 1));
    seams.open = (file) => {
      if (file.endsWith('.tmp')) appendFileSync(paths(staged.storeDir).observations, `\n${rogue}`);
    };
    const expected = `${syntheticLog()}\n${rogue}`;
    await expect(compact(staged)).rejects.toThrow('the log changed');
    expect(logOf(staged)).toBe(expected);
    expect(leftovers(staged)).toEqual([]);
  });

  it('leaves a log that loads when it dies before the rename, and the next run clears what the crash left', async () => {
    const staged = stage();
    writeLog(staged, syntheticLog());
    const text = logOf(staged);
    const before = await loadStore(staged.storeDir);
    seams.rename = () => Promise.reject(new Error('died before the rename'));
    await expect(compact(staged)).rejects.toThrow('died before the rename');
    expect(logOf(staged)).toBe(text);
    expect(await loadStore(staged.storeDir)).toEqual(before);
    // A real crash runs no cleanup, so its half-written temp file stays until the next compaction, whatever that finds to do.
    const orphan = `${paths(staged.storeDir).observations}.999.tmp`;
    writeFileSync(orphan, '{"half":');
    expect(await loadStore(staged.storeDir)).toEqual(before);
    seams.rename = undefined;
    await compact(staged);
    expect(leftovers(staged)).toEqual([]);
    expect(await loadStore(staged.storeDir)).toEqual(before);
    writeFileSync(orphan, '{"half":');
    await compact(staged);
    expect(leftovers(staged)).toEqual([]);
  });

  it('waits for a reader to let go of the log, as Windows requires, and gives up with the log intact', async () => {
    const staged = stage();
    const eperm = (): Promise<void> => Promise.reject(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }));
    writeLog(staged, syntheticLog());
    const text = logOf(staged);
    seams.rename = eperm;
    await expect(compact(staged, 0)).rejects.toThrow('EPERM');
    expect(logOf(staged)).toBe(text);
    expect(leftovers(staged)).toEqual([]);
    let refused = 0;
    seams.rename = () => (refused++ < 2 ? eperm() : Promise.resolve());
    await compact(staged);
    expect(refused).toBe(3);
    expect(logOf(staged)).not.toBe(text);
  });

  it('does not fail the deposit when it cannot finish: the records are safe, and the derive still runs', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    touchTranscript(staged, 'tldr.jsonl', 5);
    const derivedBefore = statSync(paths(staged.storeDir).derived).mtimeMs;
    seams.rename = () => Promise.reject(new Error('disk trouble'));
    const notes = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await deposit(staged.runtime, options)).toMatchObject({ sessions: 1 });
    expect(notes).toHaveBeenCalledWith(expect.stringContaining('disk trouble'));
    notes.mockRestore();
    expect(statSync(paths(staged.storeDir).derived).mtimeMs).toBeGreaterThan(derivedBefore);
    expect(revsBySession(staged).get('tldr')?.size).toBe(2);
    // The next deposit, with nothing new to capture, finishes the job.
    seams.rename = undefined;
    expect(await deposit(staged.runtime, options)).toMatchObject({ sessions: 0 });
    expect(revsBySession(staged).get('tldr')?.size).toBe(1);
  });

  it('keeps a subagent origin that only the log holds', async () => {
    const staged = stage();
    const agents = join(staged.projectsRoot, 'proj', 'tldr', 'subagents');
    mkdirSync(agents, { recursive: true });
    const transcript = `${JSON.stringify({ type: 'user', timestamp: '2026-06-01T00:00:00Z', cwd: '/w', message: { role: 'user', content: 'go' } })}\n`;
    writeFileSync(join(agents, 'agent-x.jsonl'), transcript);
    writeFileSync(join(agents, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'tu9' }));
    await deposit(staged.runtime, options);
    appendFileSync(join(agents, 'agent-x.jsonl'), transcript);
    const later = new Date(Date.now() + 5000);
    utimesSync(join(agents, 'agent-x.jsonl'), later, later);
    await deposit(staged.runtime, options);
    expect(revsBySession(staged).get('tldr~agent-x')?.size).toBe(1);
    const state = asLine(JSON.parse(readFileSync(paths(staged.storeDir).state, 'utf8')));
    writeFileSync(paths(staged.storeDir).state, JSON.stringify({ ...state, files: {} }));
    rmSync(join(staged.projectsRoot, 'proj', 'tldr'), { recursive: true });
    await deposit(staged.runtime, options);
    expect((await loadStore(staged.storeDir)).subagents).toEqual([expect.objectContaining({ session: 'tldr~agent-x', parent: 'tldr', agentType: 'Explore', spawnedBy: 'tu9' })]);
  });
});

describe('a store already past the limit', () => {
  it('loads and compacts at the next deposit, even with nothing left to capture', async () => {
    // The state a run that died at the end of its re-capture left: state.json current, and every session in the log twice.
    const staged = stage();
    await deposit(staged.runtime, options);
    const before = await loadStore(staged.storeDir);
    const live = logOf(staged);
    const older = toLines(live).map((line) => ({ ...line, rev: Number(line.rev) - 1 }));
    writeFileSync(paths(staged.storeDir).observations, jsonl(older) + live);
    seams.logChars = 1;
    expect(await deposit(staged.runtime, options)).toMatchObject({ sessions: 0, unchanged: 4 });
    expect(logOf(staged)).toBe(live);
    expect(await loadStore(staged.storeDir)).toEqual(before);
  });
});

describe('the store lock', () => {
  it('stays with a holder that outlives the stale age: a waiter does not break a lock in use', async () => {
    const staged = stage();
    const lockOptions = { waitMs: 5000, staleMs: 1000 };
    const events: string[] = [];
    const holder = withLock(
      staged.storeDir,
      async () => {
        events.push('holder in');
        await new Promise((done) => setTimeout(done, 1500));
        events.push('holder out');
      },
      lockOptions,
    );
    await new Promise((done) => setTimeout(done, 50));
    const waiter = withLock(
      staged.storeDir,
      () => {
        events.push('waiter in');
        return Promise.resolve();
      },
      lockOptions,
    );
    await Promise.all([holder, waiter]);
    expect(events).toEqual(['holder in', 'holder out', 'waiter in']);
  });

  it('stops refreshing a lock held past its hard cap, so a waiter breaks it and logs the holder', async () => {
    const staged = stage();
    const lockOptions = { waitMs: 4000, staleMs: 1000, holdMs: 1400 };
    const notes = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const events: string[] = [];
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((done) => (entered = done));
    const hung = withLock(
      staged.storeDir,
      () =>
        new Promise<void>((done) => {
          release = done;
          entered();
        }),
      lockOptions,
    );
    await inside;
    await withLock(
      staged.storeDir,
      () => {
        events.push('waiter in');
        return Promise.resolve();
      },
      lockOptions,
    );
    release();
    await hung;
    const lines = notes.mock.calls.map(([line]) => String(line));
    notes.mockRestore();
    expect(events).toEqual(['waiter in']);
    const broke = lines.filter((line) => line.includes('broke the store lock'));
    expect(broke).toHaveLength(1);
    expect(broke[0]).toContain(`pid ${String(process.pid)},`);
    expect(broke[0]).not.toContain('-');
    expect(broke[0]).toContain('not refreshed for over 1000 ms');
    expect(lines.filter((line) => line.startsWith('oars: this run held the store lock past 1400 ms and may lose it; rerun it when it ends'))).toHaveLength(1);
  });

  it('caps a holder at six times the stale age when no holdMs is given', async () => {
    const staged = stage();
    // Beats are counted, so the line cannot race a stall: no waiter and no elapsed-time floor, only the cap the holder logs.
    let capped: (line: string) => void = () => undefined;
    const logged = new Promise<string>((done) => (capped = done));
    const notes = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      if (String(chunk).includes('held the store lock past')) capped(String(chunk));
      return true;
    });
    const line = await withLock(staged.storeDir, () => logged, { waitMs: 4000, staleMs: 100 });
    notes.mockRestore();
    expect(line).toContain('past 600 ms');
  });

  it('keeps the next holder locked in when the broken holder ends', async () => {
    const staged = stage();
    const notes = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let releaseFirst: () => void = () => undefined;
    let releaseSecond: () => void = () => undefined;
    let firstIn: () => void = () => undefined;
    let secondIn: () => void = () => undefined;
    const firstEntered = new Promise<void>((done) => (firstIn = done));
    const secondEntered = new Promise<void>((done) => (secondIn = done));
    const first = withLock(
      staged.storeDir,
      () =>
        new Promise<void>((done) => {
          releaseFirst = done;
          firstIn();
        }),
      { waitMs: 4000, staleMs: 1000, holdMs: 1400 },
    );
    await firstEntered;
    const second = withLock(
      staged.storeDir,
      () =>
        new Promise<void>((done) => {
          releaseSecond = done;
          secondIn();
        }),
      { waitMs: 4000, staleMs: 1000 },
    );
    await secondEntered;
    releaseFirst();
    await first;
    await expect(withLock(staged.storeDir, () => Promise.resolve(), { waitMs: 400, staleMs: 1000 })).rejects.toThrow('locked');
    releaseSecond();
    await second;
    notes.mockRestore();
    await withLock(staged.storeDir, () => Promise.resolve(), { waitMs: 400, staleMs: 1000 });
  });

  it('keeps refreshing a live holder after the clock jumps past the cap, as a suspended machine does', async () => {
    const staged = stage();
    const lockFile = join(staged.storeDir, 'store.lock');
    let before = 0;
    let after = 0;
    const jump = vi.spyOn(Date, 'now');
    await withLock(
      staged.storeDir,
      async () => {
        before = statSync(lockFile).mtimeMs;
        const real = Date.now();
        jump.mockReturnValue(real + 7_200_000);
        await new Promise((done) => setTimeout(done, 350));
        after = statSync(lockFile).mtimeMs;
      },
      { waitMs: 1000, staleMs: 400 },
    );
    jump.mockRestore();
    expect(after).toBeGreaterThan(before);
  });
});
