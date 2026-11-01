import { copyFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { episodesOf, extractSession, rankRecovery, RECOVERY_WINDOW, type Episode, type EpisodeOutcome, type SessionCapture } from './derive.js';
import { captureSession } from './extract.js';
import { books, formatBooks, formatMeasure, measure } from './query.js';
import { makeRedactor } from './redact.js';
import { CAPTURE_VERSION, type ErrorLineObservation, type ErrorObservation, type ToolObservation, type ToolStatus } from './schema.js';
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
    const sessionsOf = (errors: readonly ErrorObservation[]) => new Map(derive({ ...store, errors }, NOW_ISO).signatures.map((sig) => [sig.sig, [sig.sessions, sig.count]]));
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
    expect(await depositSession(staged.runtime, transcript, () => NOW)).toBe('not-allowed');
    await deposit(staged.runtime, { ...options, allow: ['proj'] });
    expect(await depositSession(staged.runtime, transcript, () => NOW)).toBe('unchanged');
    utimesSync(join(parent, 'agent-x.jsonl'), new Date(NOW), new Date(NOW + 1000));
    expect(await depositSession(staged.runtime, transcript, () => NOW)).toBe('deposited');
    expect((await loadStore(staged.storeDir)).subagents).toHaveLength(2);
  });
});

describe('recovery episodes (recovery_episodes.py, t693)', () => {
  const redact = makeRedactor();
  const fromFixture = (name: string): SessionCapture => {
    const text = readFileSync(join(FIXTURES, 'proj', `${name}.jsonl`), 'utf8');
    return captureSession({ text, session: name, project: 'proj', rev: 1, at: '', bytes: 0, redact });
  };
  /** A capture from call specs: `[tool, target, status]`, an optional toolUseId, and an error line for each failed call. */
  const synthetic = (session: string, specs: readonly (readonly [string, string, ToolStatus, string?])[], orphans: readonly { after: number; line: string }[] = []): SessionCapture => {
    const tools = specs.map(([tool, target, status, id], n): ToolObservation => ({
      kind: 'tool', cv: CAPTURE_VERSION, session, rev: 1, parent: session, agentType: null, n, ts: null, tool, status, target,
      keys: [], durationMs: null, toolUseId: id ?? `c${n}`, harnessVersion: null, side: false, prompt: 0,
    }));
    const errorLine = (toolUseId: string | null, tool: string, line: string, after: number): ErrorLineObservation => ({
      kind: 'error-line', cv: CAPTURE_VERSION, session, rev: 1, toolUseId, tool, line, ts: null, harnessVersion: null, side: false, prompt: 0, after,
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
