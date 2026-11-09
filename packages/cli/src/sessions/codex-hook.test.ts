import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { errorFlagOf, hookRowOf, runCodexHook } from './codex-hook.js';
import { AT, cleanHook, payloadOf, stageHook, type HookStore } from './codex-hook-support.js';

afterEach(cleanHook);

const run = async (store: HookStore, payload: object): Promise<void> => runCodexHook(JSON.stringify(payload), store.runtime);

describe('one row per event, from the recorded schema fixture', () => {
  it('a PostToolUse payload becomes a tool row keyed on the session and the tool use id', async () => {
    const store = stageHook();
    await run(store, payloadOf('PostToolUse', { tool_name: 'exec_command', tool_use_id: 'call_1', turn_id: 'turn_1', session_id: 'sess_1', tool_response: 'Exit code: 0\nOutput:\nsecret-output' }));
    const [row, ...rest] = store.rows();
    expect(rest).toEqual([]);
    expect(row).toEqual({
      v: 1,
      source: 'hook',
      harness: 'codex',
      kind: 'tool',
      at: new Date(AT).toISOString(),
      session: 'sess_1',
      turn: 'turn_1',
      toolUseId: 'call_1',
      agentId: null,
      action: 'shell.exec',
      tool: 'exec_command',
      argClass: ['command'],
      resultKind: 'string',
      error: 'no',
      usage: null,
      model: null,
      cwdClass: null,
      degraded: false,
      missing: [],
    });
  });

  it('a PostModelRequest payload becomes a token row keyed on the session and the turn', async () => {
    const store = stageHook();
    await run(store, payloadOf('PostModelRequest', { session_id: 'sess_1', turn_id: 'turn_2', model: 'gpt-5.1-codex' }));
    const [row] = store.rows();
    expect(row).toMatchObject({ kind: 'model', session: 'sess_1', turn: 'turn_2', toolUseId: null, model: 'gpt-5.1-codex', degraded: false, missing: [] });
    expect(row?.usage).toEqual({ input: 7, cacheRead: 7, cacheWrite: 7, output: 7, thinking: 7, total: 7 });
  });

  it('a SessionStart payload adds the working folder class and the model, never the path', async () => {
    const store = stageHook();
    await run(store, payloadOf('SessionStart', { session_id: 'sess_1', cwd: join(store.root, 'elsewhere'), model: 'gpt-5.1-codex' }));
    const [row] = store.rows();
    expect(row).toMatchObject({ kind: 'session', session: 'sess_1', model: 'gpt-5.1-codex', cwdClass: 'other', degraded: false });
    expect(readFileSync(join(store.storeDir, 'hook-rows.jsonl'), 'utf8')).not.toContain('elsewhere');
  });

  it('classes the working folder: the home folder, a repository, and none', () => {
    const inRepo = (cwd: string): string | null => (cwd === '/work/app' ? '/work/app' : null);
    expect(hookRowOf(payloadOf('SessionStart', { cwd: '/home/me' }), 'at', '/home/me', inRepo)?.cwdClass).toBe('home');
    expect(hookRowOf(payloadOf('SessionStart', { cwd: '/work/app' }), 'at', '/home/me', inRepo)?.cwdClass).toBe('repo');
    expect(hookRowOf(payloadOf('SessionStart', { cwd: undefined }), 'at', '/home/me', inRepo)).toMatchObject({ cwdClass: 'none', degraded: true, missing: ['cwd'] });
  });

  it('an event it does not record writes nothing', async () => {
    const store = stageHook();
    await run(store, payloadOf('PostToolUse', { hook_event_name: 'Stop' }));
    expect(store.rows()).toEqual([]);
    expect(store.notes()).toEqual([]);
  });

  it('stores a model name that is not plain as other, and no name for a tool no table lists', async () => {
    const store = stageHook();
    await run(store, payloadOf('PostToolUse', { tool_name: 'mcp__private__thing' }));
    await run(store, payloadOf('PostModelRequest', { model: 'my model with spaces' }));
    expect(store.rows().map((row) => [row.action, row.tool, row.model])).toEqual([
      ['mcp.call', '<literal>', null],
      [null, null, 'other'],
    ]);
  });
});

describe('the names a hook payload carries', () => {
  it('reads a Bash call as a shell call and keeps the name Bash', async () => {
    const store = stageHook();
    await run(store, payloadOf('PostToolUse', { tool_name: 'Bash' }));
    expect(store.rows()[0]).toMatchObject({ action: 'shell.exec', tool: 'Bash', degraded: false });
  });

  it('reads an apply_patch call as a file edit', async () => {
    const store = stageHook();
    await run(store, payloadOf('PostToolUse', { tool_name: 'apply_patch' }));
    expect(store.rows()[0]).toMatchObject({ action: 'file.edit', tool: 'apply_patch' });
  });

  it('stores a model named by a path as other, and an org/model name plain', () => {
    const models = ['/models/private.gguf', 'C:/models/x.gguf', '~/m.gguf', './m.gguf', 'a/b/c', 'org/model'];
    expect(models.map((model) => hookRowOf(payloadOf('PostModelRequest', { model }), 'at')?.model)).toEqual(['other', 'other', 'other', 'other', 'other', 'org/model']);
  });
});

describe('what a row never holds', () => {
  it('holds no prompt, command, output, or path, whatever the payload carries', async () => {
    const store = stageHook();
    await run(store, payloadOf('PostToolUse', { tool_input: { command: 'rm -rf PRIVATE-COMMAND' }, tool_response: 'Exit code: 1\nPRIVATE-OUTPUT', transcript_path: 'C:/PRIVATE-PATH/rollout.jsonl', cwd: 'C:/PRIVATE-CWD' }));
    await run(store, payloadOf('SessionStart', { cwd: 'C:/PRIVATE-CWD', prompt: 'PRIVATE-PROMPT' }));
    const text = readFileSync(join(store.storeDir, 'hook-rows.jsonl'), 'utf8');
    for (const secret of ['PRIVATE-COMMAND', 'PRIVATE-OUTPUT', 'PRIVATE-PATH', 'PRIVATE-CWD', 'PRIVATE-PROMPT']) expect(text).not.toContain(secret);
  });
});

describe('a Codex release that adds or drops a field', () => {
  it('ignores a field it does not know', async () => {
    const store = stageHook();
    await run(store, payloadOf('PostToolUse', { brand_new_field: { nested: 'value' }, tool_use_id: 'call_9' }));
    const [row] = store.rows();
    expect(row).toMatchObject({ toolUseId: 'call_9', degraded: false, missing: [] });
    expect(JSON.stringify(row)).not.toContain('brand_new_field');
  });

  it('writes a degraded row naming a missing field', async () => {
    const store = stageHook();
    const payload = payloadOf('PostToolUse');
    delete payload.tool_use_id;
    delete payload.tool_response;
    await run(store, payload);
    expect(store.rows()[0]).toMatchObject({ kind: 'tool', toolUseId: null, resultKind: 'absent', error: 'unknown', degraded: true, missing: ['tool_use_id', 'tool_response'] });
  });

  it('writes a degraded token row, with no counts, when token_usage is null or lacks a counter', async () => {
    const store = stageHook();
    await run(store, payloadOf('PostModelRequest', { token_usage: null }));
    await run(store, payloadOf('PostModelRequest', { token_usage: { input_tokens: 5, output_tokens: 'many' } }));
    const [none, partial] = store.rows();
    expect(none).toMatchObject({ usage: null, degraded: true, missing: ['token_usage'] });
    expect(partial?.usage).toMatchObject({ input: 5, output: null, total: null });
    expect(partial?.missing).toContain('token_usage.output_tokens');
  });

  it('names a missing session, turn, tool name, and tool input', () => {
    expect(hookRowOf({ hook_event_name: 'PostModelRequest', token_usage: {} }, 'at')?.missing.slice(0, 2)).toEqual(['session_id', 'turn_id']);
    expect(hookRowOf({ hook_event_name: 'SessionStart' }, 'at')?.missing).toEqual(['session_id', 'model', 'cwd']);
    expect(hookRowOf({ hook_event_name: 'PostToolUse' }, 'at')?.missing).toEqual(['session_id', 'turn_id', 'tool_use_id', 'tool_name', 'tool_input', 'tool_response']);
  });

  it('marks a subagent row with its agent id', async () => {
    const store = stageHook();
    await run(store, payloadOf('PostToolUse', { agent_id: 'agent_7', agent_type: 'worker' }));
    expect(store.rows()[0]).toMatchObject({ agentId: 'agent_7' });
  });
});

describe('the error flag', () => {
  it('is unknown unless the response carries an exit line', () => {
    expect(errorFlagOf('Exit code: 0\nOutput:\nok')).toBe('no');
    expect(errorFlagOf('Exit code: 3\nOutput:\nboom')).toBe('yes');
    expect(errorFlagOf('Process exited with code 1\nOutput:\n')).toBe('yes');
    expect(errorFlagOf('exit code -1\nOutput:\n')).toBe('yes');
    expect(errorFlagOf('Wall time 1 seconds\nOutput:\nthe exit code 3 was expected')).toBe('unknown');
    expect(errorFlagOf('no header here')).toBe('unknown');
    expect(errorFlagOf('Process exited with code 1')).toBe('unknown');
    expect(errorFlagOf({ exit_code: 1 })).toBe('unknown');
    expect(errorFlagOf(undefined)).toBe('unknown');
  });

  it('reads only the header before the first Output: line, so a line the command printed decides nothing', () => {
    expect(errorFlagOf('ok\nExit code: 0')).toBe('unknown');
    expect(errorFlagOf('Wall time 1\nOutput:\nExit code: 1')).toBe('unknown');
    expect(errorFlagOf('Exit code: 1\nOutput:\nExit code: 0')).toBe('yes');
  });

  it('records the kind of a response that is not a string', () => {
    const kinds = [null, [], {}, 5].map((tool_response) => hookRowOf(payloadOf('PostToolUse', { tool_response }), 'at')?.resultKind);
    expect(kinds).toEqual(['null', 'array', 'object', 'object']);
  });
});

describe('fail-open', () => {
  it('resolves and leaves no partial row when the append throws, with a masked note', async () => {
    const store = stageHook();
    const runtime = { ...store.runtime, append: () => Promise.reject(new Error(`ENOENT: cannot write ${store.home}/x`)) };
    await expect(runCodexHook(JSON.stringify(payloadOf('PostToolUse')), runtime)).resolves.toBeUndefined();
    expect(store.rows()).toEqual([]);
    const [note] = store.notes();
    expect(note).toMatchObject({ event: 'codex-record', hit: false });
    expect(String(note?.error)).not.toContain(store.home);
  });

  it('resolves with a note when the input is not JSON or not an object', async () => {
    const store = stageHook();
    await expect(runCodexHook('not json', store.runtime)).resolves.toBeUndefined();
    await expect(runCodexHook('[1]', store.runtime)).resolves.toBeUndefined();
    expect(store.rows()).toEqual([]);
    expect(store.notes()).toHaveLength(2);
  });

  it('notes a row it wrote, with the session and no error', async () => {
    const store = stageHook();
    await run(store, payloadOf('PostToolUse', { session_id: 'sess_1' }));
    expect(store.notes()).toMatchObject([{ event: 'codex-record', session: 'sess_1', hit: true, error: null }]);
  });
});
