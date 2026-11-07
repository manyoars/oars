import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runHook } from './hooks.js';
import { books, formatMeasure, measure, recall } from './query.js';
import { harnessOf } from './schema.js';
import { deposit, loadStore, paths, readSkeletons } from './store.js';
import { verifyAll, verifyCaptured } from './verify.js';
import { cleanup, NOW, ocAssistant, ocShellDone, ocTool, ocUser, stage, stageOpencode, type OpencodeFixture } from './test-support.js';

afterEach(cleanup);

// Fixtures follow sst/opencode @ 21bf6b4 (see opencode.test.ts); no live OpenCode store was read. Every data folder below is under the test's own temp root
// (`stageOpencode` puts it under `root`, and the runtime's `sourceRoots` names it), so the real `~/.local/share/opencode` is never touched.

const T0 = Date.parse('2026-06-01T10:00:00Z');
const at = (second: number): number => T0 + second * 1000;
const tokens = { input: 100, output: 40, reasoning: 0, cache: { read: 0, write: 0 } };

const failing = (id: string, directory: string, extra: Partial<OpencodeFixture> = {}): OpencodeFixture => ({
  id,
  directory,
  created: at(0),
  updated: at(9),
  messages: [
    ocUser(`msg_${id}1`, 1, at(1), 'fix the build'),
    ocAssistant(`msg_${id}2`, 2, at(2), [ocTool('c1', 'shell', ocShellDone('make', 'make: *** No rule to make target\nExited with code 2', 2), at(3))], { tokens }),
    ocAssistant(`msg_${id}3`, 3, at(5), [{ type: 'text', text: 'it failed' }]),
  ],
  ...extra,
});

const options = (allow: string[]) => ({ allow, redactDomains: [], now: () => NOW });

const staged = async () => {
  const s = stage();
  const root = await stageOpencode(s.root, [failing('ses_A', join(s.root, 'not-a-repo')), failing('ses_B', join(s.root, 'other'))]);
  expect(root.startsWith(s.root)).toBe(true);
  return { ...s, home: root, runtime: { ...s.runtime, sourceRoots: { opencode: root } } };
};

const trackedKeys = (storeDir: string): string[] => {
  const state: unknown = JSON.parse(readFileSync(paths(storeDir).state, 'utf8'));
  const files = typeof state === 'object' && state !== null && 'files' in state ? state.files : {};
  return typeof files === 'object' && files !== null ? Object.keys(files).sort() : [];
};

describe('depositing the OpenCode source', () => {
  it('captures each session as an opencode-harness session, with its own cursor, and a second deposit adds nothing', async () => {
    const s = await staged();
    const first = await deposit(s.runtime, options(['opencode']));
    expect(first).toMatchObject({ sessions: 2, unchanged: 0, missing: [] });
    expect(first.sources.opencode?.read).toBe(2);
    const store = await loadStore(s.storeDir);
    expect(store.sessions.map((entry) => [entry.session, harnessOf(entry)]).sort()).toEqual([
      ['opencode-ses_A', 'opencode'],
      ['opencode-ses_B', 'opencode'],
    ]);
    const log = readFileSync(paths(s.storeDir).observations, 'utf8');
    const second = await deposit(s.runtime, options(['opencode']));
    expect(second).toMatchObject({ sessions: 0, unchanged: 2 });
    expect(readFileSync(paths(s.storeDir).observations, 'utf8')).toBe(log);
    expect(trackedKeys(s.storeDir)).toEqual(['opencode/ses_A', 'opencode/ses_B']);
  });

  it('reads an OpenCode call by its own table and frames its session as OpenCode, with the failed call an error', async () => {
    const s = await staged();
    await deposit(s.runtime, options(['opencode']));
    const store = await loadStore(s.storeDir);
    const calls = store.tools.filter((tool) => tool.session === 'opencode-ses_A');
    expect(calls.flatMap((tool) => tool.steps ?? [])[0]).toMatchObject({ action: 'shell.exec' });
    expect(calls.map((tool) => tool.status)).toEqual(['error']);
    const found = store.sessions.find((candidate) => candidate.session === 'opencode-ses_A');
    expect(found).toMatchObject({ harness: 'opencode' });
    expect(found?.frame).toMatchObject({ harness: 'opencode' });
  });

  it('reads an edit, a search, a fetch, and a subagent spawn as known actions, not as unknown tools', async () => {
    const s = await staged();
    const done = (input: object) => ({ status: 'completed', input, content: [{ type: 'text', text: 'ok' }] });
    const root = await stageOpencode(s.root, [
      {
        id: 'ses_K',
        directory: join(s.root, 'k'),
        created: at(0),
        updated: at(9),
        messages: [
          ocUser('msg_k1', 1, at(1), 'go'),
          ocAssistant('msg_k2', 2, at(2), [
            ocTool('a', 'edit', done({ path: 'a.ts', oldString: 'a', newString: 'b' }), at(3)),
            ocTool('b', 'write', done({ path: 'b.ts', content: 'x' }), at(3)),
            ocTool('c', 'patch', done({ patchText: '*** Begin Patch\n*** Add File: c.ts\n+x\n*** End Patch' }), at(3)),
            ocTool('d', 'read', done({ path: 'a.ts' }), at(3)),
            ocTool('e', 'grep', done({ pattern: 'x' }), at(3)),
            ocTool('f', 'glob', done({ pattern: '*.ts' }), at(3)),
            ocTool('g', 'webfetch', done({ url: 'https://example.com' }), at(3)),
            ocTool('h', 'websearch', done({ query: 'x' }), at(3)),
            ocTool('i', 'subagent', done({ agent: 'explore', description: 'd', prompt: 'p' }), at(3)),
            ocTool('j', 'skill', done({ id: 'review' }), at(3)),
            ocTool('k', 'todowrite', done({ todos: [] }), at(3)),
            ocTool('l', 'question', done({ questions: [] }), at(3)),
          ]),
        ],
      },
    ], 'opencode.db');
    await deposit({ ...s.runtime, sourceRoots: { opencode: root } }, options(['opencode']));
    const store = await loadStore(s.storeDir);
    const steps = store.tools.filter((tool) => tool.session === 'opencode-ses_K').flatMap((tool) => (tool.steps ?? []).map((step) => step.action));
    expect(steps).toEqual(['file.edit', 'file.write', 'file.edit', 'file.read', 'file.search', 'file.search', 'web.fetch', 'web.search', 'agent.spawn', 'skill.run', 'plan.update', 'ask.user']);
  });

  it('deposits a subagent session as a subagent of its parent, so session counts stay main sessions', async () => {
    const s = await staged();
    const root = await stageOpencode(s.root, [failing('ses_P', join(s.root, 'p')), failing('ses_C', join(s.root, 'p'), { parentId: 'ses_P', agent: 'explore' })]);
    const result = await deposit({ ...s.runtime, sourceRoots: { opencode: root } }, options(['opencode']));
    expect(result).toMatchObject({ sessions: 1, subagents: 1 });
  });

  it('is read by default and not when denied, and an allowed name reports nothing missing while a typo does', async () => {
    const s = await staged();
    // With nothing named every source is read; a denial keeps this one out.
    expect((await deposit(s.runtime, options([]))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['!opencode']))).sources['opencode']).toBeUndefined();
    expect((await deposit(s.runtime, options(['opencode']))).missing).toEqual([]);
    expect((await deposit(s.runtime, options(['opencod']))).missing).toEqual(['opencod']);
  });

  it('does not read a discovered OpenCode store that is not allowed: another allowed source reads, opencode stays unread and untracked', async () => {
    const s = await staged();
    const project = join(s.projectsRoot, 'mine');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: 'hello' } })}\n`);
    const result = await deposit(s.runtime, options(['mine']));
    expect(result.sources.opencode).toBeUndefined();
    expect(trackedKeys(s.storeDir)).toEqual(['mine/one.jsonl']);
  });

  it('changes nothing in the OpenCode data folder: a deposit only reads', async () => {
    const s = await staged();
    const before = readFileSync(join(s.home, 'opencode.db'));
    await deposit(s.runtime, options(['opencode']));
    expect(readFileSync(join(s.home, 'opencode.db')).equals(before)).toBe(true);
  });

  it('holds every verify invariant, including --strict, for a normal session, one with no usage, and one ending in an assistant line', async () => {
    const s = await staged();
    const root = await stageOpencode(s.root, [
      failing('ses_A', join(s.root, 'not-a-repo')),
      { id: 'ses_C', directory: '/x', created: at(0), updated: at(9), messages: [ocUser('msg_c1', 1, at(1), 'hi'), ocAssistant('msg_c2', 2, at(2), [{ type: 'text', text: 'hello' }]), ocUser('msg_c3', 3, at(3), 'again'), ocAssistant('msg_c4', 4, at(4), [{ type: 'text', text: 'more' }])] },
      failing('ses_D', '/x'),
    ]);
    await deposit({ ...s.runtime, sourceRoots: { opencode: root } }, options(['opencode']));
    const { skeletons } = await readSkeletons(s.storeDir);
    expect(skeletons).toHaveLength(3);
    const store = await loadStore(s.storeDir);
    expect([...verifyAll(skeletons), ...verifyCaptured(store.sessions, store.tools)].filter((result) => result.violations > 0)).toEqual([]);
  });

  it('lets the nightly run repeat a saved allow, so it reads OpenCode with no flag', async () => {
    const s = await staged();
    await deposit(s.runtime, options(['opencode']));
    const root = await stageOpencode(s.root, [failing('ses_A', join(s.root, 'not-a-repo')), failing('ses_B', join(s.root, 'other')), failing('ses_N', '/x')]);
    await runHook('nightly', '', { ...s.runtime, sourceRoots: { opencode: root } }, () => NOW);
    expect(trackedKeys(s.storeDir)).toContain('opencode/ses_N');
  });

  it('reads a session again when it grows, as a resume appends messages to the same session', async () => {
    const s = await staged();
    await deposit(s.runtime, options(['opencode']));
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(s.home, 'opencode.db'));
    db.prepare('insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?, ?)').run('msg_new', 'ses_B', 'user', 9, at(20), at(20), JSON.stringify({ time: { created: at(20) }, text: 'one more' }));
    db.prepare('update session_v2 set time_updated = ? where id = ?').run(at(20), 'ses_B');
    db.close();
    expect(await deposit(s.runtime, options(['opencode']))).toMatchObject({ sessions: 1, unchanged: 1 });
  });

  it('fails open on a database it cannot read: the Claude Code folder is kept, and the problem is named', async () => {
    const s = await staged();
    const project = join(s.projectsRoot, 'mine');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'one.jsonl'), `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: 'hello' } })}\n`);
    writeFileSync(join(s.home, 'opencode.db'), 'this is not a database');
    const result = await deposit(s.runtime, options(['mine', 'opencode']));
    expect(trackedKeys(s.storeDir)).toEqual(['mine/one.jsonl']);
    expect(result.sources.opencode?.unreadable.join('\n')).toContain('opencode.db');
  });
});

describe('recall, books, and measure over OpenCode skeletons', () => {
  it('measure counts OpenCode sessions in its window as "of which OpenCode"', async () => {
    const s = await staged();
    await deposit(s.runtime, options(['opencode']));
    const signal = measure(await loadStore(s.storeDir), [], [], 5);
    expect(signal.last.sessions).toBe(2);
    expect(signal.last.otherSessions).toMatchObject({ opencode: 2 });
    expect(formatMeasure(signal)).toMatch(/of which OpenCode\s+2\s/);
  });

  it('books --by harness separates opencode from claude-code', async () => {
    const s = await staged();
    await deposit(s.runtime, options(['opencode']));
    const store = await loadStore(s.storeDir);
    const rows = books(store, 'harness', NOW);
    expect(rows.find((row) => row.key === 'opencode')?.prompts).toBe(2);
    expect(rows.reduce((total, row) => total + row.prompts, 0)).toBe(store.prompts.length);
  });

  it('recall finds the OpenCode session by its error line', async () => {
    const s = await staged();
    await deposit(s.runtime, options(['opencode']));
    const found = recall(await loadStore(s.storeDir), { error: 'No rule' }, NOW);
    expect(found.matches.map((match) => [match.tool, match.sessions])).toEqual([['Bash', 2]]);
  });
});
