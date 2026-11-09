import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { books, measure, formatMeasure, recall } from './query.js';
import { harnessOf, type SessionObservation } from './schema.js';
import { deposit, loadStore, paths, readSkeletons } from './store.js';
import { verifyAll, verifyCaptured } from './verify.js';
import { cleanup, composers, folders, NOW, removeHeld, stage, stageCursor, stageRawCursor } from './test-support.js';

afterEach(cleanup);

const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null;

const trackedKeys = (storeDir: string): string[] => {
  const state: unknown = JSON.parse(readFileSync(paths(storeDir).state, 'utf8'));
  return isRecord(state) && isRecord(state.files) ? Object.keys(state.files) : [];
};

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

/**
 * The synthetic Cursor `User` folder (three SQLite files and the workspace folders they name) is built once: a deposit only reads it, and
 * building it per test is avoidable file work, and one loaded Windows run of this file passed the 30 s limit (the cause was not
 * reproduced). Each test still gets its own projects root and store, because a deposit writes there. A test that edits the Cursor store
 * builds its own with `ownStaged`.
 */
let sharedRoot = '';
let sharedUser = '';

beforeAll(async () => {
  sharedRoot = mkdtempSync(join(tmpdir(), 'oars-cursor-shared-'));
  const { repo, plain } = folders(sharedRoot);
  sharedUser = await stageCursor(sharedRoot, composers(repo, plain));
});

afterAll(() => {
  removeHeld(sharedRoot);
});

const staged = () => {
  const s = stage();
  return { ...s, user: sharedUser, runtime: { ...s.runtime, cursorRoot: sharedUser } };
};

const ownStaged = async () => {
  const s = stage();
  const { repo, plain } = folders(s.root);
  const user = await stageCursor(s.root, composers(repo, plain));
  return { ...s, user, runtime: { ...s.runtime, cursorRoot: user } };
};

describe('depositing the Cursor source', () => {
  it('captures each composer session as a cursor-harness session, and a second deposit adds nothing', async () => {
    const s = staged();
    const first = await deposit(s.runtime, options(['cursor']));
    expect(first).toMatchObject({ cursor: 3, sessions: 3, unchanged: 0 });
    const store = await loadStore(s.storeDir);
    expect(store.sessions.map((session) => [session.session, harnessOf(session)]).sort()).toEqual([
      ['cursor-agent', 'cursor'],
      ['cursor-chat', 'cursor'],
      ['cursor-loose', 'cursor'],
    ]);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    const second = await deposit(s.runtime, options(['cursor']));
    expect(second).toMatchObject({ cursor: 0, sessions: 0, unchanged: 3 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    const state: unknown = JSON.parse(readFileSync(paths(s.storeDir).state, 'utf8'));
    const tracked = isRecord(state) && isRecord(state.files) ? state.files : {};
    expect(Object.keys(tracked).sort()).toEqual(['cursor/agent', 'cursor/chat', 'cursor/loose']);
    expect(tracked['cursor/agent']).toMatchObject({ size: 5, mtimeMs: Date.parse('2025-03-02T09:30:00Z') });
  });

  it('deposits a composer that recorded no token counts as unobserved usage, not a measured zero, and keeps the counted ones labeled', async () => {
    const s = staged();
    await deposit(s.runtime, options(['cursor']));
    const store = await loadStore(s.storeDir);
    const loose = store.sessions.find((session) => session.session === 'cursor-loose');
    expect(loose?.usageObserved).toEqual([]);
    expect(loose?.usageResponses).toBe(0);
    expect(store.sessions.find((session) => session.session === 'cursor-chat')?.usageObserved).toEqual(['input', 'output']);
    // The derived prompts carry the same labels as their session.
    const promptOf = (id: string) => store.prompts.find((held) => held.session === id);
    expect(promptOf('cursor-loose')?.usageObserved).toEqual([]);
    expect(promptOf('cursor-loose')?.usageResponses).toBe(0);
    expect(promptOf('cursor-chat')?.usageObserved).toEqual(['input', 'output']);
  });

  it('reads a Cursor call by its own table and frames its session as Cursor, from the deposit down', async () => {
    const s = staged();
    await deposit(s.runtime, options(['cursor']));
    const store = await loadStore(s.storeDir);
    const steps = store.tools.filter((tool) => tool.session === 'cursor-agent').flatMap((tool) => tool.steps ?? []);
    expect(steps[0]).toMatchObject({ action: 'file.read', native: 'read_file' });
    expect(store.sessions.find((session) => session.session === 'cursor-agent')?.frame).toMatchObject({ harness: 'cursor' });
  });

  it('puts a session in the project slug of its workspace folder and a loose one under cursor', async () => {
    const s = staged();
    await deposit(s.runtime, options(['cursor']));
    const projects = Object.fromEntries((await loadStore(s.storeDir)).sessions.map((session) => [session.session, session.project]));
    expect(projects['cursor-agent']).toMatch(/work-app$/);
    expect(projects['cursor-loose']).toBe('cursor');
  });

  it('does not read the store unless --allow names cursor', async () => {
    const s = staged();
    expect(await deposit(s.runtime, options(['nothing-here']))).toMatchObject({ cursor: 0, sessions: 0 });
    expect(await deposit(s.runtime, options(['*']))).toMatchObject({ cursor: 3 });
  });

  it('skips silently when Cursor is absent or the runtime names no store', async () => {
    const s = stage();
    expect(await deposit({ ...s.runtime, cursorRoot: s.root }, options(['cursor']))).toMatchObject({ cursor: 0, unchanged: 0 });
    expect(await deposit(s.runtime, options(['cursor']))).toMatchObject({ cursor: 0 });
  });

  it('captures a session again when Cursor writes it after the deposit', async () => {
    const s = await ownStaged();
    await deposit(s.runtime, options(['cursor']));
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(`${s.user}/globalStorage/state.vscdb`);
    const row = db.prepare("select cast(value as text) as v from cursorDiskKV where key = 'composerData:chat'").get();
    const parsed: unknown = JSON.parse(String(row?.v));
    const composer = isRecord(parsed) ? parsed : {};
    composer.lastUpdatedAt = Number(composer.lastUpdatedAt) + 1000;
    db.prepare("update cursorDiskKV set value = ? where key = 'composerData:chat'").run(JSON.stringify(composer));
    db.close();
    const again = await deposit(s.runtime, { ...options(['cursor']), now: () => NOW + 1 });
    expect(again).toMatchObject({ cursor: 1, unchanged: 2 });
    const highest = (await loadStore(s.storeDir)).sessions.filter((session) => session.session === 'cursor-chat');
    expect(highest).toHaveLength(1);
  });
});

describe('recall, books, and measure over Cursor skeletons', () => {
  it('books groups by harness, and a Claude Code session beside a Cursor one stays separate', async () => {
    const s = staged();
    await deposit(s.runtime, options(['*']));
    const store = await loadStore(s.storeDir);
    const rows = books(store, 'harness', NOW);
    const claude = rows.find((row) => row.key === 'claude-code');
    const cursor = rows.find((row) => row.key === 'cursor');
    expect(cursor?.prompts).toBe(3);
    expect((claude?.prompts ?? 0) + (cursor?.prompts ?? 0)).toBe(store.prompts.length);
    expect(books(store, 'class', NOW).reduce((total, row) => total + row.prompts, 0)).toBe(store.prompts.length);
  });

  it('measure counts Cursor sessions in its window with no special case', async () => {
    const s = staged();
    await deposit(s.runtime, options(['cursor']));
    const store = await loadStore(s.storeDir);
    const signal = measure(store, [], [], 5);
    expect(signal.last.sessions).toBe(3);
    expect(signal.last.cursorSessions).toBe(3);
    expect(formatMeasure(signal)).toMatch(/of which Cursor\s+3\s/);
  });

  it('recall finds the Cursor session by its error and by its file', async () => {
    const s = staged();
    await deposit(s.runtime, options(['cursor']));
    const store = await loadStore(s.storeDir);
    const byError = recall(store, { error: '2 tests failed' }, NOW);
    expect(byError.matches.map((match) => [match.tool, match.sessions])).toEqual([['Bash', 1]]);
    const byPath = recall(store, { path: 'src/parser.ts' }, NOW);
    expect(byPath.matches.length).toBeGreaterThan(0);
    expect(byPath.matches.every((match) => match.sessions >= 1)).toBe(true);
  });

  it('verify holds for Cursor sessions: no invariant is violated by a deposit', async () => {
    const s = staged();
    await deposit(s.runtime, options(['cursor']));
    const { skeletons } = await readSkeletons(s.storeDir);
    expect(skeletons).toHaveLength(3);
    const store = await loadStore(s.storeDir);
    const results = [...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)];
    expect(results.filter((result) => result.violations > 0)).toEqual([]);
  });

  it('allow.unmatched sees the Cursor source, so --allow cursor reports nothing missing', async () => {
    const s = staged();
    expect((await deposit(s.runtime, options(['cursor']))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['cursr']))).missing).toEqual(['cursr']);
  });

  it('a session without a harness reads as Claude Code', () => {
    const bare: Pick<SessionObservation, 'harness'> = {};
    expect(harnessOf(bare)).toBe('claude-code');
  });
});

describe('an unreadable Cursor store fails open', () => {
  const withClaude = () => {
    const s = stage();
    const project = join(s.projectsRoot, 'mine');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: 'hello' } })}\n`);
    return s;
  };

  it('reports a file that is not a database and still deposits the Claude Code folder and writes state.json', async () => {
    const s = withClaude();
    const user = join(s.root, 'Cursor', 'User');
    mkdirSync(join(user, 'globalStorage'), { recursive: true });
    writeFileSync(join(user, 'globalStorage', 'state.vscdb'), 'this is not a database');
    const result = await deposit({ ...s.runtime, cursorRoot: user }, options(['mine', 'cursor']));
    expect(result).toMatchObject({ sessions: 1, cursor: 0, missing: [] });
    expect(result.cursorUnreadable).toHaveLength(1);
    expect(result.cursorUnreadable[0]).toContain('state.vscdb');
    expect(trackedKeys(s.storeDir)).toEqual(['mine/one.jsonl']);
  });

  it('reports a database with no cursorDiskKV table (an older Cursor) the same way', async () => {
    const s = withClaude();
    const user = join(s.root, 'Cursor', 'User');
    mkdirSync(join(user, 'globalStorage'), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(user, 'globalStorage', 'state.vscdb'));
    db.exec('create table ItemTable (key text, value blob)');
    db.close();
    const result = await deposit({ ...s.runtime, cursorRoot: user }, options(['mine', 'cursor']));
    expect(result.sessions).toBe(1);
    expect(result.cursorUnreadable).toHaveLength(1);
    expect(result.cursorUnreadable[0]).toMatch(/cursorDiskKV/);
    expect(trackedKeys(s.storeDir)).toEqual(['mine/one.jsonl']);
  });

  it('a store with no readable workspace still deposits its sessions', async () => {
    const s = stage();
    const user = await stageRawCursor(s.root, [{ id: 'x', document: { composerId: 'x', createdAt: 1, conversation: [{ type: 1, text: 'hi' }] } }], [{ json: { folder: 'file:///nowhere' } }]);
    const result = await deposit({ ...s.runtime, cursorRoot: user }, options(['cursor']));
    expect(result).toMatchObject({ cursor: 1, cursorUnreadable: [] });
  });
});

describe('the Cursor source: safety', () => {
  const doc = (composerId: string) => ({ composerId, createdAt: 1, conversation: [{ type: 1, text: 'hi' }] });

  it('skips and counts a composer whose id is not a safe file name, and writes nothing outside skeletons', async () => {
    const s = stage();
    const user = await stageRawCursor(
      s.root,
      [
        { id: 'good', document: doc('good') },
        { id: 'trav1', document: doc('../../escaped') },
        { id: 'trav2', document: doc('../../../escaped') },
        { id: 'trav3', document: doc('../../../../escaped') },
        { id: 'dots', document: doc('..') },
      ],
      [],
    );
    const result = await deposit({ ...s.runtime, cursorRoot: user }, options(['cursor']));
    // `skeletons/cursor-<id>.json` with these ids normalizes to `skeletons/`, `<store>/`, and `<root>/` (`cursor-..` is a
    // folder name, so each `..` after it cancels one level). Check the places before the counts: a mutated guard must fail here.
    expect(existsSync(join(s.storeDir, 'skeletons', 'escaped.json'))).toBe(false);
    expect(existsSync(join(s.storeDir, 'escaped.json'))).toBe(false);
    expect(existsSync(join(s.root, 'escaped.json'))).toBe(false);
    expect(result).toMatchObject({ cursor: 1, cursorRejected: 4 });
    expect(trackedKeys(s.storeDir)).toEqual(['cursor/good']);
  });

  it('lets a store write failure propagate instead of blaming the Cursor file', async () => {
    const s = stage();
    const user = await stageRawCursor(s.root, [{ id: 'good', document: doc('good') }], []);
    // A folder where the skeleton file belongs makes only that write fail.
    mkdirSync(join(s.storeDir, 'skeletons', 'cursor-good.json'), { recursive: true });
    const failure = await deposit({ ...s.runtime, cursorRoot: user }, options(['cursor'])).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failure).toBeDefined();
    expect(failure).not.toContain('state.vscdb');
  });
});
