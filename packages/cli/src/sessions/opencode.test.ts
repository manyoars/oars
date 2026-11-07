import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { opencodeRoot, openOpencodeStore, platformPath, type OpencodeSession } from './opencode.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, folders, ocAssistant, ocShellDone, ocTool, ocUser, stage, stageOpencode, type OpencodeFixture } from './test-support.js';

afterEach(cleanup);

// Fixtures follow sst/opencode @ 21bf6b4 (core/src/session/sql.ts, schema/src/session-message.ts, core/src/tool/plugin/*.ts, core/src/shell/result.ts); no live OpenCode
// store was read. Every folder below is under the test's own temp root, so the real `~/.local/share/opencode` is never touched.

const T0 = Date.parse('2026-06-01T10:00:00Z');
const at = (second: number): number => T0 + second * 1000;
const usage = { input: 100, output: 40, reasoning: 10, cache: { read: 300, write: 50 } };

interface Line {
  type?: string;
  cwd?: string;
  message?: { content?: { type?: string; text?: string; name?: string; native?: string; input?: unknown }[] };
}
const isLine = (value: unknown): value is Line => typeof value === 'object' && value !== null;
const linesOf = (text: string): Line[] => text.trim().split('\n').map((raw): unknown => JSON.parse(raw)).filter(isLine);

const capture = (transcript: string, session: string) =>
  captureSession({
    text: transcript,
    session,
    harness: 'opencode',
    project: 'p',
    rev: 1,
    at: '2026-01-01T00:00:00Z',
    bytes: transcript.length,
    redact: makeRedactor(),
    salt: 'salt',
    sid: 'abcd1234',
    repoRoot: makeRepoRoot(),
    repoIdentity: makeRepoIdentity(),
  });

const opened = async (build: (repo: string, plain: string) => OpencodeFixture[]) => {
  const staged = stage();
  const { repo, plain } = folders(staged.root);
  const root = await stageOpencode(staged.root, build(repo, plain));
  expect(root.startsWith(staged.root)).toBe(true);
  const store = await openOpencodeStore(root);
  if (store === undefined) throw new Error('the fixture store did not open');
  const read = (id: string): { session: OpencodeSession; text: string } => {
    const found = store.sessions.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`no session ${id}`);
    return { session: found, text: store.transcript(found) };
  };
  return { staged, repo, plain, root, store, read };
};

describe('opencodeRoot and platformPath', () => {
  it('names the data folder the way upstream does: XDG_DATA_HOME, else ~/.local/share, on every platform', () => {
    expect(opencodeRoot({ XDG_DATA_HOME: '/data' }, '/home/a')).toBe(join('/data', 'opencode'));
    expect(opencodeRoot({ XDG_DATA_HOME: '' }, '/home/a')).toBe(join('/home/a', '.local', 'share', 'opencode'));
    expect(opencodeRoot({}, '/home/a')).toBe(join('/home/a', '.local', 'share', 'opencode'));
  });

  it('turns a stored drive path back into the platform form only on Windows (core/src/database/path.ts:6-34)', () => {
    expect(platformPath('C:/Users/a/app', 'win32')).toBe('C:\\Users\\a\\app');
    expect(platformPath('C:/Users/a/app', 'linux')).toBe('C:/Users/a/app');
    expect(platformPath('/home/a/app', 'win32')).toBe('/home/a/app');
  });
});

describe('the OpenCode reader', () => {
  it('returns nothing for a machine without OpenCode', async () => {
    expect(await openOpencodeStore(join(stage().root, 'nowhere'))).toBeUndefined();
  });

  it('lists sessions with messages, with their folder, size, and parent, and skips an empty one', async () => {
    const { store } = await opened((repo, plain) => [
      { id: 'ses_a', directory: repo, created: at(0), updated: at(9), messages: [ocUser('msg_1', 1, at(1), 'hi'), ocAssistant('msg_2', 2, at(2), [{ type: 'text', text: 'hello' }])] },
      { id: 'ses_empty', directory: plain, created: at(0), updated: at(1), messages: [] },
      { id: 'ses_child', directory: plain, parentId: 'ses_a', agent: 'explore', created: at(3), updated: at(4), messages: [ocUser('msg_3', 1, at(3), 'look')] },
    ]);
    expect(store.sessions.map((s) => [s.id, s.size, s.mtimeMs, s.parent, s.agent])).toEqual([
      ['ses_child', 1, at(4), 'ses_a', 'explore'],
      ['ses_a', 2, at(9), null, 'build'],
    ]);
    store.close();
  });

  it('captures a normal session: prompt, response, tool names, hashed files, usage with disjoint cache fields, the version', async () => {
    const { store, read, repo } = await opened((dir) => [
      {
        id: 'ses_n',
        directory: dir,
        created: at(0),
        updated: at(9),
        messages: [
          ocUser('msg_1', 1, at(1), 'fix the parser'),
          ocAssistant(
            'msg_2',
            2,
            at(2),
            [
              { type: 'reasoning', text: 'thinking about it' },
              { type: 'text', text: 'Looking at it.' },
              ocTool('c1', 'read', { status: 'completed', input: { path: 'src/parser.ts' }, content: [{ type: 'text', text: 'code' }] }, at(3)),
              ocTool('c2', 'edit', { status: 'completed', input: { path: 'src/parser.ts', oldString: 'a', newString: 'b' }, content: [{ type: 'text', text: 'Edited' }] }, at(4)),
              ocTool('c3', 'shell', ocShellDone('npm test', 'ok', 0), at(5)),
            ],
            { tokens: usage, time: { created: at(2), completed: at(6) } },
          ),
        ],
      },
    ]);
    const { session, prompts, tools, errorLines } = capture(read('ses_n').text, 'n');
    expect(session.userTurns).toBe(1);
    expect(session.assistantTurns).toBe(1);
    expect(session.versions).toEqual(['2.2.5']);
    expect(session.models).toEqual({ 'claude-sonnet-5-5': 1 });
    // OpenCode stores `input` as the non-cached part (core/src/session/usage.ts:12), so it is not reduced again; `output` excludes reasoning (ai/src/schema/events.ts:88-90),
    // so the Claude Code field is output plus reasoning, with the reasoning kept as `thinking`.
    expect(session.usage).toEqual({ input: 100, cacheWrite: 50, cacheRead: 300, output: 50, thinking: 10 });
    expect(session.usageObserved).toEqual(['input', 'cacheWrite', 'cacheRead', 'output', 'thinking']);
    expect(tools.map((t) => [t.tool, t.status])).toEqual([['Read', 'ok'], ['Edit', 'ok'], ['Bash', 'ok']]);
    expect(tools[0]?.target).toBe(tools[1]?.target);
    // The path is stored absolute, as Claude Code's is (a relative one is joined to the session's folder), and hashed repo-relative.
    expect(session.files).toEqual([join(repo, 'src', 'parser.ts')]);
    expect(session.fileHashes).toHaveLength(1);
    expect(session.repo).toMatch(/^[0-9a-f]{16}$/);
    expect(prompts[0]?.head).toBe('fix the parser');
    expect(errorLines).toEqual([]);
    store.close();
  });

  it('reads a failed shell call by its exit code, not by its status: the tool completes and records the exit in metadata', async () => {
    const { store, read } = await opened((dir) => [
      {
        id: 'ses_f',
        directory: dir,
        created: at(0),
        updated: at(9),
        messages: [
          ocUser('msg_1', 1, at(1), 'build it'),
          ocAssistant('msg_2', 2, at(2), [
            ocTool('c1', 'shell', ocShellDone('make', 'make: *** No rule to make target\nExited with code 2', 2), at(3)),
            ocTool('c2', 'shell', ocShellDone('sleep 99', 'Timed out before completion', undefined, { timeout: true }), at(4)),
            ocTool('c3', 'shell', ocShellDone('long', 'Killed by SIGKILL', undefined, { signal: 'SIGKILL' }), at(5)),
            ocTool('c4', 'shell', ocShellDone('exit 3', '', 3), at(6)),
          ]),
        ],
      },
    ]);
    const { tools, errorLines, session } = capture(read('ses_f').text, 'f');
    expect(tools.map((t) => [t.tool, t.status])).toEqual([['Bash', 'error'], ['Bash', 'error'], ['Bash', 'error'], ['Bash', 'error']]);
    expect(errorLines.map((e) => e.line)).toEqual(['make: *** No rule to make target', 'Timed out before completion', 'Killed by SIGKILL', 'Exit code 3']);
    expect(session.bashCmds).toBe(4);
    store.close();
  });

  it('writes an error state as its message alone, so the line can join a Claude Code signature, and leaves a call still running with no outcome', async () => {
    const { store, read } = await opened((dir) => [
      {
        id: 'ses_e',
        directory: dir,
        created: at(0),
        updated: at(9),
        messages: [
          ocUser('msg_1', 1, at(1), 'edit it'),
          ocAssistant('msg_2', 2, at(2), [
            ocTool('c1', 'edit', { status: 'error', input: { path: 'a.ts', oldString: 'x', newString: 'y' }, error: { type: 'tool', message: 'oldString not found in a.ts' } }, at(3)),
            ocTool('c2', 'write', { status: 'running', input: { path: 'b.ts', content: 'z' }, metadata: {} }, at(4)),
          ]),
        ],
      },
    ]);
    const { tools, errorLines } = capture(read('ses_e').text, 'e');
    expect(errorLines.map((e) => [e.tool, e.line])).toEqual([['Edit', 'oldString not found in a.ts']]);
    expect(tools.map((t) => [t.tool, t.status])).toEqual([['Edit', 'error'], ['Write', 'none']]);
    store.close();
  });

  it('redacts a secret and an email in an error and cuts a 1,500-character error at 1,000 characters', async () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';
    const long = `${secret} mailed to jane.doe@example.com ${'x'.repeat(1500)}`;
    const { store, read } = await opened((dir) => [
      {
        id: 'ses_r',
        directory: dir,
        created: at(0),
        updated: at(9),
        messages: [ocUser('msg_1', 1, at(1), 'try it'), ocAssistant('msg_2', 2, at(2), [ocTool('c1', 'edit', { status: 'error', input: { path: 'a.ts', oldString: 'a', newString: 'b' }, error: { type: 'tool', message: long } }, at(3))])],
      },
    ]);
    const line = capture(read('ses_r').text, 'r').errorLines[0]?.line ?? '';
    expect(Array.from(line)).toHaveLength(1000);
    expect(line).not.toContain(secret);
    expect(line).not.toContain('jane.doe@example.com');
    store.close();
  });

  it('leaves a response with no usage, and one whose figures are all zero, unobserved, not a measured zero', async () => {
    const { store, read } = await opened((dir) => [
      {
        id: 'ses_u',
        directory: dir,
        created: at(0),
        updated: at(9),
        messages: [
          ocUser('msg_1', 1, at(1), 'hello'),
          ocAssistant('msg_2', 2, at(2), [{ type: 'text', text: 'hi' }]),
          ocAssistant('msg_3', 3, at(3), [{ type: 'text', text: 'again' }], { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
        ],
      },
    ]);
    const { session, prompts } = capture(read('ses_u').text, 'u');
    expect(session.usageObserved).toEqual([]);
    expect(session.usageResponses).toBe(0);
    expect(prompts[0]?.usageObserved).toEqual([]);
    store.close();
  });

  it('captures a folder that is not a repository with no repository', async () => {
    const { store, read, plain } = await opened((_repo, dir) => [{ id: 'ses_p', directory: dir, created: at(0), updated: at(2), messages: [ocUser('msg_1', 1, at(1), 'notes'), ocAssistant('msg_2', 2, at(2), [{ type: 'text', text: 'ok' }])] }]);
    expect(store.sessions[0]?.folder).toBe(plain);
    expect(capture(read('ses_p').text, 'p').session.repo).toBeNull();
    store.close();
  });

  it('gives each prompt its own time, and a missing or relative time takes the latest time so far', async () => {
    const { store, read } = await opened((dir) => [
      {
        id: 'ses_t',
        directory: dir,
        created: at(0),
        updated: at(60),
        messages: [
          ocUser('msg_1', 1, at(1), 'first'),
          ocAssistant('msg_2', 2, at(5), [{ type: 'text', text: 'one' }]),
          // The envelope's own time is relative (a small number), so the row's column stands for it, and the clock never steps back.
          { ...ocUser('msg_3', 3, at(30), 'second'), data: { time: { created: 7 }, text: 'second' } },
          { ...ocAssistant('msg_4', 4, at(35), [{ type: 'text', text: 'two' }]), data: { agent: 'build', model: { id: 'm', providerID: 'p' }, content: [{ type: 'text', text: 'two' }] } },
        ],
      },
    ]);
    const { prompts, session } = capture(read('ses_t').text, 't');
    expect(session.tsFirst).toBe(new Date(at(1)).toISOString());
    expect(prompts).toHaveLength(2);
    expect(prompts[0]?.wallSec).toBe(4);
    expect(prompts[1]?.wallSec).toBe(5);
    store.close();
  });

  it('follows a change of directory: a location switch moves the cwd, and earlier lines keep the one before it', async () => {
    const staged = stage();
    const { repo, plain } = folders(staged.root);
    const root = await stageOpencode(staged.root, [
      {
        id: 'ses_l',
        directory: plain,
        created: at(0),
        updated: at(9),
        messages: [
          ocUser('msg_1', 1, at(1), 'before'),
          ocAssistant('msg_2', 2, at(2), [ocTool('c1', 'edit', { status: 'completed', input: { path: 'a.ts', oldString: 'a', newString: 'b' }, content: [{ type: 'text', text: 'ok' }] }, at(3))]),
          { id: 'msg_3', type: 'location-switched', seq: 3, created: at(4), data: { time: { created: at(4) }, location: { directory: plain }, previous: { location: { directory: repo } } } },
          ocUser('msg_4', 4, at(5), 'after'),
        ],
      },
    ]);
    const store = await openOpencodeStore(root);
    const session = store?.sessions[0];
    if (store === undefined || session === undefined) throw new Error('no store');
    expect(linesOf(store.transcript(session)).map((l) => l.cwd)).toEqual([repo, repo, repo, plain]);
    store.close();
  });

  it('does not count a fork parent\'s copied messages as the fork\'s own', async () => {
    const { store, read } = await opened((dir) => [
      {
        id: 'ses_fork',
        directory: dir,
        forkOf: 'ses_parent',
        created: at(10),
        updated: at(20),
        messages: [
          // Copied rows are `msg_<event id>_<seq>` (core/src/session/projector.ts:198, :226); the fork's own are plain.
          { ...ocUser('msg_EVENT_1', 1, at(1), 'parent prompt') },
          { ...ocAssistant('msg_EVENT_2', 2, at(2), [{ type: 'text', text: 'parent answer' }], { tokens: usage }) },
          ocUser('msg_own1', 3, at(11), 'my own prompt'),
          ocAssistant('msg_own2', 4, at(12), [{ type: 'text', text: 'my own answer' }]),
        ],
      },
    ]);
    const { session, prompts } = capture(read('ses_fork').text, 'fork');
    expect(prompts.map((p) => p.head)).toEqual(['my own prompt']);
    expect(session.assistantTurns).toBe(1);
    expect(session.usageObserved).toEqual([]);
    store.close();
  });

  it('reads an assistant\'s content from part rows first and any inline content after them, as upstream does', async () => {
    const { store, read } = await opened((dir) => [
      {
        id: 'ses_parts',
        directory: dir,
        created: at(0),
        updated: at(9),
        messages: [ocUser('msg_1', 1, at(1), 'go'), ocAssistant('msg_2', 2, at(2), [{ type: 'text', text: 'inline tail' }])],
        parts: [
          { messageId: 'msg_2', ordinal: 0, type: 'text', data: { type: 'text', text: 'from a part' } },
          { messageId: 'msg_2', ordinal: 1, type: 'tool', data: ocTool('c1', 'shell', ocShellDone('ls', 'a', 0), at(3)) },
        ],
      },
    ]);
    const assistant = linesOf(read('ses_parts').text).find((l) => l.type === 'assistant');
    expect(assistant?.message?.content?.map((c) => (c.type === 'text' ? c.text : c.type))).toEqual(['from a part', 'tool_use', 'inline tail']);
    expect(capture(read('ses_parts').text, 'parts').tools.map((t) => t.tool)).toEqual(['Bash']);
    store.close();
  });

  it('records a user-run shell command (`!cmd`) as an operator turn with a <bash-input> line, as Claude Code does: no agent turn, no shell call, no error line', async () => {
    const { store, read } = await opened((dir) => [
      {
        id: 'ses_sh',
        directory: dir,
        created: at(0),
        updated: at(9),
        messages: [
          ocUser('msg_1', 1, at(1), 'hello'),
          { id: 'msg_2', type: 'shell', seq: 2, created: at(2), data: { time: { created: at(2), completed: at(3) }, shellID: 'sh1', command: 'git status', status: 'exited', exit: 128, output: { output: 'fatal: not a git repository', cursor: 28, size: 28, truncated: false } } },
          ocAssistant('msg_3', 3, at(62), [{ type: 'text', text: 'not a repository' }]),
        ],
      },
    ]);
    const text = read('ses_sh').text;
    expect(text).toContain('<bash-input>git status</bash-input>');
    expect(text).not.toContain('tool_use');
    const { session, prompts, tools, errorLines } = capture(text, 'sh');
    expect(tools).toEqual([]);
    expect(errorLines).toEqual([]);
    expect([session.assistantTurns, session.bashCmds]).toEqual([1, 0]);
    // The prompt is the operator's typed text; the `!cmd` is a human turn but not a prompt, and its output is not one: the agent's run is timed from the command (62 s - 2 s).
    expect(prompts.map((p) => p.head)).toEqual(['hello']);
    expect(session.trust?.unattendedRun).toEqual([0, 1]);
    store.close();
  });

  it('writes a successful `!cmd` as a <bash-input> line and a <bash-stdout> line, and skips the output line when the command printed nothing', async () => {
    const shell = (id: string, seq: number, command: string, output: string) => ({
      id,
      type: 'shell',
      seq,
      created: at(seq),
      data: { time: { created: at(seq), completed: at(seq + 1) }, shellID: `sh${String(seq)}`, command, status: 'exited', exit: 0, output: { output, cursor: output.length, size: output.length, truncated: false } },
    });
    const { store, read } = await opened((dir) => [
      {
        id: 'ses_ok',
        directory: dir,
        created: at(0),
        updated: at(9),
        messages: [ocUser('msg_1', 1, at(1), 'hello'), shell('msg_2', 2, 'ls', 'a.txt'), shell('msg_4', 4, 'true', ''), ocAssistant('msg_6', 6, at(30), [{ type: 'text', text: 'done' }])],
      },
    ]);
    const users = linesOf(read('ses_ok').text)
      .filter((l) => l.type === 'user')
      .map((l) => l.message?.content?.[0]?.text);
    expect(users).toEqual(['hello', '<bash-input>ls</bash-input>', '<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>', '<bash-input>true</bash-input>']);
    const { session, prompts, errorLines } = capture(read('ses_ok').text, 'ok');
    expect(errorLines).toEqual([]);
    expect([session.assistantTurns, session.bashCmds]).toEqual([1, 0]);
    expect(prompts.map((p) => p.head)).toEqual(['hello']);
    store.close();
  });

  it('does not read a synthetic message, a system message, a skill message, or a compaction as the operator\'s prompt', async () => {
    const { store, read } = await opened((dir) => [
      {
        id: 'ses_s',
        directory: dir,
        created: at(0),
        updated: at(9),
        messages: [
          ocUser('msg_1', 1, at(1), 'real prompt'),
          { id: 'msg_2', type: 'synthetic', seq: 2, created: at(2), data: { time: { created: at(2) }, text: 'a subagent finished' } },
          { id: 'msg_3', type: 'system', seq: 3, created: at(3), data: { time: { created: at(3) }, text: 'the date changed' } },
          { id: 'msg_4', type: 'skill', seq: 4, created: at(4), data: { time: { created: at(4) }, skill: 'sk', name: 'review', text: 'skill body' } },
          { id: 'msg_5', type: 'compaction', seq: 5, created: at(5), data: { time: { created: at(5) }, status: 'completed', reason: 'auto', summary: 'summary text' } },
          { id: 'msg_6', type: 'idle', seq: 6, created: at(6), data: { time: { created: at(6) }, outcome: 'succeeded' } },
        ],
      },
    ]);
    expect(capture(read('ses_s').text, 's').prompts.map((p) => p.head)).toEqual(['real prompt']);
    store.close();
  });

  it('turns each tool into the vocabulary the extractor reads, keeping the OpenCode name in `native`', async () => {
    const { store, read } = await opened((dir) => [
      {
        id: 'ses_names',
        directory: dir,
        created: at(0),
        updated: at(9),
        messages: [
          ocUser('msg_1', 1, at(1), 'go'),
          ocAssistant('msg_2', 2, at(2), [
            ocTool('c1', 'write', { status: 'completed', input: { path: 'new.ts', content: 'x' }, content: [{ type: 'text', text: 'ok' }] }, at(3)),
            ocTool('c2', 'patch', { status: 'completed', input: { patchText: '*** Begin Patch\n*** Add File: one.ts\n+a\n*** Update File: two.ts\n*** Move to: three.ts\n@@\n-a\n+b\n*** Delete File: four.ts\n*** End Patch' }, content: [{ type: 'text', text: 'ok' }] }, at(4)),
            ocTool('c3', 'grep', { status: 'completed', input: { pattern: 'foo', path: 'src' }, content: [{ type: 'text', text: 'x' }] }, at(5)),
            ocTool('c4', 'glob', { status: 'completed', input: { pattern: '**/*.ts' }, content: [{ type: 'text', text: 'x' }] }, at(6)),
            ocTool('c5', 'skill', { status: 'completed', input: { id: 'review' }, content: [{ type: 'text', text: 'x' }] }, at(7)),
            ocTool('c6', 'subagent', { status: 'completed', input: { agent: 'explore', description: 'look', prompt: 'look' }, content: [{ type: 'text', text: 'x' }] }, at(8)),
            ocTool('c7', 'todowrite', { status: 'completed', input: { todos: [] }, content: [{ type: 'text', text: 'x' }] }, at(9)),
          ]),
        ],
      },
    ]);
    const blocks = linesOf(read('ses_names').text).flatMap((l) => (l.type === 'assistant' ? (l.message?.content ?? []) : [])).filter((b) => b.type === 'tool_use');
    expect(blocks.map((b) => [b.name, b.native])).toEqual([['Write', 'write'], ['Edit', 'patch'], ['Edit', 'patch'], ['Edit', 'patch'], ['Edit', 'patch'], ['Grep', 'grep'], ['Glob', 'glob'], ['skill', 'skill'], ['subagent', 'subagent'], ['todowrite', 'todowrite']]);
    expect(blocks[7]?.input).toEqual({ skill: 'review' });
    const { session } = capture(read('ses_names').text, 'names');
    expect(session.files.length).toBeGreaterThanOrEqual(5);
    store.close();
  });

  it('fails the whole store when the database is not an OpenCode one, so the deposit can warn naming the file', async () => {
    const staged = stage();
    const root = await stageOpencode(staged.root, []);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(root, 'opencode.db'));
    db.exec('drop table session_message');
    db.close();
    await expect(openOpencodeStore(root)).rejects.toThrow();
  });
});
