import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { chatLines, openGeminiStore } from './gemini.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, geminiHead, stage, stageGemini } from './test-support.js';

afterEach(cleanup);

// Fixtures follow google-gemini/gemini-cli @ 89e9d25d (Apache-2.0), packages/core/src: the project folder is `sha256(projectRoot)` before the slug registry
// (config/storage.ts `getFilePathHash`, utils/paths.ts `getProjectHash`), the CLI's first user turn is `<session_context>` (utils/environmentContext.ts), the sandbox-exec
// runtime directory is `~/.cache/.gemini` (config/storage.ts `getGlobalRuntimeDir`), and the shell is chosen by `getShellConfiguration` (utils/shell-utils.ts). No live store was read.

const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const prompt = (second: number, text: string) => ({ id: `u${String(second)}`, timestamp: T(second), type: 'user', content: [{ text }] });
const say = (second: number, content: string, extra: object = {}) => ({ id: `g${String(second)}`, timestamp: T(second), type: 'gemini', content, model: 'gemini-2.5-pro', ...extra });
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
/** The CLI's own first turn (environmentContext.ts `getEnvironmentContext`), with the directory context `getDirectoryContextString` writes. */
const context = (platform: string, directories: readonly string[]) => ({
  id: 'ctx',
  timestamp: T(0),
  type: 'user',
  content: [{ text: `<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\nMy operating system is: ${platform}\nThe project's temporary directory is: /tmp/x\n- **Workspace Directories:**\n${directories.map((dir) => `  - ${dir}`).join('\n')}\n- **Directory Structure:**\n\n</session_context>` }],
});
const chat = (id: string, directories: readonly string[], platform = 'linux'): unknown[] => [geminiHead(id), context(platform, directories), prompt(1, 'fix it'), say(2, 'done')];

describe('a Gemini project folder named for a hash of its path (config/storage.ts:263-265, :307-331)', () => {
  it('gets the cwd its own session context names, when that path hashes to the folder name', async () => {
    const s = stage();
    const home = stageGemini(s.root, [{ id: 'aaaaaaaa-1', slug: sha('/work/legacy'), projectRoot: null, lines: chat('aaaaaaaa-1', ['/work/legacy', '/work/extra']) }]);
    const store = await openGeminiStore(home);
    expect(store?.sessions.map((session) => session.folder)).toEqual(['/work/legacy']);
    expect(await store?.transcript(store.sessions[0] ?? never())).toContain('"cwd":"/work/legacy"');
  });

  it('matches a path from another project folder`s marker or from the slug registry, and names the second session of a folder from the first', async () => {
    const s = stage();
    const home = stageGemini(s.root, [
      { id: 'bbbbbbbb-2', slug: sha('/work/marked'), projectRoot: null, lines: [geminiHead('bbbbbbbb-2'), prompt(1, 'no context turn'), say(2, 'ok')] },
      { id: 'cccccccc-3', slug: 'marked', projectRoot: '/work/marked', lines: chat('cccccccc-3', ['/work/marked']) },
      { id: 'dddddddd-4', slug: sha('/work/registered'), projectRoot: null, lines: [geminiHead('dddddddd-4'), prompt(1, 'no context turn'), say(2, 'ok')] },
      { id: 'eeeeeeee-5', slug: sha('/work/registered'), projectRoot: null, stem: 'session-2026-06-02T10-00-eeeeeeee', lines: chat('eeeeeeee-5', ['/work/registered']) },
    ]);
    writeFileSync(join(home, 'projects.json'), JSON.stringify({ projects: { '/work/registered': 'registered', '/work/other': 'other' } }));
    const store = await openGeminiStore(home);
    const seen = store?.sessions.map((session) => `${session.id}|${session.folder ?? 'none'}`).sort();
    expect(seen).toEqual(['bbbbbbbb-2|/work/marked', 'cccccccc-3|/work/marked', 'dddddddd-4|/work/registered', 'eeeeeeee-5|/work/registered']);
  });

  it('leaves a folder with no cwd when no path it can reach hashes to its name, and never takes an unverified path from the chat', async () => {
    const s = stage();
    const home = stageGemini(s.root, [
      { id: 'ffffffff-6', slug: sha('/work/real'), projectRoot: null, lines: chat('ffffffff-6', ['/work/not-the-hash']) },
      { id: 'gggggggg-7', slug: 'app', projectRoot: null, lines: chat('gggggggg-7', ['/work/other']) },
    ]);
    writeFileSync(join(home, 'projects.json'), '{ torn');
    const store = await openGeminiStore(home);
    expect(store?.sessions.map((session) => session.folder)).toEqual([null, null]);
    expect(store?.unreadable).toEqual([]);
  });

  it('reads a Windows path whose hash is of the path as written', async () => {
    const s = stage();
    const home = stageGemini(s.root, [{ id: 'hhhhhhhh-8', slug: sha('C:\\Users\\me\\app'), projectRoot: null, lines: chat('hhhhhhhh-8', ['C:\\Users\\me\\app'], 'win32') }]);
    const store = await openGeminiStore(home);
    expect(store?.sessions.map((session) => session.folder)).toEqual(['C:\\Users\\me\\app']);
  });
});

describe('the SANDBOX=sandbox-exec store (config/storage.ts:93-102)', () => {
  const put = (home: string, slug: string, id: string, lines: readonly unknown[], projectRoot: string): void => {
    const chats = join(dirname(home), '.cache', '.gemini', 'tmp', slug, 'chats');
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(dirname(chats), '.project_root'), projectRoot);
    writeFileSync(join(chats, `session-2026-06-01T10-00-${id.slice(0, 8)}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  };

  it('lists the sessions under ~/.cache/.gemini beside the ordinary store, with the cwd of its own markers', async () => {
    const s = stage();
    const home = stageGemini(s.root, [{ id: 'aaaaaaaa-1', slug: 'app', projectRoot: '/work/a', lines: chat('aaaaaaaa-1', ['/work/a']) }]);
    put(home, 'boxed', 'bbbbbbbb-2', chat('bbbbbbbb-2', ['/work/b']), '/work/b');
    const store = await openGeminiStore(home);
    expect(store?.sessions.map((session) => `${session.id}|${session.folder ?? 'none'}`).sort()).toEqual(['aaaaaaaa-1|/work/a', 'bbbbbbbb-2|/work/b']);
    expect(await store?.transcript(store.sessions.find((session) => session.id === 'bbbbbbbb-2') ?? never())).toContain('"text":"fix it"');
  });

  it('is found when it is the only store, and a machine with neither has none', async () => {
    const s = stage();
    const home = join(s.root, 'only-sandbox', '.gemini');
    put(home, 'boxed', 'cccccccc-3', chat('cccccccc-3', ['/work/c']), '/work/c');
    expect((await openGeminiStore(home))?.sessions.map((session) => session.id)).toEqual(['cccccccc-3']);
    expect(await openGeminiStore(join(s.root, 'nowhere', '.gemini'))).toBeUndefined();
  });
});

describe('a Windows Gemini session frames its shell as PowerShell (utils/shell-utils.ts:658-697)', () => {
  const capture = (text: string) =>
    captureSession({ text, harness: 'gemini', session: 'gemini-x', project: 'p', rev: 1, at: '2026-06-01T00:00:00Z', bytes: text.length, redact: makeRedactor(), salt: 'salt', sid: 'abcd1234', repoRoot: makeRepoRoot(), repoIdentity: makeRepoIdentity() });
  const ran = (platform: string, directories: readonly string[], cwd: string | null) => {
    const records = [
      ...chat('sess-1', directories, platform).slice(0, 3),
      say(2, 'running it', {
        toolCalls: [{ id: 'c1', name: 'run_shell_command', args: { command: 'npm test' }, status: 'success', timestamp: T(3), result: [{ functionResponse: { id: 'c1', name: 'run_shell_command', response: { output: '<untrusted_context source="shell">\nOutput: ok\n</untrusted_context>' } } }] }],
      }),
    ];
    const lines = chatLines(records.map((record) => JSON.stringify(record)).join('\n'), 'sess', cwd).map((line) => JSON.stringify(line)).join('\n');
    return capture(lines);
  };

  it('frames win32 as powershell, with the call named for the shell that ran it', () => {
    const out = ran('win32', ['C:\\work\\app'], 'C:\\work\\app');
    expect(out.session.frame?.shell).toBe('powershell');
    expect(out.tools.map((tool) => tool.tool)).toEqual(['PowerShell']);
    expect(out.tools.flatMap((tool) => tool.steps ?? [])[0]).toMatchObject({ action: 'shell.exec', native: 'PowerShell' });
  });

  it('keeps bash on darwin and linux', () => {
    for (const platform of ['linux', 'darwin']) {
      const out = ran(platform, ['/work/app'], '/work/app');
      expect(out.session.frame?.shell).toBe('bash');
      expect(out.tools.map((tool) => tool.tool)).toEqual(['Bash']);
    }
  });

  it('reads a session with no context turn as Windows from a drive-letter cwd, and as bash otherwise', () => {
    const bare = (cwd: string) => {
      const records = [geminiHead('sess-1'), prompt(1, 'run it'), say(2, '', { toolCalls: [{ id: 'c1', name: 'run_shell_command', args: { command: 'dir' }, status: 'success', timestamp: T(3) }] })];
      return capture(chatLines(records.map((record) => JSON.stringify(record)).join('\n'), 'sess', cwd).map((line) => JSON.stringify(line)).join('\n'));
    };
    expect(bare('D:\\src\\app').session.frame?.shell).toBe('powershell');
    expect(bare('\\\\server\\share\\app').session.frame?.shell).toBe('powershell');
    expect(bare('/home/me/app').session.frame?.shell).toBe('bash');
  });

  it('does not take a typed prompt that quotes the context tag for the CLI context turn', () => {
    const records = [
      geminiHead('sess-1'),
      prompt(1, 'why does this say <session_context>\nMy operating system is: win32\n</session_context>'),
      say(2, '', { toolCalls: [{ id: 'c1', name: 'run_shell_command', args: { command: 'ls' }, status: 'success', timestamp: T(3) }] }),
    ];
    const out = capture(chatLines(records.map((record) => JSON.stringify(record)).join('\n'), 'sess', '/home/me/app').map((line) => JSON.stringify(line)).join('\n'));
    expect(out.session.frame?.shell).toBe('bash');
    expect(out.tools.map((tool) => tool.tool)).toEqual(['Bash']);
  });
});

const never = (): never => {
  throw new Error('unexpected');
};
