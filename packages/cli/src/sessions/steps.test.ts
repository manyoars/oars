import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionsDeposit, sessionsMeasure, sessionsRecall, sessionsVerify, type SessionsDeps } from './command.js';
import { runHook } from './hooks.js';
import { slugOf } from './allow.js';
import { CAPTURE_VERSION, EXTRACTOR_VERSION, parseStepRow, type StepRow } from './schema.js';
import { formatStepCounters, newContext, readSteps, runStep, stepCounters, stuckSteps } from './steps.js';
import { deposit } from './store.js';
import { cleanup, FIXTURES, NOW, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const REPO = join('work', 'app');

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

const failed = (key: string, error: string, step: StepRow['step'] = 'deposit'): StepRow => row({ step, status: 'error', key, error, out: {} });

describe('the step-log row schema (spec 3.1)', () => {
  it('reads a valid row, with and without the label stamp', () => {
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
    ['a string ms', { ms: '5' }],
  ])('rejects %s', (_label, patch) => {
    expect(parseStepRow({ ...row(), ...patch })).toBeUndefined();
  });

  it('rejects a value that is not an object', () => {
    expect(parseStepRow(null)).toBeUndefined();
    expect(parseStepRow([row()])).toBeUndefined();
  });
});

describe('the steps each command logs', () => {
  it('a manual deposit appends a deposit row and a derive row, trigger manual, sharing one run', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.trigger, entry.status])).toEqual([['deposit', 'manual', 'ok'], ['derive', 'manual', 'ok']]);
    expect(rows[0]?.run).toBe(rows[1]?.run);
    expect(rows[0]?.cv).toBe(CAPTURE_VERSION);
    expect(rows[0]?.ev).toBe(EXTRACTOR_VERSION);
    expect(rows[0]?.at).toBe('2026-06-10T00:00:00.000Z');
    expect(rows[0]?.out.session).toBeGreaterThan(0);
    expect(rows[0]?.out['user-prompt']).toBeGreaterThan(0);
    expect(rows[0]?.in.transcript).toBeGreaterThan(0);
    expect(rows[1]?.out.summary).toBe(rows[0]?.out.session);
    expect(rows[1]?.in.session).toBe(rows[0]?.out.session);
    // A second deposit with nothing changed has the same deposit key, so the repeat is visible, and writes nothing.
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    const again = await readSteps(staged.storeDir);
    expect(again).toHaveLength(4);
    expect(again[2]?.key).toBe(rows[0]?.key);
    expect(again[2]?.out).toEqual({});
    expect(again[3]?.key).toBe(rows[1]?.key);
  });

  it('a failed manual deposit logs error with the first line and skips derive; the next run retries the same key', async () => {
    const staged = stage();
    await expect(sessionsDeposit(depsOf(staged), { allow: [], allowFiles: [], redactDomains: [] })).rejects.toThrow('Nothing to read');
    await expect(sessionsDeposit(depsOf(staged), { allow: [], allowFiles: [], redactDomains: [] })).rejects.toThrow('Nothing to read');
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.status])).toEqual([['deposit', 'error'], ['derive', 'skipped'], ['deposit', 'error'], ['derive', 'skipped']]);
    expect(rows[0]?.error).toMatch(/^Nothing to read/);
    expect(rows[0]?.error).not.toContain('\n');
    expect(rows[1]?.key).toBeNull();
    expect(rows[0]?.key).toBe(rows[2]?.key);
  });

  it('recall appends a recall row, trigger manual, with the match count', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    await sessionsRecall(depsOf(staged), { cls: 'no-tools' });
    const recalled = (await readSteps(staged.storeDir)).filter((entry) => entry.step === 'recall');
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toMatchObject({ trigger: 'manual', status: 'ok', in: { query: 1 } });
    expect(typeof recalled[0]?.out.matches).toBe('number');
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
    expect(outcome.document).toMatchObject({ stuck: [] });
  });

  it('verify counts a step whose key failed on three runs in a row as stuck, and names the step and the error', async () => {
    const staged = stage();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(sessionsDeposit(depsOf(staged), { allow: [], allowFiles: [], redactDomains: [] })).rejects.toThrow();
      // Two failed runs are not yet stuck.
      if (attempt === 1) expect((await sessionsVerify(depsOf(staged), { session: undefined })).document).toMatchObject({ stuck: [] });
    }
    const outcome = await sessionsVerify(depsOf(staged), { session: undefined });
    expect(outcome.document).toMatchObject({ stuck: [{ step: 'deposit', runs: 3 }] });
    expect(outcome.text).toMatch(/FAIL {2}deposit is stuck: key [0-9a-f]{16} failed 3 runs in a row: Nothing to read/);
    const last = (await readSteps(staged.storeDir)).filter((entry) => entry.step === 'verify').at(-1);
    expect(last?.out.stuck).toBe(1);
  });

  it('a step that throws logs an error row with the first line, masks it, and rethrows', async () => {
    const staged = stage();
    mkdirSync(staged.storeDir, { recursive: true });
    const context = newContext(staged.storeDir, () => NOW, 'manual');
    await expect(runStep(context, 'verify', () => Promise.reject(new Error('\n  disk gone for dev@corp.example\nsecond line')))).rejects.toThrow('disk gone');
    await expect(runStep(context, 'recall', () => Promise.reject(new Error('plain')), () => Promise.resolve('kk'))).rejects.toThrow('plain');
    await expect(runStep(context, 'recall', () => Promise.reject(new Error('\n')))).rejects.toThrow();
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.status, entry.key, entry.error])).toEqual([
      ['verify', 'error', null, expect.not.stringContaining('dev@corp.example')],
      ['recall', 'error', 'kk', 'plain'],
      ['recall', 'error', null, 'unknown error'],
    ]);
    expect(rows[0]?.error).toContain('disk gone');
    expect(rows[0]?.error).not.toContain('second line');
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
    expect(rows[0]?.out.session).toBe(1);
    expect(rows[1]?.out).toEqual({});
    expect(rows[1]?.key).toBe(rows[0]?.key);
    expect(rows.map((entry) => entry.trigger)).not.toContain('session-end');
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
  });

  it('the nightly run appends a deposit row and a derive row, trigger nightly; with nothing saved it logs nothing', async () => {
    const staged = await deposited();
    await runHook('nightly', '{}', staged.runtime, () => NOW);
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.trigger, entry.status])).toEqual([['deposit', 'nightly', 'ok'], ['derive', 'nightly', 'ok']]);
    expect(rows[0]?.run).toBe(rows[1]?.run);
    const empty = stage();
    await runHook('nightly', '{}', empty.runtime, () => NOW);
    expect(await readSteps(empty.storeDir)).toEqual([]);
  });

  it('the lookup hooks append a recall row with their own trigger', async () => {
    const staged = await deposited();
    await runHook('session-start', JSON.stringify({ session_id: 's1', cwd: REPO }), staged.runtime, () => NOW);
    await runHook('post-tool', JSON.stringify({ session_id: 's1', tool_name: 'Bash', error: 'Exit code 1\nnothing seen before' }), staged.runtime, () => NOW);
    const rows = await readSteps(staged.storeDir);
    expect(rows.map((entry) => [entry.step, entry.trigger, entry.status])).toEqual([['recall', 'session-start', 'ok'], ['recall', 'post-tool', 'ok']]);
    expect(rows[1]?.out).toEqual({ matches: 0 });
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
      row({ step: 'verify', out: { checked: 6, passed: 5, cvBehind: 2, stuck: 0 } }),
      row({ step: 'recall', trigger: 'session-start', out: { matches: 1 } }),
      row({ step: 'recall', out: { matches: 0 } }),
      failed('k9', 'boom'),
    ];
    const counters = stepCounters(rows);
    expect(counters.deposited).toEqual({ session: 3, subagent: 1, tool: 15 });
    expect(counters.derived).toEqual({ signature: 4, summary: 4 });
    expect(counters.verify).toEqual({ checked: 6, passed: 5, cvBehind: 2, stuck: 0 });
    expect(counters.recall).toEqual({ queries: 2, matches: 1 });
    expect(counters.failures).toEqual({ [`deposit@${EXTRACTOR_VERSION}`]: 1 });
    expect(counters.steps.find((line) => line.step === 'deposit')).toMatchObject({ runs: 3, ok: 2, error: 1, skipped: 0, meanMs: 8 });
    expect(counters.steps.find((line) => line.step === 'derive')).toMatchObject({ runs: 3, ok: 2, skipped: 1, meanMs: 5 });
    const text = formatStepCounters(counters);
    expect(text).toContain('records deposited, session');
    expect(text).toContain('invariants passed of checked');
    expect(text).toMatch(/recall queries\s+2/);
    expect(text).toMatch(/stuck steps\s+0/);
  });

  it('a step with only skipped runs has a mean of zero; a streak ended by an ok row is not stuck', () => {
    const skipped = row({ step: 'index', status: 'skipped', key: null, ms: 0, out: {} });
    expect(stepCounters([skipped]).steps).toEqual([{ step: 'index', runs: 1, ok: 0, error: 0, skipped: 1, meanMs: 0 }]);
    const streak = [failed('k', 'a'), failed('k', 'b'), row({ key: 'k' }), failed('k', 'c'), failed('k', 'd')];
    expect(stuckSteps(streak)).toEqual([]);
    expect(stuckSteps([...streak, skipped, failed('k', 'e')])).toEqual([{ step: 'deposit', key: 'k', runs: 3, error: 'e' }]);
    expect(stuckSteps([failed('k1', 'a'), failed('k2', 'b'), failed('k1', 'c'), failed('k2', 'd'), failed('k1', 'e')])).toEqual([{ step: 'deposit', key: 'k1', runs: 3, error: 'e' }]);
  });

  it('measure prints the step counters under the G1 signals, and the document carries them', async () => {
    const staged = stage();
    await sessionsDeposit(depsOf(staged), { allow: ['proj'], allowFiles: [], redactDomains: [] });
    await sessionsVerify(depsOf(staged), { session: undefined });
    const outcome = await sessionsMeasure(depsOf(staged), { last: 50, since: undefined });
    expect(outcome.text).toContain('pipeline step log');
    expect(outcome.text).toMatch(/deposit runs \(ok\/error\/skipped\)\s+1\/0\/0/);
    expect(outcome.text).toMatch(/derive runs \(ok\/error\/skipped\)\s+1\/0\/0/);
    expect(outcome.text).toMatch(/invariants passed of checked\s+\d+\/\d+/);
    expect(outcome.document).toMatchObject({ steps: { runs: 3 } });
  });

  it('measure on a store with no log says no step has run, and a torn or foreign line is not counted', async () => {
    const staged = stage();
    expect((await sessionsMeasure(depsOf(staged), { last: 50, since: undefined })).text).toContain('no step has run yet');
    mkdirSync(staged.storeDir, { recursive: true });
    appendFileSync(join(staged.storeDir, 'pipeline-runs.jsonl'), `${JSON.stringify(row())}\n{"step":"deposit"}\n{"torn":`);
    expect(await readSteps(staged.storeDir)).toEqual([row()]);
  });
});
