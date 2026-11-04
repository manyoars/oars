// The setup snapshot, tool funnel, and trust shape (t815). Every fixture is synthetic; the Claude Code line shapes are the ones t816's census of 2.1.312 to
// 2.1.318 names (deferred_tools_delta.addedNames and removedNames, api-request-shape.shape.tools[].name, tool_reference.tool_name, stop_hook_summary.hookInfos[],
// hook_success.command, nested_memory.content.content, permission-mode lines and the user line's permissionMode), the Codex ones are the payloads
// codex.test.ts already cites (openai/codex @ ac558e2: TurnAbortReason protocol.rs:4580, AskForApproval :1163, SessionMeta.dynamic_tools, ResponseItem::AdditionalTools
// and ToolSearchOutput, models.rs). No real session or store was read.
import { describe, expect, it } from 'vitest';
import { rolloutLines } from './codex.js';
import { eventLines } from './copilot.js';
import { chatLines } from './gemini.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { CAPTURE_VERSION } from './schema.js';
import { copilotEvent, geminiHead, rolloutLine } from './test-support.js';

const redact = makeRedactor();
const line = (value: object): string => JSON.stringify(value);
const at = (seconds: number): string => new Date(Date.UTC(2026, 5, 1, 0, 0, 0) + seconds * 1000).toISOString();
let counter = 0;
const base = (seconds: number) => ({ uuid: `u${String((counter += 1))}`, timestamp: at(seconds), version: '2.1.318', cwd: '/w' });

const typed = (seconds: number, text: string, extra: object = {}): string => line({ ...base(seconds), type: 'user', message: { role: 'user', content: text }, ...extra });
const said = (seconds: number, content: object[] = [{ type: 'text', text: 'ok' }]): string => line({ ...base(seconds), type: 'assistant', message: { role: 'assistant', model: 'm', content } });
const called = (seconds: number, id: string, name: string): string => said(seconds, [{ type: 'tool_use', id, name, input: {} }]);
const answered = (seconds: number, id: string, content: unknown, failed = false): string =>
  line({ ...base(seconds), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content }] } });
const attach = (seconds: number, attachment: object): string => line({ ...base(seconds), type: 'attachment', attachment });

const capture = (lines: readonly string[], options: { harness?: 'codex' | 'copilot' | 'cursor' | 'gemini'; subagent?: boolean } = {}) => {
  const text = lines.join('\n');
  return captureSession({
    text,
    session: 's',
    project: 'p',
    rev: 1,
    at: 'x',
    bytes: text.length,
    redact,
    salt: 'salt',
    sid: null,
    ...(options.harness === undefined ? {} : { harness: options.harness }),
    ...(options.subagent === true ? { subagent: { parent: 'main', agentType: 'Explore', spawnedBy: null, spawnedIn: null } } : {}),
  }).session;
};

describe('the setup snapshot', () => {
  const recorded = [
    line({ type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: 's' }),
    typed(1, 'go', { permissionMode: 'acceptEdits' }),
    typed(2, 'again', { permissionMode: 'weirdNewMode' }),
    line({ type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: 's' }),
    attach(3, { type: 'hook_success', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', command: 'node a.js', exitCode: 0, stdout: 'SECRET-OUT', stderr: '' }),
    attach(4, { type: 'hook_success', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', command: 'node a.js', exitCode: 0 }),
    attach(5, { type: 'hook_blocking_error', hookName: 'PreToolUse:Write', hookEvent: 'PreToolUse', blockingError: { blockingError: 'no', command: 'node b.js' } }),
    line({ ...base(6), type: 'system', subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [{ command: 'node c.js', durationMs: 5 }] }),
    attach(7, { type: 'nested_memory', path: '/w/CLAUDE.md', content: { path: '/w/CLAUDE.md', content: 'abcde' } }),
    attach(8, { type: 'nested_memory', path: '/w/CLAUDE.md', content: { path: '/w/CLAUDE.md', content: 'abcde' } }),
    attach(9, { type: 'nested_memory', path: '/w/sub/CLAUDE.md', content: { path: '/w/sub/CLAUDE.md', content: 'éé' } }),
    attach(10, { type: 'deferred_tools_delta', addedNames: ['mcp__plugin_demo-kit_search__find', 'mcp__plain__tool'], removedNames: [] }),
    called(11, 'c1', 'mcp__plugin_other_srv__run'),
  ];

  it('records the mode, plugins, hook count, and instruction bytes a Claude Code transcript holds', () => {
    const session = capture(recorded);
    expect(session.cv).toBe(CAPTURE_VERSION);
    expect(session.setup).toEqual({ permissionMode: 'acceptEdits', plugins: ['demo-kit', 'other'], hookCount: 3, instructionBytes: 5 + 4 });
  });

  it('reads the mode from permission-mode lines alone when no user line carries it', () => {
    expect(capture([line({ type: 'permission-mode', permissionMode: 'plan', sessionId: 's' }), typed(1, 'go')]).setup).toEqual({ permissionMode: 'plan' });
  });

  it('stores an unknown mode as other, and keeps no hook command or output', () => {
    const session = capture([typed(1, 'a', { permissionMode: 'weirdNewMode' })]);
    expect(session.setup).toEqual({ permissionMode: 'other' });
    expect(JSON.stringify(capture(recorded))).not.toMatch(/node a\.js|SECRET-OUT|abcde/);
  });

  it('stores nothing for a transcript that records none of it', () => {
    const session = capture([typed(1, 'hello'), said(2)]);
    expect(session.setup).toBeUndefined();
    expect(session.funnel).toBeUndefined();
  });

  it('reads the mode and tools a Codex rollout records, and leaves hooks, plugins, and instruction bytes absent', () => {
    const rollout = [
      rolloutLine(at(0), 'session_meta', { id: 'c1', cwd: '/w', cli_version: '0.50.0', dynamic_tools: [{ type: 'function', name: 'lookup' }, { type: 'namespace', name: 'ns', tools: [{ name: 'inner' }] }] }),
      rolloutLine(at(1), 'turn_context', { model: 'gpt', cwd: '/w', approval_policy: { granular: { sandbox_approval: true } } }),
      rolloutLine(at(2), 'event_msg', { type: 'user_message', message: 'go' }),
      rolloutLine(at(3), 'response_item', { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'extra' }] }),
      rolloutLine(at(4), 'response_item', { type: 'tool_search_output', call_id: 'x', status: 'completed', execution: 'client', tools: [{ type: 'function', name: 'lookup' }] }),
    ];
    const session = capture(rolloutLines(rollout.map((entry) => JSON.stringify(entry)).join('\n'), 'c1').map((entry) => JSON.stringify(entry)), { harness: 'codex' });
    expect(session.setup).toEqual({ permissionMode: 'granular' });
    expect(session.funnel).toEqual({ offered: ['extra', 'inner', 'lookup'], loaded: ['lookup'] });
  });

  it('stores a Codex rollout with no approval policy and no tools as absent', () => {
    const rollout = [rolloutLine(at(0), 'session_meta', { id: 'c1', cwd: '/w', cli_version: '0.50.0', dynamic_tools: null }), rolloutLine(at(1), 'event_msg', { type: 'user_message', message: 'go' })];
    const session = capture(rolloutLines(rollout.map((entry) => JSON.stringify(entry)).join('\n'), 'c1').map((entry) => JSON.stringify(entry)), { harness: 'codex' });
    expect(session.setup).toBeUndefined();
    expect(session.funnel).toBeUndefined();
  });

  it('stores nothing of the shape for a Cursor session, whose store holds none of it', () => {
    const session = capture([typed(1, 'go'), said(2), typed(3, '[Request interrupted by user]')], { harness: 'cursor' });
    expect(session.setup).toBeUndefined();
    expect(session.funnel).toBeUndefined();
    expect(session.trust).toBeUndefined();
  });
});

describe('the tool funnel', () => {
  const lines = [
    line({ ...base(0), type: 'api-request-shape', shapeHash: 'h', shape: { system: [{ type: 'text', text: 'SYSTEM-PROMPT-SENTINEL' }], tools: [{ name: 'Read', description: 'TOOL-DESCRIPTION-SENTINEL', input_schema: {} }, { name: 'Bash' }] } }),
    attach(1, { type: 'deferred_tools_delta', addedNames: ['mcp__x__a', 'mcp__x__b', 'WebFetch'], removedNames: [] }),
    typed(2, 'go'),
    called(3, 'r1', 'Read'),
    answered(4, 'r1', 'file text'),
    called(5, 's1', 'ToolSearch'),
    answered(6, 's1', [{ type: 'tool_reference', tool_name: 'mcp__x__a' }]),
    attach(7, { type: 'deferred_tools_delta', addedNames: [], removedNames: ['WebFetch'] }),
  ];

  it('records a tool offered and never called, one loaded by a search, and one removed mid-session', () => {
    const session = capture(lines);
    expect(session.funnel).toEqual({ offered: ['Bash', 'Read', 'mcp__x__a', 'mcp__x__b'], loaded: ['mcp__x__a'], removed: ['WebFetch'] });
    // `called` and `worked` stay the session's tool calls and their status: a tool offered and not called is only in `offered`.
    expect(Object.keys(session.tools).sort()).toEqual(['Read', 'ToolSearch']);
  });

  it('keeps a tool offered again after a removal on the offered side, and never the system prompt or a description', () => {
    const again = [...lines, attach(8, { type: 'deferred_tools_delta', addedNames: ['WebFetch'], removedNames: [] })];
    const session = capture(again);
    expect(session.funnel?.offered).toContain('WebFetch');
    expect(session.funnel?.removed).toBeUndefined();
    expect(JSON.stringify(session)).not.toMatch(/SENTINEL/);
  });
});

describe('the trust shape', () => {
  it('counts a rejection, a policy denial, a hook denial, and an interrupt, and not the interrupt marker that follows a rejection', () => {
    const session = capture([
      typed(0, 'go'),
      called(1, 'a', 'Bash'),
      answered(2, 'a', "The user doesn't want to proceed with this tool use. The tool use was rejected.", true),
      typed(3, '[Request interrupted by user for tool use]'),
      called(4, 'b', 'Bash'),
      answered(5, 'b', 'Permission to use Bash with command rm -rf x has been denied.', true),
      called(6, 'c', 'Write'),
      answered(7, 'c', 'PreToolUse:Write hook error: [node guard.js]: blocked', true),
      called(8, 'd', 'Bash'),
      answered(9, 'd', 'bash: /root/x: Permission denied', true),
      called(10, 'e', 'Edit'),
      typed(11, '[Request interrupted by user]'),
    ]);
    expect(session.trust).toMatchObject({ interrupts: 1, rejections: 1, denials: 2 });
    expect(session.trust?.trustEvent).toEqual([
      { event: 'rejection', tool: 'Bash', prompt: 0 },
      { event: 'denial', tool: 'Bash', prompt: 1 },
      { event: 'denial', tool: 'Write', prompt: 1 },
      { event: 'interrupt', tool: 'Edit', prompt: 1 },
    ]);
  });

  it('counts a replayed rejection and a replayed marker once', () => {
    const rejected = answered(2, 'a', "The user doesn't want to take this action right now.", true);
    const marker = typed(3, '[Request interrupted by user]');
    const session = capture([typed(0, 'go'), called(1, 'a', 'Bash'), rejected, rejected, said(4), marker, marker]);
    expect(session.trust).toMatchObject({ rejections: 1, interrupts: 1 });
  });

  it('stores zeros for a Claude Code session in which nothing was stopped', () => {
    expect(capture([typed(0, 'go'), said(1)]).trust).toMatchObject({ interrupts: 0, rejections: 0, denials: 0 });
  });

  it('reads an interrupt in a Codex rollout, not a turn the harness replaced, and leaves rejections and denials absent', () => {
    const rollout = [
      rolloutLine(at(0), 'session_meta', { id: 'c1', cwd: '/w', cli_version: '0.50.0' }),
      rolloutLine(at(1), 'event_msg', { type: 'user_message', message: 'go' }),
      rolloutLine(at(2), 'event_msg', { type: 'turn_aborted', turn_id: 't', reason: 'interrupted' }),
      rolloutLine(at(3), 'event_msg', { type: 'turn_aborted', turn_id: 't2', reason: 'replaced' }),
    ];
    const session = capture(rolloutLines(rollout.map((entry) => JSON.stringify(entry)).join('\n'), 'c1').map((entry) => JSON.stringify(entry)), { harness: 'codex' });
    expect(session.trust).toMatchObject({ interrupts: 1, trustEvent: [{ event: 'interrupt', tool: null, prompt: 0 }] });
    expect(session.trust).not.toHaveProperty('rejections');
    expect(session.trust).not.toHaveProperty('denials');
  });
});

describe('unattendedRun', () => {
  it('runs from each human turn to the agent last line before the next one, so a late reply is not an overnight run', () => {
    const session = capture([typed(0, 'start'), said(60), called(120, 't', 'Bash'), answered(150, 't', 'ok'), typed(36000, 'next morning'), said(36030)]);
    expect(session.trust?.unattendedRun).toEqual([2.5, 0.5]);
  });

  it('does not count an automated turn as a human turn', () => {
    const session = capture([
      typed(0, 'start'),
      said(60),
      typed(1800, '<task-notification>done</task-notification>'),
      said(1860),
      typed(36000, 'next morning'),
      said(36030),
    ]);
    expect(session.trust?.unattendedRun).toEqual([31, 0.5]);
  });

  it('counts a shell command the operator typed as a human turn, and the interrupt marker as neither', () => {
    const session = capture([typed(0, 'start'), said(60), typed(120, '<bash-input>ls</bash-input>'), said(180), typed(200, '[Request interrupted by user]')]);
    expect(session.trust?.unattendedRun).toEqual([1, 1]);
  });

  it('keeps a one-prompt run to its last line', () => {
    expect(capture([typed(0, 'overnight'), said(30000)]).trust?.unattendedRun).toEqual([500]);
  });

  it('has no run for a subagent transcript, which has no human turn of its own', () => {
    expect(capture([typed(0, 'task'), said(60)], { subagent: true }).trust?.unattendedRun).toBeUndefined();
  });

  it('reads a Codex rollout by its prompts', () => {
    const rollout = [
      rolloutLine(at(0), 'session_meta', { id: 'c1', cwd: '/w', cli_version: '0.50.0' }),
      rolloutLine(at(2), 'event_msg', { type: 'user_message', message: 'go' }),
      rolloutLine(at(10), 'event_msg', { type: 'agent_message', message: 'done' }),
      rolloutLine(at(100), 'event_msg', { type: 'user_message', message: 'more' }),
      rolloutLine(at(130), 'event_msg', { type: 'agent_message', message: 'done' }),
    ];
    const session = capture(rolloutLines(rollout.map((entry) => JSON.stringify(entry)).join('\n'), 'c1').map((entry) => JSON.stringify(entry)), { harness: 'codex' });
    expect(session.trust?.unattendedRun).toEqual([0.13, 0.5]);
  });

  it('counts a Codex prompt that starts with a tag as a human turn, so it ends the run before it', () => {
    const rollout = [
      rolloutLine(at(0), 'session_meta', { id: 'c1', cwd: '/w', cli_version: '0.50.0' }),
      rolloutLine(at(2), 'event_msg', { type: 'user_message', message: 'go' }),
      rolloutLine(at(10), 'event_msg', { type: 'agent_message', message: 'done' }),
      rolloutLine(at(36000), 'event_msg', { type: 'user_message', message: '<div> broken' }),
      rolloutLine(at(36030), 'event_msg', { type: 'agent_message', message: 'done' }),
    ];
    const session = capture(rolloutLines(rollout.map((entry) => JSON.stringify(entry)).join('\n'), 'c1').map((entry) => JSON.stringify(entry)), { harness: 'codex' });
    expect(session.trust?.unattendedRun).toEqual([0.13, 0.5]);
  });

  it('counts a compaction summary as the agent working, not a human turn', () => {
    const summary = typed(600, 'This session is being continued from a previous conversation', { isCompactSummary: true });
    const session = capture([typed(0, 'start'), said(60), summary, said(660), typed(36000, 'next morning'), said(36030)]);
    expect(session.trust?.unattendedRun).toEqual([11, 0.5]);
  });

  it('counts a replayed human line once: a resume replays the lines it resumed from', () => {
    const first = typed(0, 'a', { uuid: 'h1' });
    const second = typed(120, 'b', { uuid: 'h2' });
    const session = capture([first, said(60), second, said(180), first, said(60), second, said(180), typed(240, 'c'), said(270)]);
    expect(session.trust?.unattendedRun).toEqual([1, 1, 0.5]);
  });

  it('closes the run of a human line with no usable time, and lets the agent lines after it extend nothing', () => {
    const session = capture([typed(0, 'a'), said(60), typed(100, 'b', { timestamp: undefined }), said(1000)]);
    expect(session.trust?.unattendedRun).toEqual([1]);
  });

  describe('a rejection', () => {
    const refusal = "The user doesn't want to proceed with this tool use. The tool use was rejected.";

    it('ends the run at the last agent line before it, so a prompt rejected the next morning is not an overnight run', () => {
      const session = capture([
        typed(0, 'start'),
        said(60),
        called(120, 'a', 'Bash'),
        answered(36000, 'a', refusal, true),
        typed(36001, '[Request interrupted by user for tool use]'),
        typed(36010, 'next morning'),
        said(36030),
      ]);
      expect(session.trust?.unattendedRun).toEqual([2, 0.33]);
    });

    it('counts nothing for the work after a rejection with feedback until the next human turn', () => {
      const session = capture([typed(0, 'start'), said(60), called(120, 'a', 'Bash'), answered(36000, 'a', refusal, true), said(36020), typed(36100, 'more'), said(36130)]);
      expect(session.trust?.unattendedRun).toEqual([2, 0.5]);
    });
  });

  describe('a line the agent did not write', () => {
    // A late line, then the next human turn: if the late line extended the run, the first run would read 600 minutes.
    const late = (middle: string): readonly string[] => [typed(0, 'start'), said(60), middle, typed(36010, 'next morning'), said(36030)];
    const synthetic = line({
      ...base(36000),
      type: 'assistant',
      message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] },
    });

    it('does not extend a run with a local command that no model answered, nor its output', () => {
      expect(capture(late(typed(36000, '<command-name>/status</command-name>'))).trust?.unattendedRun).toEqual([1, 0.33]);
      expect(capture(late(typed(36000, '<local-command-stdout>Status dialog dismissed</local-command-stdout>'))).trust?.unattendedRun).toEqual([1, 0.33]);
      expect(capture(late(typed(36000, '<local-command-stderr>failed</local-command-stderr>'))).trust?.unattendedRun).toEqual([1, 0.33]);
      expect(capture(late(typed(36000, '<command-message>status</command-message>'))).trust?.unattendedRun).toEqual([1, 0.33]);
      expect(capture(late(typed(36000, '<local-command-caveat>Caveat: x</local-command-caveat>'))).trust?.unattendedRun).toEqual([1, 0.33]);
    });

    it('does not extend a run with a meta line the harness wrote', () => {
      const caveat = typed(36000, '<local-command-caveat>Caveat: the messages below were generated by the user</local-command-caveat>', { isMeta: true });
      expect(capture(late(caveat)).trust?.unattendedRun).toEqual([1, 0.33]);
      expect(capture(late(typed(36000, 'plain text the harness injected', { isMeta: true }))).trust?.unattendedRun).toEqual([1, 0.33]);
    });

    it('does not extend a run with a synthetic assistant line', () => {
      expect(capture(late(synthetic)).trust?.unattendedRun).toEqual([1, 0.33]);
    });

    it('counts a command the model answered as a human turn', () => {
      const session = capture([typed(0, 'start'), said(60), typed(36000, '<command-name>/review</command-name>'), said(36030)]);
      expect(session.trust?.unattendedRun).toEqual([1, 0.5]);
    });
  });

  it('counts a prompt that is only an image as a human turn', () => {
    const pasted = line({ ...base(36000), type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } });
    expect(capture([typed(0, 'start'), said(60), pasted, said(36030)]).trust?.unattendedRun).toEqual([1, 0.5]);
  });
});

describe("the shape's edge cases", () => {
  const codex = (rollout: readonly object[]) => capture(rolloutLines(rollout.map((entry) => JSON.stringify(entry)).join('\n'), 'c1').map((entry) => JSON.stringify(entry)), { harness: 'codex' });

  it('stores a Copilot session as absent for everything its reader does not record, and its prompts as runs', () => {
    const events = [
      copilotEvent(at(0), 'session.start', { sessionId: 'k1', copilotVersion: '1.0.105', selectedModel: 'm', context: { cwd: '/w' } }),
      copilotEvent(at(1), 'user.message', { content: 'go' }),
      copilotEvent(at(2), 'assistant.message', { content: 'ok', model: 'm', messageId: 'm1' }),
      copilotEvent(at(30), 'user.message', { content: 'more' }),
      copilotEvent(at(40), 'assistant.message', { content: 'done', model: 'm', messageId: 'm2' }),
    ];
    const session = capture(eventLines(events.map((entry) => JSON.stringify(entry)).join('\n'), 'k1').map((entry) => JSON.stringify(entry)), { harness: 'copilot' });
    expect(session.setup).toBeUndefined();
    expect(session.funnel).toBeUndefined();
    expect(session.trust).toEqual({ unattendedRun: [0.02, 0.17] });
  });

  it('stores a Gemini CLI session as absent for everything its reader does not record, and its prompts as runs (timing is real: each message has its own time)', () => {
    const user = (seconds: number, text: string) => ({ id: `u${String(seconds)}`, timestamp: at(seconds), type: 'user', content: [{ text }] });
    const model = (seconds: number, text: string) => ({ id: `g${String(seconds)}`, timestamp: at(seconds), type: 'gemini', content: text, model: 'm', tokens: { input: 10, output: 5, cached: 0, thoughts: 0, tool: 0, total: 15 } });
    const records = [geminiHead('g1'), user(1, 'go'), model(2, 'ok'), user(30, 'more'), model(40, 'done')];
    const session = capture(chatLines(records.map((entry) => JSON.stringify(entry)).join('\n'), 'g1', '/w').map((entry) => JSON.stringify(entry)), { harness: 'gemini' });
    expect(session.setup).toBeUndefined();
    expect(session.funnel).toBeUndefined();
    expect(session.trust).toEqual({ unattendedRun: [0.02, 0.17] });
  });

  it('reads nothing from a sidechain line: a subagent setup is not the main session', () => {
    const side = (seconds: number, attachment: object): string => line({ ...base(seconds), type: 'attachment', isSidechain: true, attachment });
    const session = capture([
      typed(0, 'go'),
      side(1, { type: 'hook_success', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', command: 'node a.js' }),
      side(2, { type: 'nested_memory', path: '/w/CLAUDE.md', content: { path: '/w/CLAUDE.md', content: 'abcde' } }),
      side(3, { type: 'deferred_tools_delta', addedNames: ['mcp__sub__tool'], removedNames: [] }),
      said(4),
    ]);
    expect(session.setup).toBeUndefined();
    expect(session.funnel).toBeUndefined();
  });

  it('counts a hook by its name, from any of the three hook attachments', () => {
    const session = capture([
      typed(0, 'go'),
      attach(1, { type: 'hook_additional_context', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: ['context text'] }),
      attach(2, { type: 'hook_additional_context', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: ['again'] }),
      attach(3, { type: 'hook_additional_context', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', content: ['x'] }),
    ]);
    expect(session.setup).toEqual({ hookCount: 2 });
    expect(JSON.stringify(session)).not.toMatch(/context text/);
  });

  it('counts a Stop hook once when its own line was seen, and from the summary when it was not', () => {
    const summary = line({ ...base(5), type: 'system', subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [{ command: 'node c.js', durationMs: 5 }] });
    expect(capture([typed(0, 'go'), attach(1, { type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop', command: 'node c.js' }), summary]).setup).toEqual({ hookCount: 1 });
    expect(capture([typed(0, 'go'), summary]).setup).toEqual({ hookCount: 1 });
    expect(capture([typed(0, 'go'), attach(1, { type: 'hook_success', hookName: 'Stop:main', hookEvent: 'Stop', command: 'node c.js' }), summary]).setup).toEqual({ hookCount: 1 });
  });

  it('stores no plugin whose name looks like a secret, as it redacts the tool name', () => {
    const token = 'sk-ant-api03Xk29fjQ81zLmPq7Rt';
    const session = capture([typed(0, 'go'), attach(1, { type: 'deferred_tools_delta', addedNames: [`mcp__plugin_${token}_srv__t`], removedNames: [] })]);
    expect(JSON.stringify(session)).not.toContain(token);
    expect(session.setup).toBeUndefined();
  });

  it('stores two server names that redact to one form once in each funnel list', () => {
    const one = 'mcp__sk-ant-api03Xk29fjQ81zLmPq7Rt__run';
    const two = 'mcp__sk-ant-api03Yk29fjQ81zLmPq7Rt__run';
    const session = capture([
      typed(0, 'go'),
      attach(1, { type: 'deferred_tools_delta', addedNames: [one, two], removedNames: [] }),
      called(2, 's', 'ToolSearch'),
      answered(3, 's', [{ type: 'tool_reference', tool_name: one }, { type: 'tool_reference', tool_name: two }]),
    ]);
    expect(session.funnel?.offered).toHaveLength(1);
    expect(session.funnel?.loaded).toEqual(session.funnel?.offered);
    const swapped = capture([typed(0, 'go'), attach(1, { type: 'deferred_tools_delta', addedNames: [one, two], removedNames: [] }), attach(2, { type: 'deferred_tools_delta', addedNames: [], removedNames: [two] })]);
    expect(swapped.funnel?.removed).toHaveLength(1);
  });

  it('reads a plugin name only up to its first underscore, since the tool name cannot say where the plugin ends', () => {
    const session = capture([typed(0, 'go'), attach(1, { type: 'deferred_tools_delta', addedNames: ['mcp__plugin_my_plugin_srv__t'], removedNames: [] })]);
    expect(session.setup).toEqual({ plugins: ['my'] });
  });

  it('stores a tool name the way a call is stored: an MCP server part that looks like a secret is redacted in the funnel and in a trust event', () => {
    const token = 'sk-ant-api03Xk29fjQ81zLmPq7Rt';
    const name = `mcp__${token}__run`;
    const session = capture([typed(0, 'go'), attach(1, { type: 'deferred_tools_delta', addedNames: [name], removedNames: [] }), called(2, 'a', name), typed(3, '[Request interrupted by user]')]);
    expect(JSON.stringify(session.funnel)).not.toContain(token);
    expect(JSON.stringify(session.trust)).not.toContain(token);
  });

  it('forgets a call that never got a result once an interrupt is recorded and once the human speaks again', () => {
    const session = capture([typed(0, 'go'), called(1, 'e', 'Edit'), typed(2, '[Request interrupted by user for tool use]'), typed(3, 'again'), said(4), typed(5, '[Request interrupted by user]')]);
    expect(session.trust?.trustEvent?.map((item) => item.tool)).toEqual(['Edit', null]);
    const none = capture([typed(0, 'go'), called(1, 'e', 'Edit'), typed(2, 'never mind'), said(3), typed(4, '[Request interrupted by user]')]);
    expect(none.trust?.trustEvent?.map((item) => item.tool)).toEqual([null]);
  });

  it('does not reopen a call a replayed tool_use repeats after its result', () => {
    const call = called(1, 'a', 'Bash');
    const session = capture([typed(0, 'go'), call, answered(2, 'a', 'ok'), call, typed(3, '[Request interrupted by user]')]);
    expect(session.trust?.trustEvent).toEqual([{ event: 'interrupt', tool: null, prompt: 0 }]);
  });

  it('keeps the first and last line times of a Codex rollout whether or not it declares tools', () => {
    const rollout = (declared: object[] | null) => [
      rolloutLine(at(0), 'session_meta', { id: 'c1', cwd: '/w', cli_version: '0.50.0', dynamic_tools: declared }),
      rolloutLine(at(500), 'event_msg', { type: 'user_message', message: 'go' }),
      rolloutLine(at(600), 'event_msg', { type: 'turn_aborted', turn_id: 't', reason: 'interrupted' }),
    ];
    const plain = codex(rollout(null));
    const declared = codex(rollout([{ type: 'function', name: 'lookup' }]));
    expect(declared.tsFirst).toBe(plain.tsFirst);
    expect(plain.tsLast).toBe(at(500));
    expect(declared.tsLast).toBe(plain.tsLast);
    expect(declared.funnel).toEqual({ offered: ['lookup'] });
  });

  it('never stores a negative run: an agent line older than its human turn does not move the end', () => {
    const session = capture([typed(100, 'go'), said(10), said(160)]);
    expect(session.trust?.unattendedRun).toEqual([1]);
    expect(capture([typed(100, 'go'), said(10)]).trust?.unattendedRun).toEqual([0]);
  });

  it('does not let a rejection hide the interrupt that follows a typed prompt', () => {
    const session = capture([
      typed(0, 'go'),
      called(1, 'a', 'Bash'),
      answered(2, 'a', "The user doesn't want to proceed with this tool use. The tool use was rejected.", true),
      typed(3, 'try something else'),
      typed(4, '[Request interrupted by user]'),
    ]);
    expect(session.trust).toMatchObject({ rejections: 1, interrupts: 1 });
  });

  it('keeps an interrupt in a harness that records no rejections, whatever wording a failure before it has', () => {
    const session = capture(
      [
        typed(0, 'go'),
        called(1, 'a', 'shell'),
        answered(2, 'a', "The user doesn't want to proceed with this tool use. The tool use was rejected.", true),
        line({ ...base(3), type: 'oars-interrupt' }),
      ],
      { harness: 'codex' },
    );
    expect(session.trust).toMatchObject({ interrupts: 1, trustEvent: [{ event: 'interrupt', tool: null, prompt: 0 }] });
    expect(session.trust).not.toHaveProperty('rejections');
  });

  it('reads plugins for Claude Code only', () => {
    const rollout = [
      rolloutLine(at(0), 'session_meta', { id: 'c1', cwd: '/w', cli_version: '0.50.0', dynamic_tools: [{ type: 'function', name: 'mcp__plugin_kit_s__t' }] }),
      rolloutLine(at(1), 'event_msg', { type: 'user_message', message: 'go' }),
    ];
    const session = codex(rollout);
    expect(session.funnel).toEqual({ offered: ['mcp__plugin_kit_s__t'] });
    expect(session.setup).toBeUndefined();
  });

  it('counts the other two wordings of a policy denial', () => {
    const session = capture([
      typed(0, 'go'),
      called(1, 'a', 'Bash'),
      answered(2, 'a', 'Permission for this action has been denied. Reason: classifier', true),
      called(3, 'b', 'Write'),
      answered(4, 'b', 'Hook PreToolUse:Write denied this tool', true),
    ]);
    expect(session.trust).toMatchObject({ denials: 2, rejections: 0 });
    expect(session.trust?.trustEvent?.map((item) => item.tool)).toEqual(['Bash', 'Write']);
  });
});
