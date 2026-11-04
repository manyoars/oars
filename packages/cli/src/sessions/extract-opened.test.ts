// How a turn opens (t768): a slash command or a skill opens a prompt like a typed line, and a line the harness injected opens nothing.
// Every name here is invented.
import { describe, expect, it } from 'vitest';
import { captureSession, type Capture } from './extract.js';
import { readTurns } from './gold.js';
import { makeRedactor } from './redact.js';

const redact = makeRedactor();
const line = (type: string, content: unknown, extra: object = {}): string =>
  JSON.stringify({ type, timestamp: '2026-06-10T00:00:00.000Z', cwd: '/w', message: { role: type === 'assistant' ? 'assistant' : 'user', model: 'model-a', content }, ...extra });
const user = (text: string, extra: object = {}): string => line('user', text, extra);
const answer = (text = 'done', extra: object = {}): string => line('assistant', [{ type: 'text', text }], extra);
const call = (id: string): string => line('assistant', [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'a.txt' } }]);
const synthetic = (): string => JSON.stringify({ type: 'assistant', timestamp: '2026-06-10T00:00:00.000Z', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'none' }] } });
const capture = (lines: readonly string[], extra: object = {}): Capture => captureSession({ text: lines.join('\n'), session: 's', project: 'p', rev: 1, at: '', bytes: 0, redact, ...extra });

const command = (name: string, args?: string): string =>
  `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>${args === undefined ? '' : `\n<command-args>${args}</command-args>`}`;
const commandNameFirst = (name: string, args: string): string => `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>\n<command-args>${args}</command-args>`;
const CAVEAT = '<local-command-caveat>Caveat: generated while running local commands.</local-command-caveat>';
const OUTPUT = '<local-command-stdout>Set the widget to blue</local-command-stdout>';
const REMINDER = '<system-reminder>The widget list changed.</system-reminder>';
const NOTIFICATION = '<task-notification><task-id>1</task-id><status>completed</status></task-notification>';
const TEAMMATE = '<teammate-message teammate_id="lead">Please polish the widget.</teammate-message>';

describe('a turn opened by a command or a skill', () => {
  it('opens a prompt from a slash command with arguments, the wrapper tags removed', () => {
    const { prompts, tools } = capture([user(command('frobnicate', 'the blue widget')), call('t1'), answer()]);
    expect(prompts.map(({ index, head, opened }) => ({ index, head, opened }))).toEqual([{ index: 0, head: '/frobnicate the blue widget', opened: 'command' }]);
    expect(prompts[0]?.turns).toBe(2);
    expect(tools[0]?.prompt).toBe(0);
  });

  it('reads the wrapper in either order and across lines', () => {
    const { prompts } = capture([user(commandNameFirst('frobnicate', 'first line\nsecond line')), answer()]);
    expect(prompts[0]?.head).toBe('/frobnicate first line\nsecond line');
  });

  it('opens a prompt from a skill, whose body stays out of the head', () => {
    const { prompts } = capture([
      user(command('polish-widgets', '')),
      user('Base directory for this skill: /skills/polish-widgets\n\nThe whole skill body.', { isMeta: true }),
      answer(),
    ]);
    expect(prompts.map(({ head, opened }) => ({ head, opened }))).toEqual([{ head: '/polish-widgets', opened: 'command' }]);
  });

  it('opens a prompt from a command with no args element', () => {
    expect(capture([user(command('frobnicate')), answer()]).prompts[0]?.head).toBe('/frobnicate');
  });

  it('redacts a command head as any prompt, and cuts it after', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const { prompts } = capture([user(command('frobnicate', `use ${secret} ${'x'.repeat(400)}`)), answer()]);
    expect(prompts[0]?.head).not.toContain(secret);
    expect(prompts[0]?.head).toContain('<secret>');
    expect(prompts[0]?.head.length).toBe(300);
  });

  it('starts the prompt at the command, so the turn before it keeps its own wall time and calls', () => {
    const later = (at: string, text: string): string => JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: text } });
    const { prompts, tools } = capture([
      later('2026-06-10T00:00:00.000Z', 'first ask'),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-10T00:00:10.000Z', message: { role: 'assistant', model: 'model-a', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
      later('2026-06-10T00:01:00.000Z', command('frobnicate', 'go')),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-10T00:01:30.000Z', message: { role: 'assistant', model: 'model-a', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] } }),
    ]);
    expect(prompts.map(({ wallSec, opened }) => ({ wallSec, opened }))).toEqual([
      { wallSec: 10, opened: 'typed' },
      { wallSec: 30, opened: 'command' },
    ]);
    expect(tools.map((tool) => tool.prompt)).toEqual([0, 1]);
  });

  it('holds no command or skill name in any field but the class A head and skills', () => {
    const { prompts } = capture([user(command('private-widget-maker', 'go')), answer('done', { attributionSkill: 'private-widget-maker' })]);
    const [prompt] = prompts;
    const { head, skills, ...rest } = prompt ?? { head: '', skills: [] };
    expect(head).toContain('private-widget-maker');
    expect(skills).toEqual(['private-widget-maker']);
    expect(JSON.stringify(rest)).not.toContain('private-widget-maker');
  });
});

describe('a typed prompt', () => {
  it('reads as typed', () => {
    expect(capture([user('fix the widget'), answer()]).prompts.map(({ head, opened }) => ({ head, opened }))).toEqual([{ head: 'fix the widget', opened: 'typed' }]);
  });

  it('keeps a leading < the operator typed by hand', () => {
    for (const text of ['<div> breaks the widget', '<3 this, now fix it', '< 5 widgets remain', '<command>not the wrapper</command>']) {
      expect(capture([user(text), answer()]).prompts.map(({ head, opened }) => ({ head, opened }))).toEqual([{ head: text, opened: 'typed' }]);
    }
  });

  it('keeps a paste wrapper the harness puts around what the operator pasted', () => {
    const text = '\n<pasted_content id="1">the widget log</pasted_content>';
    expect(capture([user(text), answer()]).prompts[0]?.opened).toBe('typed');
  });
});

describe('a line the harness injected', () => {
  const injected: ReadonlyArray<readonly [string, string]> = [
    ['a local-command caveat', CAVEAT],
    ['local command output', OUTPUT],
    ['local command errors', '<local-command-stderr>no such widget</local-command-stderr>'],
    ['a system reminder', REMINDER],
    ['a task notification', NOTIFICATION],
    ['a teammate message', TEAMMATE],
    ['a scheduled task', '<scheduled-task name="n">go</scheduled-task>'],
    ['a shell-mode input', '<bash-input>ls</bash-input>'],
    ['a shell-mode output', '<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>'],
    ['a shell-mode error', '<bash-stderr>no such file</bash-stderr>'],
    ['one after a line break', `\n${NOTIFICATION}`],
  ];

  for (const [name, text] of injected) {
    it(`opens no prompt: ${name}`, () => {
      expect(capture([user(text), answer()]).prompts).toEqual([]);
    });

    it(`stays out as a meta line too: ${name}`, () => {
      expect(capture([user(text, { isMeta: true }), answer()]).prompts).toEqual([]);
    });

    it(`stays in the prompt before it: ${name}`, () => {
      const { prompts } = capture([user('fix the widget'), answer(), user(text), answer()]);
      expect(prompts.map((prompt) => ({ head: prompt.head, turns: prompt.turns }))).toEqual([{ head: 'fix the widget', turns: 2 }]);
    });
  }
});

describe('a local command, with no assistant turn after it', () => {
  it('opens no prompt at the end of a transcript', () => {
    expect(capture([user(command('clear', ''))]).prompts).toEqual([]);
  });

  it('opens no prompt when a typed prompt follows, and the typed prompt holds the turn', () => {
    const { prompts } = capture([user(command('clear', '')), user(CAVEAT, { isMeta: true }), user('fix the widget'), answer()]);
    expect(prompts.map(({ head, opened }) => ({ head, opened }))).toEqual([{ head: 'fix the widget', opened: 'typed' }]);
  });

  it('opens no prompt when its output follows, though a turn comes after that', () => {
    const { prompts } = capture([user('first ask'), answer(), user(command('set-color', 'blue')), user(OUTPUT), answer()]);
    expect(prompts.map((prompt) => prompt.head)).toEqual(['first ask']);
    expect(prompts[0]?.turns).toBe(2);
  });

  it('opens no prompt when a task notification opens the next turn', () => {
    expect(capture([user(command('set-color', 'blue')), user(NOTIFICATION), answer()]).prompts).toEqual([]);
  });

  it('opens no prompt on a synthetic line: that is the harness speaking, not a model', () => {
    expect(capture([user(command('set-color', 'blue')), synthetic()]).prompts).toEqual([]);
    expect(capture([user(command('set-color', 'blue')), synthetic(), user('fix the widget'), answer()]).prompts.map((prompt) => prompt.head)).toEqual(['fix the widget']);
  });

  it('opens a prompt when a model answers after a synthetic line', () => {
    expect(capture([user(command('frobnicate', 'go')), synthetic(), answer()]).prompts.map((prompt) => prompt.head)).toEqual(['/frobnicate go']);
  });

  it('opens no prompt on a sidechain answer, a bad line, or a request copy, and looks past a tool result to the turn', () => {
    const blob = JSON.stringify({ type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'text', text: 'copy' }] } });
    expect(capture([user(command('set-color', 'blue')), answer('aside', { isSidechain: true }), blob, 'not json', '[1]']).prompts).toEqual([]);
    const result = line('user', [{ type: 'tool_result', tool_use_id: 't0', content: 'ok' }]);
    expect(capture([user(command('frobnicate', 'go')), result, answer()]).prompts.map((prompt) => prompt.head)).toEqual(['/frobnicate go']);
  });

  it('gives the turn to the last of two commands', () => {
    const { prompts } = capture([user(command('clear', '')), user(command('frobnicate', 'go')), answer()]);
    expect(prompts.map((prompt) => prompt.head)).toEqual(['/frobnicate go']);
  });

  it('opens no prompt from a wrapper with nothing in it', () => {
    expect(capture([user('<command-name></command-name>'), answer()]).prompts).toEqual([]);
  });
});

describe('a teammate transcript', () => {
  it('opens no prompt from a teammate message, and neither names it typed nor keeps its text', () => {
    const { prompts } = capture([user(TEAMMATE, { isSidechain: true }), answer('x', { isSidechain: true })], { subagent: { parent: 'p', agentType: 'worker', spawnedBy: null, spawnedIn: null } });
    expect(prompts).toEqual([]);
  });

  it('keeps the plain first line a subagent is given, so its turns stay in a prompt', () => {
    const { prompts } = capture([user('polish the widget', { isSidechain: true }), answer('x', { isSidechain: true }), user(TEAMMATE, { isSidechain: true }), answer('y', { isSidechain: true })], { subagent: { parent: 'p', agentType: 'worker', spawnedBy: null, spawnedIn: null } });
    expect(prompts.map(({ head, opened, turns }) => ({ head, opened, turns }))).toEqual([{ head: 'polish the widget', opened: 'typed', turns: 2 }]);
  });
});

describe('a sidechain or Cursor line', () => {
  it('a sidechain command opens no prompt', () => {
    expect(capture([user(command('frobnicate', 'go'), { isSidechain: true }), answer('x', { isSidechain: true })]).prompts).toEqual([]);
  });

  it('a Cursor session keeps its leading < rule: this brief fixes Claude Code only', () => {
    expect(capture([user('<div> breaks the widget'), answer()], { harness: 'cursor' }).prompts).toEqual([]);
    expect(capture([user(command('frobnicate', 'go')), answer()], { harness: 'cursor' }).prompts).toEqual([]);
    expect(capture([user('fix the widget'), answer()], { harness: 'cursor' }).prompts.map(({ head, opened }) => ({ head, opened }))).toEqual([{ head: 'fix the widget', opened: 'typed' }]);
  });
});

describe('the gold reader', () => {
  it('numbers turns as capture numbers prompts, with the same request as the head', () => {
    const lines = [
      user(command('clear', '')),
      user(CAVEAT, { isMeta: true }),
      user(command('frobnicate', 'go')),
      answer('first'),
      user(NOTIFICATION),
      answer('second'),
      user('<div> breaks the widget'),
      answer('third'),
      user(command('set-color', 'blue')),
      user(OUTPUT),
      user('fix the widget'),
      answer('fourth'),
    ];
    const heads = capture(lines).prompts.map((prompt) => prompt.head);
    const turns = readTurns(lines.join('\n'));
    expect(heads).toEqual(['/frobnicate go', '<div> breaks the widget', 'fix the widget']);
    expect(turns.map((turn) => turn.request)).toEqual(heads);
    expect(turns.map((turn) => turn.replies)).toEqual([['first', 'second'], ['third'], ['fourth']]);
  });
});
