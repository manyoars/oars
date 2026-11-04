// The setup snapshot, tool funnel, and trust shape (t815). Every fixture is synthetic; the Claude Code line shapes are the ones t816's census of 2.1.312 to
// 2.1.318 names (deferred_tools_delta.addedNames and removedNames, api-request-shape.shape.tools[].name, tool_reference.tool_name, stop_hook_summary.hookInfos[],
// hook_success.command, nested_memory.content.content, permission-mode lines and the user line's permissionMode), the Codex ones are the payloads
// codex.test.ts already cites (openai/codex @ ac558e2: TurnAbortReason protocol.rs:4580, AskForApproval :1163, SessionMeta.dynamic_tools, ResponseItem::AdditionalTools
// and ToolSearchOutput, models.rs). No real session or store was read.
import { describe, expect, it } from 'vitest';
import { rolloutLines } from './codex.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { CAPTURE_VERSION } from './schema.js';
import { rolloutLine } from './test-support.js';

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

const capture = (lines: readonly string[], options: { harness?: 'codex' | 'cursor'; subagent?: boolean } = {}) => {
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
    attach(5, { type: 'hook_blocking_error', hookEvent: 'PreToolUse', blockingError: { blockingError: 'no', command: 'node b.js' } }),
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
    expect(session.funnel).toEqual({ offered: ['extra', 'inner', 'lookup', 'ns'], loaded: ['lookup'] });
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
});
