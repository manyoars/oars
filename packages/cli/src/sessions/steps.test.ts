import { appendFileSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliError, ExitCode } from '../errors.js';
import { sessionsContext, sessionsDeposit, sessionsMeasure, sessionsRecall, sessionsVerify, type SessionsDeps } from './command.js';
import { runHook } from './hooks.js';
import { slugOf } from './allow.js';
import { signatureOf } from './extract.js';
import { makeRedactor } from './redact.js';
import { CAPTURE_VERSION, EXTRACTOR_VERSION, parseStepRow, type StepRow } from './schema.js';
import { formatStepCounters, inputKey, newContext, readSteps, runDeposit, runStep, stepCounters, stuckSteps } from './steps.js';
import type { RecallQuery } from './query.js';
import { deposit, digest, loadStore, newTrace, refresh } from './store.js';
import { cleanup, FIXTURES, NOW, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const REPO = join('work', 'app');

// Copied from the spec (4.1 triggers, 3.1 steps), not read from the code under test, so dropping a name from schema.ts fails here.
const SPEC_TRIGGERS = ['session-start', 'post-tool', 'stop', 'nightly', 'manual', 'weekly', 'sync', 'cron', 'release', 'run-end', 'run-start'] as const;
const SPEC_STEPS = ['deposit', 'verify', 'derive', 'label', 'index', 'recall'] as const;

const depsOf = (staged: Staged): SessionsDeps => ({ sessions: staged.runtime, install: undefined, now: () => NOW });

const row = (patch: Partial<StepRow> = {}): StepRow => ({
  at: '2026-06-10T00:00:00.000Z',
  run: 'r1',
  trigger: 'manual',
  step: 'deposit',
  status: 'ok',
  ms: 5,
  in: { transcript: 3 },
  out: { session: 1, tool: 212 },
  cv: CAPTURE_VERSION,
  ev: EXTRACTOR_VERSION,
  key: 'k1',
  error: null,
  ...patch,
});

/** A real failure for every step that reads `state.json`: a directory where the file belongs. */
const fixState = (staged: Staged): void => {
  rmSync(join(staged.storeDir, 'state.json'), { recursive: true, force: true });
};
const breakState = (staged: Staged): void => {
  fixState(staged);
  mkdirSync(join(staged.storeDir, 'state.json'), { recursive: true });
};

const failed = (key: string, error: string, step: StepRow['step'] = 'deposit'): StepRow => row({ step, status: 'error', key, error, out: {} });

describe('the step-log row schema (spec 3.1)', () => {
  it('reads a valid row, and a label row with its stamp', () => {
    expect(parseStepRow(row())).toEqual(row());
    expect(parseStepRow(row({ step: 'label', lv: 'l1' }))).toEqual(row({ step: 'label', lv: 'l1' }));
    expect(parseStepRow(row({ key: null, status: 'skipped' }))?.key).toBeNull();
  });

  it.each(['at', 'run', 'trigger', 'step', 'status', 'ms', 'in', 'out', 'cv', 'ev', 'key', 'error'])('rejects a row without %s', (field) => {
    expect(parseStepRow(Object.fromEntries(Object.entries(row()).filter(([key]) => key !== field)))).toBeUndefined();
  });

  it.each([
    ['an unknown trigger (never session-end)', { trigger: 'session-end' }],
    ['an unknown step', { step: 'rebuild' }],
    ['an unknown status', { status: 'done' }],
    ['counts that are not numbers', { in: { session: 'one' } }],
    ['counts that are an array', { out: [1] }],
    ['a numeric key', { key: 4 }],
    ['a numeric error', { error: 4 }],
    ['a numeric lv', { lv: 4 }],
    ['an lv on a step other than label', { lv: 'l1' }],
    ['a label row without its lv stamp', { step: 'label' }],
    ['an ok row with an error line', { error: 'boom' }],
    ['a string ms', { ms: '5' }],
  ])('rejects %s', (_label, patch) => {
    expect(parseStepRow({ ...row(), ...patch })).toBeUndefined();
  });

  it.each(SPEC_TRIGGERS)('accepts the spec 4.1 trigger %s (the ones nothing local starts are schema only)', (trigger) => {
    expect(parseStepRow(row({ trigger }))?.trigger).toBe(trigger);
  });

  it.each(SPEC_STEPS)('accepts the spec 3.1 step %s (label is schema only)', (step) => {
    expect(parseStepRow(row({ step, ...(step === 'label' ? { lv: 'l1' } : {}) }))?.step).toBe(step);
  });

  it('rejects a value that is not an object', () => {
    expect(parseStepRow(null)).toBeUndefined();
    expect(parseStepRow([row()])).toBeUndefined();
  });
});

describe('the steps each command logs', () => {
  it('a manual deposit appends a deposit, a derive, and an index row, trigger manual, sharing one run', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.trigger, entry.status])).toEqual([['deposit', 'manual', 'ok'], ['derive', 'manual', 'ok'], ['index', 'manual', 'ok']]);
    expect(rows[0]?.run).toBe(rows[1]?.run);
    expect(rows[2]?.run).toBe(rows[1]?.run);
    expect(rows[2]?.key).toBe(rows[1]?.key);
    expect(rows[2]?.out).toEqual({ signature: 1, project: 1 });
    expect(rows[2]?.in).toEqual({ session: 4, subagent: 0, error: 6 });
    expect(rows[0]?.cv).toBe(CAPTURE_VERSION);
    expect(rows[0]?.ev).toBe(EXTRACTOR_VERSION);
    expect(rows[0]?.at).toBe('2026-06-10T00:00:00.000Z');
    expect(rows[0]?.out).toEqual({ session: 4, 'user-prompt': 7, tool: 18, 'error-line': 6 });
    expect(rows[0]?.in).toEqual({ transcript: 4 });
    expect(rows[1]?.in).toEqual({ session: 4, subagent: 0, 'user-prompt': 7, tool: 18 });
    expect(rows[1]?.out).toEqual({ signature: 5, summary: 4 });
    // A second deposit with nothing changed has the same deposit key, so the repeat is visible, and writes nothing.
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    const again = await readSteps(staged.storeDir);
    expect(again).toHaveLength(6);
    expect(again[3]?.key).toBe(rows[0]?.key);
    expect(again[3]?.in).toEqual({ transcript: 4 });
    expect(again[3]?.out).toEqual({});
    expect(again[4]?.key).toBe(rows[1]?.key);
    expect(again[5]?.key).toBe(rows[2]?.key);
  });

  it('the --allow-file entries are part of the deposit key', async () => {
    const staged = stage();
    const file = join(staged.projectsRoot, 'allow.txt');
    writeFileSync(file, 'proj');
    await sessionsDeposit(depsOf(staged), { allow: [], allowFiles: [file], redactDomains: [] });
    const rows = await readSteps(staged.storeDir);
    expect(rows[0]?.key).toBe(digest([CAPTURE_VERSION, EXTRACTOR_VERSION, 'manual', 'proj', '--']));
  });

  it('a failed manual deposit logs error with the first line and skips derive; the next run retries the same key', async () => {
    const staged = stage();
    breakState(staged);
    await expect(sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] })).rejects.toThrow('EISDIR');
    await expect(sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] })).rejects.toThrow('EISDIR');
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.status])).toEqual([['deposit', 'error'], ['derive', 'skipped'], ['index', 'skipped'], ['deposit', 'error'], ['derive', 'skipped'], ['index', 'skipped']]);
    expect(rows[0]?.error).toMatch(/^EISDIR/);
    expect(rows[0]?.error).not.toContain('\n');
    expect(rows[1]?.key).toBeNull();
    expect(rows[0]?.key).toBe(rows[3]?.key);
  });

  it('recall appends a recall row, trigger manual, with the match count', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    const outcome = await sessionsRecall(depsOf(staged), { cls: 'no-tools' });
    const recalled = (await readSteps(staged.storeDir)).filter((entry) => entry.step === 'recall');
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toMatchObject({ trigger: 'manual', status: 'ok', in: { query: 1 } });
    expect(outcome.document).toHaveProperty('matches.length', recalled[0]?.out.matches);
    expect(recalled[0]?.key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('verify appends a verify row with the invariants, cv-behind, and stuck counts', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    const outcome = await sessionsVerify(depsOf(staged), { session: undefined });
    const verified = (await readSteps(staged.storeDir)).filter((entry) => entry.step === 'verify');
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({ trigger: 'manual', status: 'ok' });
    expect(verified[0]?.out.checked).toBe(outcome.report.invariants.length);
    expect(verified[0]?.out.passed).toBe(outcome.report.invariants.filter((entry) => entry.pass).length);
    expect(verified[0]?.out.cvBehind).toBe(0);
    expect(verified[0]?.out.stuck).toBe(0);
    expect(verified[0]?.in).toEqual({ session: 4, subagent: 0 });
    expect(outcome.document).toMatchObject({ stuck: [] });
    // The key is the sessions checked, each at its rev and cv, and `ev` (spec 4.2); `--session` narrows it to that session's entries.
    // Written in reverse, so the key's sort is what orders it, not the file.
    const file = join(staged.storeDir, 'observations.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd().split('\n').reverse().join('\n')}\n`);
    await sessionsVerify(depsOf(staged), { session: undefined });
    const store = await loadStore(staged.storeDir);
    const entriesKey = (entries: readonly { session: string; rev: number; cv: string }[]): string =>
      digest([EXTRACTOR_VERSION, ...entries.map((entry) => `${entry.session}:${String(entry.rev)}:${entry.cv}`).sort()]);
    const reversed = (await readSteps(staged.storeDir)).filter((entry) => entry.step === 'verify').at(-1);
    expect(reversed?.key).toBe(entriesKey([...store.sessions, ...store.subagents]));
    expect(reversed?.key).toBe(verified[0]?.key);
    const only = store.sessions[0];
    if (only === undefined) throw new Error('fixture has no session');
    await sessionsVerify(depsOf(staged), { session: only.session });
    const narrowed = (await readSteps(staged.storeDir)).filter((entry) => entry.step === 'verify').at(-1);
    expect(narrowed?.key).toBe(entriesKey([only]));
    expect(narrowed?.key).not.toBe(verified[0]?.key);
  });

  it('verify counts a session captured at an older capture version as cv-behind', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    await sessionsVerify(depsOf(staged), { session: undefined });
    const file = join(staged.storeDir, 'observations.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll(`"cv":"${CAPTURE_VERSION}"`, `"cv":"${String(Number(CAPTURE_VERSION) - 1)}"`));
    await sessionsVerify(depsOf(staged), { session: undefined });
    const verifies = (await readSteps(staged.storeDir)).filter((entry) => entry.step === 'verify');
    expect(verifies.at(-1)?.out.cvBehind).toBeGreaterThan(0);
    // `cv` is part of the verify key (spec 4.2): the rewrite alone, with the same revs, moves it.
    expect(verifies[1]?.key).not.toBe(verifies[0]?.key);
  });

  it('verify counts a step whose key failed on three runs in a row as stuck, and names the step and the error', async () => {
    const staged = stage();
    breakState(staged);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] })).rejects.toThrow();
      // Two failed runs are not yet stuck (verify reads state.json too, so it runs with the file repaired).
      if (attempt === 1) {
        fixState(staged);
        expect((await sessionsVerify(depsOf(staged), { session: undefined })).document).toMatchObject({ stuck: [] });
        breakState(staged);
      }
    }
    fixState(staged);
    const outcome = await sessionsVerify(depsOf(staged), { session: undefined });
    expect(outcome.document).toMatchObject({ stuck: [{ step: 'deposit', runs: 3 }] });
    expect(outcome.text).toMatch(/FAIL {2}deposit is stuck: key [0-9a-f]{16} failed 3 runs in a row: EISDIR/);
    const last = (await readSteps(staged.storeDir)).filter((entry) => entry.step === 'verify').at(-1);
    expect(last?.out.stuck).toBe(1);
  });

  it('a step that throws logs an error row with the first line, masks it, and rethrows', async () => {
    const staged = stage();
    mkdirSync(staged.storeDir, { recursive: true });
    const context = newContext(staged.storeDir, () => NOW, 'manual');
    await expect(runStep(context, 'verify', () => Promise.reject(new Error('\n  disk gone for dev@corp.example\nsecond line')), 'vk')).rejects.toThrow('disk gone');
    await expect(runStep(context, 'recall', () => Promise.reject(new Error('plain')), 'kk')).rejects.toThrow('plain');
    await expect(runStep(context, 'recall', () => Promise.reject(new Error('\n')), 'ek')).rejects.toThrow();
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.status, entry.key, entry.error])).toEqual([
      ['verify', 'error', 'vk', expect.not.stringContaining('dev@corp.example')],
      ['recall', 'error', 'kk', 'plain'],
      ['recall', 'error', 'ek', 'unknown error'],
    ]);
    expect(rows[0]?.error).toContain('disk gone');
    expect(rows[0]?.error).not.toContain('second line');
  });

  it('a failure line is masked with the store redact domains and cut to 300 characters', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: ['corp.example'] });
    const context = newContext(staged.storeDir, () => NOW, 'manual');
    await expect(
      runStep(context, 'recall', () => Promise.reject(new Error(`cannot reach build.corp.example ${'pad '.repeat(100)}`)), 'k'),
    ).rejects.toThrow('cannot reach');
    const rows = await readSteps(staged.storeDir);
    const error = rows[rows.length - 1]?.error ?? '';
    expect(error).toContain('<org-domain>');
    expect(error).not.toContain('corp.example');
    expect(error).toHaveLength(300);
  });
});

describe('the steps each hook logs', () => {
  const deposited = async (): Promise<Staged> => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    return staged;
  };

  it('the SessionEnd hook, argument stop, appends one deposit row with trigger stop and no derive row', async () => {
    const staged = await deposited();
    const transcript = join(staged.projectsRoot, slugOf(REPO), 'fresh.jsonl');
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), transcript);
    const input = JSON.stringify({ session_id: 'fresh', transcript_path: transcript, hook_event_name: 'SessionEnd' });
    await runHook('stop', input, staged.runtime, () => NOW);
    await runHook('stop', input, staged.runtime, () => NOW);
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.trigger, entry.status])).toEqual([['deposit', 'stop', 'ok'], ['deposit', 'stop', 'ok']]);
    expect(rows[0]?.in).toEqual({ transcript: 1 });
    expect(rows[0]?.key).toBe(digest([CAPTURE_VERSION, EXTRACTOR_VERSION, 'stop', transcript, '--']));
    expect(rows[0]?.out.session).toBe(1);
    expect(rows[1]?.out).toEqual({});
    expect(rows[1]?.key).toBe(rows[0]?.key);
    expect(rows.map((entry) => entry.trigger)).not.toContain('session-end');
  });

  it('the stop deposit takes the session subagents too and counts them as subagent, not session', async () => {
    const staged = await deposited();
    const transcript = join(staged.projectsRoot, slugOf(REPO), 'fresh.jsonl');
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), transcript);
    const subagents = join(staged.projectsRoot, slugOf(REPO), 'fresh', 'subagents');
    mkdirSync(subagents, { recursive: true });
    copyFileSync(join(FIXTURES, 'proj', 'sidechain.jsonl'), join(subagents, 'agent-x.jsonl'));
    await runHook('stop', JSON.stringify({ session_id: 'fresh', transcript_path: transcript, hook_event_name: 'SessionEnd' }), staged.runtime, () => NOW);
    const rows = await readSteps(staged.storeDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.out.session).toBe(1);
    expect(rows[0]?.out.subagent).toBe(1);
  });

  it('a stop for a transcript with no path logs nothing, and a held lock logs an error row', async () => {
    const staged = await deposited();
    await runHook('stop', '{}', staged.runtime, () => NOW);
    expect(await readSteps(staged.storeDir)).toEqual([]);
    const transcript = join(staged.projectsRoot, slugOf(REPO), 'blocked.jsonl');
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), transcript);
    appendFileSync(join(staged.storeDir, 'store.lock'), 'a holder that never frees');
    await runHook('stop', JSON.stringify({ session_id: 'blocked', transcript_path: transcript }), staged.runtime, () => NOW);
    const rows = await readSteps(staged.storeDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step: 'deposit', trigger: 'stop', status: 'error' });
    expect(rows[0]?.error).toContain('store is locked');
    // The failed row carries the key built from that transcript, not the whole-store state, and the retry that succeeds carries the same one.
    expect(rows[0]?.key).toMatch(/^[0-9a-f]{16}$/);
    rmSync(join(staged.storeDir, 'store.lock'));
    await runHook('stop', JSON.stringify({ session_id: 'blocked', transcript_path: transcript }), staged.runtime, () => NOW);
    expect((await readSteps(staged.storeDir))[1]).toMatchObject({ status: 'ok', key: rows[0]?.key });
    const other = join(staged.projectsRoot, slugOf(REPO), 'other.jsonl');
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), other);
    appendFileSync(join(staged.storeDir, 'store.lock'), 'a holder that never frees');
    await runHook('stop', JSON.stringify({ session_id: 'other', transcript_path: other }), staged.runtime, () => NOW);
    expect((await readSteps(staged.storeDir))[2]?.key).not.toBe(rows[0]?.key);
  }, 20_000);

  it('a stop for a folder off the allowlist, or a transcript that is gone, logs an ok deposit row with nothing written and a key', async () => {
    const staged = await deposited();
    const outside = join(staged.projectsRoot, 'not-allowed-folder');
    mkdirSync(outside, { recursive: true });
    const stranger = join(outside, 'x.jsonl');
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), stranger);
    await runHook('stop', JSON.stringify({ session_id: 'x', transcript_path: stranger }), staged.runtime, () => NOW);
    await runHook('stop', JSON.stringify({ session_id: 'gone', transcript_path: join(staged.projectsRoot, slugOf(REPO), 'gone.jsonl') }), staged.runtime, () => NOW);
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.status, entry.out])).toEqual([['deposit', 'ok', {}], ['deposit', 'ok', {}]]);
    expect(rows[0]?.key).toMatch(/^[0-9a-f]{16}$/);
    expect(rows[0]?.key).not.toBe(rows[1]?.key);
  });

  it('the deposit key sorts the requested inputs and the domains', () => {
    expect(inputKey('manual', ['b', 'a'], ['y.example', 'x.example'])).toBe(digest([CAPTURE_VERSION, EXTRACTOR_VERSION, 'manual', 'a', 'b', '--', 'x.example', 'y.example']));
  });

  it('the nightly key carries the saved redact domains', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: ['corp.example'], now: () => NOW });
    await runHook('nightly', '{}', staged.runtime, () => NOW);
    const rows = await readSteps(staged.storeDir);
    expect(rows[0]?.key).toBe(digest([CAPTURE_VERSION, EXTRACTOR_VERSION, 'nightly', REPO, '--', 'corp.example']));
  });

  it('the nightly run appends a deposit, a derive, and an index row, trigger nightly; with nothing saved it logs nothing', async () => {
    const staged = await deposited();
    await runHook('nightly', '{}', staged.runtime, () => NOW);
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.trigger, entry.status])).toEqual([['deposit', 'nightly', 'ok'], ['derive', 'nightly', 'ok'], ['index', 'nightly', 'ok']]);
    expect(rows[0]?.run).toBe(rows[1]?.run);
    expect(rows[0]?.key).toBe(digest([CAPTURE_VERSION, EXTRACTOR_VERSION, 'nightly', REPO, '--']));
    expect(rows[0]?.in).toEqual({ transcript: 4 });
    const empty = stage();
    await runHook('nightly', '{}', empty.runtime, () => NOW);
    expect(await readSteps(empty.storeDir)).toEqual([]);
  });

  it('the nightly deposit counts a changed subagent transcript in its transcript input', async () => {
    const staged = stage();
    const parent = join(staged.projectsRoot, 'proj', 'errors-a', 'subagents');
    mkdirSync(parent, { recursive: true });
    const agent = join(parent, 'agent-x.jsonl');
    copyFileSync(join(FIXTURES, 'proj', 'sidechain.jsonl'), agent);
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    appendFileSync(agent, readFileSync(join(FIXTURES, 'proj', 'sidechain.jsonl')));
    await runHook('nightly', '{}', staged.runtime, () => NOW);
    const nightly = (await readSteps(staged.storeDir)).filter((entry) => entry.trigger === 'nightly' && entry.step === 'deposit');
    expect(nightly[0]?.out.subagent).toBe(1);
    expect(nightly[0]?.in).toEqual({ transcript: 5 });
  });

  it('the lookup hooks append a recall row with their own trigger', async () => {
    const staged = await deposited();
    await runHook('session-start', JSON.stringify({ session_id: 's1', cwd: REPO }), staged.runtime, () => NOW);
    await runHook('post-tool', JSON.stringify({ session_id: 's1', tool_name: 'Bash', error: 'Exit code 1\nnothing seen before' }), staged.runtime, () => NOW);
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.trigger, entry.status])).toEqual([['recall', 'session-start', 'ok'], ['recall', 'post-tool', 'ok']]);
    expect(rows[1]?.out).toEqual({ matches: 0 });
  });

  it('a lookup hook that finds a recurring signature or a repository history logs matches: 1', async () => {
    const staged = await deposited();
    await runHook('session-start', JSON.stringify({ session_id: 's1', cwd: REPO }), staged.runtime, () => NOW);
    await runHook('post-tool', JSON.stringify({ session_id: 's1', tool_name: 'Bash', error: 'Exit code 2\nbash: -c: line 7: unexpected EOF while looking for matching quote\n' }), staged.runtime, () => NOW);
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.trigger, entry.out.matches])).toEqual([['session-start', 1], ['post-tool', 1]]);
  });

  it('a lookup row is keyed by what was looked up: the cwd for session-start, the signature for post-tool', async () => {
    const staged = await deposited();
    const start = (session: string, cwd: string): Promise<string | undefined> => runHook('session-start', JSON.stringify({ session_id: session, cwd }), staged.runtime, () => NOW);
    const tool = (session: string, error: string): Promise<string | undefined> => runHook('post-tool', JSON.stringify({ session_id: session, tool_name: 'Bash', error }), staged.runtime, () => NOW);
    await start('s1', REPO);
    await start('s2', REPO);
    await start('s3', join('work', 'other'));
    await tool('s1', 'Exit code 1\nboom one');
    await tool('s2', 'Exit code 1\nboom one');
    await tool('s2', 'Exit code 1\nboom two');
    const keys = (await readSteps(staged.storeDir)).map((entry) => entry.key);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    expect(keys[3]).toBe(keys[4]);
    expect(keys[3]).not.toBe(keys[5]);
    expect(keys[0]).not.toBe(keys[3]);
    // Literal inputs: the event and what was looked up (spec 4.2), so dropping either term goes red.
    expect(keys[0]).toBe(digest([EXTRACTOR_VERSION, 'session-start', REPO]));
    expect(keys[3]).toBe(digest([EXTRACTOR_VERSION, 'post-tool', signatureOf('Bash', 'Exit code 1\nboom one', makeRedactor([]))]));
  });

  it('a nightly that cannot read state.json logs a deposit error row and a skipped derive row, trigger nightly', async () => {
    const staged = await deposited();
    breakState(staged);
    await runHook('nightly', '{}', staged.runtime, () => NOW);
    const rows = (await readSteps(staged.storeDir)).slice(-3);
    expect(rows.map((entry) => [entry.step, entry.trigger, entry.status])).toEqual([['deposit', 'nightly', 'error'], ['derive', 'nightly', 'skipped'], ['index', 'nightly', 'skipped']]);
    expect(rows[0]?.key).toBe(digest([CAPTURE_VERSION, EXTRACTOR_VERSION, 'nightly', '--']));
  });

  it('a lookup hook that read no index (nothing deposited yet) logs no recall row (a lookup that throws logs an error row: hooks-failure.test.ts)', async () => {
    const staged = stage();
    await runHook('session-start', JSON.stringify({ session_id: 's1', cwd: REPO }), staged.runtime, () => NOW);
    await runHook('post-tool', JSON.stringify({ session_id: 's1', tool_name: 'Bash', error: 'Exit code 1\nboom' }), staged.runtime, () => NOW);
    expect(await readSteps(staged.storeDir)).toEqual([]);
  });

  it('a broken hook-calls.jsonl does not cost the recall row', async () => {
    const staged = await deposited();
    mkdirSync(join(staged.storeDir, 'hook-calls.jsonl'), { recursive: true });
    await runHook('session-start', JSON.stringify({ session_id: 's1', cwd: REPO }), staged.runtime, () => NOW);
    expect((await readSteps(staged.storeDir)).map((entry) => [entry.step, entry.status])).toEqual([['recall', 'ok']]);
  });

  it('a lookup hook that had nothing to look up (no cwd, no tool or failure text) logs no recall row', async () => {
    const staged = await deposited();
    await runHook('session-start', JSON.stringify({ session_id: 's1' }), staged.runtime, () => NOW);
    await runHook('post-tool', JSON.stringify({ session_id: 's1', tool_name: 'Bash' }), staged.runtime, () => NOW);
    await runHook('post-tool', JSON.stringify({ session_id: 's1', error: 'Exit code 1' }), staged.runtime, () => NOW);
    expect(await readSteps(staged.storeDir)).toEqual([]);
  });
});

describe('a failed step and its key', () => {
  const nothing = { allow: [], allowFiles: [], redactDomains: [] };
  const good = { allow: ['proj'], allowFiles: [], redactDomains: [] };

  it('three failed deposits and then a good one leave nothing stuck, in the verify document and in its row', async () => {
    const staged = stage();
    breakState(staged);
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(sessionsDeposit(depsOf(staged), good)).rejects.toThrow('EISDIR');
    fixState(staged);
    expect((await sessionsVerify(depsOf(staged), { session: undefined })).document).toMatchObject({ stuck: [{ step: 'deposit', runs: 3 }] });
    await sessionsDeposit(depsOf(staged), good);
    const outcome = await sessionsVerify(depsOf(staged), { session: undefined });
    expect(outcome.document).toMatchObject({ stuck: [] });
    expect(outcome.failed).toEqual([]);
    expect((await readSteps(staged.storeDir)).filter((entry) => entry.step === 'verify').at(-1)?.out.stuck).toBe(0);
  });

  it('a usage error is no failed step: it leaves no row, so three of them are never stuck', async () => {
    const staged = stage();
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(sessionsDeposit(depsOf(staged), nothing)).rejects.toThrow('Nothing to read');
    expect(await readSteps(staged.storeDir)).toEqual([]);
    const context = newContext(staged.storeDir, () => NOW, 'manual');
    await expect(runDeposit(context, true, 'k', () => Promise.reject(new CliError('bad flag', ExitCode.USAGE, 'usage')))).rejects.toThrow('bad flag');
    await expect(runDeposit(context, false, 'k', () => Promise.reject(new CliError('other', ExitCode.UNEXPECTED, 'unexpected')))).rejects.toThrow('other');
    expect((await readSteps(staged.storeDir)).map((entry) => [entry.status, entry.error])).toEqual([['error', 'other']]);
  });

  it('a state.json that cannot be read still leaves one error row: the failure line is masked with no domains', async () => {
    const staged = stage();
    breakState(staged);
    await expect(sessionsDeposit(depsOf(staged), good)).rejects.toThrow('EISDIR');
    const rows = await readSteps(staged.storeDir);
    expect(rows.filter((entry) => entry.step === 'deposit' && entry.status === 'error')).toHaveLength(1);
    expect(rows.map((entry) => entry.step)).toEqual(['deposit', 'derive', 'index']);
  });

  it('the derive key is set when the store cannot be loaded during the derive pass, and the failure carries its time', async () => {
    const staged = stage();
    mkdirSync(join(staged.storeDir, 'observations.jsonl'), { recursive: true });
    const trace = newTrace();
    await refresh(staged.runtime, [], '2026-06-10T00:00:00.000Z', trace);
    expect(trace.deriveFailure?.key).toBe(digest([EXTRACTOR_VERSION]));
    expect(trace.deriveFailure?.ms).toBeGreaterThanOrEqual(0);
  });

  it('a failed derive logs its own wall time and takes it out of the deposit row', async () => {
    const staged = stage();
    mkdirSync(staged.storeDir, { recursive: true });
    const context = newContext(staged.storeDir, () => NOW, 'manual');
    const before = performance.now();
    await expect(
      runDeposit(context, true, 'k', async (trace) => {
        await new Promise((done) => setTimeout(done, 60));
        trace.deriveFailure = { error: new Error('derive broke'), key: 'dk', ms: 40 };
        return { value: 1, in: {} };
      }),
    ).rejects.toThrow('derive broke');
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.status, entry.ms])).toEqual([['deposit', 'ok', expect.any(Number)], ['derive', 'error', 40], ['index', 'skipped', 0]]);
    // The deposit row is the run's wall time less the derive's 40 ms, so the two rows do not double count.
    expect(rows[0]?.ms).toBeLessThanOrEqual(performance.now() - before - 40 + 1);
  });

  it('an ok deposit row leaves out the derive and index passes, which carry their own ms', async () => {
    const staged = stage();
    mkdirSync(staged.storeDir, { recursive: true });
    const context = newContext(staged.storeDir, () => NOW, 'manual');
    const before = performance.now();
    await runDeposit(context, true, 'k', async (trace) => {
      await new Promise((done) => setTimeout(done, 100));
      trace.derive = { ms: 40, in: {}, out: {}, key: 'dk' };
      trace.index = { ms: 30, in: {}, out: {}, key: 'dk' };
      return { value: 1, in: {} };
    });
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => entry.ms)).toEqual([expect.any(Number), 40, 30]);
    expect(rows[0]?.ms).toBeLessThanOrEqual(performance.now() - before - 70 + 1);
  });

  it('a failed index pass logs its own ms and comes out of the deposit row', async () => {
    const staged = stage();
    mkdirSync(staged.storeDir, { recursive: true });
    const context = newContext(staged.storeDir, () => NOW, 'manual');
    const before = performance.now();
    await expect(
      runDeposit(context, true, 'k', async (trace) => {
        await new Promise((done) => setTimeout(done, 100));
        trace.derive = { ms: 40, in: {}, out: {}, key: 'dk' };
        trace.indexFailure = { error: new Error('index broke'), key: 'dk', ms: 30 };
        return { value: 1, in: {} };
      }),
    ).rejects.toThrow('index broke');
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.status, entry.ms])).toEqual([['deposit', 'ok', expect.any(Number)], ['derive', 'ok', 40], ['index', 'error', 30]]);
    expect(rows[0]?.ms).toBeLessThanOrEqual(performance.now() - before - 70 + 1);
  });

  it('a derive that cannot be written logs deposit ok, then derive error with its key, and rethrows', async () => {
    const staged = stage();
    mkdirSync(join(staged.storeDir, 'derived.json'), { recursive: true });
    await expect(sessionsDeposit(depsOf(staged), good)).rejects.toThrow();
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.status])).toEqual([['deposit', 'ok'], ['derive', 'error'], ['index', 'skipped']]);
    expect(rows[0]?.out.session).toBeGreaterThan(0);
    expect(rows[1]?.key).toMatch(/^[0-9a-f]{16}$/);
    expect(rows[1]?.error).toMatch(/^\S/);
    expect(rows[1]?.error).not.toContain('\n');
  });

  it('a recall and a verify that fail carry a key, and three failed recalls of one query are stuck', async () => {
    const staged = stage();
    mkdirSync(join(staged.storeDir, 'observations.jsonl'), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(sessionsRecall(depsOf(staged), { cls: 'no-tools' })).rejects.toThrow();
    await expect(sessionsRecall(depsOf(staged), { cls: 'other' })).rejects.toThrow();
    await expect(sessionsVerify(depsOf(staged), { session: 's1' })).rejects.toThrow();
    await expect(sessionsVerify(depsOf(staged), { session: 's2' })).rejects.toThrow();
    const rows = await readSteps(staged.storeDir);
    const recalls = rows.filter((entry) => entry.step === 'recall');
    expect(recalls[0]?.key).toMatch(/^[0-9a-f]{16}$/);
    expect(recalls[1]?.key).toBe(recalls[0]?.key);
    expect(recalls[2]?.key).toBe(recalls[0]?.key);
    expect(recalls[3]?.key).not.toBe(recalls[0]?.key);
    // Each query field alone moves the key (spec 4.2: the query is the key).
    const keyOf = async (query: RecallQuery): Promise<string | null | undefined> => {
      await expect(sessionsRecall(depsOf(staged), query)).rejects.toThrow();
      return (await readSteps(staged.storeDir)).filter((entry) => entry.step === 'recall').at(-1)?.key;
    };
    const base = await keyOf({ cls: 'no-tools', error: 'boom', path: 'a.ts', sinceDays: 7 });
    expect(await keyOf({ cls: 'no-tools', error: 'bang', path: 'a.ts', sinceDays: 7 })).not.toBe(base);
    expect(await keyOf({ cls: 'no-tools', error: 'boom', path: 'b.ts', sinceDays: 7 })).not.toBe(base);
    expect(await keyOf({ cls: 'no-tools', error: 'boom', path: 'a.ts', sinceDays: 8 })).not.toBe(base);
    const verifies = rows.filter((entry) => entry.step === 'verify');
    expect(verifies[0]?.key).toBe(digest([EXTRACTOR_VERSION, 'verify', 's1']));
    expect(verifies[1]?.key).toBe(digest([EXTRACTOR_VERSION, 'verify', 's2']));
    expect(stuckSteps(rows).map((entry) => [entry.step, entry.key, entry.runs])).toEqual([['recall', recalls[0]?.key, 3]]);
  });

  it('a stuck step also fails verify --strict: it is in failed', async () => {
    const staged = stage();
    breakState(staged);
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(sessionsDeposit(depsOf(staged), good)).rejects.toThrow();
    fixState(staged);
    const outcome = await sessionsVerify(depsOf(staged), { session: undefined });
    expect(outcome.failed).toContain('stuck: deposit');
    // The --strict --json failure document is the report, so it carries the stuck key and its error line (spec 4.4).
    expect(outcome.report.stuck).toMatchObject([{ step: 'deposit', runs: 3 }]);
    expect(outcome.report.stuck[0]?.error).toMatch(/^EISDIR/);
  });

  it('a row that cannot be appended changes no step outcome: read-only steps and a good deposit succeed, a failing one throws its own error', async () => {
    const staged = stage();
    mkdirSync(join(staged.storeDir, 'pipeline-runs.jsonl'), { recursive: true });
    breakState(staged);
    await expect(sessionsDeposit(depsOf(staged), good)).rejects.toThrow('EISDIR');
    fixState(staged);
    await expect(sessionsDeposit(depsOf(staged), good)).resolves.toMatchObject({ document: { ok: true } });
    await expect(sessionsRecall(depsOf(staged), { cls: 'no-tools' })).resolves.toMatchObject({ document: { ok: true } });
    await expect(sessionsVerify(depsOf(staged), { session: undefined })).resolves.toMatchObject({ document: { ok: true } });
    await expect(sessionsRecall(depsOf(staged), {})).rejects.toThrow('Pass --error');
  });
});

describe('recall --context, the deposit key, and the index step', () => {
  const good = { allow: ['proj'], allowFiles: [], redactDomains: [] };
  const contextOptions = { cwd: REPO, top: 5, maxChars: 1200 };

  it('recall --context logs a manual recall row keyed by the cwd and harness, with one query and the block count', async () => {
    const staged = stage(slugOf(REPO));
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    await sessionsContext(depsOf(staged), contextOptions);
    await sessionsContext(depsOf(staged), { ...contextOptions, cwd: join('work', 'nothing-here') });
    // A harness version that never ran here finds nothing, and the harness is part of the key.
    await sessionsContext(depsOf(staged), { ...contextOptions, harness: 'claude-code' });
    const rows = (await readSteps(staged.storeDir)).filter((entry) => entry.step === 'recall');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ trigger: 'manual', status: 'ok', in: { query: 1 }, out: { matches: 1 }, key: digest([EXTRACTOR_VERSION, 'context', REPO, '']) });
    expect(rows[2]).toMatchObject({ out: { matches: 0 }, key: digest([EXTRACTOR_VERSION, 'context', REPO, 'claude-code']) });
    expect(rows[1]).toMatchObject({ out: { matches: 0 }, key: digest([EXTRACTOR_VERSION, 'context', join('work', 'nothing-here'), '']) });
  });

  it('recall --context that cannot load the store logs an error row with that key, and three of them are stuck', async () => {
    const staged = stage();
    mkdirSync(join(staged.storeDir, 'observations.jsonl'), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(sessionsContext(depsOf(staged), contextOptions)).rejects.toThrow();
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.trigger, entry.status, entry.key])).toEqual(Array(3).fill(['recall', 'manual', 'error', digest([EXTRACTOR_VERSION, 'context', REPO, ''])]));
    expect(stuckSteps(rows).map((entry) => [entry.step, entry.runs])).toEqual([['recall', 3]]);
  });

  it('the deposit key is the digest of the capture version, the extractor version, the trigger, and the requested inputs', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj', 'a'], allowFiles: [], redactDomains: ['corp.example'] });
    const first = (await readSteps(staged.storeDir))[0];
    expect(first?.key).toBe(digest([CAPTURE_VERSION, EXTRACTOR_VERSION, 'manual', 'a', 'proj', '--', 'corp.example']));
    expect(inputKey('stop', ['t.jsonl'], [])).toBe(digest([CAPTURE_VERSION, EXTRACTOR_VERSION, 'stop', 't.jsonl', '--']));
  });

  it('a manual deposit whose index cannot be written logs deposit ok, derive ok, then index error with the shared key, and rethrows', async () => {
    const staged = stage();
    mkdirSync(join(staged.storeDir, 'hook-index.json'), { recursive: true });
    await expect(sessionsDeposit(depsOf(staged), good)).rejects.toThrow();
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.status])).toEqual([['deposit', 'ok'], ['derive', 'ok'], ['index', 'error']]);
    expect(rows[2]?.key).toBe(rows[1]?.key);
    expect(rows[2]?.error).toMatch(/^\S/);
    expect(rows[2]?.error).not.toContain('\n');
  });

  it('a derive that fails leaves the index step skipped, not booked as derive', async () => {
    const staged = stage();
    mkdirSync(join(staged.storeDir, 'derived.json'), { recursive: true });
    await expect(sessionsDeposit(depsOf(staged), good)).rejects.toThrow();
    expect((await readSteps(staged.storeDir)).map((entry) => [entry.step, entry.status, entry.key])).toEqual([['deposit', 'ok', expect.any(String)], ['derive', 'error', expect.any(String)], ['index', 'skipped', null]]);
  });

  it('three failed verifies and then a good one: the good verify is not itself stuck, and --strict passes', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), good);
    const observations = join(staged.storeDir, 'observations.jsonl');
    const kept = readFileSync(observations);
    rmSync(observations);
    mkdirSync(observations);
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(sessionsVerify(depsOf(staged), { session: undefined })).rejects.toThrow();
    rmSync(observations, { recursive: true });
    writeFileSync(observations, kept);
    const outcome = await sessionsVerify(depsOf(staged), { session: undefined });
    expect(outcome.report.stuck).toEqual([]);
    expect(outcome.failed).toEqual([]);
  });

  it("a re-deposited subagent changes verify's key: the high-water mark covers sessions and subagents", async () => {
    const staged = stage();
    const parent = join(staged.projectsRoot, 'proj', 'errors-a', 'subagents');
    mkdirSync(parent, { recursive: true });
    const agent = join(parent, 'agent-x.jsonl');
    copyFileSync(join(FIXTURES, 'proj', 'sidechain.jsonl'), agent);
    await sessionsDeposit(depsOf(staged), good);
    await sessionsVerify(depsOf(staged), { session: undefined });
    appendFileSync(agent, readFileSync(join(FIXTURES, 'proj', 'sidechain.jsonl')));
    await sessionsDeposit(depsOf(staged), good);
    await sessionsVerify(depsOf(staged), { session: undefined });
    const all = await readSteps(staged.storeDir);
    const first = all.find((entry) => entry.step === 'deposit');
    expect(first?.out.subagent).toBe(1);
    expect(first?.out.session).toBe(4);
    expect(first?.in).toEqual({ transcript: 5 });
    const verifies = all.filter((entry) => entry.step === 'verify');
    expect(verifies).toHaveLength(2);
    expect(verifies[1]?.key).not.toBe(verifies[0]?.key);
    expect(verifies[1]?.in).toEqual({ session: 4, subagent: 1 });
    // The derive key is the high-water mark (highest rev per session, subagents too) and `ev` (spec 4.2); a deposit that raises a rev moves it.
    const derives = all.filter((entry) => entry.step === 'derive');
    const store = await loadStore(staged.storeDir);
    expect(derives).toHaveLength(2);
    expect(derives[1]?.key).not.toBe(derives[0]?.key);
    expect(derives[1]?.key).toBe(digest([EXTRACTOR_VERSION, ...[...store.sessions, ...store.subagents].map((session) => `${session.session}:${String(session.rev)}`).sort()]));
  });
});

describe('the counters (spec 3.2)', () => {
  it('derives the counters from a fixture log', () => {
    const rows: StepRow[] = [
      row({ out: { session: 2, subagent: 1, tool: 10 } }),
      row({ out: { session: 1, tool: 5 }, ms: 15 }),
      row({ step: 'derive', out: { signature: 3, summary: 3 } }),
      row({ step: 'derive', out: { signature: 4, summary: 4 } }),
      row({ step: 'derive', status: 'skipped', key: null, ms: 0, out: {} }),
      row({ step: 'index', out: { signature: 7, project: 1 } }),
      row({ step: 'index', out: { signature: 9, project: 2 } }),
      row({ step: 'verify', out: { checked: 6, passed: 5, cvBehind: 2, stuck: 0 } }),
      row({ step: 'recall', trigger: 'session-start', out: { matches: 1 } }),
      row({ step: 'recall', out: { matches: 0 } }),
      failed('k9', 'boom'),
    ];
    const counters = stepCounters(rows);
    expect(counters.deposited).toEqual({ session: 3, subagent: 1, tool: 15 });
    expect(counters.derived).toEqual({ signature: 4, summary: 4 });
    expect(counters.indexed).toEqual({ signature: 9, project: 2 });
    expect(counters.verify).toEqual({ checked: 6, passed: 5, cvBehind: 2, stuck: 0 });
    expect(counters.recall).toEqual({ queries: 2, matches: 1 });
    expect(counters.failures).toEqual({ [`deposit@${EXTRACTOR_VERSION}`]: 1 });
    expect(counters.steps.find((line) => line.step === 'deposit')).toMatchObject({ runs: 3, ok: 2, error: 1, skipped: 0, meanMs: 8 });
    expect(counters.steps.find((line) => line.step === 'derive')).toMatchObject({ runs: 3, ok: 2, skipped: 1, meanMs: 5 });
    const text = formatStepCounters(counters);
    expect(text).toContain('records deposited, session');
    expect(text).toMatch(/index holds, signature\s+9/);
    expect(text).toMatch(/index holds, project\s+2/);
    expect(text).toContain('invariants passed of checked');
    expect(text).toMatch(/recall queries\s+2/);
    expect(text).toMatch(/stuck steps\s+0/);
    expect(text).toMatch(/records derived, signature\s+4/);
    expect(text).toMatch(/records derived, summary\s+4/);
    expect(text).toMatch(/cv-behind sessions\s+2/);
    expect(text).toMatch(/recall matches\s+1/);
    expect(text).toMatch(/failed runs, deposit@\S+\s+1/);
    expect(text).toMatch(/invariants passed of checked\s+5\/6/);
  });

  it('prints each stuck step with its key, run count, and last error', () => {
    const text = formatStepCounters(stepCounters([failed('k', 'a'), failed('k', 'b'), failed('k', 'e')]));
    expect(text).toContain('  stuck: deposit key k, 3 runs in a row: e');
    expect(text).toMatch(/stuck steps\s+1/);
  });

  it('keeps a line per step and ev, so the mean ms of two extractor versions is not mixed', () => {
    const counters = stepCounters([row({ ms: 10 }), row({ ms: 30, ev: 'old' }), row({ ms: 50, ev: 'old' })]);
    expect(counters.steps.map((line) => [line.step, line.ev, line.runs, line.meanMs])).toEqual([['deposit', EXTRACTOR_VERSION, 1, 10], ['deposit', 'old', 2, 40]]);
    const text = formatStepCounters(counters);
    expect(text).toContain(`deposit@${EXTRACTOR_VERSION} mean ms`);
    expect(text).toContain('deposit@old mean ms');
    expect(text).toContain('pipeline step log (all time)');
  });

  it('a nightly deposit that fails every night is stuck although stop deposits succeed in between', () => {
    const nightly = (key: string): StepRow => failed(key, 'locked');
    const stop = row({ trigger: 'stop', key: 'transcript-key' });
    const rows = [{ ...nightly('n'), trigger: 'nightly' as const }, stop, { ...nightly('n'), trigger: 'nightly' as const }, stop, { ...nightly('n'), trigger: 'nightly' as const }];
    expect(stuckSteps(rows)).toEqual([{ step: 'deposit', key: 'n', runs: 3, error: 'locked' }]);
    // A good nightly ends the nightly streak.
    expect(stuckSteps([...rows, row({ trigger: 'nightly', key: 'n2' })])).toEqual([]);
  });

  it('a step with only skipped runs has a mean of zero; a streak ended by an ok row is not stuck', () => {
    const skipped = row({ step: 'index', status: 'skipped', key: null, ms: 0, out: {} });
    expect(stepCounters([skipped]).steps).toEqual([{ step: 'index', ev: EXTRACTOR_VERSION, runs: 1, ok: 0, error: 0, skipped: 1, meanMs: 0 }]);
    const streak = [failed('k', 'a'), failed('k', 'b'), row({ key: 'k' }), failed('k', 'c'), failed('k', 'd')];
    expect(stuckSteps(streak)).toEqual([]);
    expect(stuckSteps([...streak, skipped, failed('k', 'e')])).toEqual([{ step: 'deposit', key: 'k', runs: 3, error: 'e' }]);
    // A good run ends the open streaks of its step and trigger, whatever key it carries.
    expect(stuckSteps([failed('k1', 'a'), failed('k1', 'b'), failed('k1', 'c'), row({ key: 'other' })])).toEqual([]);
    expect(stuckSteps([failed('k1', 'a'), failed('k1', 'b'), failed('k1', 'c'), row({ step: 'verify', key: 'other' })])).toHaveLength(1);
    // The same key made good by another trigger ends the streak too (spec 4.2: the key now has output).
    const nightlyOn = (key: string): StepRow => ({ ...failed(key, 'locked', 'derive'), trigger: 'nightly' });
    expect(stuckSteps([nightlyOn('K'), nightlyOn('K'), nightlyOn('K'), row({ step: 'derive', trigger: 'manual', key: 'K' })])).toEqual([]);
    expect(stuckSteps([nightlyOn('K'), nightlyOn('K'), nightlyOn('K'), row({ step: 'derive', trigger: 'manual', key: 'other' })])).toHaveLength(1);
    expect(stuckSteps([failed('k1', 'a'), failed('k2', 'b'), failed('k1', 'c'), failed('k2', 'd'), failed('k1', 'e')])).toEqual([{ step: 'deposit', key: 'k1', runs: 3, error: 'e' }]);
  });

  it('measure prints the step counters under the G1 signals, and the document carries them', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    await sessionsVerify(depsOf(staged), { session: undefined });
    const outcome = await sessionsMeasure(depsOf(staged), { last: 50, since: undefined });
    expect(outcome.text).toContain('pipeline step log');
    expect(outcome.text).toMatch(/deposit@\d+ runs \(ok\/error\/skipped\)\s+1\/0\/0/);
    expect(outcome.text).toMatch(/derive@\d+ runs \(ok\/error\/skipped\)\s+1\/0\/0/);
    expect(outcome.text).toMatch(/index@\d+ runs \(ok\/error\/skipped\)\s+1\/0\/0/);
    expect(outcome.text).toMatch(/invariants passed of checked\s+\d+\/\d+/);
    expect(outcome.document).toMatchObject({ steps: { runs: 4 } });
  });

  it('measure --repo filters the G1 table only: the step counters stay all-time', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    const whole = await sessionsMeasure(depsOf(staged), { last: 50, since: undefined });
    const elsewhere = await sessionsMeasure(depsOf(staged), { last: 50, since: undefined, repo: join(staged.storeDir, 'no-such-repo') });
    expect(elsewhere.document).toMatchObject({ steps: stepCounters(await readSteps(staged.storeDir)) });
    expect(whole.text).toContain('pipeline step log (all time)');
    expect(elsewhere.text).toContain('pipeline step log (all time)');
    expect(elsewhere.text).toMatch(/deposit@\d+ runs \(ok\/error\/skipped\)\s+1\/0\/0/);
  });

  it('measure on a store with no log says no step has run, and a torn or foreign line is not counted', async () => {
    const staged = stage();
    expect((await sessionsMeasure(depsOf(staged), { last: 50, since: undefined })).text).toContain('no step has run yet');
    mkdirSync(staged.storeDir, { recursive: true });
    appendFileSync(join(staged.storeDir, 'pipeline-runs.jsonl'), `${JSON.stringify(row())}\n{"step":"deposit"}\n{"torn":`);
    expect(await readSteps(staged.storeDir)).toEqual([row()]);
  });
});

describe('every ms term reads the clock (spec 3.2 mean ms)', () => {
  const good = { allow: ['proj'], allowFiles: [], redactDomains: [] };
  // The clock answers each performance.now() call from the list, then repeats the last value, so a term that is dropped or no longer
  // subtracts its start changes the row's ms exactly.
  const clock = <T>(values: readonly number[], run: () => Promise<T>): Promise<T> => {
    let calls = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => values[Math.min(calls++, values.length - 1)] ?? 0);
    return run().finally(() => {
      spy.mockRestore();
    });
  };

  it('runStep logs the wall time of an ok run and of a failed one', async () => {
    const staged = stage();
    const context = newContext(staged.storeDir, () => NOW, 'manual');
    await clock([5, 15], () => runStep(context, 'recall', () => Promise.resolve({ value: 1, report: { in: {}, out: {}, key: 'k' } }), 'k'));
    await clock([5, 17], () => runStep(context, 'recall', () => Promise.reject(new Error('x')), 'k')).catch(() => undefined);
    expect((await readSteps(staged.storeDir)).map((entry) => [entry.status, entry.ms])).toEqual([['ok', 10], ['error', 12]]);
  });

  it('runDeposit logs the wall time of a failed deposit', async () => {
    const staged = stage();
    const context = newContext(staged.storeDir, () => NOW, 'manual');
    await clock([5, 25], () => runDeposit(context, false, 'k', () => Promise.reject(new Error('x')))).catch(() => undefined);
    expect((await readSteps(staged.storeDir))[0]?.ms).toBe(20);
  });

  it('refresh times the derive pass and the index pass on their own starts', async () => {
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const trace = newTrace();
    await clock([5, 15, 20, 45], () => refresh(staged.runtime, [], '2026-06-10T00:00:00.000Z', trace));
    expect([trace.derive?.ms, trace.index?.ms]).toEqual([10, 25]);
  });

  it('refresh times a failed derive pass and a failed index pass', async () => {
    const broken = stage();
    mkdirSync(join(broken.storeDir, 'observations.jsonl'), { recursive: true });
    const first = newTrace();
    await clock([5, 15], () => refresh(broken.runtime, [], '2026-06-10T00:00:00.000Z', first));
    expect(first.deriveFailure?.ms).toBe(10);
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    rmSync(join(staged.storeDir, 'hook-index.json'));
    mkdirSync(join(staged.storeDir, 'hook-index.json'), { recursive: true });
    const second = newTrace();
    await clock([5, 15, 20, 45], () => refresh(staged.runtime, [], '2026-06-10T00:00:00.000Z', second));
    expect(second.indexFailure?.ms).toBe(25);
  });

  it('a lookup hook logs its wall time on the recall row and the hook-calls line', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), good);
    await clock([5, 19], () => runHook('session-start', JSON.stringify({ session_id: 's1', cwd: REPO }), staged.runtime, () => NOW));
    const row = (await readSteps(staged.storeDir)).find((entry) => entry.step === 'recall');
    expect(row?.ms).toBe(14);
    expect(readFileSync(join(staged.storeDir, 'hook-calls.jsonl'), 'utf8')).toContain('"ms":14');
  });
});
