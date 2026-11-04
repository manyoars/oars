import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, stage, stageVscode } from './test-support.js';
import { chatBadLines, chatData, chatLines, openVscodeCopilotStore, vscodeAppData } from './vscode-copilot.js';

afterEach(cleanup);

// Every fixture is written from the public source of microsoft/vscode @ f92b8f3adcd9bc034e6b9ade05c093dd59b99c5f (MIT), paths under src/vs/workbench/contrib/chat/common/:
// the request `ISerializableChatRequestData` (model/chatModel.ts:2230-2259: requestId, message, response, timestamp, modelId, isSystemInitiated, hiddenFromTranscript) and the
// response fields it inherits (:2198-2226: result, responseTimestamp, completionTokens, modelTotals); the file `ISerializableChatData3` (:2381-2394: version, sessionId, creationDate,
// workingDirectory); a tool call `IChatToolInvocationSerialized` (chatService/chatService.ts:1246-1270: toolId, toolCallId, toolSpecificData, resultError, resultDetails,
// isConfirmed, isComplete, subAgentInvocationId, completedAt); its terminal data `IChatTerminalToolInvocationData` (:715-725 commandLine, :790-807 terminalCommandOutput and
// terminalCommandState); `ToolConfirmKind` (:901-913: Denied 0, ConfirmationNotNeeded 1, UserAction 4, Skipped 5, with `source`); `IChatUsageModelTotal` (:176-188); the edit part `kind:'textEditGroup'`
// (model/chatModel.ts:1316); and the `.jsonl` log entries (model/objectMutationLog.ts:195-215, 345-390). Tool ids are from extensions/copilot/src/extension/tools/common/toolNames.ts.
// No live store was read.

const capture = (text: string) =>
  captureSession({
    text,
    harness: 'vscode-copilot',
    session: 'vscode-copilot-x',
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

const T0 = Date.parse('2026-06-01T10:00:00Z');
const MS = (second: number): number => T0 + second * 1000;
const iso = (second: number): string => new Date(MS(second)).toISOString();
const request = (second: number, text: string, response: readonly unknown[], extra: object = {}) => ({
  requestId: `request_${String(second)}`,
  message: { text, parts: [] },
  variableData: { variables: [] },
  response,
  timestamp: MS(second),
  responseTimestamp: MS(second + 1),
  modelId: 'copilot/claude-sonnet-4.5',
  ...extra,
});
const md = (value: string) => ({ value });
const APPROVED = { type: 4 };
const tool = (id: string, toolId: string, extra: object = {}) => ({ kind: 'toolInvocationSerialized', toolId, toolCallId: id, isConfirmed: APPROVED, isComplete: true, ...extra });
const shell = (id: string, command: string, state: object | undefined, output = '', extra: object = {}) =>
  tool(id, 'run_in_terminal', { toolSpecificData: { kind: 'terminal', commandLine: { original: command }, terminalCommandOutput: { text: output }, ...(state === undefined ? {} : { terminalCommandState: state }) }, ...extra });
const edited = (path: string) => ({ kind: 'textEditGroup', uri: { scheme: 'file', path }, edits: [], done: true });
const chat = (requests: readonly unknown[], extra: object = {}) => ({ version: 3, sessionId: 'sess-1', creationDate: MS(0), requests, ...extra });
const extractOf = (data: object, folder: string | null = '/work/app') => {
  const parsed = chatData(JSON.stringify(data), false);
  return capture(
    chatLines(parsed, 'sess', folder)
      .map((line) => JSON.stringify(line))
      .join('\n'),
  );
};

describe('the VS Code Copilot Chat reader', () => {
  it('turns a normal session into a prompt, calls with outcomes, whole-turn usage, the model, and the cwd, with the vendor version unset', () => {
    const out = extractOf(
      chat([
        request(
          1,
          'fix the build',
          [
            md('running it'),
            { kind: 'thinking', value: 'hidden reasoning' },
            shell('c1', 'npm test', { exitCode: 0 }, 'all passed'),
            md('now the edit'),
            tool('c2', 'replace_string_in_file'),
            edited('/work/app/src/a.ts'),
            edited('/work/app/docs/b.md'),
            tool('c3', 'create_file'),
            edited('/work/app/new.txt'),
            md('done'),
          ],
          { completionTokens: 60, promptTokens: 7000, modelTotals: [{ model: 'claude-sonnet-4.5', inputTokens: 900, cachedTokens: 400, outputTokens: 60 }] },
        ),
      ]),
    );
    expect(out.session.userTurns).toBe(1);
    expect(out.session.assistantTurns).toBe(1);
    expect(out.session.env.harness).toBeNull();
    expect(out.session.models).toEqual({ 'copilot/claude-sonnet-4.5': 1 });
    // `inputTokens` is taken whole (the source does not say it includes the cache), and `promptTokens`, the last call's, is not read.
    expect(out.session.usage).toMatchObject({ input: 900, cacheRead: 400, output: 60 });
    expect(out.tools.map((entry) => [entry.tool, entry.status])).toEqual([
      ['Bash', 'ok'],
      ['Edit', 'ok'],
      ['Edit', 'ok'],
      ['Write', 'ok'],
    ]);
    expect(out.session.files).toHaveLength(3);
    expect(out.errorLines).toEqual([]);
    expect(out.session.tsFirst).toBe(iso(1));
  });

  it('gives every public tool name a row: a notebook edit is an edit that touches its file, a directory is a write, terminal driving and a kernel run are other with the name kept, and a skill is a skill', () => {
    // toolNames.ts lists `edit_notebook_file`, `create_directory`, `send_to_terminal`, `run_notebook_cell`, and `skill`; the notebook edit part is `kind:'notebookEditGroup'` (model/chatModel.ts:1321,1331).
    const notebook = { kind: 'notebookEditGroup', uri: { scheme: 'file', path: '/work/app/n.ipynb' }, edits: [], done: true };
    const out = extractOf(
      chat([request(1, 'x', [tool('c1', 'edit_notebook_file'), notebook, tool('c2', 'copilot_createDirectory'), tool('c3', 'send_to_terminal'), tool('c4', 'run_notebook_cell'), tool('c5', 'skill'), tool('c6', 'runTests'), tool('c7', 'mcp__demo__search')])]),
    );
    expect(out.tools.map((entry) => entry.steps?.[0]?.action)).toEqual(['file.edit', 'file.write', 'other', 'other', 'skill.run', 'other', 'other']);
    expect(out.tools.map((entry) => entry.steps?.[0]?.native)).toEqual(['edit_notebook_file', 'copilot_createDirectory', 'send_to_terminal', 'run_notebook_cell', 'skill', 'runTests', '<literal>']);
    expect(out.session.files).toHaveLength(1);
  });

  it('records a shell call that exited nonzero as an error from its exit code, whatever the error field says, with the output as its error line', () => {
    const out = extractOf(chat([request(1, 'run it', [shell('c1', 'make', { exitCode: 2 }, 'make: *** No rule to make target\nsecond'), shell('c2', 'true', { exitCode: 0 }, 'fine', { resultError: 'a status that says failed' })])]));
    expect(out.tools).toMatchObject([
      { tool: 'Bash', status: 'error' },
      { tool: 'Bash', status: 'ok' },
    ]);
    expect(out.errorLines).toHaveLength(1);
    expect(out.errorLines[0]?.line).toContain('make: *** No rule to make target');
  });

  it('leaves a shell call with no exit code and no error as none (a background run), and one with an error and no exit code as an error', () => {
    const out = extractOf(chat([request(1, 'x', [shell('c1', 'watch', undefined, 'tick'), shell('c2', 'oops', undefined, '', { resultError: 'spawn failed' }), tool('c3', 'read_file', { isConfirmed: undefined, summary: { kind: 'incomplete' } }), tool('c4', 'read_file', { summary: { kind: 'incomplete' } })])]));
    // An unfinished call is written with `summary.kind` `incomplete` and, before confirmation, no `isConfirmed` (chatToolInvocation.ts:508,516-517); `isComplete` is always true.
    expect(out.tools.map((entry) => entry.status)).toEqual(['none', 'error', 'none', 'none']);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['spawn failed']);
  });

  it('stores no file of an unfinished or post-approval-skipped edit as a success, and a finished edit keeps every file', () => {
    // The edit's files are `textEditGroup` parts after the call (model/chatModel.ts:1316); the call carries one outcome for all of them (chatToolInvocation.ts:508,516).
    const files = (id: string, extra: object) => [tool(id, 'multi_replace_string_in_file', extra), edited('/work/app/a.ts'), edited('/work/app/b.ts')];
    const out = extractOf(
      chat([
        request(1, 'x', [
          ...files('c1', { isConfirmed: undefined, summary: { kind: 'incomplete' } }),
          ...files('c2', { isConfirmed: { type: 5 } }),
          ...files('c3', { isConfirmed: { type: 5, source: 'user' } }),
          ...files('c4', {}),
        ]),
      ]),
    );
    expect(out.tools.map((entry) => [entry.steps?.[0]?.action, entry.status])).toEqual([
      ['file.edit', 'none'],
      ['file.edit', 'none'],
      ['file.edit', 'none'],
      ['file.edit', 'none'],
      ['file.edit', 'error'],
      ['file.edit', 'error'],
      ['file.edit', 'ok'],
      ['file.edit', 'ok'],
    ]);
  });

  it('records a failed non-shell call and an edit that failed, which is still an edit by name, as errors, and reads an MCP tool failure message from its embed array', () => {
    // `IToolResultInputOutputDetails.output` is an array of `{type:'embed', value, isText}` (common/tools/languageModelToolsService.ts:290-296, written as an array at
    // contrib/mcp/common/mcpLanguageModelToolContribution.ts:279-280); a plain string output is the older spelling (`isToolResultInputOutputDetails`, :305).
    const embeds = [
      { type: 'embed', value: 'AAAA', isText: false },
      { type: 'embed', value: 'upstream returned 502', isText: true },
    ];
    const out = extractOf(
      chat([
        request(1, 'x', [
          tool('c1', 'copilot_readFile', { resultError: true }),
          tool('c2', 'copilot_applyPatch', { resultDetails: { input: 'p', output: 'patch did not apply', isError: true } }),
          tool('c3', 'mcp_demo_search', { resultDetails: { input: '{}', output: embeds, isError: true } }),
          tool('c4', 'mcp_demo_search', { resultDetails: { input: '{}', output: [{ type: 'embed', value: 'AAAA', isText: false }], isError: true } }),
        ]),
      ]),
    );
    expect(out.tools.map((entry) => [entry.tool, entry.status])).toEqual([
      ['copilot_readFile', 'error'],
      ['Edit', 'error'],
      ['mcp_demo_search', 'error'],
      ['mcp_demo_search', 'error'],
    ]);
    expect(out.errorLines.map((entry) => entry.line)).toEqual(['tool failed', 'patch did not apply', 'upstream returned 502', 'tool failed']);
  });

  it('runs the command the user last edited, then the tool-edited one, then the original, and stamps a failed call with its completedAt', () => {
    // chatTerminalToolConfirmationSubPart.ts:118 prefers the edited command as the one that runs.
    const commandOf = (commandLine: object): string => {
      const call = chatLines(chat([request(1, 'x', [tool('c1', 'run_in_terminal', { toolSpecificData: { kind: 'terminal', commandLine } })])]), 's', null).find((line) => line.type === 'assistant');
      return JSON.stringify(call?.message);
    };
    expect(commandOf({ original: 'a', toolEdited: 'b', userEdited: 'c' })).toContain('"command":"c"');
    expect(commandOf({ original: 'a', toolEdited: 'b' })).toContain('"command":"b"');
    expect(commandOf({ original: 'a' })).toContain('"command":"a"');
    const out = extractOf(chat([request(1, 'x', [tool('c1', 'copilot_readFile', { resultError: 'boom', completedAt: MS(9) })])]));
    expect(out.errorLines[0]?.ts).toBe(iso(9));
  });

  it("reads a user's refusal as the harness's own wording, so it stores user-rejected, and a hook's or a risk assessment's as a permission denial", () => {
    // The Skip button of a tool confirmation writes `{type:5, source:'user'}` (the decline path), a risk assessment's denial `{type:5, source:'riskAssessment'}`; an explicit
    // cancel (the extensions-install prompt) writes `{type:0, source:'user'}`; a skip after approval (chatToolInvocation.ts:516) names no source.
    const out = extractOf(
      chat([
        request(1, 'x', [
          tool('c1', 'run_in_terminal', { isConfirmed: { type: 5, source: 'user' } }),
          tool('c2', 'run_in_terminal', { isConfirmed: { type: 0, source: 'user' } }),
          tool('c3', 'run_in_terminal', { isConfirmed: false }),
          tool('c4', 'run_in_terminal', { isConfirmed: { type: 5, source: 'hook' } }),
          tool('c5', 'run_in_terminal', { isConfirmed: { type: 5, source: 'riskAssessment' } }),
          tool('c6', 'run_in_terminal', { isConfirmed: { type: 0, source: 'hook' } }),
          tool('c7', 'run_in_terminal', { isConfirmed: { type: 0 } }),
          tool('c8', 'run_in_terminal', { isConfirmed: { type: 5 } }),
        ]),
      ]),
    );
    expect(out.tools.map((entry) => entry.status)).toEqual(['error', 'error', 'error', 'error', 'error', 'error', 'error', 'none']);
    expect(out.tools.map((entry) => entry.errorCode)).toEqual(['user-rejected', 'user-rejected', 'user-rejected', 'permission-denied', 'permission-denied', 'permission-denied', 'other', undefined]);
  });

  it('redacts a secret and an email, and cuts a 1,500-character error at 1,000 characters, on a tool error and on a shell error', () => {
    const long = `fail: sk-abcdefghijklmnopqrstuvwxyz0123 for alice@example.com ${'x'.repeat(1500)}`;
    for (const call of [shell('c1', 'make', { exitCode: 1 }, long), tool('c1', 'copilot_readFile', { resultError: long })]) {
      const error = extractOf(chat([request(1, 'go', [call])])).errorLines[0];
      expect(error?.line.length).toBeLessThanOrEqual(1000);
      expect(error?.line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
      expect(error?.line).not.toContain('alice@example.com');
    }
  });

  it('writes no usage for a session with none, and only the output for one with a whole-turn count and no model totals', () => {
    const none = extractOf(chat([request(1, 'a', [md('hello')])]));
    expect(none.session.usage).toMatchObject({ input: 0, output: 0 });
    const only = extractOf(chat([request(1, 'a', [md('hello')], { completionTokens: 12, promptTokens: 5000 })]));
    expect(only.session.usage).toMatchObject({ input: 0, output: 12 });
  });

  it('gives each prompt its own time, carries a missing or relative one forward, and never makes one up', () => {
    const lines = chatLines(chat([request(1, 'a', [md('x')]), request(2, 'b', [md('y')], { timestamp: undefined, responseTimestamp: undefined }), request(3, 'c', [md('z')], { timestamp: 5000 })]), 's', null);
    expect(lines.filter((line) => line.type === 'user').map((line) => line.timestamp)).toEqual([iso(1), iso(2), iso(2)]);
    expect(chatLines(chat([request(1, 'a', [md('x')], { timestamp: undefined, responseTimestamp: undefined })], { creationDate: undefined }), 's', null)[0]?.timestamp).toBe(new Date(0).toISOString());
  });

  it('does not read a hidden prompt, keeps its response, and skips a subagent call but keeps the parent that spawned it', () => {
    const out = extractOf(
      chat([
        request(1, 'real prompt', [md('ok')]),
        request(2, 'system injected', [md('reply'), tool('c1', 'runSubagent'), tool('c2', 'run_in_terminal', { subAgentInvocationId: 'c1', toolSpecificData: { kind: 'terminal', commandLine: { original: 'ls' } } })], { isSystemInitiated: true }),
        request(3, 'hidden', [md('quiet')], { hiddenFromTranscript: true }),
      ]),
    );
    expect(out.session.userTurns).toBe(1);
    expect(out.session.assistantTurns).toBe(3);
    expect(out.tools.map((entry) => entry.tool)).toEqual(['runSubagent']);
  });

  it('takes the working directory from the session over the workspace folder, and the old string format of a message and a response part', () => {
    const lines = chatLines({ version: 1, sessionId: 's1', creationDate: MS(0), workingDirectory: pathToFileURL(join(process.cwd(), 'elsewhere')).href, requests: [{ requestId: 'r', message: 'old prompt', response: ['old reply'], timestamp: MS(1) }] }, 's', '/workspace');
    expect(lines.map((line) => line.cwd)).toEqual([join(process.cwd(), 'elsewhere'), join(process.cwd(), 'elsewhere')]);
    expect(lines[0]).toMatchObject({ message: { content: [{ text: 'old prompt' }] } });
    expect(lines[1]).toMatchObject({ message: { content: [{ text: 'old reply' }] } });
  });

  it('never lets a log entry write through __proto__, constructor, or prototype, so file content cannot pollute Object.prototype', () => {
    const log = [
      JSON.stringify({ kind: 0, v: { version: 3, sessionId: 's1', requests: [] } }),
      JSON.stringify({ kind: 1, k: ['__proto__', 'polluted'], v: 'yes' }),
      JSON.stringify({ kind: 1, k: ['constructor', 'prototype', 'polluted'], v: 'yes' }),
      JSON.stringify({ kind: 2, k: ['__proto__', 'polluted'], v: ['yes'] }),
      JSON.stringify({ kind: 1, k: ['requests', '__proto__', 'polluted'], v: 'yes' }),
      JSON.stringify({ kind: 1, k: ['prototype'], v: 'yes' }),
      JSON.stringify({ kind: 1, k: ['kept'], v: 'ok' }),
    ].join('\n');
    const data = chatData(log, true);
    expect('polluted' in {}).toBe(false);
    expect('polluted' in []).toBe(false);
    expect(Object.hasOwn(data, 'prototype')).toBe(false);
    expect(data.kept).toBe('ok');
  });

  it('reads the log form by replaying set, push (cut to its index), and delete entries, and counts a torn line', () => {
    const log = [
      JSON.stringify({ kind: 0, v: { version: 3, sessionId: 's1', creationDate: MS(0), requests: [] } }),
      JSON.stringify({ kind: 2, k: ['requests'], v: [request(1, 'first', [])] }),
      JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [md('one '), md('two')] }),
      '{torn',
      JSON.stringify({ kind: 1, k: ['requests', 0, 'modelId'], v: 'copilot/gpt-5' }),
      JSON.stringify({ kind: 2, k: ['requests'], i: 0, v: [request(5, 'rewritten', [md('r')])] }),
      JSON.stringify({ kind: 3, k: ['requests', 0, 'modelId'] }),
      JSON.stringify({ kind: 1, k: ['nowhere', 'deep'], v: 1 }),
    ].join('\n');
    const data = chatData(log, true);
    expect(data.requests).toMatchObject([{ message: { text: 'rewritten' }, response: [{ value: 'r' }] }]);
    expect(JSON.stringify(data.requests)).not.toContain('modelId');
    expect(chatBadLines(log)).toEqual(['{torn']);
    expect(chatData('', true)).toEqual({});
    expect(() => chatData('{torn\nnot json\n', true)).toThrow(/no parseable/);
    expect(() => chatData('[]', false)).toThrow(/no parseable/);
    expect(() => chatData(JSON.stringify({ kind: 0, v: [] }), true)).toThrow(/no parseable/);
  });
});

describe('the VS Code Copilot Chat store', () => {
  const data = (text: string) => chat([request(1, text, [md('hi')])]);

  it('finds each build, each workspace folder, and an empty window, with the folder from workspace.json and a code-workspace file, and the newest copy of a moved session', async () => {
    const s = stage();
    const folder = join(s.root, 'proj-a');
    const codeWorkspace = join(s.root, 'multi', 'x.code-workspace');
    const appData = stageVscode(s.root, [
      { id: 'a1', data: data('a'), hash: 'h1', workspace: { folder: pathToFileURL(folder).href } },
      { id: 'b1', log: [{ kind: 0, v: data('b') }], channel: 'Code - Insiders', hash: 'h2', workspace: { workspace: pathToFileURL(codeWorkspace).href } },
      { id: 'c1', data: data('c') },
      { id: 'r1', data: data('remote'), channel: 'Code - OSS', hash: 'h3', workspace: { folder: 'vscode-remote://ssh-remote%2Bbox/home/me/x' } },
      { id: 'm1', data: data('old copy'), hash: 'h1' },
    ]);
    // The same session id in a second workspace, written later, is the one read.
    const second = join(appData, 'Code', 'User', 'workspaceStorage', 'h4', 'chatSessions');
    mkdirSync(second, { recursive: true });
    writeFileSync(join(appData, 'Code', 'User', 'workspaceStorage', 'h4', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(join(s.root, 'proj-b')).href }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(second, 'm1.json'), JSON.stringify(data('new copy')));
    const store = await openVscodeCopilotStore(appData);
    expect(store?.sessions.map((session) => [session.id, session.folder]).sort()).toEqual([
      ['a1', folder],
      ['b1', join(s.root, 'multi')],
      ['c1', null],
      ['m1', join(s.root, 'proj-b')],
      ['r1', null],
    ]);
    const moved = store?.sessions.find((session) => session.id === 'm1');
    expect(moved && (await store?.transcript(moved))).toContain('new copy');
    expect(store?.unreadable).toEqual([]);
  });

  it('reads the log form first and the json form only when the log is unreadable, and both forms give the same transcript', async () => {
    const s = stage();
    const appData = stageVscode(s.root, [
      { id: 'both', data: data('from json'), log: [{ kind: 0, v: data('from log') }] },
      { id: 'fallback', data: data('from json'), log: '{torn\nnot json\n' },
      // An empty log is a read failure to VS Code ("Empty log file", objectMutationLog.ts:393), so the `.json` beside it is tried.
      { id: 'empty-log', data: data('from json'), log: '' },
      { id: 'same-json', data: data('same') },
      { id: 'same-log', log: [{ kind: 0, v: data('same') }] },
    ]);
    const store = await openVscodeCopilotStore(appData);
    const text = async (id: string): Promise<string> => {
      const found = store?.sessions.find((session) => session.id === id);
      return found === undefined ? '' : (await store?.transcript(found)) ?? '';
    };
    expect(await text('both')).toContain('from log');
    expect(await text('empty-log')).toContain('from json');
    expect(await text('fallback')).toContain('from json');
    expect((await text('same-json')).replaceAll('same-json', 'x')).toBe((await text('same-log')).replaceAll('same-log', 'x'));
  });

  it('is undefined when no build has a User folder, skips a User folder that is a file without naming it, rejects an unsafe id, and throws for a wholly torn session', async () => {
    const s = stage();
    expect(await openVscodeCopilotStore(join(s.root, 'nowhere'))).toBeUndefined();
    const appData = stageVscode(s.root, [{ id: 'torn', data: '{torn' }]);
    const dir = join(appData, 'Code', 'User', 'globalStorage', 'emptyWindowChatSessions');
    writeFileSync(join(dir, 'bad id.json'), '{}');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    mkdirSync(join(appData, 'Code - Insiders', 'User', 'workspaceStorage', 'h', 'chatSessions', 'folder.json'), { recursive: true });
    writeFileSync(join(appData, 'Code - Insiders', 'User', 'workspaceStorage', 'h', 'workspace.json'), '{torn');
    const store = await openVscodeCopilotStore(appData);
    expect(store?.rejected).toBe(1);
    const torn = store?.sessions.find((session) => session.id === 'torn');
    await expect(torn && store?.transcript(torn)).rejects.toThrow(/no parseable/);
    // A User folder that is a file is ENOTDIR, which is the same as absent: skipped, never fatal, and nothing is named.
    const odd = join(s.root, 'odd');
    mkdirSync(join(odd, 'Code'), { recursive: true });
    writeFileSync(join(odd, 'Code', 'User'), 'x');
    const blocked = await openVscodeCopilotStore(odd);
    expect(blocked?.sessions).toEqual([]);
    expect(blocked?.unreadable).toEqual([]);
  });
});

describe('where VS Code keeps its data', () => {
  it('is the roaming app data on Windows, Application Support on macOS, and the config home on Linux, and VSCODE_APPDATA replaces it', () => {
    expect(vscodeAppData('win32', { APPDATA: 'C:\\Roaming' }, 'H')).toBe('C:\\Roaming');
    expect(vscodeAppData('win32', {}, 'H')).toBe(join('H', 'AppData', 'Roaming'));
    expect(vscodeAppData('darwin', {}, 'H')).toBe(join('H', 'Library', 'Application Support'));
    expect(vscodeAppData('linux', { XDG_CONFIG_HOME: '/cfg' }, 'H')).toBe('/cfg');
    expect(vscodeAppData('linux', {}, 'H')).toBe(join('H', '.config'));
    expect(vscodeAppData('linux', { VSCODE_APPDATA: '/data', XDG_CONFIG_HOME: '/cfg' }, 'H')).toBe('/data');
    expect(vscodeAppData('linux', { VSCODE_APPDATA: '' }, 'H')).toBe(join('H', '.config'));
  });
});
