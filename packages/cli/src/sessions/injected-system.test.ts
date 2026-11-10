// t1111 Item 1: a request blob with the system role carries the harness's own text, and the same block must get the marker its attachment record gets.
// Every fixture is made up filler; no real instruction text, path, or name is in this file.
import { describe, expect, it } from 'vitest';
import { injectedRule, type JsonObject } from './injected.js';

const KEY = 'test-key-system';
const MARK = /\[injected ([a-z0-9-]+) ([0-9a-f]{12})\]/;
const run = (line: JsonObject): JsonObject => injectedRule(KEY)(line);
const text = (value: unknown): string => JSON.stringify(value);
const at = (value: unknown, ...path: Array<string | number>): unknown => path.reduce((found, step) => (typeof found === 'object' && found !== null ? Reflect.get(found, step) : undefined), value);
const blob = (body: string, role = 'system'): JsonObject => ({ type: 'api-request-blob', hash: 'h1', message: { role, content: [{ type: 'text', text: body }, { type: 'text', text: 'typed words' }] } });
const blobText = (out: JsonObject): unknown => at(out, 'message', 'content', 0, 'text');
const attached = (type: string, body: string): JsonObject => ({ type: 'attachment', attachment: { type, content: body } });
const attachedText = (out: JsonObject): unknown => at(out, 'attachment', 'content');

const FORMS: ReadonlyArray<{ form: string; attachment: string; kind: string; body: string }> = [
  { form: 'the SessionStart hook output', attachment: 'hook_additional_context', kind: 'hook-additional-context', body: 'SessionStart hook additional context: lamp recall: the blue lamp stays lit, and the green kettle waits on shelf nine.' },
  { form: 'the skill listing', attachment: 'skill_listing', kind: 'skill-listing', body: 'The following skills are available for use with the Skill tool:\n\n- lamp-polish: polish the blue lamp\n- kettle-fill: fill the green kettle' },
  { form: 'the agent roster', attachment: 'agent_listing_delta', kind: 'agent-listing-delta', body: 'Available agent types for the Agent tool:\n- lamp-keeper: keeps the blue lamp lit' },
  { form: 'the environment block', attachment: 'environment', kind: 'environment', body: '# Environment\nYou have been invoked in the following environment:\n - Primary working directory: C:\Users\nobody\lamps\n - Platform: win32' },
  { form: 'the MCP server instructions', attachment: 'mcp_instructions_delta', kind: 'mcp-instructions-delta', body: '# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n## lamp\nAlways dim the lamp first.' },
  { form: 'a rules file block', attachment: 'instructions', kind: 'instructions', body: 'Contents of C:\Users\nobody\lamps\.claude\rules\lamps.md (project instructions, checked into the codebase):\n\nKeep the blue lamp lit.' },
  { form: 'a rules file block on a Unix path', attachment: 'instructions', kind: 'instructions', body: 'Contents of /home/nobody/lamps/.claude/rules/lamps.md (project instructions, checked into the codebase):\n\nKeep the blue lamp lit.' },
];

describe('a system-role request blob', () => {
  for (const { form, attachment, kind, body } of FORMS) {
    it(`marks ${form} under the marker its attachment copy gets`, () => {
      const out = blobText(run(blob(body)));
      expect(out).toMatch(new RegExp(`^\[injected ${kind} [0-9a-f]{12}\]$`));
      expect(out).toBe(attachedText(run(attached(attachment, body))));
      expect(text(run(blob(body)))).not.toContain('lamp');
    });
  }

  it('marks a string content as it marks a block', () => {
    const line: JsonObject = { type: 'api-request-blob', message: { role: 'system', content: FORMS[3]?.body ?? '' } };
    expect(at(run(line), 'message', 'content')).toMatch(MARK);
  });

  it('leaves the words typed beside it, a system text with no such form, and a non-system blob', () => {
    expect(at(run(blob(FORMS[1]?.body ?? '')), 'message', 'content', 1, 'text')).toBe('typed words');
    const plain = blob('Plain words about nothing in particular.');
    expect(run(plain)).toBe(plain);
    const user = blob(FORMS[3]?.body ?? '', 'user');
    expect(run(user)).toBe(user);
  });
});

describe('memory-file text', () => {
  const SNIPPET = '1\t- violet-otter memory: the kettle lives on shelf nine';
  const edited = (filename: string, snippet = SNIPPET): JsonObject => ({ type: 'attachment', attachment: { type: 'edited_text_file', filename, snippet } });

  it('marks the snippet of an edited CLAUDE.md, MEMORY.md, or memory/*.md, and keeps the file name', () => {
    for (const name of ['C:\Users\nobody\lamps\CLAUDE.md', '/home/nobody/.claude/projects/x/memory/MEMORY.md', 'C:\Users\nobody\.claude\projects\x\memory\feedback_lamp.md']) {
      const out = run(edited(name));
      expect(at(out, 'attachment', 'snippet')).toMatch(/^\[injected memory-file [0-9a-f]{12}\]$/);
      expect(at(out, 'attachment', 'filename')).toBe(name);
      expect(text(out)).not.toContain('violet-otter');
    }
  });

  it('marks the rendered copy of such a record', () => {
    const out = run({ ...edited('/home/nobody/lamps/CLAUDE.md'), rendered: [{ role: 'user', content: `Note: /home/nobody/lamps/CLAUDE.md was modified.\n${SNIPPET}` }] });
    expect(text(out)).not.toContain('violet-otter');
    expect(text(at(out, 'rendered'))).toMatch(MARK);
  });

  it('leaves the snippet of an edited file that is no memory file', () => {
    const other = edited('/home/nobody/lamps/src/parse.ts', 'const lamp = 1;');
    expect(run(other)).toBe(other);
    const bare: JsonObject = { type: 'attachment', attachment: { type: 'edited_text_file', snippet: 'const lamp = 1;' } };
    expect(run(bare)).toBe(bare);
  });

  it('marks a "changed on disk" system message and a system blob that names a memory file', () => {
    const message = 'Note: /home/nobody/lamps/CLAUDE.md changed on disk since it was read.\n1\tviolet-otter memory: the kettle lives on shelf nine';
    const system: JsonObject = { type: 'system', subtype: 'file_changed', content: message };
    expect(at(run(system), 'content')).toMatch(/^\[injected memory-file [0-9a-f]{12}\]$/);
    expect(blobText(run(blob(message)))).toMatch(/^\[injected memory-file [0-9a-f]{12}\]$/);
    const plain: JsonObject = { type: 'system', subtype: 'informational', content: 'The lamp changed on disk.' };
    expect(run(plain)).toBe(plain);
  });
});
