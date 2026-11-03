import { appendFileSync, mkdirSync, promises, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES, NOW, addProject, cleanup, stage, type Staged } from './test-support.js';

// The log's real limit is 536,870,888 characters, and a file that size is too slow for the suite. So a text read of the log fails here past
// an injected size, the way Node fails past the real one; the proof over a real 540 MB log is in the t767 report.
const seams = vi.hoisted(() => ({
  logChars: Number.POSITIVE_INFINITY,
  rename: undefined as undefined | ((to: string) => Promise<void>),
}));

vi.mock('node:fs/promises', () => ({
  ...promises,
  readFile: async (file: string, encoding: 'utf8') => {
    const text = await promises.readFile(file, encoding);
    if (file.endsWith('observations.jsonl') && text.length > seams.logChars) throw new RangeError('Invalid string length');
    return text;
  },
  rename: async (from: string, to: string) => {
    await seams.rename?.(to);
    await promises.rename(from, to);
  },
}));

const { deposit, depositSession, loadStore, paths } = await import('./store.js');
const { extractSession } = await import('./derive.js');
const { makeRedactor } = await import('./redact.js');

beforeEach(() => {
  seams.logChars = Number.POSITIVE_INFINITY;
  seams.rename = undefined;
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

// The compaction describe block follows in the next item; these keep the imports the rest of the file needs.
export const unused = { appendFileSync, statSync, utimesSync, addProject, depositSession };
