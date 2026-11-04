import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { grokBadLines, grokLines, grokRoot, openGrokStore } from './grok.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, grokUpdate as line, stage, stageGrok } from './test-support.js';

afterEach(cleanup);

// Every fixture below is written from xai-org/grok-build @ 2bdd1d6 (Apache-2.0), under crates/codegen/, and from the ACP schema it implements
// (agentclientprotocol/agent-client-protocol @ 0e486bc, schema/v1/schema.json):
//   updates.jsonl line `{timestamp: u64 seconds, method, params: {sessionId, update}}`  xai-grok-shell storage/mod.rs:721-725
//   update kinds `user_message_chunk`, `agent_message_chunk` (content {type:"text", text}, _meta), `tool_call` (toolCallId, title, kind, status, rawInput),
//     a model-issued `tool_call` has kind `other` (tool_calls.rs:1488; the real kind comes on a later update, :2734), so only the `bash-mode-` call (tool_dispatch.rs:246) is `execute`;
//     `tool_call_update` (toolCallId, status, content[], rawOutput)                                         ACP schema.json SessionUpdate
//   `_meta.hostTurn` (either chunk kind), `_meta.hideFromScrollback`, and `_meta.interjection` mark text the harness wrote; `_meta.promptIndex` numbers a prompt
//     storage/mod.rs:966, :974, :1009; acp_session.rs:1353-1372; turn.rs:328, :890-901
//   `title` is the tool's name                                                                              xai-grok-shell tool_calls.rs:1487
//   rawOutput of a shell call: `{type:"Bash", output: bytes, output_for_prompt, exit_code, command, truncated, signal, timed_out, description, current_dir, output_file, total_bytes}`   xai-grok-tools types/output.rs:384-403
//   a call is `failed` only on a timeout or a signal, so exit 2 arrives `completed`                         acp_conversion.rs:241-250
//   edit keys: `file_path` (search_replace, write, hashline_edit), `filePath` (edit, camelCase), `patch` (apply_patch)   xai-grok-tools implementations/{grok_build/search_replace/mod.rs:74,
//     opencode/edit/mod.rs:64,:138,:579, opencode/write/mod.rs:31, grok_build_hashline/edit/types.rs:12, codex/apply_patch/tool.rs:104}; the patch format's
//     `*** Update File: <path>` headers are codex/apply_patch/parser.rs:40-42
//   usage.json `{turns: [{endedAt, inputTokens, outputTokens, cachedReadTokens, cacheCreationTokens, reasoningTokens, primaryModelId}]}`   usage_file.rs:10-80
// `inputTokens` includes cache reads and writes (xai-grok-sampling-types conversation.rs:771-773). No live store was read.

const capture = (text: string) =>
  captureSession({
    text,
    harness: 'grok',
    session: 'grok-x',
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

const BASE = Date.parse('2026-06-01T10:00:00Z') / 1000;
const S = (second: number): number => BASE + second;
const iso = (second: number): string => new Date((BASE + second) * 1000).toISOString();
const asText = (events: readonly unknown[]): string => events.map((entry) => JSON.stringify(entry)).join('\n');
type Obj = { [key: string]: unknown };
const summaryOf = (extra: Obj = {}): Obj => ({ info: { id: 'sess', cwd: '/work/app' }, created_at: iso(0), current_model_id: 'grok-build', ...extra });
const linesOf = (events: readonly unknown[], summary: Obj = summaryOf(), usage?: Obj) => grokLines(asText(events), 'sess', summary, usage);
const extractOf = (events: readonly unknown[], summary: Obj = summaryOf(), usage?: Obj) => capture(linesOf(events, summary, usage).map((entry) => JSON.stringify(entry)).join('\n'));

const prompt = (second: number, text: string, meta?: object) => line(S(second), { sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, ...(meta === undefined ? {} : { _meta: meta }) });
const say = (second: number, text: string, meta?: object) => line(S(second), { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, ...(meta === undefined ? {} : { _meta: meta }) });
const call = (second: number, toolCallId: string, title: string, rawInput: object = {}, kind = 'other') => line(S(second), { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'pending', rawInput });
// A completion upstream writes always carries `rawOutput` (acp_conversion.rs:116-640), and a tool with no richer output type answers with `ToolOutput::Text`
// (a text part in `content[]` and `{type:"Text", text}`, :501-509); a failure from the tool layer carries a text part only (tool_calls.rs:2834-2838, :3325-3329).
const finish = (second: number, toolCallId: string, status: string, extra: object = {}) => {
  const bare = status === 'completed' && !('content' in extra) && !('rawOutput' in extra);
  const text = { content: [{ type: 'content', content: { type: 'text', text: 'done' } }], rawOutput: { type: 'Text', text: 'done' } };
  return line(S(second), { sessionUpdate: 'tool_call_update', toolCallId, status, ...(bare ? text : {}), ...extra });
};
const bytes = (text: string): number[] => [...Buffer.from(text)];
// The model-issued path overwrites `output_for_prompt` with the formatted prompt, `exit: N\n<output>` (grok_build/bash/mod.rs:2246, format_default_prompt :386-417), so a
// fixture of that path writes the header; the `output` bytes stay the raw output (:2232).
const bash = (exit: number, text: string, extra: object = {}) => ({ type: 'Bash', exit_code: exit, command: 'x', output: bytes(text), output_for_prompt: `exit: ${String(exit)}\n${text}`, signal: null, timed_out: false, truncated: false, description: null, output_file: '', total_bytes: Buffer.byteLength(text), current_dir: '/work/app', ...extra });
// The concise tool's form (grok_build_concise/bash.rs:37-58, :187): `Exit code: N`, then the output in a fence.
const conciseBash = (exit: number, text: string, extra: object = {}) => bash(exit, text, { output_for_prompt: `Exit code: ${String(exit)}\n\nCommand output:\n\n\`\`\`\n${text}\n\`\`\`\n\nCommand completed.\n\nThe previous shell command ended, so on the next invocation of this tool, you will be using a new shell session.\n\nOn the next terminal tool call, the directory of the shell will be /work/app.`, ...extra });
// The user's `!cmd` is the one path that keeps `output_for_prompt` plain, and writes `description: None` (tool_dispatch.rs:304-317).
const bashMode = (exit: number, text: string, extra: object = {}) => bash(exit, text, { output_for_prompt: text, description: null, ...extra });
const turn = (second: number, extra: object = {}) => ({ turnNumber: 1, endedAt: iso(second), inputTokens: 900, outputTokens: 60, cachedReadTokens: 400, cacheCreationTokens: 100, reasoningTokens: 7, modelCalls: 2, primaryModelId: 'grok-build', ...extra });
// The user's `!cmd` input as upstream writes it: the tagged `ToolInput::Bash` (tool_dispatch.rs:223-229, :250; xai-grok-tools types/tool_io.rs:55-59).
const BANG = { variant: 'Bash', command: 'ls -a', description: 'ls -a', is_background: false };
const usageOf = (...turns: Obj[]): Obj => ({ sessionId: 'sess', updatedAt: iso(99), session: {}, turns });

describe('the Grok Build reader', () => {
  it('turns a normal session into prompts, calls with outcomes, usage from usage.json, the model, and the cwd', () => {
    const events = [
      prompt(1, 'fix the '),
      prompt(1, 'build'),
      say(2, 'running '),
      say(2, 'it'),
      call(3, 'c1', 'run_terminal_cmd', { command: 'npm test' }),
      finish(4, 'c1', 'completed', { rawOutput: bash(0, 'ok') }),
      call(5, 'c2', 'search_replace', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }),
      finish(6, 'c2', 'completed', { content: [{ type: 'diff', path: '/work/app/src/a.ts', oldText: 'a', newText: 'b' }], rawOutput: { type: 'SearchReplace', EditsApplied: { old_string: 'a', new_string: 'b', tool_output_for_prompt: 'edited', absolute_path: '/work/app/src/a.ts', edits: { details: [] } } } }),
      call(7, 'c3', 'apply_patch', { patch: '*** Begin Patch\n*** Update File: docs/b.md\n@@\n-x\n+y\n*** Add File: docs/c.md\n+z\n*** End Patch' }),
      finish(8, 'c3', 'completed', { content: [{ type: 'diff', path: '/work/app/docs/b.md', oldText: 'x', newText: 'y' }, { type: 'diff', path: '/work/app/docs/c.md', newText: 'z' }], rawOutput: { type: 'ApplyPatch', Success: { files: [{ path: '/work/app/docs/b.md', action: 'modified', old_text: 'x', new_text: 'y' }, { path: '/work/app/docs/c.md', action: 'added', new_text: 'z' }], tool_output_for_prompt: 'applied' } } }),
      say(9, 'done'),
    ];
    const out = extractOf(events, summaryOf(), usageOf(turn(10)));
    expect(out.session.userTurns).toBe(1);
    expect(out.session.assistantTurns).toBe(4);
    expect(out.session.models).toEqual({ 'grok-build': 4 });
    // inputTokens includes the cache reads and writes, and capture's fields are disjoint: 900 - 400 - 100.
    expect(out.session.usage).toMatchObject({ input: 400, cacheRead: 400, cacheWrite: 100, output: 60, thinking: 7 });
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Bash', 'ok'], ['Edit', 'ok'], ['Edit', 'ok'], ['Edit', 'ok']]);
    // A relative request and the completion's absolute diff path name one file, so each file is stored once, in the absolute form Claude Code's `file_path` has.
    expect([...out.session.files].sort()).toEqual(['/work/app/docs/b.md', '/work/app/docs/c.md', '/work/app/src/a.ts']);
    expect(out.errorLines).toEqual([]);
    expect(out.session.tsFirst).toBe(iso(1));
  });

  it('records a shell call whose exit code is nonzero as an error even though its status says completed', () => {
    const out = extractOf([prompt(1, 'run it'), call(2, 'c1', 'run_terminal_cmd', { command: 'make' }), finish(3, 'c1', 'completed', { rawOutput: bash(2, 'make: *** No rule to make target\nsecond') })]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'error' }]);
    expect(out.errorLines).toMatchObject([{ tool: 'Bash', line: 'make: *** No rule to make target' }]);
  });

  it('records a timed-out shell call as an error with its output, and one that exited zero but was cut by a signal as an error', () => {
    const out = extractOf([
      prompt(1, 'run them'),
      call(2, 'c', 'bash', { command: 'sleep 9' }),
      finish(3, 'c', 'failed', { rawOutput: bash(-1, 'timed out after 5s', { timed_out: true }) }),
      call(4, 'd', 'bash', { command: 'true' }),
      finish(5, 'd', 'failed', { rawOutput: bash(0, '', { signal: 'killed' }) }),
    ]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['error', 'error']);
    expect(out.errorLines.map((error) => error.line)[0]).toBe('timed out after 5s');
  });

  it('reads the output bytes, not the formatted prompt header or the concise tool’s fence, and says "Exit code" when there is no output at all', () => {
    const out = extractOf([
      prompt(1, 'x'),
      call(2, 'c', 'bash', { command: 'a' }),
      finish(3, 'c', 'completed', { rawOutput: bash(1, 'raw bytes only') }),
      call(4, 'd', 'bash', { command: 'b' }),
      finish(5, 'd', 'completed', { rawOutput: bash(3, '') }),
      call(6, 'e', 'run_terminal_cmd', { command: 'c' }),
      finish(7, 'e', 'completed', { rawOutput: conciseBash(2, 'concise output') }),
    ]);
    expect(out.errorLines.map((error) => error.line)).toEqual(['raw bytes only', 'Exit code 3', 'concise output']);
  });

  it('strips ANSI sequences from the output bytes, so a coloured error line still joins a plain one', () => {
    const esc = String.fromCharCode(27);
    const out = extractOf([prompt(1, 'x'), call(2, 'c', 'bash', { command: 'a' }), finish(3, 'c', 'completed', { rawOutput: bash(1, `${esc}[31;1merror${esc}[0m: bad thing`) })]);
    expect(out.errorLines.map((error) => error.line)).toEqual(['error: bad thing']);
  });

  it('unwraps a failed tool to the text of its content, never the rawOutput wrapper, so the error line joins a Claude Code signature', () => {
    const out = extractOf([
      prompt(1, 'read it'),
      call(2, 'c1', 'read_file', { path: '/nope' }),
      finish(3, 'c1', 'failed', { content: [{ type: 'content', content: { type: 'text', text: 'ENOENT: no such file or directory, open /nope' } }], rawOutput: { type: 'ReadFile', FileNotFound: 'ENOENT: no such file or directory, open <workspace>/nope' } }),
      call(4, 'c2', 'list_dir', {}),
      finish(5, 'c2', 'failed', { rawOutput: { type: 'ListDir', NotFound: 'no such directory' } }),
      call(6, 'c3', 'bash', { command: 'x' }),
      finish(7, 'c3', 'failed', { content: [{ type: 'content', content: { type: 'text', text: 'killed' } }] }),
    ]);
    expect(out.errorLines.map((error) => error.line)).toEqual(['ENOENT: no such file or directory, open /nope', 'tool failed', 'killed']);
  });

  it('writes no usage for a session with no usage.json, and gives every assistant line a requestId', () => {
    const lines = linesOf([prompt(1, 'hi'), say(2, 'hello'), prompt(3, 'again'), say(4, 'more')]);
    const assistant = lines.filter((entry) => entry.type === 'assistant');
    expect(assistant).toHaveLength(2);
    expect(assistant.every((entry) => typeof entry.requestId === 'string' && entry.requestId !== '')).toBe(true);
    expect(new Set(assistant.map((entry) => entry.requestId)).size).toBe(2);
    expect(extractOf([prompt(1, 'hi'), say(2, 'hello')]).session.usage).toMatchObject({ input: 0, output: 0 });
  });

  it('captures a session from a folder that is not a repository', () => {
    const out = extractOf([prompt(1, 'hi'), call(2, 'c1', 'read_file', { path: 'a.txt' }), finish(3, 'c1', 'completed')], summaryOf({ info: { id: 'sess', cwd: '/tmp/notes' } }));
    expect(out.tools).toMatchObject([{ tool: 'read_file', status: 'ok' }]);
    expect(out.session.repo).toBeNull();
  });

  it('sums every turn once, lands each on the last response before its endedAt, and takes the turn’s model', () => {
    const events = [prompt(1, 'a'), say(2, 'one'), prompt(5, 'b'), say(6, 'two')];
    const lines = linesOf(events, summaryOf(), usageOf(turn(3, { turnNumber: 1, inputTokens: 100, cachedReadTokens: 40, cacheCreationTokens: 0, outputTokens: 5, reasoningTokens: 0, primaryModelId: 'm-a' }), turn(7, { turnNumber: 2, inputTokens: 300, cachedReadTokens: 100, cacheCreationTokens: 50, outputTokens: 9, reasoningTokens: 2, primaryModelId: 'm-b' })));
    const usages = lines.filter((entry) => entry.type === 'assistant').map((entry) => [entry.requestedModel, typeof entry.message === 'object' && entry.message !== null && 'usage' in entry.message ? entry.message.usage : undefined]);
    expect(usages).toEqual([
      ['m-a', { input_tokens: 60, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, output_tokens: 5, output_tokens_details: { thinking_tokens: 0 } }],
      ['m-b', { input_tokens: 150, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 9, output_tokens_details: { thinking_tokens: 2 } }],
    ]);
    expect(extractOf(events, summaryOf(), usageOf(turn(3), turn(7))).session.usage).toMatchObject({ input: 800, cacheRead: 800, output: 120 });
  });

  it('attaches a turn that ends before any response to the first one, and drops usage when there is no response', () => {
    const early = linesOf([prompt(5, 'a'), say(6, 'one')], summaryOf(), usageOf(turn(1)));
    expect(early.filter((entry) => entry.type === 'assistant')).toMatchObject([{ message: { usage: { output_tokens: 60 } } }]);
    expect(() => linesOf([prompt(5, 'a')], summaryOf(), usageOf(turn(1)))).not.toThrow();
  });

  it('never subtracts below zero when the vendor’s cache fields exceed its input', () => {
    const lines = linesOf([prompt(1, 'a'), say(2, 'x')], summaryOf(), usageOf(turn(3, { inputTokens: 10, cachedReadTokens: 30, cacheCreationTokens: 0 })));
    expect(lines.filter((entry) => entry.type === 'assistant')).toMatchObject([{ message: { usage: { input_tokens: 0, cache_read_input_tokens: 30 } } }]);
  });

  it('skips the lines and the usage a fork copied from its parent, keeping what happened after forked_at', () => {
    const forked = { session_kind: 'fork', parent_session_id: 'parent', forked_at: iso(10) };
    const events = [prompt(1, 'parent prompt'), say(2, 'parent answer'), prompt(11, 'child prompt'), say(12, 'child answer')];
    const out = extractOf(events, summaryOf(forked), usageOf(turn(3), turn(13, { turnNumber: 2, inputTokens: 50, cachedReadTokens: 0, cacheCreationTokens: 0, outputTokens: 4, reasoningTokens: 0 })));
    expect(out.session.userTurns).toBe(1);
    expect(out.session.usage).toMatchObject({ input: 50, output: 4 });
    // A restore or a resume keeps its own file: nothing is skipped without a fork.
    expect(extractOf(events, summaryOf({ forked_at: undefined })).session.userTurns).toBe(2);
  });

  it('does not read the harness’s own text as the operator’s: a host-turn marker ends a prompt, an interjection is not one', () => {
    const lines = linesOf([prompt(1, 'real '), prompt(1, 'prompt'), prompt(2, 'turn boundary', { hostTurn: true }), prompt(3, 'steer', { interjection: true }), say(4, 'ok'), prompt(5, 'second')]);
    expect(lines.filter((entry) => entry.type === 'user').map((entry) => JSON.stringify(entry.message))).toEqual([
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'real prompt' }] }),
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'second' }] }),
    ]);
  });

  it('gives a prompt with timestamp 0, a missing one, or an earlier one the latest time so far, never an earlier one', () => {
    const lines = linesOf([line(0, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'zero' } }), say(9, 'a'), prompt(3, 'earlier'), say(10, 'b'), { method: 'session/update', params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'none' } } } }]);
    expect(lines.filter((entry) => entry.type === 'user').map((entry) => entry.timestamp)).toEqual([iso(0), iso(9), iso(10)]);
  });

  it('follows the shell’s current_dir for the cwd after a directory change', () => {
    const lines = linesOf([prompt(1, 'cd'), call(2, 'c1', 'bash', { command: 'cd /other' }), finish(3, 'c1', 'completed', { rawOutput: bash(0, '', { current_dir: '/other' }) }), prompt(4, 'next')]);
    expect(lines.filter((entry) => entry.type === 'user' && typeof entry.cwd === 'string').map((entry) => entry.cwd)).toEqual(['/work/app', '/other', '/other']);
  });

  it('records an MCP call the way Claude Code does, a user bash-mode command by its kind, and a call with no completion as none', () => {
    const out = extractOf([
      prompt(1, 'go'),
      call(2, 'c1', 'oars__oars_recall', {}, 'other'),
      finish(3, 'c1', 'completed'),
      call(4, 'bash-mode-1', 'Execute `ls -a`', BANG, 'execute'),
      finish(5, 'bash-mode-1', 'failed', { rawOutput: bashMode(2, 'ls: no such file') }),
      call(6, 'c3', 'grep', { pattern: 'x' }),
      finish(7, 'c3', 'in_progress'),
    ]);
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['mcp__oars__oars_recall', 'ok'], ['Bash', 'error'], ['grep', 'none']]);
    // The stored step reads the command upstream's input holds (rawInput.command), not the title.
    expect(out.tools[1]?.steps?.[0]).toMatchObject({ action: 'shell.exec', identity: { program: 'ls' } });
  });

  it('attributes an MCP call made through the use_tool wrapper to its server, as mcp.call', () => {
    // The model reaches an MCP tool through `use_tool` (17-sessions.md:42), so the call is titled `use_tool` (tool_calls.rs:1487, use_tool/mod.rs:15) and the target
    // is `rawInput.tool_name`, qualified `server__tool` (use_tool/input.rs:19-20, use_tool/mod.rs:308), with its arguments in `tool_input`.
    const out = extractOf([
      prompt(1, 'go'),
      call(2, 'c1', 'use_tool', { tool_name: 'linear__save_issue', tool_input: { title: 'x' } }, 'other'),
      finish(3, 'c1', 'completed'),
      call(4, 'c2', 'use_tool', { tool_name: 'nounderscores', tool_input: {} }, 'other'),
      finish(5, 'c2', 'completed'),
      call(6, 'c3', 'use_tool', { tool_name: 'linear__list', tool_input_file: '/tmp/in.json' }, 'other'),
      finish(7, 'c3', 'completed'),
    ]);
    expect(out.tools.map((tool) => tool.tool)).toEqual(['mcp__linear__save_issue', 'use_tool', 'mcp__linear__list']);
    expect(out.tools.map((tool) => tool.steps?.[0]?.action)).toEqual(['mcp.call', 'other', 'mcp.call']);
  });

  it('reads a skill call as skill.run with the skill’s name, and a todowrite call as a plan update', () => {
    // The opencode `skill` tool's input is `{name}` (opencode/skill/mod.rs:50) and `todowrite` is its plan tool (opencode/todowrite/mod.rs, ToolId "todowrite").
    const out = extractOf([prompt(1, 'go'), call(2, 'c1', 'skill', { name: 'pdf' }), finish(3, 'c1', 'completed'), call(4, 'c2', 'todowrite', { todos: [] }), finish(5, 'c2', 'completed')]);
    expect(out.tools.map((tool) => tool.steps?.[0]?.action)).toEqual(['skill.run', 'plan.update']);
    expect(linesOf([prompt(1, 'go'), call(2, 'c1', 'skill', { name: 'pdf' })]).flatMap((entry) => JSON.stringify(entry))).toEqual(expect.arrayContaining([expect.stringContaining('"input":{"skill":"pdf"}')]));
  });

  it('starts a new response after a host-turn marker, so a say, a marker, and a say are two assistant lines', () => {
    const lines = linesOf([prompt(1, 'go'), say(2, 'first'), prompt(3, 'boundary', { hostTurn: true }), say(4, 'second')]);
    expect(lines.filter((entry) => entry.type === 'assistant')).toHaveLength(2);
  });

  it('does not read a slash command’s output as a model response: an agent chunk with hostTurn ends the turn and its text is dropped', () => {
    // A slash command's output is persisted as an agent_message_chunk with _meta.hostTurn (acp_session.rs:1353-1372, slash_exec.rs:64), and upstream's own
    // rebuilders treat it as a boundary and drop the text (storage/mod.rs:429-432, replay.rs:448-452).
    const lines = linesOf([prompt(1, 'go'), say(2, 'first'), say(3, 'COMMAND OUTPUT', { hostTurn: true }), say(4, 'second')]);
    const assistants = lines.filter((entry) => entry.type === 'assistant');
    expect(JSON.stringify(assistants)).not.toContain('COMMAND OUTPUT');
    expect(assistants).toHaveLength(2);
  });

  it('does not count a harness-started turn as the operator’s prompt: a user chunk with hideFromScrollback is dropped and separates the responses', () => {
    // upstream marks the user chunk of a TaskCompleted, SubagentCompleted, WorkflowCompleted, NotificationDrain, GoalSummary, or GoalClassifierNudge turn
    // (turn.rs:328, :896-901, session/mod.rs:242-255).
    const events = [prompt(1, 'go', { promptIndex: 0 }), say(2, 'first'), prompt(3, 'task finished', { promptIndex: 1, hideFromScrollback: true }), say(4, 'second')];
    const lines = linesOf(events);
    expect(lines.filter((entry) => entry.type === 'user')).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain('task finished');
    expect(lines.filter((entry) => entry.type === 'assistant')).toHaveLength(2);
    expect(extractOf(events).session.userTurns).toBe(1);
  });

  it('keeps two prompts apart when no reply falls between them: a change of promptIndex opens a new prompt, the same index merges, an unmarked chunk is kept and opens its own run', () => {
    // upstream writes _meta.promptIndex on each prompt (turn.rs:890-895) and a change of it opens a new run (storage/mod.rs:1009, replay.rs:427-432); a `!cmd`
    // prompt carries only modelId (tool_dispatch.rs:185-187), so an unmarked chunk is kept and opens its own run ("including between unmarked and marked", storage/mod.rs:1038-1039); upstream never writes a marked and an unmarked chunk for one prompt (turn.rs:960-962).
    const texts = (events: readonly unknown[]) => linesOf(events).filter((entry) => entry.type === 'user').map((entry) => JSON.stringify(entry.message));
    const one = (text: string) => JSON.stringify({ role: 'user', content: [{ type: 'text', text }] });
    expect(texts([prompt(1, 'first try', { promptIndex: 0 }), prompt(2, 'retry', { promptIndex: 1 })])).toEqual([one('first try'), one('retry')]);
    expect(texts([prompt(1, 'in ', { promptIndex: 3 }), prompt(1, 'two', { promptIndex: 3 })])).toEqual([one('in two')]);
    expect(texts([prompt(1, 'in ', { promptIndex: 3 }), prompt(1, 'parts')])).toEqual([one('in '), one('parts')]);
    expect(texts([prompt(1, 'first try', { promptIndex: 0 }), prompt(2, '!ls')])).toEqual([one('first try'), one('!ls')]);
    expect(texts([prompt(1, 'in '), prompt(1, 'parts')])).toEqual([one('in parts')]);
  });

  it('gives a session whose lines all lack a time one time: created_at, else the epoch', () => {
    const untimed = (sessionUpdate: string, text: string) => ({ method: 'session/update', params: { update: { sessionUpdate, content: { type: 'text', text } } } });
    const events = [untimed('user_message_chunk', 'one'), untimed('agent_message_chunk', 'x'), untimed('user_message_chunk', 'two')];
    const stamps = (summary: Obj) => grokLines(asText(events), 'sess', summary, undefined).filter((entry) => entry.type === 'user').map((entry) => entry.timestamp);
    expect(stamps(summaryOf())).toEqual([iso(0), iso(0)]);
    // With no created_at either there is no time to give; the epoch stands (documented in docs/sessions-store.md, Timestamps).
    expect(stamps({ info: { id: 'sess', cwd: '/work/app' } })).toEqual(['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z']);
  });

  it('skips torn lines, lines of an unknown shape, an update with no id, and a completion with no known call, and counts the torn ones', () => {
    const text = `${asText([prompt(1, 'hi'), line(S(2), { sessionUpdate: 'plan', entries: [] }), call(3, '', 'bash'), finish(4, 'ghost', 'completed')])}\n{torn\n[1]\n`;
    expect(grokBadLines(text)).toEqual(['{torn']);
    const lines = grokLines(text, 'sess', summaryOf(), undefined);
    expect(lines.filter((entry) => entry.type === 'user')).toHaveLength(1);
    expect(() => grokLines('{torn\nnot json\n', 'sess', summaryOf(), undefined)).toThrow('no parseable line');
  });

  it('settles a call once', () => {
    const out = extractOf([prompt(1, 'x'), call(2, 'c1', 'bash', { command: 'a' }), finish(3, 'c1', 'completed', { rawOutput: bash(0, 'ok') }), finish(4, 'c1', 'failed', { rawOutput: bash(1, 'late') })]);
    expect(out.tools.map((tool) => tool.status)).toEqual(['ok']);
  });

  it('redacts a secret and an email, and cuts a 1,500-character error at 1,000 characters', () => {
    const long = `fail: sk-abcdefghijklmnopqrstuvwxyz0123 for alice@example.com ${'x'.repeat(1500)}`;
    const out = extractOf([prompt(1, 'x'), call(2, 'c1', 'bash', { command: 'run' }), finish(3, 'c1', 'completed', { rawOutput: bash(1, long) })]);
    const error = out.errorLines[0];
    expect(error?.line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(error?.line).not.toContain('alice@example.com');
    expect(error?.line.length).toBeLessThanOrEqual(1000);
    const failed = extractOf([prompt(1, 'x'), call(2, 'c1', 'read_file', {}), finish(3, 'c1', 'failed', { content: [{ type: 'content', content: { type: 'text', text: long } }] })]).errorLines[0];
    expect(failed?.line.length).toBeLessThanOrEqual(1000);
    expect(failed?.line).not.toContain('alice@example.com');
  });

  it('records an edit by its name even when it fails or the tool reports no path, with the original name kept for the table', () => {
    const out = extractOf([
      prompt(1, 'edit'),
      call(2, 'c1', 'write', { file_path: 'src/new.ts', content: 'x' }),
      finish(3, 'c1', 'failed', { content: [{ type: 'content', content: { type: 'text', text: 'denied' } }] }),
      call(4, 'c2', 'edit', {}, 'other'),
      finish(5, 'c2', 'completed'),
      call(6, 'c3', 'edit', { filePath: 'src/a.ts', oldString: 'a', newString: 'b' }, 'other'),
      finish(7, 'c3', 'failed', { content: [{ type: 'content', content: { type: 'text', text: 'oldString not found' } }] }),
    ]);
    expect(out.tools.map((tool) => [tool.tool, tool.status])).toEqual([['Edit', 'error'], ['Edit', 'ok'], ['Edit', 'error']]);
    // The opencode `edit` tool's wire key is camelCase (`filePath`: opencode/edit/mod.rs:64, :138, :579), so a failed edit, which has no diff part, still names its file.
    expect([...out.session.files].sort()).toEqual(['/work/app/src/a.ts', '/work/app/src/new.ts']);
  });
});

describe('the Grok home', () => {
  it('is GROK_HOME, else ~/.grok', () => {
    expect(grokRoot({ GROK_HOME: '/x/y' }, '/home/u')).toBe('/x/y');
    expect(grokRoot({ GROK_HOME: '' }, '/home/u')).toBe(join('/home/u', '.grok'));
    expect(grokRoot({}, '/home/u')).toBe(join('/home/u', '.grok'));
  });

  it('lists sessions by folder name with the cwd summary.json names, skips subagents, husks, and what is no session, and reports what it cannot read', async () => {
    const s = stage();
    const updates = [prompt(1, 'x')];
    const home = stageGrok(s.root, [
      { id: 'aaa', cwd: '/work/a', updates },
      { id: 'bbb', cwd: '/work/b', updates: [prompt(1, 'x'), say(2, 'y')], usage: usageOf(turn(2)) },
      { id: 'sub1', cwd: '/work/a', updates, summary: { session_kind: 'subagent' } },
      { id: 'sub2', cwd: '/work/a', updates, summary: { session_kind: 'subagent_fork' } },
      { id: 'husk', cwd: '/work/a', updates: [], summary: { num_messages: 0 } },
      { id: 'noupd', cwd: '/work/a', updates: null },
      { id: 'bad id', cwd: '/work/a', updates },
      { id: 'torn', cwd: '/work/c', updates: '{torn\n' },
    ]);
    expect(home.startsWith(s.root)).toBe(true);
    mkdirSync(join(home, 'sessions', 'stray'), { recursive: true });
    writeFileSync(join(home, 'sessions', 'stray.txt'), 'x');
    writeFileSync(join(home, 'sessions', encodeURIComponent('/work/a'), 'stray.txt'), 'x');
    mkdirSync(join(home, 'sessions', 'stray', 'nosummary'));
    const store = await openGrokStore(home);
    expect(store?.sessions.map((session) => [session.id, session.folder]).sort()).toEqual([['aaa', '/work/a'], ['bbb', '/work/b'], ['torn', '/work/c']]);
    expect(store?.rejected).toBe(1);
    expect(store?.unreadable).toEqual([]);
    const withUsage = store?.sessions.find((session) => session.id === 'bbb');
    expect(await store?.transcript(withUsage ?? never())).toContain('"output_tokens":60');
    expect(await openGrokStore(join(s.root, 'nowhere'))).toBeUndefined();
    await expect(store?.transcript({ ...(withUsage ?? never()), dir: join(home, 'gone') })).rejects.toThrow();
  });

  it('names a session whose summary.json is corrupt, never fatal, and does not name its folder', async () => {
    const s = stage();
    const home = stageGrok(s.root, [{ id: 'good', cwd: '/work/a', updates: [prompt(1, 'x')] }, { id: 'broken', cwd: '/work/a', updates: [prompt(1, 'x')] }]);
    writeFileSync(join(home, 'sessions', encodeURIComponent('/work/a'), 'broken', 'summary.json'), '{not json');
    const store = await openGrokStore(home);
    expect(store?.sessions.map((session) => session.id)).toEqual(['good']);
    expect(store?.unreadable).toHaveLength(1);
    expect(store?.unreadable[0]?.file).toContain('broken');
    expect(store?.unreadable[0]?.reason).not.toContain(s.root);
  });

  it('reports a sessions folder that cannot be listed by its base name, never fatal', async () => {
    const s = stage();
    const home = join(s.root, 'grok-file');
    mkdirSync(home);
    writeFileSync(join(home, 'sessions'), 'a file, not a folder');
    const store = await openGrokStore(home);
    expect(store?.sessions).toEqual([]);
    expect(store?.unreadable).toHaveLength(1);
    expect(store?.unreadable[0]?.reason).not.toContain(s.root);
    await expect(store?.transcript({ id: 'x', folder: null, dir: 'x', size: 0, mtimeMs: 0 })).rejects.toThrow();
  });

  it('lists a session whose summary names no cwd with no folder', async () => {
    const s = stage();
    const home = stageGrok(s.root, [{ id: 'long', cwd: '/work/a', updates: [prompt(1, 'x')], summary: { info: { id: 'long', cwd: '' } } }]);
    const store = await openGrokStore(home);
    expect(store?.sessions[0]?.folder).toBeNull();
  });
});

const never = (): never => {
  throw new Error('no session');
};
