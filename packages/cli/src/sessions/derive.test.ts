import { copyFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deriveSession, episodesOf, extractSession, isRunner, rankRecovery, RECOVERY_WINDOW, REDO_WINDOW, type Episode, type EpisodeOutcome, type SessionCapture } from './derive.js';
import { captureSession, emptyUsage, shellTarget } from './extract.js';
import { books, formatBooks, formatMeasure, measure } from './query.js';
import { makeRedactor } from './redact.js';
import { CAPTURE_VERSION, type ErrorLineObservation, type ErrorObservation, type PromptVerify, type ShellSegment, type ToolObservation, type ToolStatus, type UserPromptObservation } from './schema.js';
import { deposit, depositSession, derive, loadStore, paths } from './store.js';
import { cleanup, FIXTURES, NOW, stage } from './test-support.js';

afterEach(cleanup);

const options = { allow: ['proj'], redactDomains: [], now: () => NOW };
const NOW_ISO = new Date(NOW).toISOString();

describe('the derive stage (register A28)', () => {
  it('re-derives the version-2 records from the log alone: deleting every raw transcript changes nothing a reader sees', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const before = await loadStore(staged.storeDir);
    rmSync(staged.projectsRoot, { recursive: true, force: true });
    const after = await loadStore(staged.storeDir);
    expect(after).toEqual(before);
    expect(formatMeasure(measure(after, [], [], 5))).toBe(formatMeasure(measure(before, [], [], 5)));
    expect(after.prompts.length).toBeGreaterThan(0);
    expect(after.errors.length).toBeGreaterThan(0);
  });

  it('derives from the log what capture plus derive in one pass computes from raw', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const store = await loadStore(staged.storeDir);
    const raw = extractSession({
      text: readFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), 'utf8'),
      session: 'errors-a',
      project: 'proj',
      rev: store.sessions.find((session) => session.session === 'errors-a')?.rev ?? 0,
      at: '',
      bytes: 0,
      redact: makeRedactor(),
    });
    const strip = (records: readonly { session: string }[]) => records.filter((record) => record.session === 'errors-a');
    expect(strip(store.prompts)).toEqual(raw.prompts);
    expect(strip(store.errors)).toEqual(raw.errors);
  });

  it('keeps a version-2 session as written, files a subagent transcript apart, and skips records with no session line', async () => {
    const staged = stage();
    mkdirSync(staged.storeDir, { recursive: true });
    const v2 = extractSession({ text: readFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), 'utf8'), session: 'old', project: 'proj', rev: 1, at: '', bytes: 0, redact: makeRedactor() });
    // A version-2 session line: `v` instead of `cv`, and no parent or agent fields.
    const legacy: { [key: string]: unknown } = { ...v2.session, v: '2' };
    for (const key of ['cv', 'parent', 'agentType', 'spawnedBy']) Reflect.deleteProperty(legacy, key);
    const child = extractSession({
      text: readFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), 'utf8'),
      session: 'old~agent-a',
      project: 'proj',
      rev: 1,
      at: '',
      bytes: 0,
      redact: makeRedactor(),
      subagent: { parent: 'old', agentType: 'Explore', spawnedBy: 'toolu_1' },
    });
    const lines = [legacy, ...v2.prompts, ...v2.errors, child.session, ...child.tools, { ...v2.tools[0], session: 'orphan' }];
    writeFileSync(paths(staged.storeDir).observations, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    const store = await loadStore(staged.storeDir);
    expect(store.sessions).toEqual([expect.objectContaining({ session: 'old', cv: '2', parent: null, agentType: null, spawnedBy: null })]);
    expect(store.prompts).toEqual(v2.prompts);
    expect(store.errors).toEqual(v2.errors);
    expect(store.subagents).toEqual([expect.objectContaining({ session: 'old~agent-a', parent: 'old', agentType: 'Explore', spawnedBy: 'toolu_1' })]);
    expect(store.tools).toEqual(child.tools);
  });
});

describe('subagent transcripts (A24)', () => {
  const withSubagents = () => {
    const staged = stage();
    const parent = join(staged.projectsRoot, 'proj', 'errors-a', 'subagents');
    mkdirSync(join(parent, 'workflows', 'wf_1'), { recursive: true });
    copyFileSync(join(FIXTURES, 'proj', 'sidechain.jsonl'), join(parent, 'agent-x.jsonl'));
    writeFileSync(join(parent, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 't1' }));
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), join(parent, 'workflows', 'wf_1', 'agent-y.jsonl'));
    writeFileSync(join(parent, 'agent-x.notes.txt'), 'not a transcript');
    writeFileSync(join(parent, 'workflows', 'wf_1', 'agent-z.meta.json'), '{ torn');
    mkdirSync(join(parent, 'workflows', 'other'));
    return { staged, parent };
  };

  it('deposits subagent transcripts apart from sessions, with their parent and type, and books their tokens to the spawning prompt', async () => {
    const { staged } = withSubagents();
    const first = await deposit(staged.runtime, options);
    expect(first).toMatchObject({ sessions: 4, subagents: 2 });
    expect(await deposit(staged.runtime, options)).toMatchObject({ sessions: 0, subagents: 0, unchanged: 6 });
    const store = await loadStore(staged.storeDir);
    expect(store.sessions).toHaveLength(4);
    expect(store.subagents.map((agent) => [agent.session, agent.parent, agent.agentType, agent.spawnedBy])).toEqual([
      ['errors-a~agent-x', 'errors-a', 'Explore', 't1'],
      ['errors-a~wf_1~agent-y', 'errors-a', null, null],
    ]);
    const agentTools = store.tools.filter((tool) => tool.session === 'errors-a~agent-x');
    expect(agentTools.length).toBeGreaterThan(0);
    expect(agentTools.every((tool) => tool.parent === 'errors-a' && tool.agentType === 'Explore' && !tool.side)).toBe(true);
    const spent = store.subagents[0]?.usage;
    const rows = books(store, 'class', NOW);
    expect(rows.reduce((total, row) => total + row.delegated, 0)).toBe((spent?.input ?? 0) + (spent?.cacheWrite ?? 0) + (spent?.cacheRead ?? 0) + (spent?.output ?? 0));
    expect(rows.reduce((total, row) => total + row.delegated, 0)).toBeGreaterThan(0);
    expect(formatBooks(rows, 'class')).toContain('delegated');
    // Every deposited transcript, main and subagent, is in oars' own raw archive (retention point 4c).
    const raw = join(paths(staged.storeDir).raw, 'proj');
    expect(readFileSync(join(raw, 'errors-a', 'subagents', 'workflows', 'wf_1', 'agent-y.jsonl'), 'utf8')).toBe(readFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), 'utf8'));
    expect(readFileSync(join(raw, 'errors-a.jsonl'), 'utf8')).toBe(readFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), 'utf8'));
  });

  it("derives a subagent's errors into the store under its parent, so each signature counts the parent once", async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const without = await loadStore(staged.storeDir);
    // The agent repeats its parent's own transcript: every error doubles, no signature gains a session.
    const parent = join(staged.projectsRoot, 'proj', 'errors-a', 'subagents');
    mkdirSync(parent, { recursive: true });
    copyFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), join(parent, 'agent-x.jsonl'));
    writeFileSync(join(parent, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 't6' }));
    await deposit(staged.runtime, options);
    const store = await loadStore(staged.storeDir);
    const mine = without.errors.filter((error) => error.session === 'errors-a');
    const agents = store.errors.filter((error) => error.agent === 'errors-a~agent-x');
    expect(mine.length).toBeGreaterThan(0);
    expect(agents.map((error) => error.sig)).toEqual(mine.map((error) => error.sig));
    // Attributed to the parent prompt whose call (t6) spawned the agent, with that prompt's class.
    const spawning = store.prompts.find((prompt) => prompt.session === 'errors-a' && prompt.index === 0);
    expect(agents.every((error) => error.session === 'errors-a' && error.prompt === 0 && error.cls === spawning?.cls)).toBe(true);
    expect(store.errors).toHaveLength(without.errors.length + mine.length);
    expect(store.sessions).toHaveLength(without.sessions.length);
    const sessionsOf = (errors: ErrorObservation[]) => new Map(derive({ ...store, errors }, NOW_ISO).signatures.map((sig) => [sig.sig, [sig.sessions, sig.count]]));
    const before = sessionsOf(without.errors);
    for (const [sig, [sessions, count]] of sessionsOf(store.errors)) {
      const was = before.get(sig) ?? [0, 0];
      expect(sessions).toBe(was[0]);
      expect(count).toBe((was[1] ?? 0) + agents.filter((error) => error.sig === sig).length);
    }
    // An agent whose spawning call is not in the parent keeps its errors with no prompt.
    writeFileSync(join(parent, 'agent-x.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'missing' }));
    copyFileSync(join(FIXTURES, 'proj', 'errors-b.jsonl'), join(parent, 'agent-x.jsonl'));
    await deposit(staged.runtime, options);
    const orphaned = (await loadStore(staged.storeDir)).errors.filter((error) => error.agent === 'errors-a~agent-x');
    expect(orphaned.length).toBeGreaterThan(0);
    expect(orphaned.every((error) => error.session === 'errors-a' && error.prompt === null && error.cls === null)).toBe(true);
  });

  it('takes the subagents of a session at its Stop deposit', async () => {
    const { staged, parent } = withSubagents();
    const transcript = join(staged.projectsRoot, 'proj', 'errors-a.jsonl');
    // Before any deposit names a folder, every folder is allowed.
    expect(await depositSession(staged.runtime, transcript, () => NOW)).toBe('deposited');
    await deposit(staged.runtime, { ...options, allow: ['proj'] });
    expect(await depositSession(staged.runtime, transcript, () => NOW)).toBe('unchanged');
    utimesSync(join(parent, 'agent-x.jsonl'), new Date(NOW), new Date(NOW + 1000));
    expect(await depositSession(staged.runtime, transcript, () => NOW)).toBe('deposited');
    expect((await loadStore(staged.storeDir)).subagents).toHaveLength(2);
  });
});

describe('recovery episodes (recovery_episodes.py)', () => {
  const redact = makeRedactor();
  const fromFixture = (name: string): SessionCapture => {
    const text = readFileSync(join(FIXTURES, 'proj', `${name}.jsonl`), 'utf8');
    return captureSession({ text, session: name, project: 'proj', rev: 1, at: '', bytes: 0, redact });
  };
  /** A capture from call specs: `[tool, target, status]`, an optional toolUseId, and an error line for each failed call. */
  const synthetic = (session: string, specs: readonly (readonly [string, string, ToolStatus, string?])[], orphans: readonly { after: number; line: string }[] = []): SessionCapture => {
    const tools = specs.map(([tool, target, status, id], n): ToolObservation => ({
      kind: 'tool', cv: CAPTURE_VERSION, sid: null, session, rev: 1, parent: session, agentType: null, n, ts: null, tool, status, target, targetBase: null,
      keys: [], durationMs: null, toolUseId: id ?? `c${String(n)}`, harnessVersion: null, side: false, prompt: 0,
    }));
    const errorLine = (toolUseId: string | null, tool: string, line: string, after: number): ErrorLineObservation => ({
      kind: 'error-line', cv: CAPTURE_VERSION, sid: null, session, rev: 1, toolUseId, tool, line, ts: null, harnessVersion: null, side: false, prompt: 0, after,
    });
    const errorLines = [
      ...tools.filter((tool) => tool.status === 'error').map((tool) => errorLine(tool.toolUseId, tool.tool, `${tool.tool} failed`, tool.n + 1)),
      ...orphans.map((orphan) => errorLine('gone', '?', orphan.line, orphan.after)),
    ].sort((a, b) => a.after - b.after);
    const head = fromFixture('errors-a').session;
    return { session: { ...head, session }, prompts: [], tools, errorLines };
  };

  it('reads fixed, worked around, and abandoned on the fixtures', () => {
    // errors-a: the quoting Bash failure is replaced by an Edit (shell to edit), the unread Write by an Edit (same family).
    expect(episodesOf(fromFixture('errors-a'), redact)).toEqual([
      { session: 'errors-a', sig: 'Bash | bash: -c: line <n>: unexpected EOF while looking for matching quote', outcome: 'worked around', calls: 3 },
      { session: 'errors-a', sig: 'Write | File has not been read yet. Read it first before writing to it.', outcome: 'worked around', calls: 2 },
    ]);
    expect(episodesOf(synthetic('s', [['Bash', 'npm test', 'error'], ['Read', 'a', 'ok'], ['Bash', 'npm test', 'ok']]), redact)).toEqual([
      { session: 's', sig: 'Bash | Bash failed', outcome: 'fixed', calls: 2 },
    ]);
    expect(episodesOf(synthetic('s', [['Bash', 'npm test', 'error'], ['Read', 'a', 'ok'], ['TodoWrite', 'TodoWrite', 'ok']]), redact)).toEqual([
      { session: 's', sig: 'Bash | Bash failed', outcome: 'abandoned', calls: 2 },
    ]);
  });

  it('carries the call a derived error answers, so a reader can count one row per call', () => {
    const capture = synthetic('s', [['Bash', 'npm test', 'error']]);
    const id = capture.tools[0]?.toolUseId;
    expect(id).toEqual(expect.any(String));
    expect(deriveSession(capture, redact).errors[0]?.toolUseId).toBe(id);
  });

  it('looks 20 calls ahead and no further', () => {
    expect(RECOVERY_WINDOW).toBe(20);
    const filler = Array.from({ length: 19 }, (): readonly [string, string, ToolStatus] => ['TodoWrite', 'TodoWrite', 'ok']);
    const at20 = synthetic('s', [['Bash', 'npm test', 'error'], ...filler, ['Bash', 'npm test', 'ok']]);
    const at21 = synthetic('s', [['Bash', 'npm test', 'error'], ...filler, ['TodoWrite', 'TodoWrite', 'ok'], ['Bash', 'npm test', 'ok']]);
    expect(episodesOf(at20, redact)[0]).toMatchObject({ outcome: 'fixed', calls: 20 });
    expect(episodesOf(at21, redact)[0]).toMatchObject({ outcome: 'abandoned', calls: 20 });
  });

  it('counts a repeated toolUseId once and makes an orphan error a call of its own, named ?', () => {
    const resumed = synthetic('s', [['Bash', 'npm test', 'error', 'x'], ['Bash', 'npm test', 'error', 'x'], ['Bash', 'npm test', 'ok']]);
    expect(episodesOf(resumed, redact)).toEqual([{ session: 's', sig: 'Bash | Bash failed', outcome: 'fixed', calls: 1 }]);
    const orphan = synthetic('s', [['Read', 'a', 'ok'], ['Read', 'b', 'ok']], [{ after: 1, line: 'tool 42 is gone' }]);
    expect(episodesOf(orphan, redact)).toEqual([{ session: 's', sig: '? | tool <n> is gone', outcome: 'abandoned', calls: 1 }]);
  });

  it('ranks signatures seen in two or more sessions by sessions times median calls, then sessions, errors, and signature', () => {
    const episode = (session: string, sig: string, outcome: EpisodeOutcome, calls: number): Episode => ({ session, sig, outcome, calls });
    const ranked = rankRecovery(
      [
        episode('a', 'one-session', 'fixed', 9),
        episode('a', 'one-session', 'fixed', 9),
        episode('a', 'B', 'fixed', 1),
        episode('b', 'B', 'abandoned', 3),
        episode('a', 'A', 'worked around', 2),
        episode('b', 'A', 'fixed', 2),
        episode('a', 'C', 'fixed', 4),
        episode('b', 'C', 'fixed', 4),
        episode('c', 'C', 'abandoned', 4),
      ],
      10,
    );
    expect(ranked.map((rank) => rank.sig)).toEqual(['C', 'A', 'B']);
    expect(ranked[0]).toEqual({ sig: 'C', sessions: 3, errors: 3, medianCalls: 4, score: 12, fixed: 2, workedAround: 0, abandoned: 1 });
    expect(ranked[1]).toMatchObject({ sig: 'A', score: 4, fixed: 1, workedAround: 1 });
    expect(ranked[2]).toMatchObject({ sig: 'B', medianCalls: 2, score: 4, abandoned: 1 });
    expect(rankRecovery([episode('a', 'C', 'fixed', 1), episode('b', 'C', 'fixed', 1), episode('a', 'A', 'fixed', 1), episode('b', 'A', 'fixed', 1)], 1)).toMatchObject([{ sig: 'A' }]);
  });
});

describe('prompt outcome signals', () => {
  const redact = makeRedactor();
  const head = captureSession({ text: readFileSync(join(FIXTURES, 'proj', 'errors-a.jsonl'), 'utf8'), session: 's', project: 'proj', rev: 1, at: '', bytes: 0, redact }).session;
  interface Call {
    prompt: number | null;
    tool: string;
    status?: ToolStatus;
    target?: string | null;
    id?: string | null;
    keys?: string[];
    side?: boolean;
    segments?: ShellSegment[];
    commits?: Array<string | null>;
  }
  interface Failure {
    prompt: number;
    line: string;
    side?: boolean;
    id?: string;
  }
  const edit = (prompt: number, target = 'hash-a', status: ToolStatus = 'ok'): Call => ({ prompt, tool: 'Edit', target, status });
  const shell = (prompt: number, status: ToolStatus = 'ok', target = 'npm test'): Call => ({ prompt, tool: 'Bash', target, status, segments: [{ run: target, read: true }] });
  const commit = (prompt: number, status: ToolStatus = 'ok'): Call => ({ ...shell(prompt, status, 'git commit'), ...(status === 'ok' ? { commits: ['abc1234'] } : {}) });
  /** A record captured before CAPTURE 6: `target` is all it has. */
  const older = (call: Call): Call => ({ prompt: call.prompt, tool: call.tool, ...(call.target === undefined ? {} : { target: call.target }), ...(call.status === undefined ? {} : { status: call.status }) });
  const derived = (heads: readonly string[], calls: readonly Call[], failures: readonly Failure[] = []) => {
    const tools = calls.map((call, n): ToolObservation => ({
      kind: 'tool', cv: CAPTURE_VERSION, sid: null, session: 's', rev: 1, parent: 's', agentType: null, n, ts: null, tool: call.tool, status: call.status ?? 'ok', target: call.target ?? null, targetBase: null,
      keys: call.keys ?? [], durationMs: null, toolUseId: call.id === undefined ? `c${String(n)}` : call.id, harnessVersion: null, side: call.side ?? false, prompt: call.prompt,
      ...(call.segments === undefined ? {} : { segments: call.segments }), ...(call.commits === undefined ? {} : { commits: call.commits }),
    }));
    const errorLines = failures.map((failure): ErrorLineObservation => ({
      kind: 'error-line', cv: CAPTURE_VERSION, sid: null, session: 's', rev: 1, toolUseId: failure.id ?? null, tool: 'Edit', line: failure.line, ts: null, harnessVersion: null, side: failure.side ?? false, prompt: failure.prompt, after: 0,
    }));
    const prompts = heads.map((text, index): UserPromptObservation => ({
      kind: 'user-prompt', cv: CAPTURE_VERSION, sid: null, session: 's', rev: 1, index, ts: null, wallSec: null, head: text, thinking: 0, turns: 0, model: 'm', efforts: [], skills: [], usage: emptyUsage(), promptFingerprint: null,
    }));
    return deriveSession({ session: head, prompts, tools, errorLines }, redact).prompts;
  };
  const one = (calls: readonly Call[], failures: readonly Failure[] = []) => derived(['work'], calls, failures)[0];
  const asPrompts = (count: number): string[] => Array.from({ length: count }, (_, index) => `prompt ${String(index)}`);

  describe('verify', () => {
    it.each<[string, Call[], PromptVerify]>([
      ['no call', [], 'na'],
      ['only reads and shell', [{ prompt: 0, tool: 'Read', target: 'hash-a' }, shell(0)], 'na'],
      ['only a failed edit', [edit(0, 'hash-a', 'error'), shell(0)], 'na'],
      ['an edit and no shell call', [edit(0)], 'none'],
      ['a shell call before the edit only', [shell(0), edit(0)], 'none'],
      ['a last shell call with no result', [edit(0), shell(0), shell(0, 'none')], 'none'],
      ['an edit with no result of its own', [edit(0, 'hash-a', 'none'), shell(0)], 'passed'],
      ['a clean shell call after the edit', [edit(0), shell(0)], 'passed'],
      ['PowerShell', [edit(0), { ...shell(0, 'error'), tool: 'PowerShell' }], 'failed'],
      ['a Write and a MultiEdit', [{ prompt: 0, tool: 'Write', target: 'hash-a' }, shell(0, 'error'), { prompt: 0, tool: 'MultiEdit', target: 'hash-b' }, shell(0)], 'passed'],
      ['the last of several: a fix after a failure', [edit(0), shell(0, 'error'), shell(0)], 'passed'],
      ['the last of several: a failure after a pass', [edit(0), shell(0), shell(0, 'error')], 'failed'],
      ['an edit after the failure takes the failure out of the running', [edit(0), shell(0, 'error'), edit(0)], 'none'],
      ['a failed edit is not the last edit', [edit(0), shell(0), edit(0, 'hash-a', 'error')], 'passed'],
      ['a backgrounded call only says it started', [edit(0), { ...shell(0), keys: ['command', 'run_in_background'] }], 'none'],
      ['the call before a backgrounded one decides', [edit(0), shell(0, 'error'), { ...shell(0), keys: ['command', 'run_in_background'] }], 'failed'],
      ['a sidechain edit is not the prompt editing', [{ ...edit(0), side: true }, shell(0)], 'na'],
      ['a sidechain shell call does not decide', [edit(0), shell(0), { ...shell(0, 'error'), side: true }], 'passed'],
      ['a read after the edit is no verification', [edit(0), shell(0, 'ok', 'ls')], 'none'],
      ['a read after a runner does not decide', [edit(0), shell(0), shell(0, 'error', 'ls')], 'passed'],
      ['a runner behind a pipe is masked', [edit(0), { ...shell(0), segments: [{ run: 'npm test', read: false }, { run: 'tail', read: true }] }], 'masked'],
      ['a failed call with a masked runner is still masked', [edit(0), { ...shell(0, 'error'), segments: [{ run: 'npm test', read: false }, { run: 'false', read: true }] }], 'masked'],
      ['the last runner of a call decides', [edit(0), { ...shell(0), segments: [{ run: 'npm test', read: false }, { run: 'npm run build', read: true }] }], 'passed'],
      ['a runner chained to a later command reads the call', [edit(0), { ...shell(0, 'error'), segments: [{ run: 'cd web', read: true }, { run: 'npm test', read: true }, { run: 'git push', read: true }] }], 'failed'],
      ['a runner with no result', [edit(0), shell(0, 'none')], 'none'],
      ['a masked runner with no result', [edit(0), { ...shell(0, 'none'), segments: [{ run: 'npm test', read: false }, { run: 'tail', read: true }] }], 'none'],
    ])('%s', (_name, calls, expected) => {
      expect(one(calls)?.verify).toBe(expected);
    });
    it('reads the first copies of a repeated call, so a resumed repeat does not turn a later prompt into none', () => {
      // The repeat of `x` under prompt 1 is dropped, leaving that prompt no calls: `na`, not the `none` its own edit would read as.
      expect(derived(['work', 'work'], [{ ...edit(0), id: 'x' }, { ...edit(1, 'hash-a', 'none'), id: 'x' }]).map((prompt) => prompt.verify)).toEqual(['none', 'na']);
    });
    it('says nothing about a shell call captured before segments, which could have been a runner', () => {
      expect(one([edit(0), older(shell(0))])?.verify).toBeUndefined();
      expect(one([edit(0), shell(0), older(shell(0))])?.verify).toBeUndefined();
    });
    it('still reads a runner that came after an older call', () => {
      expect(one([edit(0), older(shell(0)), shell(0)])?.verify).toBe('passed');
    });
    it.each<[string, boolean]>([
      ['npm test', true], ['npm t', true], ['bun t', true], ['npm run test:unit', true], ['npm run typecheck', true], ['pnpm build', true], ['yarn lint', true],
      ['npx vitest run', true], ['npx tsc', true], ['pnpm exec jest', true], ['uv run pytest', true], ['python pytest', true], ['vitest', true],
      ['mvn mod-x verify', true], ['mvn package', true], ['mvnw install', true], ['gradlew test', true], ['just build oars run check', true], ['make', true], ['make test', true],
      ['cargo test', true], ['cargo clippy', true], ['go vet', true], ['go test', true], ['dotnet build', true],
      ['ls', false], ['git status', false], ['git commit', false], ['cat test', false], ['npm install', false], ['npm run dev', false], ['just status', false], ['just checkout', false],
      ['cargo add', false], ['go get', false], ['make clean', false], ['mvn', false], ['python script', false], ['npx foo', false],
      ['pnpm vitest run', true], ['yarn tsc', true], ['npm exec vitest', true], ['bun jest', true], ['python unittest', true], ['pnpm playwright test', true],
      ['playwright install', false], ['npx playwright install', false], ['yarn playwright install', false], ['pre-commit install', false], ['cypress open', false],
      ['pnpm web add test-utils', false], ['npm web install test-utils', false], ['npm run test-utils', true],
      ['npm install lint-staged', false], ['pnpm add test-utils', false], ['npm uninstall jest-check', false], ['cargo add check', false], ['go get test', false], ['npm view test', false], ['go run check', false],
      ['cargo test add', true], ['npm test install', true], ['pnpm test view', true], ['yarn workspace web add test-utils', false], ['yarn workspace web test', true],
    ])('%s is a runner: %s', (run, expected) => {
      expect(isRunner({ run, read: true })).toBe(expected);
    });
  });

  describe('captured commits', () => {
    it('counts a commit behind another command, and each of several', () => {
      expect(one([{ ...shell(0, 'ok', 'git add'), commits: ['abc1234', null] }])?.commits).toBe(2);
    });
    it('counts a commit whose sha could not be read', () => {
      expect(one([{ ...shell(0, 'ok', 'git add'), commits: [null] }])?.commits).toBe(1);
    });
    it('a captured call with no commits is not a commit, whatever its target says', () => {
      expect(one([shell(0, 'ok', 'git commit')])?.commits).toBe(0);
    });
    it('keeps the first-line floor for a record captured before CAPTURE 6', () => {
      expect(one([older(commit(0))])?.commits).toBe(1);
      expect(one([older(commit(0, 'error'))])?.commits).toBe(0);
      expect(one([older(shell(0))])?.commits).toBe(0);
    });
    it('a commit behind another command ends the redo window', () => {
      const prompts = derived(asPrompts(2), [edit(0), { ...shell(0, 'ok', 'git add'), commits: ['abc1234'] }, edit(1)]);
      expect(prompts[0]?.redo).toBe(false);
    });
  });

  describe('stopped', () => {
    const REJECTED = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).";
    it('is null with no marker', () => {
      expect(one([edit(0)])?.stopped).toBeNull();
    });

    it.each([REJECTED, "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."])('reads a tool rejection from its error line: %s', (line) => {
      expect(one([edit(0, 'hash-a', 'error')], [{ prompt: 0, line }])?.stopped).toBe('rejected');
    });

    it.each(['Permission for this action was denied by the Claude Code auto mode classifier. Reason: x', 'PreToolUse:Bash hook error: y', 'Search failed: ripgrep rejected the pattern'])('does not read a policy or tool failure as the user rejecting: %s', (line) => {
      expect(one([edit(0, 'hash-a', 'error')], [{ prompt: 0, line }])?.stopped).toBeNull();
    });

    it('does not read a sidechain rejection as the prompt being stopped', () => {
      expect(one([edit(0)], [{ prompt: 0, line: REJECTED, side: true }])?.stopped).toBeNull();
    });

    it.each(['[Request interrupted by user]', '[Request interrupted by user for tool use]'])('books the marker %s to the prompt it cut short, not to itself', (marker) => {
      expect(derived(['work', marker, 'next'], []).map((prompt) => prompt.stopped)).toEqual(['interrupt', null, null]);
    });

    it('does not read the marker quoted inside a prompt', () => {
      expect(derived(['work', 'why did [Request interrupted by user] appear?'], []).map((prompt) => prompt.stopped)).toEqual([null, null]);
    });

    it('names a rejection over the interrupt marker the harness writes right after it', () => {
      expect(derived(['work', '[Request interrupted by user for tool use]'], [edit(0, 'hash-a', 'error')], [{ prompt: 0, line: REJECTED }])[0]?.stopped).toBe('rejected');
    });

    it('does not read a rejection a resumed session repeats as the later prompt being stopped', () => {
      const failures = [{ prompt: 0, line: REJECTED, id: 'x' }, { prompt: 2, line: REJECTED, id: 'x' }];
      expect(derived(asPrompts(3), [], failures).map((prompt) => prompt.stopped)).toEqual(['rejected', null, null]);
    });

    it('finds a repeat through capture, and still counts it in errors', () => {
      const user = (text: string): string => JSON.stringify({ type: 'user', isSidechain: false, cwd: '/work/app', message: { role: 'user', content: text } });
      const call = JSON.stringify({ type: 'assistant', isSidechain: false, requestId: 'r1', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/work/app/a.ts', old_string: 'a', new_string: 'b' } }] } });
      const result = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', is_error: true, content: REJECTED }] } });
      const lines = [user('first'), call, result, user('second'), user('resumed'), call, result].join('\n');
      const { prompts } = extractSession({ text: lines, session: 's', project: 'proj', rev: 1, at: '', bytes: 0, redact });
      expect(prompts.map((prompt) => [prompt.stopped, prompt.errors])).toEqual([['rejected', 1], [null, 0], [null, 1]]);
    });

    it('keeps a second rejection of another call, and two with no id, each on its own prompt', () => {
      expect(derived(asPrompts(2), [], [{ prompt: 0, line: REJECTED, id: 'x' }, { prompt: 1, line: REJECTED, id: 'y' }]).map((prompt) => prompt.stopped)).toEqual(['rejected', 'rejected']);
      expect(derived(asPrompts(2), [], [{ prompt: 0, line: REJECTED }, { prompt: 1, line: REJECTED }]).map((prompt) => prompt.stopped)).toEqual(['rejected', 'rejected']);
    });

    it('does not let a sidechain copy of an id hide the main-line rejection', () => {
      expect(derived(asPrompts(1), [], [{ prompt: 0, line: REJECTED, id: 'x', side: true }, { prompt: 0, line: REJECTED, id: 'x' }])[0]?.stopped).toBe('rejected');
    });

    it('finds both markers in a real transcript shape, through capture', () => {
      const user = (text: string): string => JSON.stringify({ type: 'user', isSidechain: false, cwd: '/work/app', message: { role: 'user', content: text } });
      const lines = [
        user('first'),
        JSON.stringify({ type: 'assistant', isSidechain: false, requestId: 'r1', message: { role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/work/app/a.ts', old_string: 'a', new_string: 'b' } }] } }),
        JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', is_error: true, content: `${REJECTED} STOP what you are doing and wait for the user to tell you how to proceed.` }] } }),
        JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
        user('second'),
        user('[Request interrupted by user]'),
        user('third'),
      ].join('\n');
      const { prompts } = extractSession({ text: lines, session: 's', project: 'proj', rev: 1, at: '', bytes: 0, redact });
      expect(prompts.map((prompt) => [prompt.head.slice(0, 8), prompt.stopped, prompt.verify])).toEqual([
        ['first', 'rejected', 'na'],
        ['[Request', null, 'na'],
        ['second', 'interrupt', 'na'],
        ['[Request', null, 'na'],
        ['third', null, 'na'],
      ]);
    });
  });

  describe('commits', () => {
    it('counts the successful calls the captured target names as git commit', () => {
      expect(one([commit(0), edit(0), commit(0), { prompt: 0, tool: 'PowerShell', target: 'git commit' }])?.commits).toBe(3);
    });

    it('counts no failed, unanswered, or sidechain commit, and no other git call', () => {
      expect(one([commit(0, 'error'), commit(0, 'none'), { ...commit(0), side: true }, shell(0, 'ok', 'git push'), { prompt: 0, tool: 'Read', target: 'git commit' }])?.commits).toBe(0);
    });

    // The target is the first line's program and subcommand, so this form is out of reach until the captured commits field lands.
    it('is a floor: a commit behind another command on the line is not seen', () => {
      // The target is what `shellTarget` reads from the real command, so the form runs through it.
      const target = shellTarget('git add . && git commit -m x');
      expect(target).toBe('git add');
      expect(one([shell(0, 'ok', target)])?.commits).toBe(0);
    });

    it('counts a call a resumed session repeats once, under the prompt that made it', () => {
      expect(derived(['work', 'work'], [{ ...commit(0), id: 'x' }, { ...commit(1, 'none'), id: 'x' }]).map((prompt) => prompt.commits)).toEqual([1, 0]);
    });
  });

  describe('redo', () => {
    const redone = (count: number, calls: readonly Call[]): (boolean | undefined)[] => derived(asPrompts(count), calls).map((prompt) => prompt.redo);

    it('marks the earlier prompt when the next one edits the same path', () => {
      expect(redone(2, [edit(0), edit(1)])).toEqual([true, false]);
    });

    it('looks REDO_WINDOW prompts ahead and no further', () => {
      expect(REDO_WINDOW).toBe(3);
      expect(redone(REDO_WINDOW + 1, [edit(0), edit(REDO_WINDOW)])[0]).toBe(true);
      expect(redone(REDO_WINDOW + 2, [edit(0), edit(REDO_WINDOW + 1)])[0]).toBe(false);
    });

    it('marks each prompt of a chain but the last', () => {
      expect(redone(3, [edit(0), edit(1), edit(2)])).toEqual([true, true, false]);
    });

    it('ignores another path, a read of the path, a failed re-edit, and two edits in one prompt', () => {
      expect(redone(2, [edit(0), edit(1, 'hash-b')])).toEqual([false, false]);
      expect(redone(2, [edit(0), { prompt: 1, tool: 'Read', target: 'hash-a' }])).toEqual([false, false]);
      expect(redone(2, [edit(0), edit(1, 'hash-a', 'error')])).toEqual([false, false]);
      expect(redone(1, [edit(0), edit(0)])).toEqual([false]);
    });

    it('does not count a failed first edit as the prompt having edited the path', () => {
      expect(redone(2, [edit(0, 'hash-a', 'error'), edit(1)])).toEqual([false, false]);
    });

    it('stops at a commit between the two edits, wherever it falls', () => {
      expect(redone(2, [edit(0), commit(0), edit(1)])).toEqual([false, false]);
      expect(redone(3, [edit(0), commit(1), edit(2)])).toEqual([false, false, false]);
      expect(redone(2, [edit(0), commit(1), edit(1)])).toEqual([false, false]);
    });

    it('does not stop at a failed commit, or a commit before the first edit or after the second', () => {
      expect(redone(2, [edit(0), commit(1, 'error'), edit(1)])[0]).toBe(true);
      expect(redone(2, [commit(0), edit(0), edit(1), commit(1)])[0]).toBe(true);
    });

    it('does not read a call a resumed session repeats as a second edit', () => {
      expect(redone(2, [{ ...edit(0), id: 'x' }, { ...edit(1, 'hash-a', 'none'), id: 'x' }])).toEqual([false, false]);
    });

    it('keeps every call with no id: nothing says one repeats another', () => {
      expect(redone(2, [{ ...edit(0), id: null }, { ...edit(1), id: null }])).toEqual([true, false]);
    });

    it('skips a call with no target and a sidechain edit', () => {
      expect(redone(2, [{ prompt: 0, tool: 'Edit', target: null }, { prompt: 1, tool: 'Edit', target: null }])).toEqual([false, false]);
      expect(redone(2, [edit(0), { ...edit(1), side: true }])).toEqual([false, false]);
    });

    it('takes a call before the first prompt as no edit of any prompt', () => {
      expect(redone(1, [{ ...edit(0), prompt: null }, edit(0)])).toEqual([false]);
    });
  });
});
