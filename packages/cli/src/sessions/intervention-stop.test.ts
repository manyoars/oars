// The `user-stop` bucket through each harness's own adapter (t912, Item 2): a prompt the human stopped, written in each harness's native transcript form, captured, and derived. A harness reads a stop as
// far as its adapter writes the rejection sentence or the interrupt marker; the ones that write neither keep their current bucket, and this file pins which is which (docs/sessions-store.md, "`user-stop` by harness").
// The shapes follow the ones intervention-harness.test.ts, codex.test.ts, cursor.test.ts, and vscode-copilot.test.ts cite; no live store was read.
import { afterEach, describe, expect, it } from 'vitest';
import { rolloutLines } from './codex.js';
import { openCursorStore } from './cursor.js';
import { eventLines } from './copilot.js';
import { deriveSession } from './derive.js';
import { captureSession } from './extract.js';
import { chatLines } from './gemini.js';
import { grokLines } from './grok.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import type { Harness, PromptIntervention } from './schema.js';
import { chatData, chatLines as vscodeChatLines } from './vscode-copilot.js';
import { cleanup, copilotEvent, geminiHead, grokUpdate, rolloutLine, stage, stageCursor, type FixtureBubble } from './test-support.js';

afterEach(cleanup);

/** How the human stopped the agent. */
type Stop = 'rejected' | 'interrupt';
/** What the stopped prompt did first: nothing, or a shell call that failed (so a stop and an error meet in one prompt). */
type Before = 'edit' | 'failed-run';

const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const asText = (lines: readonly unknown[]): string => lines.map((entry) => JSON.stringify(entry)).join('\n');
const REJECTION = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
const MARKER = '[Request interrupted by user]';

/** Claude Code: a rejected call is an `is_error` result with the sentence; an interrupt is a user line that starts with the marker. */
const claudeCode = (stop: Stop, before: Before): string => {
  const lines: object[] = [{ type: 'user', timestamp: T(1), message: { role: 'user', content: 'change the field' } }];
  let at = 1;
  const call = (id: string, name: string, input: object): void => {
    lines.push({ type: 'assistant', timestamp: T((at += 1)), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  };
  const result = (id: string, error: boolean, content: string): void => {
    lines.push({ type: 'user', timestamp: T((at += 1)), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content }] } });
  };
  if (before === 'failed-run') {
    call('t0', 'Bash', { command: 'npm test' });
    result('t0', true, 'Exit code 1\nfailed');
  }
  call('t1', 'Edit', { file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' });
  if (stop === 'rejected') result('t1', true, REJECTION);
  else lines.push({ type: 'user', timestamp: T((at += 1)), message: { role: 'user', content: [{ type: 'text', text: MARKER }] } });
  lines.push({ type: 'user', timestamp: T((at += 1)), message: { role: 'user', content: 'go on' } });
  return asText(lines);
};

/** Codex: an interrupt is a `turn_aborted` with reason `interrupted`, which the reader writes as the interrupt marker prompt (and counts as a trust event); a declined call carries `exec command rejected by user`, a decline in the harness's fixed text. */
const codexWith = (stop: Stop, before: Before): string => {
  const lines: object[] = [
    rolloutLine(T(0), 'session_meta', { id: 'sess-1', session_id: 'sess-1', timestamp: T(0), cwd: '/work/app', originator: 'codex_cli_rs', cli_version: '0.50.0' }),
    rolloutLine(T(1), 'turn_context', { model: 'gpt-5-codex', cwd: '/work/app' }),
    rolloutLine(T(2), 'event_msg', { type: 'user_message', message: 'change the field' }),
  ];
  if (before === 'failed-run') {
    lines.push(rolloutLine(T(3), 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['npm', 'test'] }), call_id: 'c0' }));
    lines.push(rolloutLine(T(4), 'response_item', { type: 'function_call_output', call_id: 'c0', output: 'Exit code: 1\nWall time: 0.1 seconds\nOutput:\nout' }));
  }
  lines.push(rolloutLine(T(5), 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['rm', 'x'] }), call_id: 'c1' }));
  if (stop === 'rejected') lines.push(rolloutLine(T(6), 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'exec command rejected by user' }));
  else lines.push(rolloutLine(T(6), 'event_msg', { type: 'turn_aborted', reason: 'interrupted' }));
  lines.push(rolloutLine(T(7), 'event_msg', { type: 'user_message', message: 'go on' }));
  return rolloutLines(asText(lines), 'sess').map((entry) => JSON.stringify(entry)).join('\n');
};

/** Copilot CLI writes no event for a refusal or an abort that this reader takes (`session.error` and `abort` are not read), so both stops are the same transcript as a call that ended. */
const copilot = (_stop: Stop, before: Before): string => {
  const lines: object[] = [copilotEvent(T(0), 'session.start', { sessionId: 'sess-1', copilotVersion: '1.0.105', producer: 'copilot-agent', selectedModel: 'claude-sonnet-4.5', startTime: T(0), version: 1, context: { cwd: '/work/app' } })];
  lines.push(copilotEvent(T(1), 'user.message', { content: 'change the field' }));
  if (before === 'failed-run') {
    lines.push(copilotEvent(T(2), 'assistant.message', { messageId: 'm0', content: '', model: 'claude-sonnet-4.5', toolRequests: [{ toolCallId: 'c0', name: 'bash', arguments: { command: 'npm test' } }] }));
    lines.push(copilotEvent(T(3), 'tool.execution_start', { toolCallId: 'c0', toolName: 'bash', arguments: { command: 'npm test' }, shellToolInfo: { hasWriteFileRedirection: false, possiblePaths: [] } }));
    lines.push(copilotEvent(T(4), 'tool.execution_complete', { toolCallId: 'c0', success: false, shellExecution: { exitCode: 1 }, result: { content: 'out' }, error: { message: 'exit 1' } }));
  }
  lines.push(copilotEvent(T(5), 'abort', { reason: 'user initiated' }));
  lines.push(copilotEvent(T(6), 'user.message', { content: 'go on' }));
  return eventLines(asText(lines), 'sess').map((entry) => JSON.stringify(entry)).join('\n');
};

/** Gemini CLI: a call the user cancelled is `cancelled` with `[Operation Cancelled] User cancelled tool execution.`, a decline in the harness's fixed text; an interrupted reply is a placeholder the reader drops and no rule reads (a failed stream writes it too). */
const gemini = (stop: Stop, before: Before): string => {
  const records: object[] = [geminiHead('sess-1'), { id: 'u1', timestamp: T(1), type: 'user', content: [{ text: 'change the field' }] }];
  const shell = (id: string, status: string, response: object): object => ({ id, name: 'run_shell_command', args: { command: id === 'a' ? 'npm test' : 'rm x' }, status, timestamp: T(3), result: [{ functionResponse: { id, name: 'run_shell_command', response } }] });
  const toolCalls: object[] = [];
  if (before === 'failed-run') toolCalls.push(shell('a', 'success', { output: '<untrusted_context source="shell">\nOutput: out\nExit Code: 1\n</untrusted_context>' }));
  if (stop === 'rejected') toolCalls.push(shell('b', 'cancelled', { error: '[Operation Cancelled] User cancelled tool execution.' }));
  if (toolCalls.length > 0) records.push({ id: 'g1', timestamp: T(2), type: 'gemini', content: '', model: 'gemini-2.5-pro', toolCalls });
  if (stop === 'interrupt') records.push({ id: 'g2', timestamp: T(4), type: 'gemini', content: '[The previous response was interrupted before it completed.]' });
  records.push({ id: 'u2', timestamp: T(5), type: 'user', content: [{ text: 'go on' }] });
  return chatLines(asText(records), 'sess', '/work/app').map((entry) => JSON.stringify(entry)).join('\n');
};

/** Grok Build: no event names a stop, so both look like a call that ended (an edit stands between the two prompts, as it does in intervention-harness.test.ts, so they stay two). */
const grok = (_stop: Stop, before: Before): string => {
  const base = Date.parse('2026-06-01T10:00:00Z') / 1000;
  const events: object[] = [grokUpdate(base + 1, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'change the field' } })];
  events.push(grokUpdate(base + 4, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'search_replace', kind: 'other', status: 'pending', rawInput: { file_path: '/work/app/src/a.ts', old_string: 'a', new_string: 'b' } }));
  events.push(grokUpdate(base + 4.5, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'edited' } }] }));
  if (before === 'failed-run') {
    events.push(grokUpdate(base + 2, { sessionUpdate: 'tool_call', toolCallId: 'c0', title: 'bash', kind: 'execute', status: 'pending', rawInput: { command: 'npm test', description: 'Run the command' } }));
    events.push(
      grokUpdate(base + 3, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c0',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'out' } }],
        rawOutput: { type: 'Bash', exit_code: 1, command: 'npm test', output: [...Buffer.from('out')], output_for_prompt: 'exit: 1\nout', signal: null, timed_out: false, truncated: false, description: 'Run the command', output_file: '', total_bytes: 3, current_dir: '/work/app' },
      }),
    );
  }
  events.push(grokUpdate(base + 5, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'go on' } }));
  const summary = { info: { id: 'sess', cwd: '/work/app' }, created_at: new Date(base * 1000).toISOString(), current_model_id: 'grok-build' };
  return grokLines(asText(events), 'sess', summary, undefined).map((entry) => JSON.stringify(entry)).join('\n');
};

/** VS Code Copilot Chat: a refusal is `isConfirmed` `{type:0}` (Denied) or `{type:5, source:'user'}`, or `false`; the reader writes the harness's rejection sentence for it. The reader has no cancel record to read and writes no interrupt marker, so the "interrupt" case is a normal confirmed turn: it pins that the prompt keeps reading `none`. */
const vscode = (stop: Stop, before: Before): string => {
  const base = Date.parse('2026-06-01T10:00:00Z');
  const response: object[] = [];
  if (before === 'failed-run') response.push({ kind: 'toolInvocationSerialized', toolId: 'run_in_terminal', toolCallId: 'c0', isConfirmed: { type: 4 }, isComplete: true, toolSpecificData: { kind: 'terminal', commandLine: { original: 'npm test' }, terminalCommandOutput: { text: 'out' }, terminalCommandState: { exitCode: 1 } } });
  response.push({ kind: 'toolInvocationSerialized', toolId: 'replace_string_in_file', toolCallId: 'c1', isConfirmed: stop === 'rejected' ? { type: 5, source: 'user' } : { type: 4 }, isComplete: true });
  response.push({ kind: 'textEditGroup', uri: { scheme: 'file', path: '/work/app/src/a.ts' }, edits: [], done: true });
  const requests = [
    { requestId: 'request_1', message: { text: 'change the field', parts: [] }, variableData: { variables: [] }, response, timestamp: base + 1000, responseTimestamp: base + 2000, modelId: 'copilot/claude-sonnet-4.5' },
    { requestId: 'request_2', message: { text: 'go on', parts: [] }, variableData: { variables: [] }, response: [], timestamp: base + 5000, responseTimestamp: base + 6000, modelId: 'copilot/claude-sonnet-4.5' },
  ];
  const data = chatData(JSON.stringify({ version: 3, sessionId: 'sess-1', creationDate: base, requests }), false);
  return vscodeChatLines(data, 'sess', '/work/app').map((entry) => JSON.stringify(entry)).join('\n');
};

/** Cursor: a rejected call is `toolFormerData.userDecision` `rejected`; an aborted terminal call has no outcome and no marker, so it is not a stop here. */
const cursor = async (stop: Stop, before: Before): Promise<string> => {
  const at = (second: number): string => T(second);
  const bubbles: FixtureBubble[] = [{ type: 1, text: 'change the field', createdAt: at(1) }];
  if (before === 'failed-run') bubbles.push({ type: 2, tool: { name: 'run_terminal_cmd', params: { command: 'npm test' }, status: 'completed', result: { exitCodeV2: 1, output: 'out' } }, createdAt: at(2) });
  // An interrupt is the terminal call the user stopped: `endedReason` ends `_ABORTED`, which the adapter records as no outcome (cursor.test.ts), so the prompt keeps reading `none`.
  if (stop === 'rejected') bubbles.push({ type: 2, tool: { name: 'edit_file', params: { relativeWorkspacePath: 'src/a.ts', contents: 'x' }, status: 'error', decision: 'rejected' }, createdAt: at(3) });
  else bubbles.push({ type: 2, tool: { name: 'run_terminal_cmd', params: { command: 'make' }, status: 'completed', result: { exitCodeV2: 0, output: '', endedReason: 'RUN_TERMINAL_COMMAND_ENDED_REASON_EXECUTION_ABORTED' } }, createdAt: at(3) });
  bubbles.push({ type: 1, text: 'go on', createdAt: at(5) });
  const staged = stage();
  const store = await openCursorStore(await stageCursor(staged.root, [{ id: 'chat', createdAt: Date.parse('2026-06-01T10:00:00Z'), lastUpdatedAt: Date.parse('2026-06-01T10:30:00Z'), bubbles }]));
  const session = store?.sessions[0];
  if (store === undefined) throw new Error('the fixture store did not open');
  if (session === undefined) {
    store.close();
    throw new Error('the fixture store held no session');
  }
  try {
    return store.transcript(session);
  } finally {
    store.close();
  }
};

type Build = (stop: Stop, before: Before) => string | Promise<string>;

const interventions = async (harness: Harness, build: Build, stop: Stop, before: Before): Promise<(PromptIntervention | undefined)[]> => {
  const text = await build(stop, before);
  const capture = captureSession({
    text,
    ...(harness === 'claude-code' ? {} : { harness }),
    session: `${harness}-x`,
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
  const prompts = deriveSession(capture, makeRedactor()).prompts;
  return prompts.filter((prompt) => !prompt.head.startsWith('[Request interrupted by user')).map((prompt) => prompt.intervention);
};

// Where the harness writes the stop (the rejection sentence, the interrupt marker, or Codex's and Gemini's fixed decline text), the stopped prompt reads `user-stop`; where it writes no stop, it keeps the bucket it had. The last prompt ('go on') is `unknown` on every harness.
const READS: readonly (readonly [Harness, Build, PromptIntervention, PromptIntervention])[] = [
  // [harness, builder, bucket after a rejection, bucket after an interrupt]
  ['claude-code', claudeCode, 'user-stop', 'user-stop'],
  ['cursor', cursor, 'user-stop', 'none'],
  ['vscode-copilot', vscode, 'user-stop', 'none'],
  ['codex', codexWith, 'user-stop', 'user-stop'],
  ['copilot', copilot, 'none', 'none'],
  ['gemini', gemini, 'user-stop', 'none'],
  ['grok', grok, 'none', 'none'],
];

describe.each(READS)('%s', (harness, build, rejected, interrupted) => {
  it(`reads a rejected call as ${rejected}`, async () => {
    expect(await interventions(harness, build, 'rejected', 'edit')).toEqual([rejected, 'unknown']);
  });

  it(`reads an interrupt as ${interrupted}`, async () => {
    expect(await interventions(harness, build, 'interrupt', 'edit')).toEqual([interrupted, 'unknown']);
  });
});

describe('a stop and an error in one prompt', () => {
  it('reads user-stop, not after-error: the stop is the first case and wins over the failed call before it and the rejected call itself', async () => {
    expect(await interventions('claude-code', claudeCode, 'rejected', 'failed-run')).toEqual(['user-stop', 'unknown']);
    expect(await interventions('claude-code', claudeCode, 'interrupt', 'failed-run')).toEqual(['user-stop', 'unknown']);
  });

  it('keeps after-error where no stop is recorded: the same failed call without the stop', async () => {
    expect(await interventions('copilot', copilot, 'interrupt', 'failed-run')).toEqual(['after-error', 'unknown']);
  });
});

describe('a Codex or Gemini decline is read by its fixed text and nothing else', () => {
  const codexOutput = (output: string): string => {
    const lines: object[] = [
      rolloutLine(T(0), 'session_meta', { id: 'sess-1', session_id: 'sess-1', timestamp: T(0), cwd: '/work/app', originator: 'codex_cli_rs', cli_version: '0.50.0' }),
      rolloutLine(T(1), 'turn_context', { model: 'gpt-5-codex', cwd: '/work/app' }),
      rolloutLine(T(2), 'event_msg', { type: 'user_message', message: 'change the field' }),
      rolloutLine(T(3), 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['rm', 'x'] }), call_id: 'c1' }),
      rolloutLine(T(4), 'response_item', { type: 'function_call_output', call_id: 'c1', output }),
      rolloutLine(T(5), 'event_msg', { type: 'user_message', message: 'go on' }),
    ];
    return rolloutLines(asText(lines), 'sess').map((entry) => JSON.stringify(entry)).join('\n');
  };

  it('reads a Codex patch decline: user-stop, with `stopped` left null for the books', async () => {
    const lines = [
      rolloutLine(T(0), 'session_meta', { id: 'sess-1', session_id: 'sess-1', timestamp: T(0), cwd: '/work/app', originator: 'codex_cli_rs', cli_version: '0.50.0' }),
      rolloutLine(T(1), 'turn_context', { model: 'gpt-5-codex', cwd: '/work/app' }),
      rolloutLine(T(2), 'event_msg', { type: 'user_message', message: 'change the field' }),
      rolloutLine(T(3), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch', call_id: 'p1' }),
      rolloutLine(T(4), 'event_msg', { type: 'patch_apply_end', call_id: 'p1', success: false, stderr: 'patch rejected by user', status: 'declined' }),
      rolloutLine(T(5), 'event_msg', { type: 'user_message', message: 'go on' }),
    ];
    const text = rolloutLines(asText(lines), 'sess').map((entry) => JSON.stringify(entry)).join('\n');
    expect(await interventions('codex', () => text, 'rejected', 'edit')).toEqual(['user-stop', 'unknown']);
  });

  it('does not read Codex text that is not the decline: a policy rejection', async () => {
    expect(await interventions('codex', () => codexOutput('write_stdin rejected: policy'), 'rejected', 'edit')).not.toContain('user-stop');
  });

  it('reads a decline in the last prompt as unknown: the last-prompt rule stays first', async () => {
    const lines = rolloutLines(
      asText([
        rolloutLine(T(0), 'session_meta', { id: 'sess-1', session_id: 'sess-1', timestamp: T(0), cwd: '/work/app', originator: 'codex_cli_rs', cli_version: '0.50.0' }),
        rolloutLine(T(1), 'turn_context', { model: 'gpt-5-codex', cwd: '/work/app' }),
        rolloutLine(T(2), 'event_msg', { type: 'user_message', message: 'change the field' }),
        rolloutLine(T(3), 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['rm', 'x'] }), call_id: 'c1' }),
        rolloutLine(T(4), 'response_item', { type: 'function_call_output', call_id: 'c1', output: 'exec command rejected by user' }),
      ]),
      'sess',
    )
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    expect(await interventions('codex', () => lines, 'rejected', 'edit')).toEqual(['unknown']);
  });

  it('does not read a Codex turn_aborted whose reason is the harness own', async () => {
    const lines = [
      rolloutLine(T(0), 'session_meta', { id: 'sess-1', session_id: 'sess-1', timestamp: T(0), cwd: '/work/app', originator: 'codex_cli_rs', cli_version: '0.50.0' }),
      rolloutLine(T(1), 'turn_context', { model: 'gpt-5-codex', cwd: '/work/app' }),
      rolloutLine(T(2), 'event_msg', { type: 'user_message', message: 'change the field' }),
      rolloutLine(T(3), 'event_msg', { type: 'turn_aborted', reason: 'replaced' }),
      rolloutLine(T(4), 'event_msg', { type: 'user_message', message: 'go on' }),
    ];
    const text = rolloutLines(asText(lines), 'sess').map((entry) => JSON.stringify(entry)).join('\n');
    expect(await interventions('codex', () => text, 'interrupt', 'edit')).toEqual(['none', 'unknown']);
  });
});
