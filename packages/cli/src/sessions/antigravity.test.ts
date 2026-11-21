import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTION_TABLES, actionOf, shellOf } from './actions.js';
import { antigravityCounts, antigravityLines, antigravityRoot, openAntigravityStore, transcriptBadLines } from './antigravity.js';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';
import { makeRepoIdentity, makeRepoRoot } from './repo-root.js';
import { cleanup, stage } from './test-support.js';

afterEach(cleanup);

// Every fixture is synthetic and follows only the SHAPE of an Antigravity `transcript_full.jsonl` record: `{step_index, type, source, status, created_at, content?, thinking?,
// error?, error_code?, tool_calls?[{name, args}]}`. Antigravity is closed source, so no vendor text is cited and no value from a real store is used.

const capture = (text: string) =>
  captureSession({
    text,
    harness: 'antigravity',
    session: 'antigravity-x',
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
const linesOf = (records: readonly unknown[]) => antigravityLines(asText(records), 'conv');
const extractOf = (records: readonly unknown[]) => capture(linesOf(records).map((entry) => JSON.stringify(entry)).join('\n'));

const T = (second: number): string => `2026-06-01T10:00:${String(second).padStart(2, '0')}.000Z`;
let index = 0;
const step = (type: string, source: string, second: number, extra: object = {}) => ({ step_index: (index += 1), type, source, status: 'DONE', created_at: T(second), ...extra });
const prompt = (second: number, content: string) => step('USER_INPUT', 'USER_EXPLICIT', second, { content });
const plan = (second: number, extra: object) => step('PLANNER_RESPONSE', 'MODEL', second, extra);
const done = (type: string, second: number, content: string, extra: object = {}) => step(type, 'MODEL', second, { content, ...extra });
const tool = (name: string, args: object) => ({ name, args });

describe('the Antigravity reader', () => {
  it('turns a conversation into prompts, the model turns, and each call with its result matched in order, with no model and no usage', () => {
    const records = [
      prompt(1, 'tidy the repo'),
      plan(2, {
        content: 'looking around',
        thinking: 'private reasoning',
        tool_calls: [tool('list_dir', { DirectoryPath: '/work/app' }), tool('view_file', { AbsolutePath: '/work/app/a.ts' }), tool('grep_search', { Query: 'x', SearchPath: '/work/app' })],
      }),
      done('LIST_DIRECTORY', 3, 'a.ts'),
      done('VIEW_FILE', 4, 'const a = 1;'),
      done('GREP_SEARCH', 5, 'a.ts:1'),
      step('CHECKPOINT', 'SYSTEM', 6, { content: 'summary' }),
      plan(7, { tool_calls: [tool('replace_file_content', { TargetFile: '/work/app/a.ts', TargetContent: 'a', ReplacementContent: 'b' }), tool('write_to_file', { TargetFile: '/work/app/b.md', CodeContent: 'x' })] }),
      done('CODE_ACTION', 8, 'edited'),
      done('CODE_ACTION', 9, 'created'),
      plan(10, { content: 'all done' }),
    ];
    const out = extractOf(records);
    expect(out.session.userTurns).toBe(1);
    expect(out.session.assistantTurns).toBe(3);
    expect(out.session.models).toEqual({});
    expect(out.tools.map((entry) => [entry.tool, entry.status])).toEqual([
      ['list_dir', 'ok'],
      ['Read', 'ok'],
      ['Grep', 'ok'],
      ['Edit', 'ok'],
      ['Write', 'ok'],
    ]);
    expect(out.session.files).toEqual(expect.arrayContaining(['/work/app/a.ts', '/work/app/b.md']));
    expect(out.errorLines).toEqual([]);
    expect(out.session.tsFirst).toBe(T(1));
    const lines = linesOf(records);
    expect(lines.some((entry) => JSON.stringify(entry).includes('private reasoning'))).toBe(false);
    expect(lines.some((entry) => JSON.stringify(entry).includes('"usage"'))).toBe(false);
  });

  it.each([
    ['view_file', { AbsolutePath: '/w/a.ts' }, 'VIEW_FILE', 'Read'],
    ['grep_search', { Query: 'x', SearchPath: '/w' }, 'GREP_SEARCH', 'Grep'],
    ['search_web', { query: 'q' }, 'SEARCH_WEB', 'WebSearch'],
    ['read_url_content', { Url: 'https://example.com' }, 'READ_URL_CONTENT', 'WebFetch'],
    ['write_to_file', { TargetFile: '/w/a.ts', CodeContent: 'x' }, 'CODE_ACTION', 'Write'],
    ['replace_file_content', { TargetFile: '/w/a.ts' }, 'CODE_ACTION', 'Edit'],
    ['multi_replace_file_content', { TargetFile: '/w/a.ts', ReplacementChunks: [] }, 'CODE_ACTION', 'Edit'],
    ['run_command', { CommandLine: 'npm test', Cwd: '/w' }, 'RUN_COMMAND', 'Bash'],
    ['invoke_subagent', { Subagents: [{ Name: 'helper' }] }, 'INVOKE_SUBAGENT', 'invoke_subagent'],
    ['send_message', { Recipient: 'helper', Message: 'hi' }, 'GENERIC', 'send_message'],
    ['list_dir', { DirectoryPath: '/w' }, 'LIST_DIRECTORY', 'list_dir'],
  ] as const)('reads %s and its %s step as one %s call', (native, args, result, name) => {
    const out = extractOf([prompt(1, 'go'), plan(2, { tool_calls: [tool(native, args)] }), done(result, 3, 'ok')]);
    expect(out.tools.map((entry) => [entry.tool, entry.status])).toEqual([[name, 'ok']]);
  });

  it('runs a command in PowerShell when the paths are written the Windows way', () => {
    const out = extractOf([prompt(1, 'go'), plan(2, { tool_calls: [tool('run_command', { CommandLine: 'dir', Cwd: 'C:\\work\\app' })] }), done('RUN_COMMAND', 3, 'listing')]);
    expect(out.tools.map((entry) => [entry.tool, entry.status])).toEqual([['PowerShell', 'ok']]);
    const bare = linesOf([prompt(1, 'go'), plan(2, { tool_calls: [tool('run_command', {})] }), done('RUN_COMMAND', 3, 'listing')]);
    expect(JSON.stringify(bare)).toContain('"name":"Bash"');
  });

  it('leaves the call of a RUNNING last step with no result, so its outcome is unknown', () => {
    const out = extractOf([prompt(1, 'serve it'), plan(2, { tool_calls: [tool('run_command', { CommandLine: 'npm start', Cwd: '/w' })] }), done('RUN_COMMAND', 3, 'listening', { status: 'RUNNING' })]);
    expect(out.tools).toMatchObject([{ tool: 'Bash', status: 'none' }]);
  });

  it('reads an error step as the failure of the call waiting for it, and as no turn when none waits', () => {
    const failed = extractOf([prompt(1, 'x'), plan(2, { tool_calls: [tool('view_file', { AbsolutePath: '/w/missing.ts' })] }), step('ERROR_MESSAGE', 'SYSTEM', 3, { error: 'file not found', error_code: 404 })]);
    expect(failed.tools).toMatchObject([{ tool: 'Read', status: 'error' }]);
    expect(failed.errorLines).toMatchObject([{ tool: 'Read', line: 'file not found' }]);
    const bare = linesOf([prompt(1, 'x'), step('ERROR_MESSAGE', 'SYSTEM', 2, { error: 'model overloaded' })]);
    expect(bare).toHaveLength(1);
    const noText = extractOf([prompt(1, 'x'), plan(2, { tool_calls: [tool('run_command', { CommandLine: 'x' })] }), step('ERROR_MESSAGE', 'SYSTEM', 3, {})]);
    expect(noText.errorLines).toMatchObject([{ line: 'tool failed' }]);
    const fromContent = extractOf([prompt(1, 'x'), plan(2, { tool_calls: [tool('run_command', { CommandLine: 'x' })] }), step('ERROR_MESSAGE', 'SYSTEM', 3, { content: 'denied' })]);
    expect(fromContent.errorLines).toMatchObject([{ line: 'denied' }]);
  });

  it('keeps a subagent call as an agent spawn with its result', () => {
    const out = extractOf([prompt(1, 'split it'), plan(2, { tool_calls: [tool('invoke_subagent', { Subagents: [{ Name: 'helper' }] }), tool('send_message', { Recipient: 'helper', Message: 'start' })] }), done('INVOKE_SUBAGENT', 3, 'finished'), done('GENERIC', 4, 'sent')]);
    expect(out.tools.map((entry) => [entry.tool, entry.status])).toEqual([['invoke_subagent', 'ok'], ['send_message', 'ok']]);
  });

  it('keeps an unknown tool, an unknown step type, and a tool step with no waiting call as generic calls, never dropping them', () => {
    const records = [
      prompt(1, 'go'),
      plan(2, { tool_calls: [tool('teleport', { Where: 'moon' })] }),
      done('GENERIC', 3, 'arrived'),
      done('BRAND_NEW_STEP', 4, 'something'),
      done('VIEW_FILE', 5, 'a result whose call the file left out'),
      step('BRAND_NEW_SYSTEM', 'SYSTEM', 6, { content: 'note' }),
    ];
    const out = extractOf(records);
    expect(out.tools.map((entry) => [entry.tool, entry.status])).toEqual([['teleport', 'ok'], ['brand_new_step', 'ok'], ['view_file', 'ok'], ['brand_new_system', 'ok']]);
    expect(antigravityCounts(asText(records))).toMatchObject({ steps: 6, unknownTypes: 2, tools: { teleport: 1 } });
  });

  it('skips the harness own steps and empty prompts, and names an empty plan nothing', () => {
    const lines = linesOf([
      step('USER_INPUT', 'USER_EXPLICIT', 1, { content: '  ' }),
      step('CONVERSATION_HISTORY', 'SYSTEM', 2, {}),
      step('EPHEMERAL_MESSAGE', 'SYSTEM', 3, { content: 'x' }),
      step('SYSTEM_MESSAGE', 'SYSTEM', 4, { content: 'x' }),
      plan(5, { thinking: 'only a thought' }),
      plan(6, { tool_calls: [{ args: {} }, { name: 'view_file' }] }),
    ]);
    expect(lines.map((entry) => entry.type)).toEqual(['assistant']);
  });

  it('orders by the file, tolerates a step_index that skips and a missing one, and carries a time forward over a bad one', () => {
    const lines = linesOf([
      { type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', created_at: T(5), content: 'one' },
      { step_index: 40, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', created_at: 'not a time', content: 'two' },
      { step_index: 2, type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'three' },
    ]);
    expect(lines.map((entry) => entry.timestamp)).toEqual([T(5), T(5), T(5)]);
    expect(lines.map((entry) => entry.type)).toEqual(['user', 'assistant', 'assistant']);
    expect(linesOf([{ type: 'USER_INPUT', content: 'no time at all' }])[0]?.timestamp).toBe(new Date(0).toISOString());
  });

  it('reads past a line that is not JSON, a record with no type, and a non-object, and reports the torn lines', () => {
    const text = [JSON.stringify(prompt(1, 'hello')), '{"torn":', '', '[1]', JSON.stringify({ step_index: 9 })].join('\n');
    expect(antigravityLines(text, 'conv')).toHaveLength(1);
    expect(transcriptBadLines(text)).toEqual(['{"torn":']);
    expect(antigravityCounts(text)).toMatchObject({ steps: 2, types: { USER_INPUT: 1, none: 1 } });
  });

  it('counts types and the tools a conversation calls', () => {
    const text = asText([prompt(1, 'x'), plan(2, { tool_calls: [tool('view_file', {}), { args: {} }] }), done('VIEW_FILE', 3, 'y'), step('CHECKPOINT', 'SYSTEM', 4, {}), step('ERROR_MESSAGE', 'SYSTEM', 5, { error: 'e' })]);
    expect(antigravityCounts(text)).toEqual({
      steps: 5,
      types: { USER_INPUT: 1, PLANNER_RESPONSE: 1, VIEW_FILE: 1, CHECKPOINT: 1, ERROR_MESSAGE: 1 },
      unknownTypes: 0,
      tools: { view_file: 1, none: 1 },
    });
  });
});

describe('the Antigravity action table', () => {
  it.each([
    ['view_file', 'file.read'],
    ['list_dir', 'file.search'],
    ['grep_search', 'file.search'],
    ['write_to_file', 'file.write'],
    ['replace_file_content', 'file.edit'],
    ['multi_replace_file_content', 'file.edit'],
    ['run_command', 'shell.exec'],
    ['PowerShell', 'shell.exec'],
    ['search_web', 'web.search'],
    ['read_url_content', 'web.fetch'],
    ['invoke_subagent', 'agent.spawn'],
    ['send_message', 'other'],
  ] as const)('maps %s to %s', (native, action) => {
    expect(actionOf(ACTION_TABLES.antigravity, native)).toEqual({ action, native });
  });

  it('files a tool it does not list as other, and names the shells', () => {
    expect(actionOf(ACTION_TABLES.antigravity, 'teleport').action).toBe('other');
    expect(shellOf(ACTION_TABLES.antigravity, 'run_command')).toBe('bash');
    expect(shellOf(ACTION_TABLES.antigravity, 'PowerShell')).toBe('powershell');
  });
});

describe('the Antigravity root', () => {
  it('is the override when set, else .gemini/antigravity under the home', () => {
    expect(antigravityRoot({ ANTIGRAVITY_HOME: '/custom/ag' }, '/home/u')).toBe('/custom/ag');
    expect(antigravityRoot({ ANTIGRAVITY_HOME: '' }, '/home/u')).toBe(join('/home/u', '.gemini', 'antigravity'));
    expect(antigravityRoot({}, '/home/u')).toBe(join('/home/u', '.gemini', 'antigravity'));
    expect(antigravityRoot({}).endsWith(join('.gemini', 'antigravity'))).toBe(true);
  });
});

const write = (root: string, id: string, text: string, when?: number): string => {
  const dir = join(root, 'brain', id, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'transcript_full.jsonl');
  writeFileSync(file, text);
  if (when !== undefined) utimesSync(file, when, when);
  return file;
};

describe('the Antigravity store', () => {
  it('lists each conversation oldest first with no folder, and hands back its transcript with the torn lines kept', async () => {
    const { root } = stage();
    const ag = join(root, 'ag');
    write(ag, 'conv-b', `${asText([prompt(1, 'second')])}\n{"torn":\n`, 2000);
    write(ag, 'conv-a', asText([prompt(1, 'first'), plan(2, { content: 'reply' })]), 1000);
    const store = await openAntigravityStore(ag);
    expect(store?.sessions.map((session) => session.id)).toEqual(['conv-a', 'conv-b']);
    const second = store?.sessions[1];
    expect(store?.sessions[0]?.size).toBeGreaterThan(0);
    expect(second).toBeDefined();
    const text = second === undefined ? '' : await store?.transcript(second);
    expect(text?.trimEnd().split('\n')).toHaveLength(2);
    expect(text?.endsWith('{"torn":\n')).toBe(true);
    expect(store).toMatchObject({ rejected: 0, shapeMoved: 0, unreadable: [] });
  });

  it('is absent with no brain folder, and skips a conversation with no transcript, an unsafe id, an empty file, and a file whose records moved', async () => {
    const { root } = stage();
    expect(await openAntigravityStore(join(root, 'nothing'))).toBeUndefined();
    const ag = join(root, 'ag');
    mkdirSync(join(ag, 'brain', 'no-transcript'), { recursive: true });
    writeFileSync(join(ag, 'brain', 'a-file'), 'not a folder');
    write(ag, 'bad id', asText([prompt(1, 'x')]));
    write(ag, 'empty', '');
    write(ag, 'moved', `${JSON.stringify({ kind: 'USER_INPUT', body: 'x' })}\n`);
    write(ag, 'only-system', asText([step('CHECKPOINT', 'SYSTEM', 1, { content: 'x' })]));
    const store = await openAntigravityStore(ag);
    expect(store?.sessions).toEqual([]);
    expect(store).toMatchObject({ rejected: 1, shapeMoved: 1, unreadable: [] });
  });

  it('reports a brain folder it cannot list or a transcript it cannot read, without a path in the reason', async () => {
    const { root } = stage();
    const home = join(root, 'ag-file');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'brain'), 'x');
    const broken = await openAntigravityStore(home);
    expect(broken?.sessions).toEqual([]);
    expect(broken?.unreadable).toHaveLength(1);
    expect(broken?.unreadable[0]?.reason).not.toContain(root);
    await expect(broken?.transcript({ id: 'x', file: 'x', size: 0, mtimeMs: 0 })).rejects.toThrow('no sessions');
    const ag = join(root, 'ag');
    mkdirSync(join(ag, 'brain', 'a-dir', '.system_generated', 'logs', 'transcript_full.jsonl'), { recursive: true });
    const store = await openAntigravityStore(ag);
    expect(store?.sessions).toEqual([]);
    expect(store?.unreadable).toHaveLength(1);
    expect(store?.unreadable[0]?.reason).not.toContain(root);
  });
});
