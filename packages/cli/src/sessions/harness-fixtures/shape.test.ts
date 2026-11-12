import { describe, expect, it } from 'vitest';
import { compareShapes, fieldSet, render } from './shape.mjs';

const SECRET = 'sk-live-SECRET-value-0123456789';
const PATH_KEY = '/home/alice/private/project.ts';

describe('the shape tool', () => {
  it('lists the paths and types the session file has and the fixture lacks, and the reverse', () => {
    const fixture = '{"type":"user","message":{"text":"hi"}}\n{"type":"tool","old":1}\n';
    const session = '{"type":"user","message":{"text":"hi","model":"m"}}\n{"type":"tool","calls":[{"id":3}]}\n';
    expect(compareShapes(session, fixture)).toEqual({
      onlyInSession: ['calls: array', 'calls[].id: number', 'calls[]: object', 'message.model: string'],
      onlyInFixture: ['old: number'],
    });
  });

  it('reads one JSON document as well as JSON lines, skips a broken line, and types null and boolean', () => {
    expect([...fieldSet('{"a":null,"b":true}')].sort()).toEqual(['(root): object', 'a: null', 'b: boolean']);
    expect([...fieldSet('{"a":1}\nnot json\n\n{"b":[]}')].sort()).toEqual(['(root): object', 'a: number', 'b: array']);
  });

  it('prints no value, and prints a key that is not a plain identifier as *', () => {
    const session = JSON.stringify({ token: SECRET, [PATH_KEY]: { nested: SECRET }, 'tool-name with spaces': 1, list: [SECRET] });
    const out = render(compareShapes(session, '{}'));
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('alice');
    expect(out).not.toContain(PATH_KEY);
    expect(out).not.toContain('spaces');
    expect(out).toContain('token: string');
    expect(out).toContain('*: object');
    expect(out).toContain('*.nested: string');
    expect(out).toContain('list[]: string');
  });

  it('prints a 42-character identifier as *', () => {
    const key = `a${'b'.repeat(41)}`;
    expect(render(compareShapes(JSON.stringify({ [key]: 1 }), '{}'))).not.toContain(key);
  });
});
