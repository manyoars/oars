import { describe, expect, it } from 'vitest';
import { ACTION_TABLES, actionOf, CANONICAL_ACTIONS, mcpOf, shellOf, type ActionTable } from './actions.js';
import { captureSession } from './extract.js';
import { LITERAL } from './public-vocabulary.js';

const claude = ACTION_TABLES['claude-code'];
const cursor = ACTION_TABLES.cursor;

describe('the Claude Code table', () => {
  it.each([
    ['Read', 'file.read'],
    ['Edit', 'file.edit'],
    ['MultiEdit', 'file.edit'],
    ['NotebookEdit', 'file.edit'],
    ['Write', 'file.write'],
    ['Grep', 'file.search'],
    ['Glob', 'file.search'],
    ['Bash', 'shell.exec'],
    ['PowerShell', 'shell.exec'],
    ['WebSearch', 'web.search'],
    ['WebFetch', 'web.fetch'],
    ['Skill', 'skill.run'],
    ['Agent', 'agent.spawn'],
    ['TodoWrite', 'plan.update'],
    ['AskUserQuestion', 'ask.user'],
    ['mcp__oars__oars_recall', 'recall.pull'],
    ['ToolSearch', 'other'],
  ])('maps %s to %s and keeps the name', (native, action) => {
    expect(actionOf(claude, native)).toEqual({ action, native });
  });

  it('reads an MCP call as mcp.call, with the name held back from class P', () => {
    expect(actionOf(claude, 'mcp__claude-in-chrome__navigate')).toEqual({ action: 'mcp.call', native: LITERAL });
  });

  it('splits an MCP name in full, with no cut at 10 characters', () => {
    expect(mcpOf(claude, 'mcp__claude-in-chrome__tabs_context_mcp')).toEqual({ server: 'claude-in-chrome', tool: 'tabs_context_mcp' });
    expect(mcpOf(claude, 'Read')).toBeUndefined();
  });

  it('names the shell of its shell tools', () => {
    expect(shellOf(claude, 'Bash')).toBe('bash');
    expect(shellOf(claude, 'PowerShell')).toBe('powershell');
    expect(shellOf(claude, 'Read')).toBeNull();
  });
});

describe('a public Claude Code tool with no canonical action', () => {
  it('keeps its name', () => {
    expect(actionOf(claude, 'StructuredOutput')).toEqual({ action: 'other', native: 'StructuredOutput' });
  });
});

describe('the Cursor table', () => {
  it.each([
    ['read_file', 'file.read'],
    ['edit_file', 'file.edit'],
    ['search_replace', 'file.edit'],
    ['reapply', 'file.edit'],
    ['write', 'file.write'],
    ['run_terminal_cmd', 'shell.exec'],
    ['grep_search', 'file.search'],
    ['grep', 'file.search'],
    ['codebase_search', 'file.search'],
    ['file_search', 'file.search'],
    ['glob_file_search', 'file.search'],
    ['list_dir', 'file.search'],
    ['web_search', 'web.search'],
    ['todo_write', 'plan.update'],
  ])('maps %s to %s and keeps the name', (native, action) => {
    expect(actionOf(cursor, native)).toEqual({ action, native });
  });

  it('reads its own MCP spelling', () => {
    expect(actionOf(cursor, 'mcp_github_search_issues')).toEqual({ action: 'mcp.call', native: LITERAL });
    expect(mcpOf(cursor, 'mcp_github_search_issues')).toEqual({ server: 'github', tool: 'search_issues' });
  });

  it('does not claim to know the shell', () => {
    expect(shellOf(cursor, 'run_terminal_cmd')).toBeNull();
  });
});

describe('the Codex table', () => {
  it.each([
    ['shell', 'shell.exec'],
    ['shell_command', 'shell.exec'],
    ['exec_command', 'shell.exec'],
    ['local_shell', 'shell.exec'],
    ['container.exec', 'shell.exec'],
    ['Bash', 'shell.exec'],
    ['apply_patch', 'file.edit'],
    ['Edit', 'file.edit'],
    ['read_file', 'file.read'],
    ['update_plan', 'plan.update'],
  ])('maps %s to %s', (native, action) => {
    expect(actionOf(ACTION_TABLES.codex, native)).toEqual({ action, native });
  });

  it('reads an MCP call in full', () => {
    expect(actionOf(ACTION_TABLES.codex, 'mcp__private-server__tool').action).toBe('mcp.call');
    expect(mcpOf(ACTION_TABLES.codex, 'mcp__private-server__tool')).toEqual({ server: 'private-server', tool: 'tool' });
  });

  it('does not claim to know the shell', () => {
    expect(shellOf(ACTION_TABLES.codex, 'shell')).toBeNull();
  });
});

describe('every table', () => {
  it.each(Object.entries(ACTION_TABLES))('%s holds only canonical actions', (_harness, table) => {
    for (const action of Object.values(table.rows)) expect(CANONICAL_ACTIONS).toContain(action);
  });

  it.each(Object.entries(ACTION_TABLES))('%s maps an unknown name to other and holds it back', (_harness, table) => {
    expect(actionOf(table, 'AcmePrivateTool')).toEqual({ action: 'other', native: LITERAL });
  });

  it.each(Object.entries(ACTION_TABLES))('%s does not read a name off the object prototype', (_harness, table) => {
    expect(actionOf(table, 'constructor')).toEqual({ action: 'other', native: LITERAL });
    expect(shellOf(table, 'constructor')).toBeNull();
  });
});

describe('an adapter is rows', () => {
  it('needs nothing but a table to map a name no other harness has', () => {
    const table: ActionTable = { rows: { apply_patch: 'file.edit' }, mcp: null, toolDelimited: true, shells: {} };
    expect(actionOf(table, 'apply_patch')).toEqual({ action: 'file.edit', native: 'apply_patch' });
    expect(actionOf(table, 'mcp__x__y')).toEqual({ action: 'other', native: LITERAL });
  });
});

const line = (value: object): string => JSON.stringify(value);
const redact = (text: string): string => text;
const transcript = (block: object): string =>
  [
    line({ type: 'user', timestamp: '2026-05-29T04:30:00Z', message: { role: 'user', content: 'p' } }),
    line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', requestedModel: 'claude-opus-5-5', message: { role: 'assistant', content: [block] } }),
  ].join('\n');

describe('the step on a captured tool record', () => {
  it('carries the action, the native name, the position, and the frame of its prompt', () => {
    const result = captureSession({ text: transcript({ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } }), session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact });
    const steps = result.tools[0]?.steps;
    expect(steps).toHaveLength(1);
    expect(steps?.[0]).toMatchObject({ n: 0, seg: 0, action: 'file.edit', native: 'Edit', frameId: result.prompts[0]?.frameId });
  });

  it('takes the session frame before the first prompt', () => {
    const text = line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } });
    const result = captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact });
    expect(result.tools[0]?.prompt).toBeNull();
    expect(result.tools[0]?.steps?.[0]?.frameId).toBe(result.session.frameId);
  });

  it('reads the table of the harness it was told about, on the name the adapter kept', () => {
    const block = { type: 'tool_use', id: 't1', name: 'Read', native: 'read_file', input: { file_path: 'a.ts' } };
    const result = captureSession({ text: transcript(block), session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact, harness: 'cursor' });
    expect(result.tools[0]).toMatchObject({ tool: 'Read' });
    expect(result.tools[0]?.steps?.[0]).toMatchObject({ action: 'file.read', native: 'read_file' });
  });

  it('keeps the name it cannot place off the step, on the class A tool record', () => {
    const result = captureSession({ text: transcript({ type: 'tool_use', id: 't1', name: 'AcmePrivateTool', input: {} }), session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact });
    expect(result.tools[0]?.tool).toBe('AcmePrivateTool');
    expect(result.tools[0]?.steps?.[0]).toMatchObject({ action: 'other', native: LITERAL });
  });
});
