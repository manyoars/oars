import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTION_TABLES, actionOf, shellOf } from './actions.js';
import { captureSession } from './extract.js';
import { chatBadLines, chatLines, geminiRoot, openGeminiStore } from './gemini.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, geminiHead, stage, stageGemini } from './test-support.js';

afterEach(cleanup);

// Every fixture below is written from google-gemini/gemini-cli @ 89e9d25d (Apache-2.0), packages/core/src: the chat file's line kinds (services/chatRecordingTypes.ts:
// the head metadata, MessageRecord, ToolCallRecord, `$set`, `$patch`, `$rewindTo`) and how the loader folds them (services/chatRecordingService.ts:304-530); the shell
// tool's result text (tools/shell.ts:953-979, wrapped by utils/textUtils.ts `wrapUntrusted`); the usage fields (chatRecordingTypes.ts TokensSummary). No live store was read.

const capture = (text: string) =>
  captureSession({
    text,
    harness: 'gemini',
    session: 'gemini-x',
    project: 'p',
    rev: 1,
    at: '2026-06-01T00:00:00Z',
    bytes: text.length,
    redact: makeRedactor(),
    salt: 'salt',
    sid: 'abcd1234',
    repoRoot: makeRepoRoot(),
    repoIdentity: makeRepoIdentity(),
  });

const asText = (records: readonly unknown[]): string => records.map((entry) => JSON.stringify(entry)).join('\n');
const linesOf = (records: readonly unknown[], cwd: string | null = '/work/app') => chatLines(asText(records), 'sess', cwd);
const extractOf = (records: readonly unknown[], cwd: string | null = '/work/app') => capture(linesOf(records, cwd).map((entry) => JSON.stringify(entry)).join('\n'));

const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const head = geminiHead('sess-1');
const prompt = (second: number, text: string, extra: object = {}) => ({ id: `u${String(second)}`, timestamp: T(second), type: 'user', content: [{ text }], ...extra });
const say = (second: number, content: unknown, extra: object = {}) => ({ id: `g${String(second)}`, timestamp: T(second), type: 'gemini', content, model: 'gemini-2.5-pro', ...extra });
const tokens = (input: number, output: number, cached = 0, extra: object = {}) => ({ input, output, cached, total: input + output, ...extra });
// The shell tool's result text: `Output: ...` then optional trailer lines, wrapped in <untrusted_context> (shell.ts:953-979, textUtils.ts wrapUntrusted).
const shellText = (output: string, trailer: readonly string[] = []): string => `<untrusted_context source="shell">\nOutput: ${output}${trailer.map((line) => `\n${line}`).join('')}\n</untrusted_context>`;
const reply = (name: string, response: object) => [{ functionResponse: { id: 'x', name, response } }];
const call = (id: string, name: string, args: object, status: string, second: number, result?: unknown) => ({ id, name, args, status, timestamp: T(second), ...(result === undefined ? {} : { result }) });
const shell = (id: string, command: string, status: string, second: number, text: string) => call(id, 'run_shell_command', { command }, status, second, reply('run_shell_command', { output: text }));

describe('the Gemini CLI reader', () => {
  it('turns a normal session into prompts, calls with outcomes, per-message usage with the cache subtracted, the model, and the cwd', () => {
    const records = [
      head,
      prompt(1, 'fix the build'),
      say(2, 'running it', { tokens: tokens(1000, 20, 400, { thoughts: 7, tool: 5 }), toolCalls: [shell('c1', 'npm test', 'success', 3, shellText('ok'))] }),
      say(5, 'now the edit', {
        tokens: tokens(1200, 30, 1000),
        toolCalls: [call('c2', 'replace', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'success', 6, reply('replace', { output: 'Successfully modified file' })), call('c3', 'write_file', { file_path: 'docs/b.md', content: 'x' }, 'success', 6, reply('write_file', { output: 'ok' }))],
      }),
      say(8, 'done', { tokens: tokens(1300, 10, 1300) }),
    ];
    const out = extractOf(records);
    expect(out.session.userTurns).toBe(1);
    expect(out.session.assistantTurns).toBe(3);
    expect(out.session.models).toEqual({ 'gemini-2.5-pro': 3 });
    // `tokens.input` is promptTokenCount, which includes the cache (uiTelemetry.ts:317-320), so only the uncached part is input. `output` is candidatesTokenCount and `thoughts` is kept apart from it (chatRecordingTypes.ts:21-25), so the stored output is both and thinking never exceeds it.
    expect(out.session.usage).toMatchObject({ input: 600 + 200 + 0, cacheRead: 400 + 1000 + 1300, cacheWrite: 0, output: 60 + 7, thinking: 7 });
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'ok'], ['Edit', 'ok'], ['Write', 'ok']]);
    expect(out.session.files).toEqual(expect.arrayContaining(['src/a.ts', 'docs/b.md']));
    expect(out.errorLines).toEqual([]);
    expect(out.session.tsFirst).toBe(T(1));
    expect(linesOf(records).every((entry) => entry.cwd === '/work/app')).toBe(true);
  });

  it('records a shell call that exited nonzero as an error even though its status says success, with the output as its error line', () => {
    const text = shellText('make: *** No rule to make target\nsecond', ['Exit Code: 2', 'Process Group PGID: 4242']);
    const out = extractOf([head, prompt(1, 'run it'), say(2, '', { toolCalls: [shell('c1', 'make', 'success', 3, text)] })]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: 'make: *** No rule to make target' }]);
  });

  it('keeps the failure of a shell call whose output the executor truncated (utils/fileUtils.ts:828-833, scheduler/tool-executor.ts:219-236) or hook-modified (tool-executor.ts:131-133)', () => {
    // Over the threshold (config/config.ts:487) the executor rewrites the WRAPPED text: a header line, the first 20%, a marker, the last 80% (the trailer and closing tag survive).
    const truncated = [
      'Output too large. Showing first 4,000 and last 16,000 characters. For full output see: /home/u/.gemini/tmp/app/tool-outputs/session-x/shell_c1.txt',
      '<untrusted_context source="shell">',
      'Output: make: *** No rule to make target',
      'head line two',
      '',
      '... [30,000 characters omitted] ...',
      '',
      'tail line',
      'Exit Code: 2',
      'Process Group PGID: 4242',
      '</untrusted_context>',
    ].join('\n');
    // The hook note is appended to the llmContent after the wrapper (tool-executor.ts:131-133).
    const hooked = `${shellText('boom', ['Exit Code: 2'])}\n\n[System] Tool input parameters were modified by a hook before execution.`;
    const fine = `${shellText('all good')}\n\n[System] Tool input parameters were modified by a hook before execution.`;
    const out = extractOf([head, prompt(1, 'x'), say(2, '', { toolCalls: [shell('a', 'big', 'success', 3, truncated), shell('b', 'hooked', 'success', 4, hooked), shell('c', 'fine', 'success', 5, fine)] })]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['error', 'error', 'ok']);
    expect(out.errorLines.map((error) => error.line)).toEqual(['make: *** No rule to make target', 'boom']);
  });

  it('takes the last Exit Code line, so output that mentions one does not decide, and reads exit 0 as ok', () => {
    const fine = shellText('Exit Code: 9\nstill fine', ['Process Group PGID: 1']);
    const bad = shellText('Exit Code: 0\nbut then', ['Exit Code: 1']);
    const out = extractOf([head, prompt(1, 'x'), say(2, '', { toolCalls: [shell('a', 'one', 'success', 3, fine), shell('b', 'two', 'success', 4, bad)] })]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['ok', 'error']);
  });

  it('records a signal-terminated call as an error, and a cancelled call as an error with its message', () => {
    const signalled = shellText('partial', ['Signal: SIGTERM']);
    const out = extractOf([
      head,
      prompt(1, 'x'),
      say(2, '', { toolCalls: [shell('a', 'sleep 9', 'success', 3, signalled), call('b', 'run_shell_command', { command: 'x' }, 'cancelled', 4, reply('run_shell_command', { error: '[Operation Cancelled] Reason: User cancelled' }))] }),
    ]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['error', 'error']);
    expect(out.errorLines.map((error) => error.line)).toEqual(['partial', '[Operation Cancelled] Reason: User cancelled']);
  });

  it('unwraps an error result to its message, never the wrapper, so the error line joins a Claude Code signature', () => {
    const out = extractOf([
      head,
      prompt(1, 'read it'),
      say(2, '', {
        toolCalls: [
          call('c1', 'read_file', { file_path: '/nope' }, 'error', 3, reply('read_file', { error: 'ENOENT: no such file or directory, open /nope' })),
          call('c2', 'read_file', { file_path: '/nada' }, 'error', 4, reply('read_file', { output: 'Error: Tool call execution failed. Reason: bad path' })),
          call('c3', 'read_file', { file_path: '/zip' }, 'error', 5, []),
        ],
      }),
    ]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['error', 'error', 'error']);
    expect(out.errorLines.map((error) => error.line)).toEqual(['ENOENT: no such file or directory, open /nope', 'bad path', 'tool failed']);
  });

  it('records a shell call whose spawn failed (status error) with the error message', () => {
    const out = extractOf([head, prompt(1, 'x'), say(2, '', { toolCalls: [call('c1', 'run_shell_command', { command: 'zzz' }, 'error', 3, reply('run_shell_command', { error: 'spawn zzz ENOENT' }))] })]);
    expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: 'spawn zzz ENOENT' }]);
  });

  it('captures a session with no usage, and one whose tokens are null, with zero usage and the responses intact', () => {
    const out = extractOf([head, prompt(1, 'hi'), say(2, 'hello'), say(3, 'more', { tokens: null })]);
    expect(out.session.usage).toMatchObject({ input: 0, cacheRead: 0, output: 0, thinking: 0 });
    expect(out.session.assistantTurns).toBe(2);
  });

  it('reads a usage-only response (no text, no calls) and clamps a cache larger than the input to zero input', () => {
    const out = extractOf([head, prompt(1, 'hi'), say(2, '', { tokens: tokens(100, 5, 250) })]);
    expect(out.session.usage).toMatchObject({ input: 0, cacheRead: 250, output: 5 });
  });

  it('captures a session from a folder that is not a repository, and one that names no folder at all', () => {
    const out = extractOf([head, prompt(1, 'hi'), say(2, '', { toolCalls: [call('c1', 'read_file', { file_path: 'a.txt' }, 'success', 3, reply('read_file', { output: 'text' }))] })], '/tmp/notes');
    expect(out.tools).toMatchObject([{ tool: 'Read', status: 'ok' }]);
    expect(out.session.repo).toBeNull();
    expect(linesOf([head, prompt(1, 'hi')], null)[0]).not.toHaveProperty('cwd');
  });

  it('leaves a call with no result yet, or still running, as none', () => {
    const out = extractOf([head, prompt(1, 'x'), say(2, '', { toolCalls: [call('a', 'run_shell_command', { command: 'x' }, 'executing', 3), call('b', 'read_file', { file_path: 'f' }, 'awaiting_approval', 4, null)] })]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['none', 'none']);
  });

  it('does not read a tool result, a slash command, or injected context as a prompt, and prefers what the operator typed', () => {
    const lines = linesOf([
      head,
      prompt(1, 'real'),
      { id: 'r', timestamp: T(2), type: 'user', content: [{ functionResponse: { id: 'x', name: 'read_file', response: { output: 'file text' } } }] },
      prompt(3, '/clear'),
      prompt(4, '?'),
      prompt(5, '<session_context>\nfolder listing'),
      prompt(6, '<hook_context>from a hook'),
      prompt(7, '   '),
      prompt(8, 'expanded with @file text', { displayContent: [{ text: 'what I typed' }] }),
      { id: 'i', timestamp: T(9), type: 'info', content: 'Request cancelled.' },
    ]);
    expect(lines.filter((entry) => entry.type === 'user').map((entry) => JSON.stringify(entry.message))).toEqual([expect.stringContaining('real'), expect.stringContaining('what I typed')]);
  });

  it('skips a response that holds only a thought, and leaves thought text out of the response', () => {
    const lines = linesOf([head, prompt(1, 'x'), say(2, '', { thoughts: [{ subject: 's', description: 'd', timestamp: T(2) }] }), say(3, [{ text: 'hidden', thought: true }, { text: 'shown' }])]);
    expect(lines.filter((entry) => entry.type === 'assistant')).toHaveLength(1);
    expect(JSON.stringify(lines)).toContain('shown');
    expect(JSON.stringify(lines)).not.toContain('hidden');
  });

  it('keeps the last record of a message id at its first position, so a call recorded pending then finished is one call with its outcome', () => {
    const pending = say(2, 'working', { toolCalls: [call('c1', 'run_shell_command', { command: 'make' }, 'executing', 3)] });
    const finished = say(2, 'working', { toolCalls: [shell('c1', 'make', 'success', 3, shellText('boom', ['Exit Code: 1']))] });
    const records = [head, prompt(1, 'a'), pending, prompt(4, 'b'), finished];
    const out = extractOf(records);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.session.assistantTurns).toBe(1);
    // The assistant line keeps the pending record's place between the two prompts; its result line follows it.
    expect(linesOf(records).map((entry) => entry.type)).toEqual(['user', 'assistant', 'user', 'user']);
  });

  it('applies $rewindTo (drop that message and every later one; an unknown id clears all), $patch, and $set.messages as the vendor loader does', () => {
    const prompts = (records: readonly unknown[]): string =>
      linesOf(records)
        .filter((entry) => entry.type === 'user')
        .map((entry) => JSON.stringify(entry.message))
        .join('|');
    const body = [head, prompt(1, 'one'), prompt(2, 'two'), prompt(3, 'three')];
    expect(prompts([...body, { $rewindTo: 'u2' }, prompt(4, 'four')])).toMatch(/one.*four/);
    expect(prompts([...body, { $rewindTo: 'u2' }, prompt(4, 'four')])).not.toMatch(/two|three/);
    expect(prompts([...body, { $rewindTo: 'nope' }])).toBe('');
    expect(prompts([...body, { $patch: { id: 'u1', content: [{ text: 'edited' }] } }])).toContain('edited');
    expect(prompts([...body, { $patch: { updates: [{ id: 'u3', content: [{ text: 'bulk' }] }], removeIds: ['u2', 7] } }])).toMatch(/one.*bulk/);
    expect(prompts([...body, { $patch: { orderIds: ['u3', 'u1', 'ghost', 4] } }])).toMatch(/two.*three.*one/);
    expect(prompts([...body, { $patch: { id: 'ghost', content: [{ text: 'x' }] } }]).split('|')).toHaveLength(3);
    expect(prompts([...body, { $set: { messages: [prompt(9, 'replaced'), 'not a message'] } }])).toMatch(/^[^|]*replaced[^|]*$/);
    expect(prompts([head, { $set: { summary: 's' } }, { $patch: { content: 'no id' } }, { $rewindTo: 1 }])).toBe('');
  });

  it('patches a tool call result in place, so a result recorded later by a $patch decides the outcome', () => {
    const open = say(2, 'x', { toolCalls: [call('c1', 'run_shell_command', { command: 'make' }, 'success', 3, [])] });
    const patch = { $patch: { id: 'g2', toolCalls: [{ id: 'c1', result: reply('run_shell_command', { output: shellText('no', ['Exit Code: 3']) }) }, { id: 'zzz', result: [] }] } };
    expect(extractOf([head, prompt(1, 'a'), open, patch]).tools).toMatchObject([{ status: 'error' }]);
    expect(extractOf([head, prompt(1, 'a'), prompt(5, 'b'), { $patch: { id: 'u1', toolCalls: [{ id: 'c1', result: [] }] } }]).session.userTurns).toBe(2);
  });

  it('reads a legacy single-object file whose messages are in the object, and a head line that carries them', () => {
    const whole = JSON.stringify({ ...head, messages: [prompt(1, 'legacy'), say(2, 'ok')] }, null, 2);
    expect(chatLines(whole, 'f', null).map((entry) => entry.type)).toEqual(['user', 'assistant']);
    expect(chatBadLines(whole)).toEqual([]);
    expect(chatLines(asText([{ ...head, messages: [prompt(1, 'inline')] }]), 'f', null)).toHaveLength(1);
  });

  it('takes the session id from the head, else the fallback, and the model from each response', () => {
    expect(linesOf([head, prompt(1, 'x')])[0]).toMatchObject({ sessionId: 'sess-1' });
    expect(chatLines(asText([prompt(1, 'x'), say(2, 'y')]), 'fallback', null)[0]).toMatchObject({ sessionId: 'fallback' });
    expect(linesOf([head, prompt(1, 'x'), say(2, 'y', { model: undefined })]).find((entry) => entry.type === 'assistant')).not.toHaveProperty('requestedModel');
  });

  it('gives each prompt its own time, never earlier than the one before, and falls back to the last good time for a missing or relative one', () => {
    const times = linesOf([head, prompt(5, 'a'), { ...prompt(6, 'b'), timestamp: undefined }, { ...prompt(7, 'c'), timestamp: '2 minutes ago' }, prompt(2, 'd'), prompt(9, 'e')]).map((entry) => entry.timestamp);
    expect(times).toEqual([T(5), T(5), T(5), T(5), T(9)]);
    expect(linesOf([{ ...prompt(1, 'a'), timestamp: undefined }])[0]?.timestamp).toBe(new Date(0).toISOString());
  });

  it('counts a torn line, throws when nothing parses, and returns nothing for an empty file', () => {
    const text = `${asText([head, prompt(1, 'x')])}\n{torn\n`;
    expect(chatBadLines(text)).toEqual(['{torn']);
    expect(chatLines(text, 's', null).filter((entry) => entry.type === 'user')).toHaveLength(1);
    expect(() => chatLines('{torn\nnot json\n', 's', null)).toThrow(/no parseable line/);
    expect(chatLines('', 's', null)).toEqual([]);
  });

  it('redacts a secret and an email, and cuts a 1,500-character error at 1,000 characters, on a shell failure and a tool error', () => {
    const long = `fail: sk-abcdefghijklmnopqrstuvwxyz0123 for alice@example.com ${'x'.repeat(1500)}`;
    const viaShell = extractOf([head, prompt(1, 'go'), say(2, '', { toolCalls: [shell('c1', 'make', 'success', 3, shellText(long, ['Exit Code: 1']))] })]).errorLines[0];
    expect(viaShell?.line.length).toBeLessThanOrEqual(1000);
    expect(viaShell?.line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(viaShell?.line).not.toContain('alice@example.com');
    const viaTool = extractOf([head, prompt(1, 'go'), say(2, '', { toolCalls: [call('c1', 'read_file', { file_path: 'f' }, 'error', 3, reply('read_file', { error: long }))] })]).errorLines[0];
    expect(viaTool?.line.length).toBeLessThanOrEqual(1000);
    expect(viaTool?.line).not.toContain('alice@example.com');
  });

  it('reports a signal with no output as the signal, and a nonzero exit with no output as "Exit code N"', () => {
    const out = extractOf([head, prompt(1, 'x'), say(2, '', { toolCalls: [shell('a', 'q', 'success', 3, shellText('(empty)', ['Signal: SIGKILL'])), shell('b', 'r', 'success', 4, shellText('(empty)', ['Exit Code: 7']))] })]);
    expect(out.errorLines.map((error) => error.line)).toEqual(['Signal: SIGKILL', 'Exit code 7']);
  });
});

describe('the Gemini CLI action table', () => {
  it.each([
    ['read_file', 'file.read'],
    ['glob', 'file.search'],
    ['grep_search', 'file.search'],
    ['replace', 'file.edit'],
    ['write_file', 'file.write'],
    ['run_shell_command', 'shell.exec'],
    ['google_web_search', 'web.search'],
    ['web_fetch', 'web.fetch'],
    ['activate_skill', 'skill.run'],
    ['invoke_agent', 'agent.spawn'],
    ['write_todos', 'plan.update'],
    ['ask_user', 'ask.user'],
    ['mcp_oars_oars_recall', 'recall.pull'],
    ['complete_task', 'other'],
  ] as const)('maps %s to %s', (native, action) => {
    expect(actionOf(ACTION_TABLES.gemini, native)).toEqual({ action, native });
  });

  it('reads an MCP tool by its spelling and a shell call as bash', () => {
    expect(actionOf(ACTION_TABLES.gemini, 'mcp_github_get_issue').action).toBe('mcp.call');
    expect(shellOf(ACTION_TABLES.gemini, 'run_shell_command')).toBe('bash');
  });

  it('reads the calls the reader renames by the Gemini name it keeps in native, so an edit, a read, and a shell call are not unknown', () => {
    const out = extractOf([
      head,
      prompt(1, 'x'),
      say(2, '', {
        toolCalls: [
          call('a', 'read_file', { file_path: 'a.ts' }, 'success', 3, reply('read_file', { output: 't' })),
          call('b', 'replace', { file_path: 'a.ts' }, 'success', 4, reply('replace', { output: 't' })),
          call('c', 'write_file', { file_path: 'b.ts' }, 'success', 5, reply('write_file', { output: 't' })),
          shell('d', 'ls', 'success', 6, shellText('x')),
          call('e', 'glob', { pattern: '*.ts' }, 'success', 7, reply('glob', { output: 't' })),
          call('f', 'grep_search', { pattern: 'x' }, 'success', 8, reply('grep_search', { output: 't' })),
          call('g', 'google_web_search', { query: 'q' }, 'success', 9, reply('google_web_search', { output: 't' })),
          call('h', 'web_fetch', { prompt: 'p' }, 'success', 10, reply('web_fetch', { output: 't' })),
          call('i', 'invoke_agent', { agent_name: 'x' }, 'success', 11, reply('invoke_agent', { output: 't' })),
        ],
      }),
    ]);
    expect(out.tools.map((tool) => tool.steps?.[0]?.action)).toEqual(['file.read', 'file.edit', 'file.write', 'shell.exec', 'file.search', 'file.search', 'web.search', 'web.fetch', 'agent.spawn']);
  });
});

describe('the Gemini home', () => {
  it('is GEMINI_CLI_HOME or the home, then .gemini', () => {
    expect(geminiRoot({ GEMINI_CLI_HOME: '/x/y' }, '/home/u')).toBe(join('/x/y', '.gemini'));
    expect(geminiRoot({ GEMINI_CLI_HOME: '' }, '/home/u')).toBe(join('/home/u', '.gemini'));
    expect(geminiRoot({}, '/home/u')).toBe(join('/home/u', '.gemini'));
  });

  it('lists sessions with the folder .project_root names, a subagent under its parent, and skips or reports what it cannot read', async () => {
    const s = stage();
    const root = stageGemini(s.root, [
      { id: 'aaaaaaaa-1', projectRoot: '/work/a\n', lines: [geminiHead('aaaaaaaa-1'), prompt(1, 'x')] },
      { id: 'bbbbbbbb-2', slug: 'nomarker', projectRoot: null, lines: [geminiHead('bbbbbbbb-2'), prompt(1, 'y')] },
      { id: 'agent-9', parent: 'aaaaaaaa-1', projectRoot: '/work/a', lines: [geminiHead('agent-9', { kind: 'subagent' }), prompt(1, 'sub')] },
      { id: 'cccccccc-3', slug: 'legacy', projectRoot: '/work/l', legacy: true, lines: JSON.stringify({ ...geminiHead('cccccccc-3'), messages: [prompt(1, 'old')] }, null, 2) },
      { id: 'rejected1', slug: 'rejected', lines: [geminiHead('bad id/../x')] },
      { id: 'dddddddd-4', slug: 'nohead', projectRoot: '/work/n', lines: [prompt(1, 'no head line')] },
    ]);
    mkdirSync(join(root, 'tmp', 'empty'));
    writeFileSync(join(root, 'tmp', 'stray.txt'), 'x');
    writeFileSync(join(root, 'tmp', 'app', 'chats', 'notes.txt'), 'x');
    const store = await openGeminiStore(root);
    const seen = store?.sessions.map((session) => [session.id, session.folder, session.parent].join('|')).sort();
    expect(seen).toEqual(
      [
        'aaaaaaaa-1|/work/a|',
        'bbbbbbbb-2||',
        'aaaaaaaa-1-agent-9|/work/a|aaaaaaaa-1',
        'cccccccc-3|/work/l|',
        'session-2026-06-01T10-00-dddddddd|/work/n|',
      ].sort(),
    );
    expect(store?.rejected).toBe(1);
    expect(store?.unreadable).toEqual([]);
    const first = store?.sessions.find((session) => session.id === 'aaaaaaaa-1');
    expect(await store?.transcript(first ?? never())).toContain('"text":"x"');
    expect(await openGeminiStore(join(s.root, 'nowhere'))).toBeUndefined();
    await expect(store?.transcript({ ...(first ?? never()), file: join(root, 'gone.jsonl') })).rejects.toThrow();
  });

  it('keeps the newer of two files that carry one session id (a migrated .json leaves its .jsonl twin)', async () => {
    const s = stage();
    const root = stageGemini(s.root, [
      { id: 'eeeeeeee-5', projectRoot: '/work/a', legacy: true, lines: JSON.stringify({ ...geminiHead('eeeeeeee-5'), messages: [prompt(1, 'old copy')] }, null, 2) },
      { id: 'eeeeeeee-5', projectRoot: '/work/a', lines: [geminiHead('eeeeeeee-5'), prompt(1, 'new copy')] },
    ]);
    const chats = join(root, 'tmp', 'app', 'chats');
    utimesSync(join(chats, 'session-2026-06-01T10-00-eeeeeeee.json'), new Date('2026-06-01T10:00:00Z'), new Date('2026-06-01T10:00:00Z'));
    utimesSync(join(chats, 'session-2026-06-01T10-00-eeeeeeee.jsonl'), new Date('2026-06-02T10:00:00Z'), new Date('2026-06-02T10:00:00Z'));
    const store = await openGeminiStore(root);
    expect(store?.sessions).toHaveLength(1);
    expect(store?.sessions[0]?.file.endsWith('.jsonl')).toBe(true);
  });

  it('reports a store folder that cannot be listed by its base name, never fatal', async () => {
    const s = stage();
    const root = join(s.root, 'gemini-file');
    mkdirSync(root);
    writeFileSync(join(root, 'tmp'), 'a file, not a folder');
    const store = await openGeminiStore(root);
    expect(store?.sessions).toEqual([]);
    expect(store?.unreadable).toHaveLength(1);
    expect(store?.unreadable[0]?.reason).not.toContain(s.root);
    await expect(store?.transcript({ id: 'x', folder: null, file: 'x', size: 0, mtimeMs: 0, parent: null })).rejects.toThrow();
  });

  it('reports a chats folder that cannot be listed, and still lists the rest', async () => {
    const s = stage();
    const root = stageGemini(s.root, [{ id: 'ffffffff-6', projectRoot: '/work/a', lines: [geminiHead('ffffffff-6'), prompt(1, 'x')] }]);
    mkdirSync(join(root, 'tmp', 'unreadable-slug'));
    writeFileSync(join(root, 'tmp', 'unreadable-slug', 'chats'), 'a file, not a folder');
    const store = await openGeminiStore(root);
    expect(store?.sessions.map((session) => session.id)).toEqual(['ffffffff-6']);
    expect(store?.unreadable.map((entry) => entry.file.includes('chats'))).toEqual([true]);
  });
});

const never = (): never => {
  throw new Error('no session');
};
