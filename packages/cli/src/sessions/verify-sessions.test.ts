// `oars sessions verify` with the per-session results and the T0 audit (t743).
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsVerify } from './command.js';
import { deposit, paths, readState } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

afterEach(cleanup);
const options = { allow: ['proj'], redactDomains: [], now: () => NOW };

describe('sessionsVerify, per session', () => {
  it('reports every session with its rows and a T0 result, and names each row of the T0 table in the text', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const verified = await sessionsVerify(deps, { session: undefined });
    expect(verified.failed).toEqual([]);
    const { sessionResults, audit } = verified.report;
    expect(sessionResults.map((entry) => entry.session).sort()).toEqual(['errors-a', 'errors-b', 'sidechain', 'tldr']);
    expect(sessionResults.every((entry) => entry.invariants.length === 10)).toBe(true);
    expect(audit.sessions).toHaveLength(4);
    expect(audit.counts).toEqual({ 'root matches and the counts bind': 4, 'changed since deposit': 0, 'root mismatch': 0, 'counts do not bind': 0, 'not run': 0 });
    expect(verified.document).toMatchObject({ sessionResults, audit });
    // Four sessions in one week hold far under 1,000 calls: layer 2 says so and scores nothing. The audit prints ahead of it.
    expect(verified.report.selfBaseline.map((entry) => [entry.status, entry.f])).toEqual([['not run', null], ['not run', null], ['not run', null], ['not run', null]]);
    expect(verified.text).toContain('not run, week under 1000 tool calls: 4');
    expect(verified.text.indexOf('sessions audited against raw')).toBeLessThan(verified.text.indexOf('sessions against their own earlier weeks'));
    for (const row of ['root matches and the counts bind', 'changed since deposit', 'root mismatch', 'counts do not bind', 'not run']) expect(verified.text).toContain(row);
  });

  it('scopes both to --session', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: 'tldr' });
    expect(verified.report.sessionResults.map((entry) => entry.session)).toEqual(['tldr']);
    expect(verified.report.audit.sessions.map((entry) => entry.session)).toEqual(['tldr']);
  });

  it('gives --session <main id> the same row 6 as the whole-store run, its subagent transcripts included', async () => {
    const staged = stage();
    const usage = { input_tokens: 5, cache_creation_input_tokens: 6, cache_read_input_tokens: 7, output_tokens: 8 };
    const assistant = (requestId: string, timestamp: string): string => JSON.stringify({ type: 'assistant', requestId, timestamp, message: { role: 'assistant', model: 'm', content: [], usage } });
    const tokens = (factor: number) => ({ inputTokens: 5 * factor, cacheCreationInputTokens: 6 * factor, cacheReadInputTokens: 7 * factor, outputTokens: 8 * factor });
    const costState = JSON.stringify({ type: 'cost-state', startTime: Date.parse('2026-10-13T15:00:00.000Z'), modelUsage: { m: tokens(3) } });
    writeFileSync(join(staged.projectsRoot, 'proj', 'p1.jsonl'), `${[assistant('r1', '2026-10-13T16:00:00.000Z'), costState].join('\n')}\n`);
    mkdirSync(join(staged.projectsRoot, 'proj', 'p1', 'subagents'), { recursive: true });
    writeFileSync(join(staged.projectsRoot, 'proj', 'p1', 'subagents', 'agent-a.jsonl'), `${[assistant('s1', '2026-10-13T16:01:00.000Z'), assistant('s2', '2026-10-13T16:02:00.000Z')].join('\n')}\n`);
    await deposit(staged.runtime, options);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const whole = (await sessionsVerify(deps, { session: undefined })).report.sessionResults.find((entry) => entry.session === 'p1');
    const scoped = (await sessionsVerify(deps, { session: 'p1' })).report.sessionResults;
    expect(whole?.invariants[5]).toMatchObject({ checked: 4, violations: 0, status: 'pass' });
    expect(scoped.map((entry) => entry.session)).toEqual(['p1']);
    expect(scoped[0]?.invariants[5]).toEqual(whole?.invariants[5]);
    const wholeRun = await sessionsVerify(deps, { session: undefined });
    expect(wholeRun.report.audit.sessions.find((entry) => entry.session === 'p1~agent-a')?.result).toBe('root matches and the counts bind');
    expect(wholeRun.report.audit.sessions.map((entry) => entry.session).sort()).toEqual(wholeRun.report.sessionResults.map((entry) => entry.session).sort());
  });

  it('reads the subagent lines in invariants, the text, and failed under --session, when the agent pushes the sum above the total', async () => {
    const staged = stage();
    const usage = { input_tokens: 5, cache_creation_input_tokens: 6, cache_read_input_tokens: 7, output_tokens: 8 };
    const assistant = (requestId: string, timestamp: string): string => JSON.stringify({ type: 'assistant', requestId, timestamp, message: { role: 'assistant', model: 'm', content: [], usage } });
    const tokens = (factor: number) => ({ inputTokens: 5 * factor, cacheCreationInputTokens: 6 * factor, cacheReadInputTokens: 7 * factor, outputTokens: 8 * factor });
    const costState = JSON.stringify({ type: 'cost-state', startTime: Date.parse('2026-10-13T15:00:00.000Z'), modelUsage: { m: tokens(2) } });
    writeFileSync(join(staged.projectsRoot, 'proj', 'p1.jsonl'), `${[assistant('r1', '2026-10-13T16:00:00.000Z'), costState].join('\n')}\n`);
    mkdirSync(join(staged.projectsRoot, 'proj', 'p1', 'subagents'), { recursive: true });
    writeFileSync(join(staged.projectsRoot, 'proj', 'p1', 'subagents', 'agent-a.jsonl'), `${[assistant('s1', '2026-10-13T16:01:00.000Z'), assistant('s2', '2026-10-13T16:02:00.000Z')].join('\n')}\n`);
    await deposit(staged.runtime, options);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const whole = await sessionsVerify(deps, { session: undefined });
    const scoped = await sessionsVerify(deps, { session: 'p1' });
    expect(whole.failed).toContain(whole.report.invariants[5]?.name);
    expect(scoped.failed).toEqual(whole.failed);
    expect(scoped.report.invariants[5]).toEqual(whole.report.invariants[5]);
    expect(scoped.report.invariants[5]?.violations).toBeGreaterThan(0);
    expect(scoped.text).toContain('FAIL');
  });

  it('reports a session whose capture record was removed as not run in the T0 audit, with the same ids as sessionResults', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const file = paths(staged.storeDir).observations;
    const kept = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '' && !line.includes('"session":"errors-b"'));
    writeFileSync(file, `${kept.join('\n')}\n`);
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    const { audit, sessionResults } = verified.report;
    expect(audit.sessions.find((entry) => entry.session === 'errors-b')).toMatchObject({ result: 'not run', tier: 'skeleton', mode: null, bindings: { bind: false } });
    expect(audit.counts['not run']).toBe(1);
    expect(audit.sessions.map((entry) => entry.session).sort()).toEqual(sessionResults.map((entry) => entry.session).sort());
  });

  it('fails a session whose raw file edit kept the size and mtime, by name, so --strict exits 4', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const raw = join(paths(staged.storeDir).raw, 'proj', 'tldr.jsonl');
    const text = readFileSync(raw, 'utf8');
    const at = text.search(/[a-y]/);
    writeFileSync(raw, `${text.slice(0, at)}z${text.slice(at + 1)}`);
    const state = await readState(staged.storeDir);
    const entry = state.files['proj/tldr.jsonl'];
    if (entry === undefined) throw new Error('no state entry');
    entry.mtimeMs = statSync(raw).mtimeMs;
    writeFileSync(paths(staged.storeDir).state, JSON.stringify(state));
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(verified.failed).toEqual(['merkle: root mismatch']);
    expect(verified.text).toContain('FAIL  tldr: root mismatch');
    expect(verified.report.audit.counts['root mismatch']).toBe(1);
  });

  it('lists a grown file as changed since deposit and does not fail it', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    appendFileSync(join(staged.projectsRoot, 'proj', 'tldr.jsonl'), '{"type":"summary"}\n');
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(verified.failed).toEqual([]);
    expect(verified.report.audit.counts['changed since deposit']).toBe(1);
  });
});
