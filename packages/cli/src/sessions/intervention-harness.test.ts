// `intervention` through each harness's own adapter (t882, Item 2): the same scenarios, written in each harness's native transcript form, captured, and derived. The rule reads only the normalized
// records, so a harness supports a bucket as far as its adapter fills `Edit`, `Bash`, `status`, `target`, and `segments`; this file is that proof, harness by harness. The shapes follow the ones
// codex.test.ts, copilot.test.ts, gemini.test.ts, and grok.test.ts cite; no live store was read.
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

/** One thing the agent did in a turn: edited a file, or ran a command that exited with `exit`. */
type Act = { edit: string } | { run: string; exit: number };
interface Turn {
  text: string;
  acts: Act[];
}

const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const asText = (lines: readonly unknown[]): string => lines.map((entry) => JSON.stringify(entry)).join('\n');
let tick = 0;
/** A fresh second for every record, so no two lines of a fixture share a timestamp. */
const next = (): number => (tick += 1);
const reset = (): void => {
  tick = 1;
};
const isEdit = (act: Act): act is { edit: string } => 'edit' in act;

const claudeCode = (turns: readonly Turn[]): string => {
  const lines: object[] = [];
  let id = 0;
  for (const turn of turns) {
    lines.push({ type: 'user', timestamp: T(next()), message: { role: 'user', content: turn.text } });
    for (const act of turn.acts) {
      id += 1;
      const input = isEdit(act) ? { file_path: `/work/app/${act.edit}`, old_string: 'a', new_string: 'b' } : { command: act.run };
      lines.push({ type: 'assistant', timestamp: T(next()), message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${String(id)}`, name: isEdit(act) ? 'Edit' : 'Bash', input }] } });
      const failed = !isEdit(act) && act.exit !== 0;
      const exit = isEdit(act) ? 0 : act.exit;
      lines.push({ type: 'user', timestamp: T(next()), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${String(id)}`, is_error: failed, content: failed ? `Exit code ${String(exit)}\nfailed` : 'ok' }] } });
    }
  }
  return asText(lines);
};

const codexWith = (wrapped: boolean) => (turns: readonly Turn[]): string => {
  const lines: object[] = [
    rolloutLine(T(0), 'session_meta', { id: 'sess-1', session_id: 'sess-1', timestamp: T(0), cwd: '/work/app', originator: 'codex_cli_rs', cli_version: '0.50.0' }),
    rolloutLine(T(1), 'turn_context', { model: 'gpt-5-codex', cwd: '/work/app' }),
  ];
  let id = 0;
  for (const turn of turns) {
    lines.push(rolloutLine(T(next()), 'event_msg', { type: 'user_message', message: turn.text }));
    for (const act of turn.acts) {
      id += 1;
      const call = `c${String(id)}`;
      if (isEdit(act)) {
        lines.push(rolloutLine(T(next()), 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: call, input: `*** Begin Patch\n*** Update File: ${act.edit}\n@@\n*** End Patch` }));
        lines.push(rolloutLine(T(next()), 'event_msg', { type: 'patch_apply_end', call_id: call, success: true, stdout: 'ok', stderr: '', changes: {} }));
      } else {
        // Codex writes a shell call as an argv. `wrapped` is the form the CLI sends (`bash -lc <command>`); the adapter quotes each word of an argv that needs it, so a wrapped command reads as the wrapper plus its quoted script.
        lines.push(rolloutLine(T(next()), 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: wrapped ? ['bash', '-lc', act.run] : act.run.split(' ') }), call_id: call }));
        lines.push(rolloutLine(T(next()), 'response_item', { type: 'function_call_output', call_id: call, output: `Exit code: ${String(act.exit)}\nWall time: 0.1 seconds\nOutput:\nout` }));
      }
    }
  }
  return rolloutLines(asText(lines), 'sess').map((entry) => JSON.stringify(entry)).join('\n');
};
const codex = codexWith(true);

const copilot = (turns: readonly Turn[]): string => {
  const lines: object[] = [copilotEvent(T(0), 'session.start', { sessionId: 'sess-1', copilotVersion: '1.0.105', producer: 'copilot-agent', selectedModel: 'claude-sonnet-4.5', startTime: T(0), version: 1, context: { cwd: '/work/app' } })];
  let id = 0;
  for (const turn of turns) {
    lines.push(copilotEvent(T(next()), 'user.message', { content: turn.text }));
    for (const act of turn.acts) {
      id += 1;
      const call = `c${String(id)}`;
      const request = isEdit(act) ? { toolCallId: call, name: 'edit', arguments: { path: act.edit } } : { toolCallId: call, name: 'bash', arguments: { command: act.run } };
      lines.push(copilotEvent(T(next()), 'assistant.message', { messageId: `m${String(id)}`, content: '', model: 'claude-sonnet-4.5', toolRequests: [request] }));
      lines.push(copilotEvent(T(next()), 'tool.execution_start', { toolCallId: call, toolName: isEdit(act) ? 'edit' : 'bash', ...(isEdit(act) ? {} : { arguments: { command: act.run }, shellToolInfo: { hasWriteFileRedirection: false, possiblePaths: [] } }) }));
      lines.push(
        copilotEvent(T(next()), 'tool.execution_complete', {
          toolCallId: call,
          success: isEdit(act) || act.exit === 0,
          ...(isEdit(act) ? { fileEdits: [{ kind: 'edit', path: act.edit }], result: { content: 'edited' } } : { shellExecution: { exitCode: act.exit }, result: { content: 'out' }, ...(act.exit === 0 ? {} : { error: { message: `exit ${String(act.exit)}` } }) }),
        }),
      );
    }
  }
  return eventLines(asText(lines), 'sess').map((entry) => JSON.stringify(entry)).join('\n');
};

const gemini = (turns: readonly Turn[]): string => {
  const records: object[] = [geminiHead('sess-1')];
  let id = 0;
  for (const turn of turns) {
    records.push({ id: `u${String(next())}`, timestamp: T(tick), type: 'user', content: [{ text: turn.text }] });
    const toolCalls = turn.acts.map((act) => {
      id += 1;
      const call = `c${String(id)}`;
      const second = next();
      if (isEdit(act)) return { id: call, name: 'replace', args: { file_path: act.edit, old_string: 'a', new_string: 'b' }, status: 'success', timestamp: T(second), result: [{ functionResponse: { id: call, name: 'replace', response: { output: 'Successfully modified file' } } }] };
      const text = `<untrusted_context source="shell">\nOutput: out${act.exit === 0 ? '' : `\nExit Code: ${String(act.exit)}`}\n</untrusted_context>`;
      return { id: call, name: 'run_shell_command', args: { command: act.run }, status: 'success', timestamp: T(second), result: [{ functionResponse: { id: call, name: 'run_shell_command', response: { output: text } } }] };
    });
    if (toolCalls.length > 0) records.push({ id: `g${String(next())}`, timestamp: T(tick), type: 'gemini', content: '', model: 'gemini-2.5-pro', toolCalls });
  }
  return chatLines(asText(records), 'sess', '/work/app').map((entry) => JSON.stringify(entry)).join('\n');
};

const grok = (turns: readonly Turn[]): string => {
  const base = Date.parse('2026-06-01T10:00:00Z') / 1000;
  const S = (second: number): number => base + second;
  const events: object[] = [];
  let id = 0;
  for (const turn of turns) {
    events.push(grokUpdate(S(next()), { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: turn.text } }));
    for (const act of turn.acts) {
      id += 1;
      const call = `c${String(id)}`;
      if (isEdit(act)) {
        events.push(grokUpdate(S(next()), { sessionUpdate: 'tool_call', toolCallId: call, title: 'search_replace', kind: 'other', status: 'pending', rawInput: { file_path: `/work/app/${act.edit}`, old_string: 'a', new_string: 'b' } }));
        events.push(grokUpdate(S(next()), { sessionUpdate: 'tool_call_update', toolCallId: call, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'edited' } }] }));
      } else {
        events.push(grokUpdate(S(next()), { sessionUpdate: 'tool_call', toolCallId: call, title: 'bash', kind: 'execute', status: 'pending', rawInput: { command: act.run, description: 'Run the command' } }));
        events.push(
          grokUpdate(S(next()), {
            sessionUpdate: 'tool_call_update',
            toolCallId: call,
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'out' } }],
            rawOutput: { type: 'Bash', exit_code: act.exit, command: act.run, output: [...Buffer.from('out')], output_for_prompt: `exit: ${String(act.exit)}\nout`, signal: null, timed_out: false, truncated: false, description: 'Run the command', output_file: '', total_bytes: 3, current_dir: '/work/app' },
          }),
        );
      }
    }
  }
  const summary = { info: { id: 'sess', cwd: '/work/app' }, created_at: new Date(base * 1000).toISOString(), current_model_id: 'grok-build' };
  return grokLines(asText(events), 'sess', summary, undefined).map((entry) => JSON.stringify(entry)).join('\n');
};

const vscode = (turns: readonly Turn[]): string => {
  const base = Date.parse('2026-06-01T10:00:00Z');
  const APPROVED = { type: 4 };
  let id = 0;
  const requests = turns.map((turn) => {
    const second = next();
    const response = turn.acts.flatMap((act): object[] => {
      id += 1;
      const call = `c${String(id)}`;
      if (isEdit(act)) return [{ kind: 'toolInvocationSerialized', toolId: 'replace_string_in_file', toolCallId: call, isConfirmed: APPROVED, isComplete: true }, { kind: 'textEditGroup', uri: { scheme: 'file', path: `/work/app/${act.edit}` }, edits: [], done: true }];
      return [{ kind: 'toolInvocationSerialized', toolId: 'run_in_terminal', toolCallId: call, isConfirmed: APPROVED, isComplete: true, toolSpecificData: { kind: 'terminal', commandLine: { original: act.run }, terminalCommandOutput: { text: 'out' }, terminalCommandState: { exitCode: act.exit } } }];
    });
    return { requestId: `request_${String(second)}`, message: { text: turn.text, parts: [] }, variableData: { variables: [] }, response, timestamp: base + second * 1000, responseTimestamp: base + (second + 1) * 1000, modelId: 'copilot/claude-sonnet-4.5' };
  });
  const data = chatData(JSON.stringify({ version: 3, sessionId: 'sess-1', creationDate: base, requests }), false);
  return vscodeChatLines(data, 'sess', '/work/app').map((entry) => JSON.stringify(entry)).join('\n');
};

/** A Cursor session lives in a sqlite store, so this stages one and reads its transcript back through the adapter. */
const cursor = async (turns: readonly Turn[]): Promise<string> => {
  const bubbles: FixtureBubble[] = [];
  for (const turn of turns) {
    bubbles.push({ type: 1, text: turn.text, createdAt: `2026-06-01T10:00:${String(next()).padStart(2, '0')}.000Z` });
    for (const act of turn.acts) {
      const createdAt = `2026-06-01T10:00:${String(next()).padStart(2, '0')}.000Z`;
      bubbles.push(
        isEdit(act)
          ? { type: 2, tool: { name: 'edit_file', params: { relativeWorkspacePath: act.edit, contents: 'x' }, status: 'completed' }, createdAt }
          : { type: 2, tool: { name: 'run_terminal_cmd', params: { command: act.run }, status: 'completed', result: { exitCodeV2: act.exit, output: 'out' } }, createdAt },
      );
    }
  }
  const staged = stage();
  const store = await openCursorStore(await stageCursor(staged.root, [{ id: 'chat', createdAt: Date.parse('2026-06-01T10:00:00Z'), lastUpdatedAt: Date.parse('2026-06-01T10:30:00Z'), bubbles }]));
  const session = store?.sessions[0];
  if (store === undefined) throw new Error('the fixture store did not open');
  if (session === undefined) {
    store.close();
    throw new Error('the fixture store held no session');
  }
  // The sqlite handle must close before the afterEach removes the folder: Windows will not delete a database file that is still open.
  try {
    return store.transcript(session);
  } finally {
    store.close();
  }
};

const BUILDERS: readonly (readonly [Harness, (turns: readonly Turn[]) => string | Promise<string>])[] = [
  ['claude-code', claudeCode],
  ['codex', codex],
  ['copilot', copilot],
  ['gemini', gemini],
  ['grok', grok],
  ['vscode-copilot', vscode],
  ['cursor', cursor],
];

const interventions = async (harness: Harness, build: (turns: readonly Turn[]) => string | Promise<string>, turns: readonly Turn[]): Promise<(PromptIntervention | undefined)[]> => {
  reset();
  const text = await build(turns);
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
  return deriveSession(capture, makeRedactor()).prompts.map((prompt) => prompt.intervention);
};

const SCENARIOS: readonly (readonly [string, Turn[], (PromptIntervention | undefined)[]])[] = [
  ['none: the next prompt touches other work', [{ text: 'add a field', acts: [{ edit: 'src/a.ts' }] }, { text: 'now the docs', acts: [{ edit: 'docs/b.md' }] }], ['none', 'unknown']],
  ['after-error: the last call failed', [{ text: 'run the build', acts: [{ run: 'npm test', exit: 1 }] }, { text: 'thanks', acts: [] }], ['after-error', 'unknown']],
  ['redo: the next prompt edits the same file', [{ text: 'add a field', acts: [{ edit: 'src/a.ts' }] }, { text: 'not that way', acts: [{ edit: 'src/a.ts' }] }], ['redo', 'unknown']],
  ['revert: the next prompt undoes the edit with git', [{ text: 'add a field', acts: [{ edit: 'src/a.ts' }] }, { text: 'put it back', acts: [{ run: 'git revert HEAD', exit: 0 }] }], ['revert', 'unknown']],
  ['revert: the next prompt asks for the undo', [{ text: 'add a field', acts: [{ edit: 'src/a.ts' }] }, { text: 'undo that', acts: [] }], ['revert', 'unknown']],
  ['unknown: the only prompt', [{ text: 'add a field', acts: [{ edit: 'src/a.ts' }] }], ['unknown']],
];

describe.each(BUILDERS)('%s', (harness, build) => {
  it.each(SCENARIOS)('%s', async (_name, turns, expected) => {
    expect(await interventions(harness, build, turns)).toEqual(expected);
  });
});

describe('codex, command sent wrapped in bash -lc', () => {
  const edit: Turn = { text: 'add a field', acts: [{ edit: 'src/a.ts' }] };

  it('still reads the git undo when its script holds a single quote', async () => {
    const turns: Turn[] = [edit, { text: 'put it back', acts: [{ run: `echo "it's"; git revert HEAD`, exit: 0 }] }];
    expect(await interventions('codex', codexWith(true), turns)).toEqual(['revert', 'unknown']);
  });

  it('reads a wrapped empty script as no undo and no crash', async () => {
    const turns: Turn[] = [edit, { text: 'put it back', acts: [{ run: '', exit: 0 }] }];
    expect(await interventions('codex', codexWith(true), turns)).toEqual(['none', 'unknown']);
  });
});

describe('codex, command sent as a plain argv', () => {
  it('sees the git undo once the command is not wrapped', async () => {
    const turns: Turn[] = [{ text: 'add a field', acts: [{ edit: 'src/a.ts' }] }, { text: 'put it back', acts: [{ run: 'git revert HEAD', exit: 0 }] }];
    expect(await interventions('codex', codexWith(false), turns)).toEqual(['revert', 'unknown']);
  });
});
