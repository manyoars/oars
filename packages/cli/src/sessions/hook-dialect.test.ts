// t1557: the Copilot dialect of `oars-hook`. The manifest at `com.github.copilot/hooks/hooks.json` is parsed and held to the events, both shells, and the fail-open guard; each event's payload
// is read in both casings and answered in Copilot's shape (a top-level `additionalContext` or `modifiedTransformedPrompt`, never Claude's `hookSpecificOutput`); the recall is tagged `copilot`,
// read through the `copilot` action table, and carries the version the session-state file states; and a payload or a harness name this program does not know gets silence.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ACTION_TABLES } from './actions.js';
import { slugOf } from './allow.js';
import { CLAUDE_DIALECT, copilotDialect, copilotVersionOf, dialectOf, harnessFlag } from './hook-dialect.js';
import { indexPath, readIndex } from './hook-index.js';
import { runHook } from './hooks.js';
import { contextOf, indexAtOf } from './next-fixtures.js';
import { armOf, readRecalls } from './recall-object.js';
import { frameKeyOf, type Position, type RecoveryEdge } from './recall-next.js';
import { deposit } from './store.js';
import { cleanup, copilotEvent, NOW, stage, stageCopilot, type Staged } from './test-support.js';

afterEach(cleanup);

const REPO = 'work/app';
const KEY = 'shell.exec/1';
const VERSION = '1.0.107';
const edge = (next: string, followed: number): RecoveryEdge => ({ next, followed, of: 20, clusters: 1, readId: 'read:0123456789abcdef', day: '2026-11-01' });
const position: Position = { prefix: 'file.edit', n: 20, next: [['shell.exec', 12], ['file.read', 8]], clusters: 1, readId: 'read:aaaaaaaaaaaaaaaa', day: '2026-11-01' };

type Json = { [key: string]: unknown };
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const asRecord = (value: unknown): Json => (isRecord(value) ? value : {});
const answerOf = (output: string | undefined): Json => asRecord(JSON.parse(output ?? '{}'));

/** A deposited store whose index carries the local reads under the Copilot frames: version unknown (`copilot/*`) and the version the session-state file states. */
const staged = async (): Promise<Staged> => {
  const made = stage(slugOf(REPO));
  await deposit(made.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
  const index = await readIndex(made.storeDir);
  const reads = { recoveryByFrame: { 'copilot/*': { [KEY]: [edge('file.read', 12)] }, [frameKeyOf({ harness: 'copilot', harnessVersion: VERSION })]: { [KEY]: [edge('file.edit', 9)] } }, positionsByFrame: { 'copilot/*': [position] } };
  writeFileSync(indexPath(made.storeDir), JSON.stringify({ ...index, ...reads }));
  return made;
};

/** A session id whose arm is the one asked for. */
const sessionOn = (made: Staged, arm: 'shown' | 'held', key: string): string => {
  const at = indexAtOf(made.storeDir);
  for (let i = 0; i < 1000; i++) if (armOf(`c${String(i)}`, [key], at) === arm) return `c${String(i)}`;
  throw new Error('no session found');
};

const copilot = copilotDialect({}, '/nowhere');
const call = (made: Staged, event: 'session-start' | 'prompt' | 'pre-tool' | 'post-tool' | 'stop', payload: object, dialect = copilot): Promise<string | undefined> =>
  runHook(event, JSON.stringify(payload), made.runtime, () => NOW, undefined, undefined, dialect);

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const manifest = asRecord(JSON.parse(readFileSync(join(root, 'com.github.copilot/hooks/hooks.json'), 'utf8')));

describe('the Copilot hooks manifest', () => {
  const hooks = asRecord(manifest.hooks);
  const entryOf = (event: string): Json => asRecord(Array.isArray(hooks[event]) ? hooks[event][0] : undefined);

  it('registers the three PascalCase events and the camelCase prompt event, and no pre-tool or submitted-prompt event', () => {
    expect(Object.keys(hooks).sort()).toEqual(['PostToolUseFailure', 'SessionEnd', 'SessionStart', 'userPromptTransformed']);
    expect(manifest.version).toBe(1);
  });

  it.each([
    ['SessionStart', 'session-start'],
    ['PostToolUseFailure', 'post-tool'],
    ['SessionEnd', 'stop'],
    ['userPromptTransformed', 'prompt'],
  ])('%s runs `oars-hook %s --harness copilot` under both shells, and does nothing when oars-hook is absent', (event, hook) => {
    const entry = entryOf(event);
    expect(entry.type).toBe('command');
    expect(String(entry.bash)).toBe(`command -v oars-hook >/dev/null || exit 0; oars-hook ${hook} --harness copilot`);
    expect(String(entry.powershell)).toBe(`if (-not (Get-Command oars-hook -ErrorAction SilentlyContinue)) { exit 0 }; [Console]::In.ReadToEnd() | oars-hook ${hook} --harness copilot`);
    expect(typeof entry.timeoutSec).toBe('number');
  });

  it('names the hook command the program accepts: every registered command is an oars-hook event with the copilot dialect', () => {
    for (const event of Object.keys(hooks)) {
      const [, hook, flag, name] = /oars-hook (\S+) (--harness) (\S+)$/.exec(String(entryOf(event).bash)) ?? [];
      expect(['session-start', 'prompt', 'post-tool', 'stop']).toContain(hook);
      expect([flag, name]).toEqual(['--harness', 'copilot']);
      expect(harnessFlag([hook ?? '', flag ?? '', name ?? ''])).toBe('copilot');
    }
  });
});

describe('the payload, in both casings', () => {
  it('reads a PascalCase (snake_case) and a camelCase SessionStart alike', () => {
    expect(copilot.readPayload({ session_id: 's', cwd: REPO, timestamp: '2026-11-21T00:00:00Z', source: 'new' })).toMatchObject({ session_id: 's', cwd: REPO });
    expect(copilot.readPayload({ sessionId: 's', cwd: REPO, timestamp: 1, source: 'new' })).toMatchObject({ session_id: 's', cwd: REPO });
  });

  it('reads a failure in both casings, with the arguments as an object or as the JSON string the camelCase payload carries', () => {
    expect(copilot.readPayload({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' }, error: 'boom' })).toMatchObject({ session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' }, error: 'boom' });
    expect(copilot.readPayload({ sessionId: 's', toolName: 'bash', toolArgs: '{"command":"ls"}', error: 'boom' })).toMatchObject({ session_id: 's', tool_name: 'bash', tool_input: { command: 'ls' }, error: 'boom' });
    expect(copilot.readPayload({ sessionId: 's', toolName: 'bash', toolArgs: 'not json' }).tool_input).toBeUndefined();
  });

  it('reads a SessionEnd in both casings, and keeps the prompt fields of userPromptTransformed whole', () => {
    expect(copilot.readPayload({ session_id: 's', reason: 'complete' })).toMatchObject({ session_id: 's' });
    expect(copilot.readPayload({ sessionId: 's', reason: 'complete' })).toMatchObject({ session_id: 's' });
    expect(copilot.readPayload({ sessionId: 's', cwd: REPO, prompt: 'a', transformedPrompt: 'b' })).toMatchObject({ transformedPrompt: 'b', prompt: 'a' });
  });

  it('answers a payload with both spellings by the snake_case one', () => {
    expect(copilot.readPayload({ session_id: 'snake', sessionId: 'camel' }).session_id).toBe('snake');
  });
});

describe('the answer, in Copilot\'s shape', () => {
  it('is a top-level additionalContext for a session start and a failed tool, and never the hookSpecificOutput wrapper', async () => {
    const made = await staged();
    const start = answerOf(await call(made, 'session-start', { session_id: 'live', cwd: REPO }));
    expect(Object.keys(start)).toEqual(['additionalContext']);
    expect(String(start.additionalContext)).toContain('unexpected EOF while looking for matching');
    const failed = answerOf(await call(made, 'post-tool', { session_id: sessionOn(made, 'shown', KEY), tool_name: 'Bash', error: 'Exit code 1\nx' }));
    expect(Object.keys(failed)).toEqual(['additionalContext']);
    expect(String(failed.additionalContext)).toContain('file.read x12');
    // The camelCase registration answers the same way.
    const camel = answerOf(await call(made, 'post-tool', { sessionId: sessionOn(made, 'shown', KEY), toolName: 'bash', toolArgs: '{}', error: 'Exit code 1\nx' }));
    expect(Object.keys(camel)).toEqual(['additionalContext']);
  });

  it('answers the prompt with modifiedTransformedPrompt: the prompt text whole, then the recall line', async () => {
    const made = await staged();
    const sid = sessionOn(made, 'shown', 'positions');
    const answer = answerOf(await call(made, 'prompt', { sessionId: sid, cwd: REPO, prompt: 'raw', transformedPrompt: 'fix the build\n\nwith detail' }));
    expect(Object.keys(answer)).toEqual(['modifiedTransformedPrompt']);
    const text = String(answer.modifiedTransformedPrompt);
    expect(text.startsWith('fix the build\n\nwith detail\n\n')).toBe(true);
    expect(text).toContain('file.edit');
    expect(text.length).toBeGreaterThan('fix the build\n\nwith detail\n\n'.length);
  });

  it('keeps the Claude Code answer exactly as it was', async () => {
    const made = await staged();
    const start = JSON.parse((await call(made, 'session-start', { session_id: 'live', cwd: REPO }, CLAUDE_DIALECT)) ?? '{}') as Json;
    expect(Object.keys(start)).toEqual(['hookSpecificOutput']);
    expect(asRecord(start.hookSpecificOutput).hookEventName).toBe('SessionStart');
  });

  it('prints nothing for a held session, and for a prompt payload that does not carry the prompt', async () => {
    const made = await staged();
    expect(await call(made, 'post-tool', { session_id: sessionOn(made, 'held', KEY), tool_name: 'Bash', error: 'Exit code 1\nx' })).toBeUndefined();
    expect(await call(made, 'prompt', { sessionId: sessionOn(made, 'shown', 'positions'), cwd: REPO, prompt: 'raw' })).toBeUndefined();
  });

  it('does not ask a pre-tool push of Copilot: no output, and no exposure row', async () => {
    const made = await staged();
    expect(await call(made, 'pre-tool', { session_id: 'live', tool_name: 'Bash', tool_input: { command: 'ls' } })).toBeUndefined();
    expect(await readRecalls(made.storeDir)).toHaveLength(0);
  });
});

describe('the harness a Copilot recall is read and tagged under', () => {
  it('tags the row `copilot` and looks the failure up in the copilot frame', async () => {
    const made = await staged();
    const sid = sessionOn(made, 'shown', KEY);
    await call(made, 'post-tool', { session_id: sid, tool_name: 'Bash', error: 'Exit code 1\nx' });
    const rows = await readRecalls(made.storeDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.frame.harness).toBe('copilot');
    expect(rows[0]?.frame.harnessVersion).toBeNull();
  });

  it('reads a Claude tool name and a Copilot one through the copilot table', () => {
    for (const name of ['Bash', 'bash', 'powershell', 'PowerShell']) expect(ACTION_TABLES.copilot.rows[name]).toBe('shell.exec');
    expect(ACTION_TABLES.copilot.rows.Edit).toBe('file.edit');
    expect(ACTION_TABLES.copilot.rows.Read).toBe('file.read');
  });

  it('takes the harness version from the session-state file, serves the cell for that version, and tags the row with it', async () => {
    const made = await staged();
    const sid = sessionOn(made, 'shown', KEY);
    const home = stageCopilot(made.root, [{ id: sid, lines: [copilotEvent('2026-11-20T00:00:00Z', 'session.start', { sessionId: sid, copilotVersion: VERSION })] }]);
    const dialect = copilotDialect({ COPILOT_HOME: home }, '/nowhere');
    const output = answerOf(await call(made, 'post-tool', { session_id: sid, tool_name: 'Bash', error: 'Exit code 1\nx' }, dialect));
    expect(String(output.additionalContext)).toContain('file.edit x9');
    expect(String(output.additionalContext)).not.toContain('file.read');
    expect((await readRecalls(made.storeDir))[0]?.frame).toMatchObject({ harness: 'copilot', harnessVersion: VERSION });
  });

  it('still answers with no version when the session-state file is missing, has no session.start, or the id names no folder', async () => {
    const made = await staged();
    const home = stageCopilot(made.root, [{ id: 'torn', lines: 'not json\n{"type":"other"}\n' }]);
    const dialect = copilotDialect({ COPILOT_HOME: home }, '/nowhere');
    for (const id of ['torn', 'absent']) {
      const sid = sessionOn(made, 'shown', KEY);
      expect(await copilotVersionOf(home, id)).toBeNull();
      expect(String(answerOf(await call(made, 'post-tool', { session_id: sid, tool_name: 'Bash', error: 'Exit code 1\nx' }, dialect)).additionalContext)).toContain('file.read x12');
    }
    expect(await copilotVersionOf(home, '../torn')).toBeNull();
    expect(await copilotVersionOf(home, '..')).toBeNull();
  });

  it('reads a version that sits after other lines of the head, and a session.start with no version as none', async () => {
    const made = await staged();
    const home = stageCopilot(made.root, [
      { id: 'late', lines: [copilotEvent('2026-11-20T00:00:00Z', 'session.model_change', { newModel: 'x' }), copilotEvent('2026-11-20T00:00:01Z', 'session.start', { copilotVersion: '1.2.3' })] },
      { id: 'bare', lines: [copilotEvent('2026-11-20T00:00:00Z', 'session.start', { sessionId: 'bare' })] },
      { id: 'flat', lines: ['"a string"', copilotEvent('2026-11-20T00:00:00Z', 'session.start', 'no data object')] },
    ]);
    expect(await copilotVersionOf(home, 'late')).toBe('1.2.3');
    expect(await copilotVersionOf(home, 'bare')).toBeNull();
    expect(await copilotVersionOf(home, 'flat')).toBeNull();
  });

  it('records no Claude Code candidate census for a Copilot session start', async () => {
    const made = await staged();
    await call(made, 'session-start', { session_id: 'live', cwd: REPO });
    expect(() => readFileSync(join(made.storeDir, 'candidates.jsonl'), 'utf8')).toThrow();
    await call(made, 'session-start', { session_id: 'live', cwd: REPO }, CLAUDE_DIALECT);
    expect(readFileSync(join(made.storeDir, 'candidates.jsonl'), 'utf8')).toContain('"harness":"claude-code"');
  });

  it('answers a session end with nothing, since the payload has no transcript to deposit', async () => {
    const made = await staged();
    expect(await call(made, 'stop', { session_id: 'live', reason: 'complete' })).toBeUndefined();
  });
});

describe('an unknown payload shape or harness name', () => {
  it('answers nothing, and never throws, for a payload with no session, no tool, or no failure text', async () => {
    const made = await staged();
    for (const event of ['session-start', 'prompt', 'post-tool'] as const) {
      expect(await call(made, event, {})).toBeUndefined();
      expect(await call(made, event, { unrelated: 1, nested: { deeper: [1, 2] } })).toBeUndefined();
    }
    expect(await runHook('post-tool', 'not json', made.runtime, () => NOW, undefined, undefined, copilot)).toBeUndefined();
    expect(await runHook('post-tool', '[1]', made.runtime, () => NOW, undefined, undefined, copilot)).toBeUndefined();
    expect(contextOf(await call(made, 'post-tool', { sessionId: 's', toolName: 'bash' }))).toBe('');
  });

  it('has no dialect for a name it does not know, and takes the flag in both spellings', () => {
    const env = {};
    expect(dialectOf('copilot', env, '/h')?.harness).toBe('copilot');
    expect(dialectOf(undefined, env, '/h')).toBe(CLAUDE_DIALECT);
    expect(dialectOf('claude-code', env, '/h')).toBe(CLAUDE_DIALECT);
    expect(dialectOf('mystery', env, '/h')).toBeUndefined();
    expect(dialectOf('', env, '/h')).toBeUndefined();
    expect(harnessFlag(['node', 'x', 'prompt'])).toBeUndefined();
    expect(harnessFlag(['node', 'x', 'prompt', '--harness', 'copilot'])).toBe('copilot');
    expect(harnessFlag(['node', 'x', 'prompt', '--harness=copilot'])).toBe('copilot');
    expect(harnessFlag(['node', 'x', 'prompt', '--harness'])).toBe('');
  });
});
