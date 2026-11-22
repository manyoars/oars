// t1558: the Codex dialect of `oars-hook`. The plugin manifest registers the four events through `extensions["com.openai"]` (never a root `hooks/hooks.json`, which Claude Code also loads);
// one invocation both records (codex-hook.ts) and pushes; each event's payload is answered in the hookSpecificOutput shape Codex reads; the recall is tagged `codex`; and a failed command is
// read from the rollout's tail by the payload's `tool_use_id`, since Codex's `tool_response` carries no exit code.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTION_TABLES, actionOf, HOOK_TOOLS } from './actions.js';
import { denialOf, slugOf } from './allow.js';
import { CLAUDE_DIALECT, codexDialect, dialectOf, harnessFlag } from './hook-dialect.js';
import { indexPath, readIndex, type HookIndex } from './hook-index.js';
import { HOOK_EVENTS, runHook } from './hooks.js';
import { armOf, readRecalls } from './recall-object.js';
import { frameKeyOf, type Position, type RecoveryEdge } from './recall-next.js';
import { toolShapeId, type RecallRead } from './recall-reads.js';
import { deposit, paths } from './store.js';
import { callFailureOf, failureOfOutput } from './codex-rollout.js';
import { cleanup, NOW, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const REPO = 'work/app';
const KEY = 'shell.exec/1';
const SHAPE = toolShapeId('Bash', ['command']);
const edge = (next: string, followed: number): RecoveryEdge => ({ next, followed, of: 20, clusters: 1, readId: 'read:0123456789abcdef', day: '2026-11-01' });
const position: Position = { prefix: 'file.edit', n: 20, next: [['shell.exec', 12], ['file.read', 8]], clusters: 1, readId: 'read:aaaaaaaaaaaaaaaa', day: '2026-11-01' };
const fit: RecallRead = {
  readId: SHAPE,
  family: 'fit',
  tool: 'Bash',
  keys: ['command'],
  n: 40,
  count: 175,
  calls: 175,
  clusters: 1,
  firstDay: '2026-10-01',
  lastDay: '2026-10-30',
  harnesses: ['codex'],
  harnessVersions: ['0.169.0'],
  models: ['gpt-5.5'],
  followed: [['Read', 12]],
};

type Json = { [key: string]: unknown };
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const asRecord = (value: unknown): Json => (isRecord(value) ? value : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const answerOf = (output: string | undefined): Json => asRecord(JSON.parse(output ?? '{}'));
const specific = (output: string | undefined): Json => asRecord(answerOf(output).hookSpecificOutput);

/** A deposited store whose index carries the local reads under the Codex frame (version unknown) and the fit read for a `Bash` call. */
const staged = async (): Promise<Staged> => {
  const made = stage(slugOf(REPO));
  await deposit(made.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
  const index = await readIndex(made.storeDir);
  const reads: Partial<HookIndex> = { recoveryByFrame: { 'codex/*': { [KEY]: [edge('file.read', 12)] } }, positionsByFrame: { 'codex/*': [position] }, fit: { [SHAPE]: fit } };
  writeFileSync(indexPath(made.storeDir), JSON.stringify({ ...index, ...reads }));
  // The consent gate of the recording: the deposit above saved its own allow list, which names no `codex`.
  writeFileSync(paths(made.storeDir).state, JSON.stringify({ allow: [REPO, 'codex'] }));
  return made;
};

const sessionOn = (made: Staged, arm: 'shown' | 'held', key: string): string => {
  const at = asRecord(JSON.parse(readFileSync(indexPath(made.storeDir), 'utf8'))).at;
  for (let i = 0; i < 1000; i++) if (armOf(`c${String(i)}`, [key], String(at)) === arm) return `c${String(i)}`;
  throw new Error('no session found');
};

const codex = codexDialect('/nowhere');
const call = (made: Staged, event: 'session-start' | 'prompt' | 'pre-tool' | 'post-tool', payload: object, dialect = codex): Promise<string | undefined> =>
  runHook(event, JSON.stringify(payload), made.runtime, () => NOW, undefined, undefined, dialect);

/** A Codex rollout line: `{timestamp, type, payload}`. */
const rollout = (payload: Json, type = 'response_item'): string => JSON.stringify({ timestamp: '2026-11-21T00:00:00.000Z', type, payload });
const output = (callId: string, body: string): string => rollout({ type: 'function_call_output', call_id: callId, output: body });

/** A rollout file holding the lines, in the session's folder; returns its path. */
const rolloutFile = (made: Staged, lines: readonly string[]): string => {
  const file = join(made.root, 'rollout-2026-11-21T00-00-00-abc.jsonl');
  mkdirSync(made.root, { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
};

const FAILED = 'Process exited with code 1\nWall time: 0.1 seconds\nOutput:\nfatal: not a git repository';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const plugin = asRecord(JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')));

describe('the Codex hooks in the plugin manifest', () => {
  const extension = asRecord(asRecord(plugin.extensions)['com.openai']);
  const hooks = asRecord(asRecord(extension.hooks).hooks);

  it('registers SessionStart, UserPromptSubmit, PreToolUse, and PostToolUse, and nothing else', () => {
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'UserPromptSubmit']);
  });

  it('runs `oars-hook <event> --harness codex` alone: no POSIX-only guard, so cmd.exe and a POSIX shell run it alike', () => {
    const wanted: { [event: string]: string } = { SessionStart: 'session-start', UserPromptSubmit: 'prompt', PreToolUse: 'pre-tool', PostToolUse: 'post-tool' };
    for (const [event, hook] of Object.entries(wanted)) {
      const handler = asRecord(listOf(asRecord(listOf(hooks[event])[0]).hooks)[0]);
      expect(handler.type).toBe('command');
      expect(handler.command).toBe(`oars-hook ${hook} --harness codex`);
      expect(String(handler.command)).not.toMatch(/command -v|[;&|<>$`'"()\\]/);
      expect(typeof handler.timeout === 'number' && handler.timeout > 0 && handler.timeout <= 5).toBe(true);
      // The command is one this program accepts: the event is an oars-hook event and the flag names a dialect it has.
      expect(HOOK_EVENTS).toContain(hook);
      expect(harnessFlag(String(handler.command).split(' ').slice(1))).toBe('codex');
      expect(dialectOf('codex', {}, '/nowhere')?.harness).toBe('codex');
    }
  });

  it('keeps the hooks in the Codex namespace: the root manifest has no `hooks` of its own, and no root hooks/hooks.json exists for Claude Code (or a later harness) to load', () => {
    expect(plugin.hooks).toBeUndefined();
    expect(existsSync(join(root, 'hooks', 'hooks.json'))).toBe(false);
    expect(existsSync(join(root, 'hooks'))).toBe(false);
  });
});

describe('one invocation records and pushes', () => {
  it('writes the recording row and returns the recall answer for the same PostToolUse payload', async () => {
    const made = await staged();
    const sid = sessionOn(made, 'shown', KEY);
    const file = rolloutFile(made, [output('call_1', FAILED)]);
    const payload = { session_id: sid, turn_id: 't1', cwd: REPO, hook_event_name: 'PostToolUse', model: 'gpt-5.5', permission_mode: 'default', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'git status' }, tool_response: 'ok', transcript_path: file };
    const reply = await call(made, 'post-tool', payload);
    expect(specific(reply)).toMatchObject({ hookEventName: 'PostToolUse' });
    expect(String(specific(reply).additionalContext)).toContain('file.read x12');
    const rows = readFileSync(paths(made.storeDir).hookRows, 'utf8').trim().split('\n').map((line) => asRecord(JSON.parse(line)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'hook', harness: 'codex', kind: 'tool', session: sid, toolUseId: 'call_1', action: 'shell.exec' });
  });

  it('records a SessionStart and answers it in the same call, and records nothing for a prompt or a pre-tool call', async () => {
    const made = await staged();
    const start = await call(made, 'session-start', { session_id: 'live', cwd: REPO, hook_event_name: 'SessionStart', model: 'gpt-5.5', transcript_path: null });
    expect(specific(start).hookEventName).toBe('SessionStart');
    await call(made, 'prompt', { session_id: sessionOn(made, 'shown', 'positions'), cwd: REPO, hook_event_name: 'UserPromptSubmit', prompt: 'fix it' });
    await call(made, 'pre-tool', { session_id: 'live', cwd: REPO, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'c', tool_input: { command: 'ls' } });
    const rows = readFileSync(paths(made.storeDir).hookRows, 'utf8').trim().split('\n').map((line) => asRecord(JSON.parse(line)));
    expect(rows.map((row) => row.kind)).toEqual(['session']);
  });

  it('records nothing for a folder the saved list denies, and still answers', async () => {
    const made = await staged();
    writeFileSync(paths(made.storeDir).state, JSON.stringify({ allow: ['codex', denialOf(slugOf(REPO))] }));
    const start = await call(made, 'session-start', { session_id: 'live', cwd: REPO, hook_event_name: 'SessionStart' });
    expect(start).toBeDefined();
    expect(existsSync(paths(made.storeDir).hookRows)).toBe(false);
    // The same payload from a folder the list does not deny records.
    await call(made, 'session-start', { session_id: 'live', cwd: 'elsewhere/app', hook_event_name: 'SessionStart' });
    expect(readFileSync(paths(made.storeDir).hookRows, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('the answer, per event, in the shape Codex reads', () => {
  it('names the event in hookSpecificOutput for a session start, a prompt, a pre-tool push, and a failed command', async () => {
    const made = await staged();
    const start = specific(await call(made, 'session-start', { session_id: 'live', cwd: REPO, hook_event_name: 'SessionStart' }));
    expect(start.hookEventName).toBe('SessionStart');
    expect(String(start.additionalContext)).toContain('unexpected EOF while looking for matching');
    const prompt = answerOf(await call(made, 'prompt', { session_id: sessionOn(made, 'shown', 'positions'), cwd: REPO, hook_event_name: 'UserPromptSubmit', prompt: 'fix' }));
    expect(Object.keys(prompt)).toEqual(['hookSpecificOutput']);
    expect(asRecord(prompt.hookSpecificOutput).hookEventName).toBe('UserPromptSubmit');
    expect(String(asRecord(prompt.hookSpecificOutput).additionalContext)).toContain('file.edit');
    const push = specific(await call(made, 'pre-tool', { session_id: sessionOn(made, 'shown', SHAPE), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'c', tool_input: { command: 'ls' } }));
    expect(push.hookEventName).toBe('PreToolUse');
    expect(typeof push.additionalContext).toBe('string');
    const failed = specific(await call(made, 'post-tool', { session_id: sessionOn(made, 'shown', KEY), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'c', tool_input: { command: 'x' }, tool_response: 'x', transcript_path: rolloutFile(made, [output('c', FAILED)]) }));
    expect(failed.hookEventName).toBe('PostToolUse');
    expect(String(failed.additionalContext)).toContain('file.read x12');
  });

  it('tags every recall `codex`, reads the shell call through the codex table plus HOOK_TOOLS, and names no version', async () => {
    const made = await staged();
    await call(made, 'pre-tool', { session_id: sessionOn(made, 'shown', SHAPE), tool_name: 'Bash', tool_input: { command: 'ls' } });
    await call(made, 'post-tool', { session_id: sessionOn(made, 'shown', KEY), tool_name: 'Bash', tool_use_id: 'c', tool_response: 'x', transcript_path: rolloutFile(made, [output('c', FAILED)]) });
    const rows = await readRecalls(made.storeDir);
    expect(rows.map((row) => row.mode)).toEqual(['push', expect.any(String)]);
    for (const row of rows) expect(row.frame?.harness).toBe('codex');
    expect(frameKeyOf({ harness: 'codex', harnessVersion: null })).toBe('codex/*');
    // `Bash` is the hook's name for the shell tool; the rollout's table does not list it, so HOOK_TOOLS does.
    expect(ACTION_TABLES.codex.rows.Bash).toBeUndefined();
    expect(HOOK_TOOLS.get('Bash')).toBe('shell.exec');
    expect(actionOf(ACTION_TABLES.codex, 'exec_command').action).toBe('shell.exec');
  });

  it('holds a push back for a held session: no output, an exposure row for what it would have shown', async () => {
    const made = await staged();
    expect(await call(made, 'pre-tool', { session_id: sessionOn(made, 'held', SHAPE), tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeUndefined();
    expect((await readRecalls(made.storeDir)).map((row) => row.arm)).toEqual(['held']);
  });

  it('answers nothing, and never throws, for a payload with no session, no tool, no failure, or no JSON at all', async () => {
    const made = await staged();
    expect(await call(made, 'pre-tool', { tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeUndefined();
    expect(await call(made, 'post-tool', { session_id: sessionOn(made, 'shown', KEY), tool_response: 'x' })).toBeUndefined();
    expect(await runHook('post-tool', 'not json', made.runtime, () => NOW, undefined, undefined, codex)).toBeUndefined();
  });
});

describe('the failure Codex does not state', () => {
  const failing = async (lines: (id: string) => string[], over: Json = {}): Promise<{ made: Staged; reply: string | undefined }> => {
    const made = await staged();
    const sid = sessionOn(made, 'shown', KEY);
    const file = rolloutFile(made, lines('call_9'));
    const reply = await call(made, 'post-tool', { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call_9', tool_input: { command: 'git status' }, tool_response: 'x', transcript_path: file, ...over });
    return { made, reply };
  };

  it('answers a command whose rollout line carries a nonzero exit code, in either spelling of the header', async () => {
    expect(String(specific((await failing((id) => [output(id, FAILED)])).reply).additionalContext)).toContain('file.read x12');
    expect(String(specific((await failing((id) => [output(id, 'Exit code: 1\nWall time: 1 seconds\nOutput:\nboom')])).reply).additionalContext)).toContain('file.read x12');
  });

  it('answers nothing for a failed call whose output line is longer than the 64 KB tail (documented in harness-install.md): the line is cut at its start and cannot be read', async () => {
    const long = `Process exited with code 1\nOutput:\n${'x'.repeat(70_000)}`;
    expect((await failing((id) => [output(id, long)])).reply).toBeUndefined();
    // The same call with a line inside the tail is answered, so the silence above is the size and nothing else.
    expect(String(specific((await failing((id) => [output(id, `Process exited with code 1\nOutput:\n${'x'.repeat(1000)}`)])).reply).additionalContext)).toContain('file.read x12');
  });

  it('answers nothing for a command that exited 0, and a call that is still running', async () => {
    expect((await failing((id) => [output(id, 'Process exited with code 0\nWall time: 0.1 seconds\nOutput:\nok')])).reply).toBeUndefined();
    expect((await failing((id) => [output(id, 'Wall time: 1 seconds\nProcess running with session ID 7\nOutput:\n')])).reply).toBeUndefined();
  });

  it('answers nothing when the rollout has no line for the payload\'s call id, or the line is another call\'s', async () => {
    expect((await failing((id) => [output(`${id}-other`, FAILED)])).reply).toBeUndefined();
    expect((await failing(() => [rollout({ type: 'function_call', name: 'exec_command', call_id: 'call_9' })])).reply).toBeUndefined();
    expect((await failing((id) => [output(id, FAILED)], { tool_use_id: undefined })).reply).toBeUndefined();
  });

  it('answers nothing when the payload names no rollout, or the rollout is not there', async () => {
    expect((await failing((id) => [output(id, FAILED)], { transcript_path: null })).reply).toBeUndefined();
    expect((await failing((id) => [output(id, FAILED)], { transcript_path: join('no', 'such', 'rollout.jsonl') })).reply).toBeUndefined();
    expect((await failing((id) => [output(id, FAILED)], { transcript_path: root })).reply).toBeUndefined();
  });

  it('takes the newest line for the call id, and reads a body given as input_text items', async () => {
    const newest = await failing((id) => [output(id, FAILED), output(id, 'Process exited with code 0\nOutput:\nok')]);
    expect(newest.reply).toBeUndefined();
    const items = await failing((id) => [rollout({ type: 'function_call_output', call_id: id, output: [{ type: 'input_text', text: FAILED }, { type: 'input_text', text: '' }] })]);
    expect(String(specific(items.reply).additionalContext)).toContain('file.read x12');
  });

  it('skips a line that names the call but is not a function_call_output, or is not JSON', async () => {
    const mixed = await failing((id) => [output(id, FAILED), `{"torn": "${id}`, rollout({ type: 'reasoning', call_id: id }), 'not json call_9']);
    expect(String(specific(mixed.reply).additionalContext)).toContain('file.read x12');
  });

  it('does not read the rollout for a call that is not a shell call', async () => {
    expect((await failing((id) => [output(id, FAILED)], { tool_name: 'apply_patch' })).reply).toBeUndefined();
  });

  it('keeps a failure the payload itself carries, without reading the rollout', async () => {
    const made = await staged();
    const reply = await call(made, 'post-tool', { session_id: sessionOn(made, 'shown', KEY), tool_name: 'Bash', error: 'Exit code 1\nx' });
    expect(String(specific(reply).additionalContext)).toContain('file.read x12');
  });
});

describe('the exit line of a finished command', () => {
  it('is the failure text in the form the hooks read: `Exit code N`, then what the command printed', () => {
    expect(failureOfOutput('Process exited with code 1\nWall time: 1 seconds\nOutput:\nboom')).toBe('Exit code 1\nboom');
    expect(failureOfOutput('Exit code: 127\nOutput:\n')).toBe('Exit code 127\n');
  });

  it('is none for a zero exit, a header with no exit line, a body with no Output line, and an exit line inside the printed text', () => {
    expect(failureOfOutput('Process exited with code 0\nOutput:\nok')).toBeUndefined();
    expect(failureOfOutput('Wall time: 1 seconds\nOutput:\nboom')).toBeUndefined();
    expect(failureOfOutput('Process exited with code 1')).toBeUndefined();
    expect(failureOfOutput('Wall time: 1\nOutput:\nExit code: 1')).toBeUndefined();
  });

  it('stands a negative exit\'s message alone (it is no exit status), and keeps the line when there is no message', () => {
    expect(failureOfOutput('Process exited with code -1\nOutput:\nkilled by signal')).toBe('killed by signal');
    expect(failureOfOutput('Process exited with code -1\nOutput:\n')).toBe('Exit code -1\n');
  });

  it('reads the call from the rollout file, and is none for no file or no id', async () => {
    const made = stage();
    const file = rolloutFile(made, [output('a', FAILED)]);
    expect(await callFailureOf(file, 'a')).toBe('Exit code 1\nfatal: not a git repository');
    expect(await callFailureOf(undefined, 'a')).toBeUndefined();
    expect(await callFailureOf(file, undefined)).toBeUndefined();
  });
});

describe('the version a hook-call event states', () => {
  // A Codex rollout is not a Claude Code transcript: a line shaped like Claude's (`version`, `message.model`) in its tail must not become the event's harness version or model.
  const stated = async (dialect: typeof codex): Promise<object | undefined> => {
    const made = await staged();
    const file = rolloutFile(made, [JSON.stringify({ type: 'assistant', version: '9.9.9', message: { model: 'claude-opus-4-5' } })]);
    const events: object[] = [];
    await runHook('post-tool', JSON.stringify({ session_id: sessionOn(made, 'shown', KEY), tool_name: 'Bash', tool_use_id: 'c', tool_response: 'x', transcript_path: file }), made.runtime, () => NOW, undefined, (type, fields) => {
      if (type === 'hook') events.push(fields);
    }, dialect);
    return events[0];
  };

  it('takes nothing from a Claude-shaped line in a Codex rollout, and does take it under the Claude layout', async () => {
    const fromCodex = await stated(codex);
    expect(fromCodex).not.toHaveProperty('harnessVersion');
    expect(fromCodex).not.toHaveProperty('model');
    expect(await stated(CLAUDE_DIALECT)).toMatchObject({ harnessVersion: '9.9.9', model: 'claude-opus-4-5' });
  });
});
