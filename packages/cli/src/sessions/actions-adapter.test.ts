import { describe, expect, it, vi } from 'vitest';
import type * as Actions from './actions.js';
import { captureSession } from './extract.js';

// The proof that an adapter is rows only: the real extractor runs and the only thing that differs is one harness's table, here holding names no adapter has today.
vi.mock('./actions.js', async (original) => {
  const actual = await original<typeof Actions>();
  return { ...actual, ACTION_TABLES: { ...actual.ACTION_TABLES, cursor: { rows: { apply_patch: 'file.edit', exec_command: 'shell.exec' }, mcp: null, toolDelimited: true, shells: { exec_command: 'zsh' } } } };
});

const line = (value: object): string => JSON.stringify(value);

describe('a new adapter', () => {
  it('maps its names, and names its shell, with no change to the extractor', () => {
    const text = [
      line({ type: 'user', timestamp: '2026-05-29T04:30:00Z', message: { role: 'user', content: 'p' } }),
      line({ type: 'assistant', timestamp: '2026-05-29T04:30:01Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'apply_patch', input: {} }, { type: 'tool_use', id: 't2', name: 'exec_command', input: {} }] } }),
    ].join('\n');
    const result = captureSession({ text, session: 's', project: 'p', rev: 1, at: 'x', bytes: 1, redact: (value) => value, harness: 'cursor' });
    expect(result.tools.map((tool) => tool.steps?.[0]?.action)).toEqual(['file.edit', 'shell.exec']);
    expect(result.tools.map((tool) => tool.steps?.[0]?.native)).toEqual(['apply_patch', 'exec_command']);
    expect(result.prompts[0]?.frame).toMatchObject({ harness: 'cursor', shell: 'zsh' });
  });
});
