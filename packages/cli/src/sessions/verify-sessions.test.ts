// `oars sessions verify` with the per-session results and the T0 audit.
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionsVerify } from './command.js';
import type * as Outbox from './pool-outbox.js';
import { outboxFolder, staleBatchesAnywhere, writeBatch } from './pool-outbox.js';
import { writeRaw } from './pool-raw.js';
import { markSent } from './pool-sent.js';
import { readSteps } from './steps.js';
import { deposit, paths, readState } from './store.js';
import { cleanup, NOW, stage } from './test-support.js';

// Wraps the real count so one test can make it fail the way an unreadable folder does.
vi.mock('./pool-outbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Outbox>();
  return { ...actual, staleBatchesAnywhere: vi.fn(actual.staleBatchesAnywhere) };
});

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
    expect(verified.text.indexOf('sessions audited against raw')).toBeLessThan(verified.text.indexOf('sessions against their own other weeks'));
    for (const row of ['root matches and the counts bind', 'changed since deposit', 'root mismatch', 'counts do not bind', 'not run']) expect(verified.text).toContain(row);
  });

  it('scopes both to --session', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: 'tldr' });
    expect(verified.report.sessionResults.map((entry) => entry.session)).toEqual(['tldr']);
    expect(verified.report.audit.sessions.map((entry) => entry.session)).toEqual(['tldr']);
    // The baseline reads every week of the store and --session only picks which results are reported; the scoped entry is the unscoped one.
    const whole = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(verified.report.selfBaseline.map((entry) => entry.session)).toEqual(['tldr']);
    expect(verified.report.selfBaseline[0]?.calls).toBe(whole.report.selfBaseline.find((entry) => entry.session === 'tldr')?.calls);
    expect(verified.report.selfBaseline[0]?.calls).toBeGreaterThan(0);
  });

  it('prints the audit ahead of the per-session lines, so a long list of failing sessions comes after the T0 table', async () => {
    const staged = stage();
    const usage = { input_tokens: 5, cache_creation_input_tokens: 6, cache_read_input_tokens: 7, output_tokens: 8 };
    const assistant = (requestId: string, timestamp: string): string => JSON.stringify({ type: 'assistant', requestId, timestamp, message: { role: 'assistant', model: 'm', content: [], usage } });
    const tokens = (factor: number) => ({ inputTokens: 5 * factor, cacheCreationInputTokens: 6 * factor, cacheReadInputTokens: 7 * factor, outputTokens: 8 * factor });
    const costState = JSON.stringify({ type: 'cost-state', startTime: Date.parse('2026-10-13T15:00:00.000Z'), modelUsage: { m: tokens(2) } });
    writeFileSync(join(staged.projectsRoot, 'proj', 'p1.jsonl'), `${[assistant('r1', '2026-10-13T16:00:00.000Z'), costState].join('\n')}\n`);
    mkdirSync(join(staged.projectsRoot, 'proj', 'p1', 'subagents'), { recursive: true });
    writeFileSync(join(staged.projectsRoot, 'proj', 'p1', 'subagents', 'agent-a.jsonl'), `${[assistant('s1', '2026-10-13T16:01:00.000Z'), assistant('s2', '2026-10-13T16:02:00.000Z')].join('\n')}\n`);
    await deposit(staged.runtime, options);
    const { text } = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(text).toContain(': FAIL ');
    expect(text.indexOf('sessions audited against raw')).toBeGreaterThan(-1);
    expect(text.indexOf('sessions audited against raw')).toBeLessThan(text.indexOf(': FAIL '));
    expect(text.indexOf('sessions against their own')).toBeLessThan(text.indexOf(': FAIL '));
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

  it('fails a session whose raw file edit kept the size and mtime, by name, and logs the mismatch in the verify row', async () => {
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
    // `stepCounters` reads this row, so a mismatch that left `merkle` out would report every check passed.
    const row = (await readSteps(staged.storeDir)).filter((entry) => entry.step === 'verify').at(-1);
    expect(row?.out.merkle).toBe(1);
  });

  it('fails a session whose skeleton leaf count disagrees with its session, by name', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const file = join(paths(staged.storeDir).skeletons, 'tldr.json');
    const leaves = readFileSync(file, 'utf8').match(/"leaves":(\d+)/)?.[1];
    if (leaves === undefined) throw new Error('no leaves');
    writeFileSync(file, readFileSync(file, 'utf8').replace(`"leaves":${leaves}`, `"leaves":${String(Number(leaves) + 1)}`));
    const verified = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(verified.failed).toEqual(['merkle: counts do not bind']);
    expect(verified.text).toContain('FAIL  tldr: counts do not bind');
    const row = (await readSteps(staged.storeDir)).filter((entry) => entry.step === 'verify').at(-1);
    expect(row?.out.merkle).toBe(1);
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

describe('sessionsVerify, outbox batches', () => {
  it('counts batches built under an older vocabulary, field list, or skeleton format, on every server, and says they will never be sent', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const clean = await sessionsVerify(deps, { session: undefined });
    expect(clean.report.staleBatches).toBe(0);
    expect(clean.text).not.toContain('outbox batches');
    await writeBatch(outboxFolder(staged.storeDir, 'https://one.test'), '0123456789abcdef', { format: 1 }, 'v0-00000000');
    await writeBatch(outboxFolder(staged.storeDir, 'https://two.test'), 'fedcba9876543210', { format: 1 }, 'v0-00000000');
    // A batch under the current stamp is not stale.
    await writeBatch(outboxFolder(staged.storeDir, 'https://two.test'), '1111111111111111', { format: 1 });
    const stale = await sessionsVerify(deps, { session: undefined });
    expect(stale.report.staleBatches).toBe(2);
    expect(stale.document).toMatchObject({ staleBatches: 2 });
    expect(stale.text).toContain('2 outbox batches were built under an older vocabulary, field list, or skeleton format');
    expect(stale.failed).toEqual([]);
  });

  it('a stray file in the outbox folder is no batch and no failure', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const root = join(staged.storeDir, 'pool-outbox');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'stray.txt'), 'not a folder');
    writeFileSync(join(root, 'ab12cd34'), 'a file where a server folder belongs');
    const report = await sessionsVerify(deps, { session: undefined });
    expect(report.report.staleBatches).toBe(0);
    expect(report.failed).toEqual([]);
  });

  it('an outbox that cannot be read counts as none, the way an unreadable scope does, and does not fail verify', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    vi.mocked(staleBatchesAnywhere).mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
    const report = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(report.report.staleBatches).toBe(0);
    expect(report.failed).toEqual([]);
  });
});

describe('sessionsVerify, what was sent and what was masked (t884)', () => {
  it('counts the batches and raw copies the nightly task or --send already sent beside the stale ones, on every server', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const none = await sessionsVerify(deps, { session: undefined });
    expect(none.report).toMatchObject({ sentBatches: 0, sentRaw: 0 });
    expect(none.text).not.toContain('already sent');
    const one = outboxFolder(staged.storeDir, 'https://one.test');
    const two = outboxFolder(staged.storeDir, 'https://two.test');
    const sentBatch = await writeBatch(one, '0123456789abcdef', { format: 1 });
    await writeBatch(one, 'fedcba9876543210', { format: 1, other: true });
    const sentCopy = await writeRaw(two, '0123456789abcdef', 0, 'one <secret> line');
    await writeRaw(two, '0123456789abcdef', 1, 'unsent line');
    await markSent(one, sentBatch.hash, NOW);
    await markSent(two, sentCopy.hash, NOW);
    // A hash in the log with no file under the current stamp (an older stamp, or a removed copy) counts for nothing.
    await markSent(two, 'f'.repeat(64), NOW);
    const sent = await sessionsVerify(deps, { session: undefined });
    expect(sent.report).toMatchObject({ sentBatches: 1, sentRaw: 1 });
    expect(sent.document).toMatchObject({ sentBatches: 1, sentRaw: 1 });
    expect(sent.text).toContain('1 outbox batch and 1 raw copy were already sent');
    expect(sent.failed).toEqual([]);
  });

  it('counts the values masked in the queued raw copies (the placeholders in their bodies), on every server', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const deps = { sessions: staged.runtime, install: undefined, now: () => NOW };
    const clean = await sessionsVerify(deps, { session: undefined });
    expect(clean.report).toMatchObject({ rawCopies: 0, rawMasked: 0 });
    expect(clean.text).not.toContain('masked');
    await writeRaw(outboxFolder(staged.storeDir, 'https://one.test'), '0123456789abcdef', 0, 'a <secret> and <email> then <host>/x\n');
    await writeRaw(outboxFolder(staged.storeDir, 'https://two.test'), 'fedcba9876543210', 0, 'at <user> and <env> and <org-domain>\n');
    const masked = await sessionsVerify(deps, { session: undefined });
    expect(masked.report).toMatchObject({ rawCopies: 2, rawMasked: 6 });
    expect(masked.document).toMatchObject({ rawCopies: 2, rawMasked: 6 });
    expect(masked.text).toContain('2 queued raw copies hold 6 placeholders (masked values, plus any a transcript already held as text)');
    expect(masked.failed).toEqual([]);
  });

  it('a raw or sent log that cannot be read counts as none and does not fail verify', async () => {
    const staged = stage();
    await deposit(staged.runtime, options);
    const root = join(staged.storeDir, 'pool-outbox');
    mkdirSync(join(root, 'abcd1234', 'sent.log'), { recursive: true });
    const report = await sessionsVerify({ sessions: staged.runtime, install: undefined, now: () => NOW }, { session: undefined });
    expect(report.report).toMatchObject({ sentBatches: 0, sentRaw: 0, rawCopies: 0, rawMasked: 0 });
    expect(report.failed).toEqual([]);
  });
});
