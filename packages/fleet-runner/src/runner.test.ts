import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makeFake, type Fault, type Script } from './fake-harness.js';
import type { RunRequest } from './harness.js';
import { parseOrder } from './order.js';
import { runOrder, type RunnerOptions } from './runner.js';
import { serializeRunBook } from './runbook.js';
import { FLEET, retestText, taskSet } from './test-fixtures.js';

// A clock driven by the test: one second per reading, so no wall time enters a run book.
const stepClock = (): (() => Date) => {
  let ticks = 0;
  return () => new Date(Date.UTC(2026, 10, 16, 12, 0, ticks++));
};

const options = (script: Script, patch: { tasks?: number; repeats?: number; runCap?: number } = {}): RunnerOptions => ({
  order: parseOrder(retestText({ repeats: patch.repeats ?? 1, runCap: patch.runCap ?? 50 }), FLEET),
  taskSet: taskSet(patch.tasks ?? 1),
  fleet: FLEET,
  adapter: makeFake(script),
  clock: stepClock(),
  operator: 'Many Oars Co.',
});

// Void the first attempt of the first slot with one fault; every later run is clean.
const firstAttempt =
  (fault: Fault): Script =>
  (request: RunRequest) =>
    request.sequence === 1 ? fault : {};

describe('void detection (spec section 9)', () => {
  const causes: [string, Fault, string][] = [
    ['a crash', { exit: 'crash' }, 'harness-failed'],
    ['an API error after the harness retries', { exit: 'api-error' }, 'harness-failed'],
    ['a rate limit that ends the run', { exit: 'rate-limit' }, 'harness-failed'],
    ['a rejected key', { exit: 'auth-rejected' }, 'sign-in-lost'],
    ['a full disk', { exit: 'disk-full' }, 'machine-failed'],
    ['the network down', { exit: 'network-down' }, 'machine-failed'],
    ['a different fixture tag', { fixtureTag: 'taskset-v2' }, 'fixture-tag-changed'],
    ['a different manifest', { manifestVersion: 'fleet-2' }, 'manifest-changed'],
    ['a different harness version', { harnessVersion: '2.1.99' }, 'harness-version-changed'],
    ['a different model ID', { modelId: 'other-model' }, 'model-changed'],
    ['a tool at another pin', { installedPins: [{ name: 'playwright', pin: 'npm:9.9.9' }] }, 'tool-pin-mismatch'],
    ['no tool installed on the tool arm', { installedPins: [] }, 'tool-pin-mismatch'],
  ];

  it.each(causes)('voids a run on %s, keeps it, and reruns it', async (_name, fault, reason) => {
    const book = await runOrder(options(firstAttempt(fault)));
    const voided = book.runs.filter((run) => run.void !== null);
    expect(voided.map((run) => run.void)).toEqual([reason]);
    expect(voided[0]?.check).toBeNull();
    // The slot is rerun in place: the order still ends complete with its 2 valid runs (1 task x 2 sides x 1 repeat).
    expect(book.runs.filter((run) => run.void === null)).toHaveLength(2);
    expect(book.runs).toHaveLength(3);
    expect(book.header.status).toBe('complete');
  });

  it('does not void a run the agent fails, and records the failed check', async () => {
    const book = await runOrder(options(() => ({ check: 'fail' })));
    expect(book.runs.every((run) => run.void === null && run.check === 'fail')).toBe(true);
  });

  it('hashes the transcript and tolerates a missing one', async () => {
    const book = await runOrder(options(firstAttempt({ noTranscript: true, exit: 'crash' })));
    expect(book.runs[0]?.transcriptSha256).toBeNull();
    expect(book.runs[1]?.transcriptSha256).toBe(createHash('sha256').update(`fake transcript of ${book.runs[1]?.runId ?? ''}\n`).digest('hex'));
  });

  it('cleans every temp folder, valid or void', async () => {
    const adapter = makeFake(firstAttempt({ exit: 'crash' }));
    await runOrder({ ...options(CLEAN_SCRIPT), adapter });
    expect(adapter.prepared).toHaveLength(3);
    expect(adapter.open.size).toBe(0);
  });
});

const CLEAN_SCRIPT: Script = () => ({});

describe('an adapter that throws', () => {
  it.each([
    ['prepare', 'machine-failed'],
    ['run', 'harness-failed'],
  ] as const)('records a throw from %s as a %s void run, reruns the slot, and keeps the run book', async (where, reason) => {
    const adapter = makeFake(firstAttempt({ throwIn: where }));
    const book = await runOrder({ ...options(CLEAN_SCRIPT), adapter });
    expect(book.runs.map((run) => run.void)).toEqual([reason, null, null]);
    expect(book.runs[0]?.exitStatus).toBe('adapter-threw');
    expect(book.runs[0]?.transcriptSha256).toBeNull();
    expect(book.header.status).toBe('complete');
    expect(adapter.open.size).toBe(0);
  });
});

describe('a task set that changes during an order (spec section 9)', () => {
  const changeAtThree: Script = (request) => (request.sequence === 3 ? { taskSetVersion: 'v2' } : {});

  it('stops with no rerun and voids every run already recorded', async () => {
    const adapter = makeFake(changeAtThree);
    const book = await runOrder({ ...options(CLEAN_SCRIPT, { tasks: 2 }), adapter });
    expect(book.runs).toHaveLength(3);
    expect(adapter.prepared).toHaveLength(3);
    expect(book.runs.every((run) => run.void === 'task-set-changed')).toBe(true);
    expect(book.runs.filter((run) => run.void === null)).toHaveLength(0);
    expect(book.header.status).toBe('voided');
  });

  it('lists every planned cell with no valid run in shortCells', async () => {
    const book = await runOrder({ ...options(CLEAN_SCRIPT, { tasks: 2 }), adapter: makeFake(changeAtThree) });
    expect(book.header.shortCells).toHaveLength(4);
    expect(book.header.shortCells.every((cell) => cell.have === 0 && cell.want === 1)).toBe(true);
  });

  it('writes the voided status and the reason on each run line', async () => {
    const lines = serializeRunBook(await runOrder({ ...options(CLEAN_SCRIPT, { tasks: 2 }), adapter: makeFake(changeAtThree) })).trimEnd().split(String.fromCharCode(10));
    expect(lines[0]).toContain('"status":"voided"');
    expect(lines.slice(1).every((line) => line.includes('"void":"task-set-changed"'))).toBe(true);
  });
});

describe('the run cap', () => {
  it('ends the order incomplete and lists the cells still short', async () => {
    // 2 tasks x 2 sides x 1 repeat needs 4 valid runs; every run crashes, so a cap of 3 stops it with no valid run.
    const book = await runOrder(options(() => ({ exit: 'crash' }), { tasks: 2, runCap: 3 }));
    expect(book.runs).toHaveLength(3);
    expect(book.header.status).toBe('incomplete');
    expect(book.header.shortCells).toEqual([
      { taskId: 't1', arm: 'playwright', side: 'before', have: 0, want: 1 },
      { taskId: 't1', arm: 'playwright', side: 'after', have: 0, want: 1 },
      { taskId: 't2', arm: 'playwright', side: 'before', have: 0, want: 1 },
      { taskId: 't2', arm: 'playwright', side: 'after', have: 0, want: 1 },
    ]);
  });

  it('lists only the cells that are short when the cap cuts a partly filled order', async () => {
    const book = await runOrder(options(CLEAN_SCRIPT, { tasks: 2, runCap: 3 }));
    expect(book.header.status).toBe('incomplete');
    expect(book.header.shortCells.map((cell) => `${cell.taskId}:${cell.side ?? ''}`)).toEqual(['t2:after']);
  });

  it('is complete when the cap equals the runs needed', async () => {
    const book = await runOrder(options(CLEAN_SCRIPT, { tasks: 2, runCap: 4 }));
    expect(book.header.status).toBe('complete');
    expect(book.header.shortCells).toEqual([]);
  });
});

describe('the run book bytes', () => {
  it('is the same on a second run with the same script and clock', async () => {
    const script = firstAttempt({ exit: 'rate-limit' });
    const first = serializeRunBook(await runOrder(options(script, { tasks: 2, repeats: 2 })));
    const second = serializeRunBook(await runOrder(options(script, { tasks: 2, repeats: 2 })));
    expect(second).toBe(first);
  });

  it('writes no signature field and no transcript text', async () => {
    const text = serializeRunBook(await runOrder(options(CLEAN_SCRIPT)));
    expect(text).not.toMatch(/signature/i);
    expect(text).not.toContain('fake transcript');
  });
});

describe('review lows of t1354', () => {
  it('records a throw from check as a check-script-failed void run and goes on', async () => {
    const adapter = makeFake(firstAttempt({ throwIn: 'check' }));
    const book = await runOrder({ ...options(CLEAN_SCRIPT), adapter });
    expect(book.runs.map((run) => run.void)).toEqual(['check-script-failed', null, null]);
    expect(book.runs[0]?.check).toBeNull();
    expect(book.header.status).toBe('complete');
    expect(adapter.open.size).toBe(0);
  });

  it('records a clean run with no transcript as a transcript-missing void run and reruns it', async () => {
    const book = await runOrder(options(firstAttempt({ noTranscript: true })));
    expect(book.runs.map((run) => run.void)).toEqual(['transcript-missing', null, null]);
    expect(book.runs[0]?.transcriptSha256).toBeNull();
    expect(book.header.status).toBe('complete');
  });

  it('records a transcript that cannot be read as a transcript-missing void run', async () => {
    const adapter = makeFake(firstAttempt({}));
    const run = adapter.run;
    adapter.run = async (prepared, request) => ({ ...(await run(prepared, request)), transcriptPath: request.sequence === 1 ? `${prepared.dir}/gone.jsonl` : `${prepared.dir}/transcript.jsonl` });
    const book = await runOrder({ ...options(CLEAN_SCRIPT), adapter });
    expect(book.runs.map((entry) => entry.void)).toEqual(['transcript-missing', null, null]);
  });

  it('keeps no check on a run voided with the whole order (a void run has check null)', async () => {
    const book = await runOrder(options((request) => (request.sequence === 2 ? { taskSetVersion: 'changed' } : {})));
    expect(book.header.status).toBe('voided');
    expect(book.runs.every((run) => run.void === 'task-set-changed' && run.check === null)).toBe(true);
  });
});
