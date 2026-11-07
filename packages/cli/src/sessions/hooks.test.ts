import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { slugOf } from './allow.js';
import { readHookCalls } from './hook-calls.js';
import { hookRuntime, HOOK_EVENTS, nightlyTelemetry, runHook } from './hooks.js';
import { deposit, depositSession, loadStore } from './store.js';
import { withoutCells } from './next-fixtures.js';
import { cleanup, composers, FIXTURES, folders, NOW, stage, stageCursor, stageRawCursor, type Staged } from './test-support.js';

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
    const { runtime, storeDir } = await deposited();
    await withoutCells(storeDir);
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
    const { runtime, storeDir } = await deposited();
    await withoutCells(storeDir);
    const input = JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'live', tool_name: 'Bash', tool_response: `Exit code 2\n${QUOTING}` });
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
    const output = await runHook('post-tool', JSON.stringify({ session_id: 's2', tool_name: 'Bash', error: 'Exit code 1\ncannot reach build.corp.example' }), staged.runtime, () => NOW);
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

  it('defers on a held store lock after its 3 s wait and still returns nothing', async () => {
    const staged = await deposited();
    const transcript = join(staged.projectsRoot, slugOf(REPO), 'blocked.jsonl');
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), transcript);
    writeFileSync(join(staged.storeDir, 'store.lock'), 'a holder that never frees');
    const started = Date.now();
    // The refusal is deferred to the pending list, not a failure; the step log holds it as its own status.
    await expect(depositSession(staged.runtime, transcript, () => NOW)).resolves.toBe('deferred');
    expect(Date.now() - started).toBeLessThan(4500);
    expect(await runHook('stop', JSON.stringify({ session_id: 'blocked', transcript_path: transcript }), staged.runtime, () => NOW)).toBeUndefined();
    const deferred = (await readHookCalls(staged.storeDir)).filter((call) => call.session === 'blocked');
    expect(deferred.map((call) => [call.event, call.hit, call.error])).toEqual([['stop', false, null]]);
  }, 20_000); // waits out the 3 s hook lock wait twice by design: 7.0 s measured alone, so about 3x

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

describe('hookRuntime', () => {
  const io = { stdin: Readable.from([]), stdout: { write: () => true } };
  const env = { APPDATA: join('C:', 'Users', 'op', 'AppData', 'Roaming') };

  it('gives only the nightly task the Cursor root, so the Stop path never opens the store', () => {
    expect(hookRuntime('nightly', env, 'win32', 'home', io).cursorRoot).toBe(join(env.APPDATA, 'Cursor', 'User'));
    for (const event of ['session-start', 'post-tool', 'stop'] as const) expect(hookRuntime(event, env, 'win32', 'home', io)).not.toHaveProperty('cursorRoot');
  });

  it('gives the nightly task the Codex root (CODEX_HOME), and no other event any sourceRoots', () => {
    const nightly = hookRuntime('nightly', { ...env, CODEX_HOME: join('x', 'codex') }, 'win32', 'home', io);
    expect(nightly.sourceRoots?.codex).toBe(join('x', 'codex'));
    expect(hookRuntime('nightly', env, 'win32', 'home', io).sourceRoots?.codex).toBe(join('home', '.codex'));
    for (const event of ['session-start', 'post-tool', 'stop'] as const) expect(hookRuntime(event, env, 'win32', 'home', io)).not.toHaveProperty('sourceRoots');
  });

  it('places the store under the config dir and projects under the Claude config dir', () => {
    const runtime = hookRuntime('stop', { ...env, CLAUDE_CONFIG_DIR: join('x', 'claude') }, 'win32', 'home', io);
    expect(runtime.storeDir).toBe(join(env.APPDATA, 'oars', 'sessions'));
    expect(runtime.projectsRoot).toBe(join('x', 'claude', 'projects'));
    expect(hookRuntime('stop', {}, 'linux', 'home', io).projectsRoot).toBe(join('home', '.claude', 'projects'));
  });
});

describe('nightlyTelemetry', () => {
  it('points the nightly run at <APPDATA>/oars/telemetry with the version and the clock it was given', () => {
    const appData = join(process.cwd(), 'temp-appdata-for-test');
    const env = { APPDATA: appData, XDG_CONFIG_HOME: appData };
    const clock = (): number => NOW;
    const telemetry = nightlyTelemetry('nightly', env, 'win32', 'unused-home', () => '4.5.6', clock);
    expect(telemetry).toEqual({ env, telemetry: { dir: join(appData, 'oars', 'telemetry'), platform: 'win32' }, version: '4.5.6', now: clock });
  });

  it('falls back to the home config folder when the environment names none', () => {
    expect(nightlyTelemetry('nightly', {}, 'linux', join('home', 'dev'), () => '1.0.0', Date.now)?.telemetry?.dir).toBe(join('home', 'dev', '.config', 'oars', 'telemetry'));
  });

  it('gives every other hook nothing to record', () => {
    let versionReads = 0;
    const version = (): string => {
      versionReads += 1;
      return '1.0.0';
    };
    for (const event of HOOK_EVENTS.filter((name) => name !== 'nightly')) expect(nightlyTelemetry(event, { APPDATA: 'x' }, 'linux', 'home', version, Date.now)).toBeUndefined();
    expect(versionReads).toBe(0);
  });
});

describe('nightly run', () => {
  it('records an unreadable Cursor store as the hook-call error, and still counts the run', async () => {
    const staged = stage();
    const user = join(staged.root, 'User');
    mkdirSync(join(user, 'globalStorage'), { recursive: true });
    writeFileSync(join(user, 'globalStorage', 'state.vscdb'), 'not a database');
    await deposit(staged.runtime, { allow: ['cursor'], redactDomains: [], now: () => NOW });
    await runHook('nightly', '', { ...staged.runtime, cursorRoot: user }, () => NOW);
    const [call] = await readHookCalls(staged.storeDir);
    expect(call?.hit).toBe(true);
    // Class A: the base name only, never the folder path with the user name.
    expect(call?.error).toMatch(/^state\.vscdb: /);
    expect(call?.error).not.toContain(user);
  });

  it('records the Cursor sessions skipped for an unsafe id as the hook-call error, so a nightly skip is never silent', async () => {
    const staged = stage();
    const doc = (composerId: string) => ({ composerId, createdAt: 1, conversation: [{ type: 1, text: 'hi' }] });
    const user = await stageRawCursor(staged.root, [{ id: 'good', document: doc('good') }, { id: 'bad', document: doc('../../escaped') }], []);
    await deposit(staged.runtime, { allow: ['cursor'], redactDomains: [], now: () => NOW });
    await runHook('nightly', '', { ...staged.runtime, cursorRoot: user }, () => NOW);
    const [call] = await readHookCalls(staged.storeDir);
    expect(call?.hit).toBe(true);
    expect(call?.error).toBe('Skipped 1 Cursor sessions whose id is not a safe file name');
  });

  it('deposits a saved cursor entry when the runtime names the Cursor store, and leaves it alone otherwise', async () => {
    const staged = stage();
    const { repo, plain } = folders(staged.root);
    const user = await stageCursor(staged.root, composers(repo, plain));
    await deposit({ ...staged.runtime, cursorRoot: user }, { allow: ['cursor'], redactDomains: [], now: () => NOW });
    const before = (await loadStore(staged.storeDir)).sessions.length;
    expect(before).toBe(3);
    await rm(staged.storeDir, { recursive: true, force: true });
    await deposit(staged.runtime, { allow: ['cursor'], redactDomains: [], now: () => NOW });
    await runHook('nightly', '', staged.runtime, () => NOW);
    expect((await loadStore(staged.storeDir)).sessions).toHaveLength(0);
    await runHook('nightly', '', { ...staged.runtime, cursorRoot: user }, () => NOW);
    expect((await loadStore(staged.storeDir)).sessions).toHaveLength(3);
  });

  it('repeats the saved --allow and --redact-domain set, refreshes the index, and reads every folder before a first deposit', async () => {
    const staged = await deposited();
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), join(staged.projectsRoot, slugOf(REPO), 'late.jsonl'));
    expect(await runHook('nightly', '', staged.runtime, () => NOW)).toBeUndefined();
    expect((await loadStore(staged.storeDir)).sessions.map((session) => session.session)).toContain('late');
    const fresh = stage();
    expect(await runHook('nightly', '', fresh.runtime, () => NOW)).toBeUndefined();
    expect((await readHookCalls(fresh.storeDir)).map((call) => call.hit)).toEqual([true]);
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
