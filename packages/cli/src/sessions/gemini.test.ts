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
// recordMessageTokens writes all six fields on every message (chatRecordingService.ts:1137-1146).
const tokens = (input: number, output: number, cached = 0, extra: object = {}) => ({ input, output, cached, thoughts: 0, tool: 0, total: input + output, ...extra });
// The shell tool's result text: `Output: ...` then optional trailer lines, wrapped in <untrusted_context> (shell.ts:953-979, textUtils.ts wrapUntrusted).
const shellText = (output: string, trailer: readonly string[] = []): string => `<untrusted_context source="shell">\nOutput: ${output}${trailer.map((line) => `\n${line}`).join('')}\n</untrusted_context>`;
// The executor stores the call's own id on its response (utils/generateContentResponseUtilities.ts:29-33).
const reply = (id: string, name: string, response: object) => [{ functionResponse: { id, name, response } }];
const call = (id: string, name: string, args: object, status: string, second: number, result?: unknown) => ({ id, name, args, status, timestamp: T(second), ...(result === undefined ? {} : { result }) });
const shell = (id: string, command: string, status: string, second: number, text: string) => call(id, 'run_shell_command', { command }, status, second, reply(id, 'run_shell_command', { output: text }));

describe('the Gemini CLI reader', () => {
  it('turns a normal session into prompts, calls with outcomes, per-message usage with the cache subtracted, the model, and the cwd', () => {
    const records = [
      head,
      prompt(1, 'fix the build'),
      say(2, 'running it', { tokens: tokens(1000, 20, 400, { thoughts: 7, tool: 5 }), toolCalls: [shell('c1', 'npm test', 'success', 3, shellText('ok'))] }),
      say(5, 'now the edit', {
        tokens: tokens(1200, 30, 1000),
        toolCalls: [call('c2', 'replace', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, 'success', 6, reply('c2', 'replace', { output: 'Successfully modified file' })), call('c3', 'write_file', { file_path: 'docs/b.md', content: 'x' }, 'success', 6, reply('c3', 'write_file', { output: 'ok' }))],
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
      say(2, '', { toolCalls: [shell('a', 'sleep 9', 'success', 3, signalled), call('b', 'run_shell_command', { command: 'x' }, 'cancelled', 4, reply('b', 'run_shell_command', { error: '[Operation Cancelled] User cancelled tool execution.' }))] }),
    ]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['error', 'error']);
    expect(out.errorLines.map((error) => error.line)).toEqual(['partial', '[Operation Cancelled] User cancelled tool execution.']);
  });

  it('unwraps an error result to its message, never the wrapper, so the error line joins a Claude Code signature', () => {
    const out = extractOf([
      head,
      prompt(1, 'read it'),
      say(2, '', {
        toolCalls: [
          call('c1', 'read_file', { file_path: '/nope' }, 'error', 3, reply('c1', 'read_file', { error: 'ENOENT: no such file or directory, open /nope' })),
          // Defensive: upstream stores `response: { error }` for a failed call (scheduler/tool-executor.ts:156-167), never an empty result with status `error`.
          call('c3', 'read_file', { file_path: '/zip' }, 'error', 5, []),
        ],
      }),
    ]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['error', 'error']);
    expect(out.errorLines.map((error) => error.line)).toEqual(['ENOENT: no such file or directory, open /nope', 'tool failed']);
  });

  it('leaves a shell call whose stored result the 64 KB cap cut short as none: the closing tag and the exit code went with the tail (utils/tool-utils.ts:178-205)', () => {
    const cut = (suffix: string): string => `<untrusted_context source="shell">\nOutput: ${'x'.repeat(200)}\nsecond line${suffix}`;
    const out = extractOf([
      head,
      prompt(1, 'x'),
      say(2, '', { toolCalls: [shell('a', 'big', 'success', 3, cut('\n... [Tool output truncated to conserve memory]')), shell('b', 'big', 'success', 4, cut('\n... [Tool output truncated to conserve memory. For full output see: /home/u/.gemini/tmp/app/tool-outputs/s/shell_b.txt]')), shell('c', 'fine', 'success', 5, shellText('all good'))] }),
    ]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['none', 'none', 'ok']);
    expect(out.errorLines).toEqual([]);
  });

  it('leaves a shell call under the summarizeToolOutput setting as none: upstream stores only the wrapped summary, with no Output: prefix and no exit code, and status success whatever the exit (tools/shell.ts:1175-1187; packages/cli/src/config/settingsSchema.ts:1090)', () => {
    const summary = (text: string): string => `<untrusted_context source="shell">
${text}
</untrusted_context>`;
    const out = extractOf([
      head,
      prompt(1, 'x'),
      say(2, '', {
        toolCalls: [
          shell('a', 'make', 'success', 3, summary('make failed: 3 errors in main.c')),
          shell('b', 'sleep 1 &', 'success', 4, summary('Command moved to background (PID: 41). Output hidden. Press Ctrl+B to view.')),
          shell('c', 'fine', 'success', 5, shellText('all good')),
        ],
      }),
    ]);
    // A call moved to the background has settled as far as the CLI knows, and reads ok (tools/shell.ts:944,1197 write the sentence inside `wrapUntrusted`); the summary is unsettled.
    expect(out.tools.map((tool) => tool.status)).toEqual(['none', 'ok', 'ok']);
    expect(out.errorLines).toEqual([]);
  });

  it('records a shell call whose spawn failed (status error) with the error message', () => {
    const out = extractOf([head, prompt(1, 'x'), say(2, '', { toolCalls: [call('c1', 'run_shell_command', { command: 'zzz' }, 'error', 3, reply('c1', 'run_shell_command', { error: 'spawn zzz ENOENT' }))] })]);
    expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: 'spawn zzz ENOENT' }]);
  });

  it('captures a session with no usage, and one whose tokens are null, with zero usage and the responses intact', () => {
    const out = extractOf([head, prompt(1, 'hi'), say(2, 'hello'), say(3, 'more', { tokens: null })]);
    expect(out.session.usage).toMatchObject({ input: 0, cacheRead: 0, output: 0, thinking: 0 });
    expect(out.session.assistantTurns).toBe(2);
  });

  it('reads a usage-only response (no text, no calls, and no model: recordSyntheticMessage writes none, geminiChat.ts:1815) and clamps a cache larger than the input to zero input', () => {
    // The clamp row is defensive: upstream counts the cache inside the input (uiTelemetry.ts:317-320), so `cached` never exceeds `input`; the `Math.max` guards a bad figure.
    const out = extractOf([head, prompt(1, 'hi'), say(2, '', { tokens: tokens(100, 5, 250), model: undefined })]);
    expect(out.session.usage).toMatchObject({ input: 0, cacheRead: 250, output: 5 });
  });

  // The placeholder upstream closes an interrupted turn with (geminiChat.ts:118,921-934): no model wrote it.
  const INTERRUPTED = '[The previous response was interrupted before it completed.]';

  it('drops the interrupted-response placeholder recorded as a tokenless model message at the next sync (chatRecordingService.ts:1465-1480)', () => {
    const lines = linesOf([head, prompt(1, 'run it'), say(2, 'working'), say(3, INTERRUPTED, { model: undefined })]);
    expect(lines.filter((entry) => entry.type === 'assistant')).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain('interrupted');
  });

  it('keeps the usage of an empty turn whose content a patch sets to the interrupted placeholder, as a usage-only line (geminiChat.ts:925-926)', () => {
    const records = [head, prompt(1, 'run it'), say(2, '', { tokens: tokens(100, 5, 40) }), { $patch: { updates: [{ id: 'g2', content: [{ text: INTERRUPTED }] }] } }];
    expect(extractOf(records).session.usage).toMatchObject({ input: 60, cacheRead: 40, output: 5 });
    expect(JSON.stringify(linesOf(records))).not.toContain('interrupted');
  });

  it('captures a session from a folder that is not a repository, and one that names no folder at all', () => {
    const out = extractOf([head, prompt(1, 'hi'), say(2, '', { toolCalls: [call('c1', 'read_file', { file_path: 'a.txt' }, 'success', 3, reply('c1', 'read_file', { output: 'text' }))] })], '/tmp/notes');
    expect(out.tools).toMatchObject([{ tool: 'Read', status: 'ok' }]);
    expect(out.session.repo).toBeNull();
    expect(linesOf([head, prompt(1, 'hi')], null)[0]).not.toHaveProperty('cwd');
  });

  it('leaves a call with no result yet, or still running, as none', () => {
    // Defensive: `recordToolCalls` (chatRecordingService.ts:1168) has one caller, `recordCompletedToolCalls` (geminiChat.ts:1842-1871), and each caller of that passes only a call that is
    // `success`, `error`, or `cancelled` (useGeminiStream.ts:917-932, nonInteractiveCli.ts:567, local-executor.ts:1294, acpSession.ts:884,932), so `executing` and `awaiting_approval`
    // (with a null result) are never written; they prove the reader's status guard.
    const out = extractOf([head, prompt(1, 'x'), say(2, '', { toolCalls: [call('a', 'run_shell_command', { command: 'x' }, 'executing', 3), call('b', 'read_file', { file_path: 'f' }, 'awaiting_approval', 4, null)] })]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['none', 'none']);
  });

  it('does not read a tool result, a slash command, or injected context as a prompt, and prefers what the operator typed', () => {
    // The tool result turn is a user message of `functionResponse` parts, recorded synthetically (core/geminiChat.ts:593-596); `info`, `warning`, and `error` are message types
    // `recordMessage` writes (chatRecordingService.ts:1079-1112); the typed texts go through the prompt path (geminiChat.ts:560-565), and `displayContent` differs from the sent text only
    // when an `@file` expansion or a command changed it (:553-557).
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
      { id: 'w', timestamp: T(10), type: 'warning', content: 'Heads up.' },
      { id: 'e', timestamp: T(11), type: 'error', content: 'Something broke.' },
    ]);
    expect(lines.filter((entry) => entry.type === 'user').map((entry) => JSON.stringify(entry.message))).toEqual([expect.stringContaining('real'), expect.stringContaining('what I typed')]);
  });

  // Each text below is one the CLI itself puts to the model as a user turn, which the chat file records like a typed prompt (geminiChat.ts:553-567 records `content` and, when it differs,
  // `displayContent`; addHistory records the rest through recordSyntheticMessage, geminiChat.ts:1345-1352). None is an operator prompt.
  const injected: readonly { name: string; text: string; writer: string }[] = [
    { name: 'loop recovery', text: "System: Potential loop detected. Details: same call. Please take a step back and confirm you're making forward progress.", writer: 'core/client.ts:1338' },
    { name: 'IDE context', text: "Here is the user's editor context as a JSON object. This is for your information only.\n```json\n{}\n```", writer: 'core/client.ts:503' },
    { name: 'IDE context changes', text: "Here is a summary of changes in the user's editor context, in JSON format. This is for your information only.\n```json\n{}\n```", writer: 'core/client.ts:613' },
    { name: 'next speaker', text: 'Please continue.', writer: 'core/client.ts:930' },
    { name: 'shell escape', text: 'I ran the following shell command:\n```sh\nls\n```\n\nThis produced the following result:\n```\na\n```', writer: 'cli useExecutionLifecycle.ts:61-66' },
    { name: 'plan exit', text: 'User has manually exited Plan Mode. Switching to Default mode (edits will require confirmation).', writer: 'cli useGeminiStream.ts:2060, utils/approvalModeUtils.ts:36-39' },
    { name: 'directory context', text: '- **Workspace Directories:**\n  - /work/app\n- **Directory Structure:**\n\n/work/app/', writer: 'core/client.ts:396, utils/environmentContext.ts:37' },
    { name: 'empty-reply nudge', text: '[System: You successfully executed a tool but returned an empty response. Please analyze the tool output and explain your progress or final answer.]', writer: 'cli useGeminiStream.ts:720,1796-1811; core agent/legacy-agent-session.ts:254-258' },
  ];
  const typedOf = (records: readonly unknown[]): string[] =>
    linesOf(records)
      .filter((entry) => entry.type === 'user')
      .map((entry) => JSON.stringify(entry.message));

  it.each(injected)('does not read the $name turn the CLI injects as a prompt ($writer)', ({ text }) => {
    expect(typedOf([head, prompt(1, 'real'), say(2, 'ok'), prompt(3, text)])).toEqual([expect.stringContaining('real')]);
  });

  it('reads the operator prompt once when loop recovery re-sends it: the recovery turn carries the operator\'s displayContent (core/client.ts:1349-1354, cli useGeminiStream.ts:1933-1938, geminiChat.ts:553-567)', () => {
    const recovery = 'System: Potential loop detected. Details: x. Please take a step back.';
    const texts = typedOf([head, prompt(1, 'expanded', { displayContent: [{ text: 'fix the build' }] }), say(2, 'ok'), prompt(3, recovery, { displayContent: [{ text: 'fix the build' }] })]);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('fix the build');
  });

  it('matches the next-speaker turn exactly, so an operator who types more than "Please continue." still has a prompt (core/client.ts:930)', () => {
    expect(typedOf([head, prompt(1, 'Please continue. Start with the tests.')])).toEqual([expect.stringContaining('Please continue. Start with the tests.')]);
  });

  it('does not read a tool-result turn with a <hook_context> note beside the result as a prompt: one of the two texts upstream puts beside a function response, the other being the steering hint below (core/client.ts:985-989)', () => {
    const response = { functionResponse: { id: 'x', name: 'read_file', response: { output: 'file text' } } };
    const hooked = { id: 'm', timestamp: T(2), type: 'user', content: [response, { text: '<hook_context>x</hook_context>' }] };
    expect(linesOf([head, hooked]).filter((entry) => entry.type === 'user')).toEqual([]);
  });

  it('reads a tool-result turn with a "User steering update:" text beside the result as a prompt: the operator typed the hint (cli useGeminiStream.ts:2345-2347, fastAckHelper.ts:67-70, utils/messageInspectors.ts:9-13)', () => {
    // The CLI unshifts `buildUserSteeringHintPrompt` (the operator's words in `<user_input>`) beside the function responses, and `isFunctionResponse` tests with `some`, so that turn is recorded.
    const response = { functionResponse: { id: 'x', name: 'read_file', response: { output: 'file text' } } };
    const steered = { id: 'm', timestamp: T(2), type: 'user', content: [{ text: 'User steering update:\n<user_input>\nuse the v2 api\n</user_input>\nInternal instruction: Re-evaluate the active plan.' }, response] };
    expect(typedOf([head, steered])).toEqual([expect.stringContaining('use the v2 api')]);
  });

  it('reads a user message with a tool result AND other typed text as a prompt: only a message made wholly of tool results is not a prompt (geminiChat.ts:527,547)', () => {
    // Defensive: upstream puts only `<hook_context>` text beside a function response (core/client.ts:985-989), and `convertToFunctionResponse` folds a tool's own text into the
    // response `output` (utils/generateContentResponseUtilities.ts:69,131-136), so this shape is one only the reader's rule meets.
    const mixed = { id: 'm', timestamp: T(2), type: 'user', content: [{ functionResponse: { id: 'x', name: 'read_file', response: { output: 'file text' } } }, { text: 'and also this' }] };
    expect(linesOf([head, mixed]).map((entry) => JSON.stringify(entry.message))).toEqual([expect.stringContaining('and also this')]);
  });

  it('applies the resume filter to the sent text (content), not to what was shown: a custom command is a prompt whose content is its expansion (chatRecordingService.ts:220-227, nonInteractiveCli.ts:289-300)', () => {
    // `displayContent` is written only when it differs from the sent text (core/geminiChat.ts:553-557), so the `/clear` prompt carries none.
    const lines = linesOf([head, prompt(1, 'expanded text', { displayContent: [{ text: '/cmd' }] }), say(2, 'ok'), prompt(3, '/clear')]);
    expect(lines.filter((entry) => entry.type === 'user').map((entry) => JSON.stringify(entry.message))).toEqual([expect.stringContaining('/cmd')]);
    expect(lines.map((entry) => entry.type)).toEqual(['user', 'assistant']);
  });

  it('skips a response that holds only a thought, and leaves thought text out of the response', () => {
    const lines = linesOf([head, prompt(1, 'x'), say(2, '', { thoughts: [{ subject: 's', description: 'd', timestamp: T(2) }] }), say(3, [{ text: 'hidden', thought: true }, { text: 'shown' }])]);
    expect(lines.filter((entry) => entry.type === 'assistant')).toHaveLength(1);
    expect(JSON.stringify(lines)).toContain('shown');
    expect(JSON.stringify(lines)).not.toContain('hidden');
  });

  it('keeps the last record of a message id, so a call recorded without its result and then finished is one response with its outcome (chatRecordingService.ts:1152,1187-1190)', () => {
    // Upstream rewrites only the LAST message, and only while it is a `gemini` one: `recordToolCalls` and `recordMessageTokens` update it in place, and start a new id otherwise.
    // So the two records of one id are adjacent. A call is recorded only once finished (see above), so the first record carries the text and no tokens, the second the tokens and the call.
    const first = say(2, 'working', { tokens: null });
    const second = say(2, 'working', { tokens: tokens(100, 5), toolCalls: [shell('c1', 'make', 'success', 3, shellText('boom', ['Exit Code: 1']))] });
    const out = extractOf([head, prompt(1, 'a'), first, second, prompt(4, 'b')]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.session.assistantTurns).toBe(1);
    expect(out.session.usage).toMatchObject({ input: 100, output: 5 });
  });

  it('keeps a rewritten id at its first position (defensive: the loader allows an id to return after a message between, chatRecordingService.ts:448, and the writer never does)', () => {
    const finished = say(2, 'working', { tokens: tokens(100, 5), toolCalls: [shell('c1', 'make', 'success', 3, shellText('boom', ['Exit Code: 1']))] });
    const records = [head, prompt(1, 'a'), say(2, 'working', { tokens: null }), prompt(4, 'b'), finished];
    expect(extractOf(records).session.assistantTurns).toBe(1);
    // The assistant line keeps the first record's place between the two prompts; its result line follows it.
    expect(linesOf(records).map((entry) => entry.type)).toEqual(['user', 'assistant', 'user', 'user']);
  });

  describe('a history sync (services/chatRecordingService.ts:1427-1590)', () => {
    // Compression (core/client.ts:724,1294) and masking (client.ts:734,1321) call setHistory, which re-records every kept turn under a fresh id with no tokens, toolCalls, or
    // model (geminiChat.ts:1386-1395, recordSyntheticMessage at chatRecordingService.ts:1116), then removes all the old ids in one $patch (chatRecordingService.ts:1533-1590).
    const original = (): unknown[] => [
      head,
      prompt(1, 'fix the build'),
      say(2, 'running it', { tokens: tokens(1000, 20), toolCalls: [shell('c1', 'make', 'success', 3, shellText('boom', ['Exit Code: 2']))] }),
      prompt(5, 'try again'),
    ];
    const copy = (id: string, type: 'user' | 'gemini', text: string, second: number) => ({ id, timestamp: T(second), type, content: [{ text }] });
    const summary = (id: string, second: number) => copy(id, 'user', '<state_snapshot>\n<overall_goal>fix the build</overall_goal>\n</state_snapshot>', second);
    const gotIt = (id: string, second: number) => copy(id, 'gemini', 'Got it. Thanks for the additional context!', second);

    it('keeps the prompts, usage, calls, and errors from before a compression, and reads neither the summary as a prompt nor the canned reply as a response', () => {
      const records = [
        ...original(),
        summary('s1', 20),
        gotIt('s2', 20),
        copy('k1', 'user', 'try again', 20),
        { $patch: { removeIds: ['u1', 'g2', 'u5'], orderIds: ['s1', 's2', 'k1'] } },
        prompt(30, 'and now'),
      ];
      const lines = linesOf(records);
      const prompts = lines.filter((entry) => entry.type === 'user' && JSON.stringify(entry.message).includes('"type":"text"')).map((entry) => /"text":"([^"]*)"/.exec(JSON.stringify(entry.message))?.[1]);
      expect(prompts).toEqual(['fix the build', 'try again', 'and now']);
      const out = extractOf(records);
      expect(out.session.userTurns).toBe(3);
      expect(out.session.assistantTurns).toBe(1);
      expect(out.session.usage).toMatchObject({ input: 1000, output: 20 });
      expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
      expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: 'boom' }]);
      // The kept messages keep their own times, not the one time of the re-recorded copies.
      expect(out.session.tsFirst).toBe(T(1));
      expect(lines.map((entry) => entry.timestamp)).toEqual([T(1), T(2), T(3), T(5), T(30)]);
    });

    // A masking pass (core/client.ts:1312-1322, context/toolOutputMaskingService.ts:215-231,361-366) fires only when a tool response was masked: the tool response turn is a user
    // turn of `functionResponse` parts (geminiChat.ts:593), `setHistory` re-records every turn with the masked snippet in place of the output, and the sync writes
    // `updates[{id: <gemini message>, toolCalls: [{id, result: <the turn's parts>}]}]` beside `removeIds` (chatRecordingService.ts:1495-1530,1577-1587).
    const maskedText = '<tool_output_masked>\nboom\n\nOutput too large. Full output available at: /tmp/out.txt\n</tool_output_masked>';
    const toolTurn = (id: string, second: number, callId: string, output: string) => ({ id, timestamp: T(second), type: 'user', content: reply(callId, 'run_shell_command', { output }) });
    const withTurn = (text: string, held: unknown = reply('c1', 'run_shell_command', { output: text }), status = 'success'): unknown[] => [
      head,
      prompt(1, 'fix the build'),
      say(2, 'running it', { tokens: tokens(1000, 20), toolCalls: [call('c1', 'run_shell_command', { command: 'make' }, status, 3, held)] }),
      toolTurn('t4', 4, 'c1', text),
      prompt(5, 'try again'),
    ];
    const maskedTurn = reply('c1', 'run_shell_command', { output: maskedText });
    const maskingPass = (suffix: string, second: number): unknown[] => [
      copy(`mu1${suffix}`, 'user', 'fix the build', second),
      copy(`mg2${suffix}`, 'gemini', 'running it', second),
      { id: `mt4${suffix}`, timestamp: T(second), type: 'user', content: maskedTurn },
      copy(`mu5${suffix}`, 'user', 'try again', second),
    ];
    const passPatch = (suffix: string, removed: readonly string[], updates: readonly unknown[] = []) => ({
      $patch: { ...(updates.length === 0 ? {} : { updates }), removeIds: removed, orderIds: [`mu1${suffix}`, `mg2${suffix}`, `mt4${suffix}`, `mu5${suffix}`] },
    });
    const maskedUpdate = [{ id: 'g2', toolCalls: [{ id: 'c1', result: maskedTurn }] }];
    const firstPass = [...maskingPass('a', 20), passPatch('a', ['u1', 'g2', 't4', 'u5'], maskedUpdate)];
    const failed = shellText('boom', ['Exit Code: 2']);

    it('keeps them through a masking pass (a tool response turn, its masked copy, and updates on the removed message), and through a second pass over the copies', () => {
      const records = [...withTurn(failed), ...firstPass, ...maskingPass('b', 40), passPatch('b', ['mu1a', 'mg2a', 'mt4a', 'mu5a'])];
      const out = extractOf(records);
      expect(out.session.userTurns).toBe(2);
      expect(out.session.assistantTurns).toBe(1);
      expect(out.session.usage).toMatchObject({ input: 1000, output: 20 });
      expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
      expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: 'boom' }]);
      expect(out.session.tsFirst).toBe(T(1));
      expect(out.session.tsLast).toBe(T(5));
    });

    it('lets the result the call held decide when a pass masks it: a failed shell call stays an error with its own line, not the masked envelope, and a cut-short one stays none (chatRecordingService.ts:1500-1525; toolOutputMaskingService.ts:224-231)', () => {
      const exit = extractOf([...withTurn(failed), ...firstPass]);
      expect(exit.tools).toMatchObject([{ status: 'error' }]);
      expect(exit.errorLines).toMatchObject([{ line: 'boom' }]);
      // A `status: error` call: the masked response drops the `error` key (toolOutputMaskingService.ts:224-231), so only the held result still names the failure.
      const errored = extractOf([...withTurn('', reply('c1', 'run_shell_command', { error: 'spawn failed' }), 'error'), ...firstPass]);
      expect(errored.tools).toMatchObject([{ status: 'error' }]);
      expect(errored.errorLines).toMatchObject([{ line: 'spawn failed' }]);
      const long = `<untrusted_context source="shell">\nOutput: ${'x'.repeat(100)}\n... [Tool output truncated to conserve memory. For full output see: /tmp/full.txt]`;
      expect(extractOf([...withTurn(long), ...firstPass]).tools).toMatchObject([{ status: 'none' }]);
    });

    it('applies an update no pass removed, and one on a removed message whose call held no result yet, but not one on a removed message whose call held its result', () => {
      const update = (removed: string[]) => ({
        $patch: { updates: [{ id: 'g2', toolCalls: [{ id: 'c1', result: reply('c1', 'run_shell_command', { output: shellText('no', ['Exit Code: 3']) }) }] }], removeIds: removed },
      });
      // Defensive for the second and third rows: a finished call always holds its result upstream, so one with none is a shape only the reader's guard meets.
      const open = [head, prompt(1, 'a'), say(2, 'x', { toolCalls: [call('c1', 'run_shell_command', { command: 'make' }, 'success', 3)] })];
      expect(extractOf([...open, update([])]).tools).toMatchObject([{ status: 'error' }]);
      expect(extractOf([...open, update(['g2'])]).tools).toMatchObject([{ status: 'error' }]);
      const held = [head, prompt(1, 'a'), say(2, 'x', { toolCalls: [shell('c1', 'make', 'success', 3, shellText('fine'))] })];
      expect(extractOf([...held, update([])]).tools).toMatchObject([{ status: 'error' }]);
      expect(extractOf([...held, update(['g2'])]).tools).toMatchObject([{ status: 'ok' }]);
    });

    it('hides a copy whose text upstream recorded stripped: the response is stored without zero-width characters and HTML comments, trimmed (geminiChat.ts:1710-1719,1811), and the history copy holds the raw parts (:1823)', () => {
      for (const raw of ['answer\n', '<!-- note -->answer', '\u200Banswer', '<!<!-- x -->-- y -->answer ']) {
        const records = [
          head,
          prompt(1, 'fix the build'),
          say(2, 'answer', { tokens: tokens(1000, 20) }),
          prompt(5, 'try again'),
          copy('k1', 'user', 'fix the build', 20),
          copy('k2', 'gemini', raw, 20),
          copy('k3', 'user', 'try again', 20),
          { $patch: { removeIds: ['u1', 'g2', 'u5'], orderIds: ['k1', 'k2', 'k3'] } },
        ];
        expect(extractOf(records).session.assistantTurns).toBe(1);
      }
    });

    it('treats the text user turn before the canned reply as the summary whatever it opens with (a scratchpad, a code fence), and still skips a bare summary whose reply is gone (context/chatCompressionService.ts:588,603,665-673)', () => {
      const userTurns = (text: string, withReply = true) =>
        extractOf([...original(), copy('s1', 'user', text, 20), ...(withReply ? [gotIt('s2', 20)] : []), { $patch: { removeIds: ['u1', 'g2', 'u5'], orderIds: withReply ? ['s1', 's2'] : ['s1'] } }]).session.userTurns;
      expect(userTurns('<state_snapshot>\n<overall_goal>g</overall_goal>\n</state_snapshot>')).toBe(2);
      expect(userTurns('<scratchpad>thinking</scratchpad>\n<state_snapshot>x</state_snapshot>')).toBe(2);
      expect(userTurns('```xml\n<state_snapshot>x</state_snapshot>\n```')).toBe(2);
      expect(userTurns('<state_snapshot>x</state_snapshot>', false)).toBe(2);
      // A typed prompt before a response that has usage is a prompt, even when the response reads like the canned one.
      expect(extractOf([head, prompt(1, 'no reply yet'), say(2, 'Got it. Thanks for the additional context!', { tokens: tokens(5, 5) })]).session.userTurns).toBe(1);
    });

    it('applies a rewind to a copy as a rewind from its original: the rolled-back prompt and response are gone and earlier turns stay (chatRecordingService.ts:1380-1410)', () => {
      const after = [prompt(30, 'rewound prompt'), say(31, 'rewound answer', { tokens: tokens(7, 7) })];
      const text = (records: readonly unknown[]) =>
        linesOf(records)
          .filter((entry) => entry.type === 'user' && JSON.stringify(entry.message).includes('"type":"text"'))
          .map((entry) => /"text":"([^"]*)"/.exec(JSON.stringify(entry.message))?.[1]);
      const once = [...withTurn(failed), ...firstPass, ...after, { $rewindTo: 'mu5a' }, prompt(40, 'retyped')];
      expect(text(once)).toEqual(['fix the build', 'retyped']);
      expect(extractOf(once).session.assistantTurns).toBe(1);
      // Through a second pass the new copy still rewinds from the original.
      const twice = [...withTurn(failed), ...firstPass, ...maskingPass('b', 40), passPatch('b', ['mu1a', 'mg2a', 'mt4a', 'mu5a']), ...after, { $rewindTo: 'mu5b' }, prompt(50, 'retyped')];
      expect(text(twice)).toEqual(['fix the build', 'retyped']);
      expect(extractOf(twice).session.usage).toMatchObject({ input: 1000, output: 20 });
      // A rewind to the first copy rolls the whole history back.
      expect(text([...withTurn(failed), ...firstPass, { $rewindTo: 'mu1a' }, prompt(50, 'fresh')])).toEqual(['fresh']);
    });

    it('keeps the hidden copies of earlier turns when a rewind names a later copy, so a later pass still hides the copies it re-records (chatRecordingService.ts:1380-1410)', () => {
      const records = [
        head,
        prompt(1, 'first'),
        say(2, 'answer one', { tokens: tokens(100, 5) }),
        prompt(3, 'second'),
        say(4, 'answer two', { tokens: tokens(200, 6) }),
        copy('a1', 'user', 'first', 20),
        copy('a2', 'gemini', 'answer one', 20),
        copy('a3', 'user', 'second', 20),
        copy('a4', 'gemini', 'answer two', 20),
        { $patch: { removeIds: ['u1', 'g2', 'u3', 'g4'], orderIds: ['a1', 'a2', 'a3', 'a4'] } },
        { $rewindTo: 'a3' },
        prompt(30, 'retyped'),
        copy('b1', 'user', 'first', 40),
        copy('b2', 'gemini', 'answer one', 40),
        copy('b3', 'user', 'retyped', 40),
        { $patch: { removeIds: ['a1', 'a2', 'u30'], orderIds: ['b1', 'b2', 'b3'] } },
      ];
      const out = extractOf(records);
      expect(out.session.userTurns).toBe(2);
      expect(out.session.assistantTurns).toBe(1);
    });

    it('drops a copy once per removed message, so a prompt typed twice stays two and an identical later prompt is not mistaken for a copy', () => {
      const records = [
        head,
        prompt(1, 'again'),
        prompt(2, 'again'),
        copy('k1', 'user', 'again', 20),
        copy('k2', 'user', 'again', 20),
        { $patch: { removeIds: ['u1', 'u2'], orderIds: ['k1', 'k2'] } },
        prompt(30, 'again'),
      ];
      expect(extractOf(records).session.userTurns).toBe(3);
    });
  });

  it('reads each parallel call from the functionResponse whose id is the call, also after a history sync patches every call with the whole user turn (chatRecordingService.ts:1500-1525)', () => {
    const calls = [shell('a', 'ok-one', 'success', 3, shellText('fine')), shell('b', 'bad-two', 'success', 3, shellText('boom', ['Exit Code: 2']))];
    // `tc.result = turnParts` gives every call in the turn the same list: both calls' responses, in the order the model asked.
    const turn = [...reply('a', 'run_shell_command', { output: shellText('fine') }), ...reply('b', 'run_shell_command', { output: shellText('boom', ['Exit Code: 2']) })];
    const before = extractOf([head, prompt(1, 'x'), say(2, '', { toolCalls: calls })]);
    expect(before.tools.map((tool) => tool.status)).toEqual(['ok', 'error']);
    const synced = [head, prompt(1, 'x'), say(2, '', { toolCalls: calls.map((entry) => ({ ...entry, result: [] })) }), { $patch: { updates: [{ id: 'g2', toolCalls: calls.map((entry) => ({ id: entry.id, result: turn })) }] } }];
    const out = extractOf(synced);
    expect(out.tools.map((tool) => tool.status)).toEqual(['ok', 'error']);
    expect(out.errorLines).toMatchObject([{ line: 'boom' }]);
    // Defensive: upstream always writes the call's id on its response; a response under any other id is the fallback, read as the call's own.
    const stray = call('s', 'run_shell_command', { command: 'x' }, 'success', 3, reply('other', 'run_shell_command', { output: shellText('late', ['Exit Code: 4']) }));
    expect(extractOf([head, prompt(1, 'x'), say(2, '', { toolCalls: [stray] })]).tools).toMatchObject([{ status: 'error' }]);
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
    // Loader-only: an unknown id clears all (chatRecordingService.ts:333-337); the writer names only ids it holds (:1380-1385, :1570).
    expect(prompts([...body, { $rewindTo: 'nope' }])).toBe('');
    // A content update is written as `updates[{id, content}]` (chatRecordingService.ts:1441-1452, 1577-1587).
    expect(prompts([...body, { $patch: { updates: [{ id: 'u1', content: [{ text: 'edited' }] }] } }])).toContain('edited');
    // A removed message stays (a history sync's $patch lists every old id, and the message is the only record of what was said); only a copy of it is hidden.
    // Defensive inputs upstream cannot write (the loader guards each, chatRecordingService.ts:362,394): a numeric id in `removeIds` and `orderIds`, a non-object entry in `$set.messages`, a non-string `$rewindTo`.
    expect(prompts([...body, { $patch: { updates: [{ id: 'u3', content: [{ text: 'bulk' }] }], removeIds: ['u2', 7] } }])).toMatch(/one.*two.*bulk/);
    // `orderIds` with a number and an unknown id: defensive, same guard.
    expect(prompts([...body, { $patch: { orderIds: ['u3', 'u1', 'ghost', 4] } }])).toMatch(/two.*three.*one/);
    // Defensive: an update for an id the file does not hold (the writer patches only ids it indexed, chatRecordingService.ts:1437), and a top-level `$patch.id` (only the loader
    // reads it, :343-345; the writer, :1577-1587, writes `updates`, `removeIds`, and `orderIds`).
    expect(prompts([...body, { $patch: { updates: [{ id: 'ghost', content: [{ text: 'x' }] }] } }]).split('|')).toHaveLength(3);
    expect(prompts([...body, { $patch: { id: 'ghost', content: [{ text: 'x' }] } }]).split('|')).toHaveLength(3);
    // Loader-only: `$set.messages` is deprecated (chatRecordingTypes.ts:151) and the writers at the pin write only metadata in `$set` (chatRecordingService.ts:751, 1034).
    // `'not a message'` in `$set.messages`: defensive, the loader keeps only objects with an id.
    expect(prompts([...body, { $set: { messages: [prompt(9, 'replaced'), 'not a message'] } }])).toMatch(/^[^|]*replaced[^|]*$/);
    // `$rewindTo: 1` (a number): defensive, upstream writes the message id string.
    expect(prompts([head, { $set: { summary: 's' } }, { $patch: { content: 'no id' } }, { $rewindTo: 1 }])).toBe('');
  });

  it('patches a tool call result in place, so a result recorded later by a $patch decides the outcome', () => {
    // Defensive: a finished call is recorded with its result (recordToolCalls, chatRecordingService.ts:1168-1230, from the executor's completed call), so a finished call with none, which
    // the patch then fills, is one upstream does not write; the row proves the reader applies an update to a call that holds nothing.
    const open = say(2, 'x', { toolCalls: [call('c1', 'run_shell_command', { command: 'make' }, 'success', 3)] });
    const result = reply('c1', 'run_shell_command', { output: shellText('no', ['Exit Code: 3']) });
    // The writer is `updates[{id, toolCalls: [{id, result}]}]` (chatRecordingService.ts:1495-1525, 1577-1587).
    expect(extractOf([head, prompt(1, 'a'), open, { $patch: { updates: [{ id: 'g2', toolCalls: [{ id: 'c1', result }] }] } }]).tools).toMatchObject([{ status: 'error' }]);
    // Defensive: a top-level `$patch.id` (only the loader reads it, :343-345), `{ id: 'zzz' }` (a call the message does not hold: the writer patches only calls in `toolCallMetaMap`),
    // and a patch aimed at a user message.
    const top = { $patch: { id: 'g2', toolCalls: [{ id: 'c1', result }, { id: 'zzz', result: [] }] } };
    expect(extractOf([head, prompt(1, 'a'), open, top]).tools).toMatchObject([{ status: 'error' }]);
    expect(extractOf([head, prompt(1, 'a'), prompt(5, 'b'), { $patch: { id: 'u1', toolCalls: [{ id: 'c1', result: [] }] } }]).session.userTurns).toBe(2);
  });

  it('reads a legacy single-object file whose messages are in the object, and a head line that carries them', () => {
    // The `.json` file is what releases before the `.jsonl` migration wrote (chatRecordingService.ts:735-747, loaded at :1647). A head LINE that carries `messages` is loader-only
    // (the loader's partial-metadata branch, :500-530); the writer's head, :855-866, holds none.
    const whole = JSON.stringify({ ...head, messages: [prompt(1, 'legacy'), say(2, 'ok')] }, null, 2);
    expect(chatLines(whole, 'f', null).map((entry) => entry.type)).toEqual(['user', 'assistant']);
    expect(chatBadLines(whole)).toEqual([]);
    expect(chatLines(asText([{ ...head, messages: [prompt(1, 'inline')] }]), 'f', null)).toHaveLength(1);
  });

  it('takes the session id from the head, else the fallback, and the model from each response', () => {
    expect(linesOf([head, prompt(1, 'x')])[0]).toMatchObject({ sessionId: 'sess-1' });
    // Defensive: the writer's first line is the head (chatRecordingService.ts:855-866), so a file with none is one `openGeminiStore` has already refused; this proves the fallback id only.
    expect(chatLines(asText([prompt(1, 'x'), say(2, 'y')]), 'fallback', null)[0]).toMatchObject({ sessionId: 'fallback' });
    expect(linesOf([head, prompt(1, 'x'), say(2, 'y', { model: undefined })]).find((entry) => entry.type === 'assistant')).not.toHaveProperty('requestedModel');
  });

  it('never steps a prompt back before the one before it, and gives one whose time is missing or relative the last good time (upstream always writes an ISO time, so this is defensive)', () => {
    // The relative time `'2 minutes ago'` is a defensive input (the brief's missing-or-relative-timestamp bullet); upstream writes an ISO `timestamp` on every message.
    const times = linesOf([head, prompt(5, 'a'), { ...prompt(6, 'b'), timestamp: undefined }, { ...prompt(7, 'c'), timestamp: '2 minutes ago' }, prompt(2, 'd'), prompt(9, 'e')]).map((entry) => entry.timestamp);
    expect(times).toEqual([T(5), T(5), T(5), T(5), T(9)]);
    expect(linesOf([{ ...prompt(1, 'a'), timestamp: undefined }])[0]?.timestamp).toBe(new Date(0).toISOString());
  });

  it('counts a torn line, throws when nothing parses, and returns nothing for an empty file', () => {
    // A torn line is a crash or full disk mid-append (appendRecord, chatRecordingService.ts:942, ENOSPC at :1020); the file otherwise holds whole lines.
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
    const viaTool = extractOf([head, prompt(1, 'go'), say(2, '', { toolCalls: [call('c1', 'read_file', { file_path: 'f' }, 'error', 3, reply('c1', 'read_file', { error: long }))] })]).errorLines[0];
    expect(viaTool?.line.length).toBeLessThanOrEqual(1000);
    expect(viaTool?.line).not.toContain('alice@example.com');
  });

  it('records a shell call that hit the inactivity timeout as an error: the tool writes a sentence and no trailer (tools/shell.ts:929-933, 1197) and the executor records success (tool-executor.ts:144-154)', () => {
    const sentence = 'Command was automatically cancelled because it exceeded the timeout of 5.0 minutes without output.';
    const quiet = `<untrusted_context source="shell">\n${sentence} There was no output before it was cancelled.\n</untrusted_context>`;
    const partial = `<untrusted_context source="shell">\n${sentence} Below is the output before it was cancelled:\nhalf a log\n</untrusted_context>`;
    const out = extractOf([head, prompt(1, 'x'), say(2, '', { toolCalls: [shell('a', 'sleep 999', 'success', 3, quiet), shell('b', 'tail -f x', 'success', 4, partial)] })]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['error', 'error']);
    expect(out.errorLines.map((error) => error.line)).toEqual([sentence, sentence]);
    // A command that PRINTS that sentence first is a success: the real one has no `Output: ` prefix, which the wrapper of a printed one has.
    const printed = extractOf([head, prompt(1, 'x'), say(2, '', { toolCalls: [shell('c', 'echo', 'success', 3, shellText(`${sentence} (printed by the command)`))] })]);
    expect(printed.tools).toMatchObject([{ status: 'ok' }]);
    expect(printed.errorLines).toEqual([]);
  });

  it('reads a successful git commit through the Exit code 0 line, so its commit survives', () => {
    const out = extractOf([head, prompt(1, 'commit it'), say(2, '', { toolCalls: [shell('a', 'git commit -m x', 'success', 3, shellText('[main abc1234] x\n 1 file changed, 1 insertion(+)'))] })]);
    expect(out.tools[0]).toMatchObject({ tool: 'Bash', status: 'ok', commits: ['abc1234'] });
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
    ['tracker_add_dependency', 'plan.update'],
    ['tracker_visualize', 'plan.update'],
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
          call('a', 'read_file', { file_path: 'a.ts' }, 'success', 3, reply('a', 'read_file', { output: 't' })),
          call('b', 'replace', { file_path: 'a.ts' }, 'success', 4, reply('b', 'replace', { output: 't' })),
          call('c', 'write_file', { file_path: 'b.ts' }, 'success', 5, reply('c', 'write_file', { output: 't' })),
          shell('d', 'ls', 'success', 6, shellText('x')),
          call('e', 'glob', { pattern: '*.ts' }, 'success', 7, reply('e', 'glob', { output: 't' })),
          call('f', 'grep_search', { pattern: 'x' }, 'success', 8, reply('f', 'grep_search', { output: 't' })),
          call('g', 'google_web_search', { query: 'q' }, 'success', 9, reply('g', 'google_web_search', { output: 't' })),
          call('h', 'web_fetch', { prompt: 'p' }, 'success', 10, reply('h', 'web_fetch', { output: 't' })),
          call('i', 'invoke_agent', { agent_name: 'x' }, 'success', 11, reply('i', 'invoke_agent', { output: 't' })),
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
      // A subagent with no parent set is written at the root of chats/ (chatRecordingService.ts:787,813-814); the vendor's own listing skips it by `kind` (cli/src/utils/sessionUtils.ts:301), so it is no main session.
      { id: 'subroot0', projectRoot: '/work/a', lines: [geminiHead('subroot0', { kind: 'subagent' }), prompt(1, 'a subagent at the root')] },
      { id: 'cccccccc-3', slug: 'legacy', projectRoot: '/work/l', legacy: true, lines: JSON.stringify({ ...geminiHead('cccccccc-3'), messages: [prompt(1, 'old')] }, null, 2) },
      // Defensive: upstream sanitizes the id in a file name (chatRecordingService.ts:805), so a head whose `sessionId` holds `/../` is not one it writes.
      { id: 'rejected1', slug: 'rejected', lines: [geminiHead('bad id/../x')] },
      // Defensive: upstream writes the head line first (chatRecordingService.ts:865), so a file that starts with a prompt is not one it writes.
      { id: 'dddddddd-4', slug: 'nohead', projectRoot: '/work/n', lines: [prompt(1, 'no head line')] },
      // Defensive: a folder under chats/ is a parent session's id, which upstream sanitizes, so one with a space is not one it writes.
      { id: 'agent-8', parent: 'bad dir', projectRoot: '/work/a', lines: [geminiHead('agent-8', { kind: 'subagent' }), prompt(1, 'in an unsafe folder')] },
      // A head and a torn line is a torn file, not an empty one: it is listed, and its bad line is counted when it is read.
      { id: 'gggggggg-7', slug: 'torn', projectRoot: '/work/t', lines: `${JSON.stringify(geminiHead('gggggggg-7'))}
{"id": "u1", "ty
` },
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
        'gggggggg-7|/work/t|',
      ].sort(),
    );
    expect(store?.rejected).toBe(2);
    expect(store?.unreadable).toEqual([]);
    const torn = store?.sessions.find((session) => session.id === 'gggggggg-7');
    expect(chatBadLines(await (store?.transcript(torn ?? never()) ?? Promise.resolve('')))).toHaveLength(1);
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

  it('lists a second chat file under one session id as its own session, so a clearContext reset does not hide the first chat (core/client.ts:1032,1050; chatRecordingService.ts:780,811-818)', async () => {
    // An AfterAgent hook's `clearContext` calls `resetChat`, which starts a new file under the same `promptId`; the vendor adds `-<n>-` to a name that already exists in that minute.
    // The earlier chat (by its head's startTime) keeps the plain id even though its file name sorts after the reset's, and each file is read for its own prompts.
    const s = stage();
    const root = stageGemini(s.root, [
      { id: 'sess-1', projectRoot: '/work/a', lines: [geminiHead('sess-1'), prompt(1, 'first chat')] },
      { id: 'sess-1', projectRoot: '/work/a', stem: 'session-2026-06-01T10-00-1-sess-1', lines: [geminiHead('sess-1', { startTime: '2026-06-01T10:00:30.000Z' }), prompt(31, 'second chat')] },
      // A file name the skeleton cannot carry is counted, not listed.
      { id: 'sess-1', projectRoot: '/work/a', stem: 'session-with a space', lines: [geminiHead('sess-1', { startTime: '2026-06-01T10:02:00.000Z' }), prompt(40, 'third chat')] },
    ]);
    const store = await openGeminiStore(root);
    expect(store?.sessions.map((session) => session.id).sort()).toEqual(['sess-1', 'sess-1-session-2026-06-01T10-00-1-sess-1']);
    expect(store?.rejected).toBe(1);
    const own = async (id: string): Promise<string> => store?.transcript(store.sessions.find((session) => session.id === id) ?? never()) ?? '';
    expect(await own('sess-1')).toContain('first chat');
    expect(await own('sess-1')).not.toContain('second chat');
    expect(await own('sess-1-session-2026-06-01T10-00-1-sess-1')).toContain('second chat');
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
