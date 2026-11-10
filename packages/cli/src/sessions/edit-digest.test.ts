// An edit that restores earlier content is detectable: every Edit, Write, and MultiEdit call carries a digest of its old and new text, and a `git restore` keeps the path it names. Every text here is invented.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { captureSession } from './extract.js';
import { makeRedactor } from './redact.js';

const redact = makeRedactor();
const line = (type: string, content: unknown, cwd = '/w'): string => JSON.stringify({ type, timestamp: '2026-06-10T00:00:00.000Z', cwd, message: { role: type, model: 'claude-opus-5-5', content } });
const call = (id: string, name: string, input: object, cwd = '/w'): string => line('assistant', [{ type: 'tool_use', id, name, input }], cwd);
const captured = (...lines: string[]) => captureSession({ text: [line('user', 'go'), ...lines].join('\n'), session: 's1', project: 'p', rev: 1, at: '', bytes: 0, redact, harness: 'claude-code' });
const digestOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);

describe('the digest of an edit', () => {
  it('holds one old and new pair for an Edit, over the exact text', () => {
    const [tool] = captured(call('e1', 'Edit', { file_path: '/w/a.ts', old_string: 'let a = 1;', new_string: 'let a = 2;' })).tools;
    expect(tool?.digests).toEqual([{ old: digestOf('let a = 1;'), new: digestOf('let a = 2;') }]);
    expect(tool?.digests?.[0]?.old).toMatch(/^[0-9a-f]{32}$/);
  });

  it('reads a line ending, trailing space, and a multibyte character as a difference', () => {
    const [lf, crlf, spaced, accent] = ['a\nb', 'a\r\nb', 'a\nb ', 'café'].map((text, at) => captured(call(`e${String(at)}`, 'Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: text })).tools[0]?.digests?.[0]?.new);
    expect(new Set([lf, crlf, spaced, accent]).size).toBe(4);
    expect(accent).toBe(digestOf('café'));
  });

  it('holds the digest of an empty new text: a deletion is text', () => {
    const [tool] = captured(call('e1', 'Edit', { file_path: '/w/a.ts', old_string: 'gone', new_string: '' })).tools;
    expect(tool?.digests).toEqual([{ old: digestOf('gone'), new: digestOf('') }]);
  });

  it('holds one pair per edit of a MultiEdit, in order', () => {
    const edits = [{ old_string: 'one', new_string: 'two' }, { old_string: 'three', new_string: 'four', replace_all: true }, { old_string: 'two', new_string: 'one' }];
    const [tool] = captured(call('m1', 'MultiEdit', { file_path: '/w/a.ts', edits })).tools;
    expect(tool?.digests).toEqual([
      { old: digestOf('one'), new: digestOf('two') },
      { old: digestOf('three'), new: digestOf('four') },
      { old: digestOf('two'), new: digestOf('one') },
    ]);
  });

  it('holds only a new digest for a Write, never the digest of an empty string', () => {
    const [tool] = captured(call('w1', 'Write', { file_path: '/w/a.ts', content: 'export {};\n' })).tools;
    expect(tool?.digests).toEqual([{ new: digestOf('export {};\n') }]);
    expect(Object.keys(tool?.digests?.[0] ?? {})).toEqual(['new']);
    // An empty file is the digest of nothing, and it is still a new digest only.
    expect(captured(call('w2', 'Write', { file_path: '/w/b.ts', content: '' })).tools[0]?.digests).toEqual([{ new: digestOf('') }]);
  });

  it('holds none for any other tool, and none for an edit with no text', () => {
    const tools = captured(
      call('r1', 'Read', { file_path: '/w/a.ts' }),
      call('b1', 'Bash', { command: 'echo old_string' }),
      call('g1', 'Grep', { pattern: 'old_string', path: '/w' }),
      call('e1', 'Edit', { file_path: '/w/a.ts' }),
      call('m1', 'MultiEdit', { file_path: '/w/a.ts', edits: [{ old_string: 'x' }, 7, null] }),
      call('w1', 'Write', { file_path: '/w/a.ts' }),
    ).tools;
    expect(tools.map((tool) => tool.digests)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(tools.some((tool) => 'digests' in tool)).toBe(false);
  });
});
