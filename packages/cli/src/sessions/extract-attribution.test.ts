// What a call records about who made it (t867): the model and the skill of the line it sits on, so a step can be attributed past its prompt. Every name here is invented.
import { describe, expect, it } from 'vitest';
import { captureSession, type Capture } from './extract.js';
import { makeRedactor } from './redact.js';

const redact = makeRedactor();
const line = (type: string, content: unknown, extra: object = {}, model = 'model-a'): string =>
  JSON.stringify({ type, timestamp: '2026-06-10T00:00:00.000Z', cwd: '/w', message: { role: type === 'assistant' ? 'assistant' : 'user', model, content }, ...extra });
const user = (text: string): string => line('user', text);
const call = (id: string, name: string, input: object, extra: object = {}, model = 'model-a'): string => line('assistant', [{ type: 'tool_use', id, name, input }], extra, model);
const read = (id: string, extra: object = {}, model = 'model-a'): string => call(id, 'Read', { file_path: 'a.txt' }, extra, model);
const capture = (lines: readonly string[]): Capture => captureSession({ text: lines.join('\n'), session: 's', project: 'p', rev: 1, at: '', bytes: 0, redact });

describe('the model of a call', () => {
  it('is the model of the line the call sits on, so a change in the middle of a prompt shows on the calls', () => {
    const { tools } = capture([user('go'), read('t1', {}, 'model-a'), read('t2', {}, 'model-b'), read('t3', {}, 'model-b')]);
    expect(tools.map((tool) => tool.model)).toEqual(['model-a', 'model-b', 'model-b']);
  });

  it('is absent when the line names none, and for a synthetic line', () => {
    const { tools } = capture([user('go'), read('t1', {}, ''), read('t2', {}, '<synthetic>')]);
    expect(tools.map((tool) => 'model' in tool)).toEqual([false, false]);
  });
});

describe('the skill behind a call', () => {
  it('is the skill the call line names, and ends when the harness stops naming one', () => {
    const { tools } = capture([
      user('go'),
      call('t0', 'Skill', { skill: 'frobnicate' }),
      read('t1', { attributionSkill: 'frobnicate' }),
      read('t2', { attributionSkill: 'frobnicate' }),
      read('t3'),
    ]);
    expect(tools.map((tool) => tool.skill)).toEqual([undefined, 'frobnicate', 'frobnicate', undefined]);
  });
});
