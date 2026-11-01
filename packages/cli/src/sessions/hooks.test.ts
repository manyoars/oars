import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { slugOf } from './allow.js';
import { readHookCalls } from './hook-calls.js';
import { runHook } from './hooks.js';
import { deposit, depositSession, loadStore } from './store.js';
import { cleanup, FIXTURES, NOW, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const REPO = join('work', 'app');
const QUOTING = 'bash: -c: line 7: unexpected EOF while looking for matching quote';

const deposited = async (): Promise<Staged> => {
  const staged = stage(slugOf(REPO));
  await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
  return staged;
};

const specific = (output: string | undefined): { [key: string]: unknown } => {
  const parsed: unknown = JSON.parse(output ?? '{}');
  const inner: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'hookSpecificOutput') : undefined;
  return typeof inner === 'object' && inner !== null ? Object.fromEntries(Object.entries(inner)) : {};
};

const context = (output: string | undefined): string => {
  const value = specific(output).additionalContext;
  return typeof value === 'string' ? value : '';
};

describe('SessionStart hook', () => {
  it('injects the repository block as additionalContext, and counts the call', async () => {
    const { runtime, storeDir } = await deposited();
    const output = await runHook('session-start', JSON.stringify({ session_id: 'live', cwd: REPO, hook_event_name: 'SessionStart', source: 'startup' }), runtime, () => NOW);
    expect(specific(output).hookEventName).toBe('SessionStart');
    expect(context(output)).toContain('unexpected EOF while looking for matching');
    expect(context(output).length).toBeLessThan(1200);
    const calls = await readHookCalls(storeDir);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ event: 'session-start', session: 'live', hit: true });
  });

  it('says nothing for a repository with no history, with no index, or on garbage stdin', async () => {
    const { runtime, storeDir } = await deposited();
    expect(await runHook('session-start', JSON.stringify({ cwd: join('elsewhere', 'other') }), runtime, () => NOW)).toBeUndefined();
    expect(await runHook('session-start', 'not json', runtime, () => NOW)).toBeUndefined();
    expect(await runHook('session-start', '[1]', runtime, () => NOW)).toBeUndefined();
    expect(await runHook('session-start', JSON.stringify({ cwd: REPO }), stage().runtime, () => NOW)).toBeUndefined();
    expect((await readHookCalls(storeDir)).every((call) => !call.hit)).toBe(true);
  });

  it('fails open: a counter that cannot be written neither throws nor costs the context, and an unreadable store gives no output', async () => {
    const { runtime, storeDir } = await deposited();
    writeFileSync(join(storeDir, 'blocked'), 'a file where a folder is expected');
    mkdirSync(join(storeDir, 'hook-calls.jsonl'));
    const output = await runHook('session-start', JSON.stringify({ cwd: REPO }), runtime, () => NOW);
    expect(context(output)).toContain('oars recall');
    const broken = { ...runtime, storeDir: join(storeDir, 'blocked', 'nested') };
    expect(await runHook('stop', JSON.stringify({ transcript_path: join(runtime.projectsRoot, 'x', 'y.jsonl') }), broken, () => NOW)).toBeUndefined();
  });
});

describe('PostToolUseFailure hook', () => {
  const failure = (error: string, tool = 'Bash') => JSON.stringify({ hook_event_name: 'PostToolUseFailure', session_id: 'live', tool_name: tool, tool_input: {}, error });

  it('names the sessions that saw the bash-quoting error and what followed', async () => {
    const { runtime } = await deposited();
    const output = await runHook('post-tool', failure(`Exit code 2\n${QUOTING}\n`), runtime, () => NOW);
    expect(specific(output).hookEventName).toBe('PostToolUseFailure');
    expect(context(output)).toMatch(/^oars recall: seen in 2 sessions; what followed: \S+/);
  });

  it('is silent for an unknown error, a missing tool, a non-failure, and an unreadable input; it counts each lookup', async () => {
    const { runtime, storeDir } = await deposited();
    expect(await runHook('post-tool', failure('Exit code 1\nsomething nobody has ever seen before'), runtime, () => NOW)).toBeUndefined();
    expect(await runHook('post-tool', JSON.stringify({ error: 'Exit code 1\nx' }), runtime, () => NOW)).toBeUndefined();
    expect(await runHook('post-tool', JSON.stringify({ tool_name: 'Read', tool_response: { content: 'fine' } }), runtime, () => NOW)).toBeUndefined();
    expect(await runHook('post-tool', '', runtime, () => NOW)).toBeUndefined();
    expect((await readHookCalls(storeDir)).filter((call) => call.event === 'post-tool')).toHaveLength(4);
  });

  it('reads a PostToolUse response that starts with Exit code, and says nothing without an index', async () => {
    const { runtime } = await deposited();
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: `Exit code 2\n${QUOTING}` });
    expect(specific(await runHook('post-tool', input, runtime, () => NOW)).hookEventName).toBe('PostToolUse');
    expect(await runHook('post-tool', input, stage().runtime, () => NOW)).toBeUndefined();
  });

  it('masks a redacted domain the way the log was masked, and reports a signature with nothing recorded after it', async () => {
    const staged = stage(slugOf(REPO));
    const one = (id: string): string[] => [
      JSON.stringify({ type: 'user', timestamp: '2026-06-10T00:00:00Z', message: { role: 'user', content: 'go' } }),
      JSON.stringify({ type: 'assistant', uuid: `a${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id: `x${id}`, name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'user', uuid: `b${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `x${id}`, is_error: true, content: 'Exit code 1\ncannot reach build.corp.example' }] } }),
    ];
    const folder = join(staged.projectsRoot, slugOf(REPO));
    writeFileSync(join(folder, 'dom1.jsonl'), `${one('1').join('\n')}\n`);
    writeFileSync(join(folder, 'dom2.jsonl'), `${one('2').join('\n')}\n`);
    await deposit(staged.runtime, { allow: [REPO], redactDomains: ['corp.example'], now: () => NOW });
    const output = await runHook('post-tool', JSON.stringify({ tool_name: 'Bash', error: 'Exit code 1\ncannot reach build.corp.example' }), staged.runtime, () => NOW);
    expect(context(output)).toContain('seen in 2 sessions; what followed: nothing recorded');
  });
});

describe('SessionEnd deposit hook', () => {
  it('deposits the finished session incrementally, once, and only from a folder an --allow named', async () => {
    const staged = await deposited();
    const transcript = join(staged.projectsRoot, slugOf(REPO), 'fresh.jsonl');
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), transcript);
    const input = JSON.stringify({ session_id: 'fresh', transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false });
    const before = (await loadStore(staged.storeDir)).sessions.length;
    expect(await runHook('stop', input, staged.runtime, () => NOW)).toBeUndefined();
    expect((await loadStore(staged.storeDir)).sessions.map((session) => session.session)).toContain('fresh');
    expect((await loadStore(staged.storeDir)).sessions).toHaveLength(before + 1);
    await runHook('stop', input, staged.runtime, () => NOW);
    expect((await loadStore(staged.storeDir)).sessions).toHaveLength(before + 1);
    const calls = (await readHookCalls(staged.storeDir)).filter((call) => call.event === 'stop');
    expect(calls.map((call) => call.hit)).toEqual([true, false]);
    expect(calls[0]?.session).toBe('fresh');
  });

  it('gives up on a held store lock inside the 5 s budget and still returns nothing', async () => {
    const staged = await deposited();
    const transcript = join(staged.projectsRoot, slugOf(REPO), 'blocked.jsonl');
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), transcript);
    writeFileSync(join(staged.storeDir, 'store.lock'), 'a holder that never frees');
    const started = Date.now();
    await expect(depositSession(staged.runtime, transcript, () => NOW)).rejects.toThrow('store is locked');
    expect(Date.now() - started).toBeLessThan(4500);
    expect(await runHook('stop', JSON.stringify({ session_id: 'blocked', transcript_path: transcript }), staged.runtime, () => NOW)).toBeUndefined();
    // The failed deposit is evidence, not silence: its hook-call line carries the failure's first line.
    const failed = (await readHookCalls(staged.storeDir)).filter((call) => call.session === 'blocked');
    expect(failed.map((call) => [call.event, call.hit])).toEqual([['stop', false]]);
    expect(failed[0]?.error).toContain('store is locked');
    expect(failed[0]?.error).not.toContain('\n');
  }, 15_000);

  it('does not read a folder no --allow named, a missing transcript, or an event without a transcript', async () => {
    const staged = await deposited();
    const other = join(staged.projectsRoot, 'not-named');
    mkdirSync(other);
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), join(other, 'stray.jsonl'));
    await runHook('stop', JSON.stringify({ session_id: 'stray', transcript_path: join(other, 'stray.jsonl') }), staged.runtime, () => NOW);
    await runHook('stop', JSON.stringify({ session_id: 'gone', transcript_path: join(staged.projectsRoot, slugOf(REPO), 'gone.jsonl') }), staged.runtime, () => NOW);
    await runHook('stop', JSON.stringify({ session_id: 'none' }), staged.runtime, () => NOW);
    expect((await loadStore(staged.storeDir)).sessions.map((session) => session.session)).not.toContain('stray');
    expect((await readHookCalls(staged.storeDir)).filter((call) => call.event === 'stop').every((call) => !call.hit)).toBe(true);
  });
});

describe('nightly run', () => {
  it('repeats the saved --allow and --redact-domain set, refreshes the index, and does nothing before a first deposit', async () => {
    const staged = await deposited();
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), join(staged.projectsRoot, slugOf(REPO), 'late.jsonl'));
    expect(await runHook('nightly', '', staged.runtime, () => NOW)).toBeUndefined();
    expect((await loadStore(staged.storeDir)).sessions.map((session) => session.session)).toContain('late');
    const fresh = stage();
    expect(await runHook('nightly', '', fresh.runtime, () => NOW)).toBeUndefined();
    expect((await readHookCalls(fresh.storeDir)).map((call) => call.hit)).toEqual([false]);
  });
});

describe('SessionEnd deposit of a growing transcript', () => {
  it('two deposits of a growing transcript leave one session row (the later revision replaces the earlier)', async () => {
    const staged = await deposited();
    const transcript = join(staged.projectsRoot, slugOf(REPO), 'grow.jsonl');
    const line = (text: string) => `${JSON.stringify({ type: 'user', timestamp: '2026-06-02T00:00:00Z', message: { role: 'user', content: text } })}\n`;
    writeFileSync(transcript, line('first'));
    const input = JSON.stringify({ session_id: 'grow', transcript_path: transcript, hook_event_name: 'SessionEnd' });
    await runHook('stop', input, staged.runtime, () => NOW);
    appendFileSync(transcript, line('second'));
    await runHook('stop', input, staged.runtime, () => NOW);
    const rows = (await loadStore(staged.storeDir)).sessions.filter((session) => session.session === 'grow');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lines).toBe(2);
  });
});
