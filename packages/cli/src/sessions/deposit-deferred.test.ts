import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { slugOf } from './allow.js';
import { readHookCalls } from './hook-calls.js';
import { runHook } from './hooks.js';
import { deferSession, listPending, PENDING_HOOK_CAP, pendingDir } from './pending.js';
import { appendStep, formatStepCounters, readSteps, stepCounters, stuckSteps } from './steps.js';
import { deposit, loadStore, paths, scanLog } from './store.js';
import { cleanup, FIXTURES, NOW, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const REPO = join('work', 'app');
const LOCK_MESSAGE = 'The store is locked by another deposit';

const deposited = async (): Promise<Staged> => {
  const staged = stage(slugOf(REPO));
  await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
  return staged;
};

/** A finished session the store has not seen, in the allowed folder. */
const finished = (staged: Staged, name: string): string => {
  const transcript = join(staged.projectsRoot, slugOf(REPO), `${name}.jsonl`);
  copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), transcript);
  return transcript;
};

const stopInput = (session: string, transcript: string): string => JSON.stringify({ session_id: session, transcript_path: transcript, hook_event_name: 'Stop' });

const sessionIds = async (staged: Staged): Promise<string[]> => (await loadStore(staged.storeDir)).sessions.map((session) => session.session);

const hold = (staged: Staged): string => {
  const lock = join(staged.storeDir, 'store.lock');
  writeFileSync(lock, 'a holder that never frees');
  return lock;
};

const pendingNames = (staged: Staged): string[] => {
  try {
    return readdirSync(pendingDir(staged.storeDir));
  } catch {
    return [];
  }
};

const stopRows = async (staged: Staged, since: number) => (await readSteps(staged.storeDir)).slice(since).filter((row) => row.trigger === 'stop');

describe('item 1: a Stop hook deposit that meets a held store lock', () => {
  it('exits quietly, leaves the session out of the store, and a later whole-store deposit takes it (before and after the pending list)', async () => {
    const staged = await deposited();
    const transcript = finished(staged, 'missed');
    hold(staged);
    // The hook never fails its session: runHook resolves with no output, and hook-bin.ts exits 0 whatever happens.
    expect(await runHook('stop', stopInput('missed', transcript), staged.runtime, () => NOW)).toBeUndefined();
    expect(await sessionIds(staged)).not.toContain('missed');

    // Without the pending list (what the walk alone did before t832): a whole-store deposit finds the transcript because state.json never saw it.
    rmSync(pendingDir(staged.storeDir), { recursive: true });
    await rm(join(staged.storeDir, 'store.lock'));
    const walked = await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    expect(walked.sessions).toBe(1);
    expect(await sessionIds(staged)).toContain('missed');
  }, 20_000); // the hook waits out its 3 s lock wait

  it('with the pending list, the whole-store deposit drains the session first and the walk finds nothing left', async () => {
    const staged = await deposited();
    const transcript = finished(staged, 'missed');
    const lock = hold(staged);
    await runHook('stop', stopInput('missed', transcript), staged.runtime, () => NOW);
    expect(pendingNames(staged)).toHaveLength(1);
    await rm(lock);
    const result = await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    expect(result.sessions).toBe(0);
    expect(await sessionIds(staged)).toContain('missed');
    expect(pendingNames(staged)).toEqual([]);
  }, 20_000);
});

describe('item 2: deferring on a held lock', () => {
  it('records the session once, holding only the transcript path, adds no wait, and exits quietly', async () => {
    const staged = await deposited();
    const transcript = finished(staged, 'deferred');
    hold(staged);
    const started = Date.now();
    expect(await runHook('stop', stopInput('deferred', transcript), staged.runtime, () => NOW)).toBeUndefined();
    // The 3 s lock wait the hook always had, and nothing on top of it.
    expect(Date.now() - started).toBeLessThan(4500);
    expect(await runHook('stop', stopInput('deferred', transcript), staged.runtime, () => NOW)).toBeUndefined();
    const names = pendingNames(staged);
    expect(names).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(pendingDir(staged.storeDir), names[0] ?? ''), 'utf8'))).toEqual({ transcript });
    expect(await sessionIds(staged)).not.toContain('deferred');
  }, 20_000);

  it('survives many hooks appending at once, with the same session twice as one entry, and needs no lock', async () => {
    const staged = await deposited();
    hold(staged);
    const distinct = Array.from({ length: 40 }, (_, index) => join(staged.projectsRoot, slugOf(REPO), `s${String(index)}.jsonl`));
    await Promise.all([...distinct, ...distinct.slice(0, 10), ...distinct.slice(0, 10)].map((transcript) => deferSession(staged.storeDir, transcript)));
    const listed = await listPending(staged.storeDir, 1000);
    expect(listed.map((entry) => entry.transcript).sort()).toEqual([...distinct].sort());
    expect(pendingNames(staged).filter((name) => !name.endsWith('.json'))).toEqual([]);
  });

  it('keeps today’s failure when the pending entry cannot be written: an error row and a hook-call error', async () => {
    const staged = await deposited();
    const transcript = finished(staged, 'unwritable');
    hold(staged);
    writeFileSync(pendingDir(staged.storeDir), 'a file where the pending folder should be');
    const before = (await readSteps(staged.storeDir)).length;
    expect(await runHook('stop', stopInput('unwritable', transcript), staged.runtime, () => NOW)).toBeUndefined();
    const rows = await stopRows(staged, before);
    expect(rows.map((row) => row.status)).toEqual(['error']);
    expect(rows[0]?.error).toContain(LOCK_MESSAGE);
    expect((await readHookCalls(staged.storeDir)).find((call) => call.session === 'unwritable')?.error).toContain('store is locked');
  }, 20_000);
});

describe('item 3: draining', () => {
  const lastRow = async (staged: Staged, since: number) => {
    const rows = await stopRows(staged, since);
    return rows[rows.length - 1];
  };

  it('drops and counts a pending session whose transcript is gone, and an entry that is not one', async () => {
    const staged = await deposited();
    const gone = join(staged.projectsRoot, slugOf(REPO), 'gone.jsonl');
    await deferSession(staged.storeDir, gone);
    writeFileSync(join(pendingDir(staged.storeDir), 'foreign.json'), 'not json');
    const own = finished(staged, 'own');
    const before = (await readSteps(staged.storeDir)).length;
    await runHook('stop', stopInput('own', own), staged.runtime, () => NOW);
    expect(pendingNames(staged)).toEqual([]);
    const row = await lastRow(staged, before);
    expect(row?.status).toBe('ok');
    expect(row?.in).toEqual({ transcript: 1, pending: 2, pendingDropped: 2 });
    expect(await sessionIds(staged)).toContain('own');
  });

  it('treats a pending session that is already current as a no-op: nothing is written, the entry goes', async () => {
    const staged = await deposited();
    const current = join(staged.projectsRoot, slugOf(REPO), 'tldr.jsonl');
    await deferSession(staged.storeDir, current);
    const logBefore = statSync(paths(staged.storeDir).observations).size;
    const stateBefore = readFileSync(paths(staged.storeDir).state, 'utf8');
    const before = (await readSteps(staged.storeDir)).length;
    await runHook('stop', stopInput('tldr', current), staged.runtime, () => NOW);
    expect(statSync(paths(staged.storeDir).observations).size).toBe(logBefore);
    expect(readFileSync(paths(staged.storeDir).state, 'utf8')).toBe(stateBefore);
    expect(pendingNames(staged)).toEqual([]);
    expect((await lastRow(staged, before))?.in).toEqual({ transcript: 1, pending: 1 });
  });

  it('leaves the entry for the next run when the run dies between taking the lock and finishing', async () => {
    const staged = await deposited();
    const pendingOne = finished(staged, 'crashy');
    await deferSession(staged.storeDir, pendingOne);
    // A directory where state.json's temp file goes makes the write fail after the records were appended: the run dies before it settles the entry.
    const temp = `${paths(staged.storeDir).state}.${String(process.pid)}.tmp`;
    mkdirSync(temp);
    const own = finished(staged, 'own');
    await runHook('stop', stopInput('own', own), staged.runtime, () => NOW);
    expect(pendingNames(staged)).toHaveLength(1);
    expect(readdirSync(staged.storeDir)).not.toContain('store.lock');
    rmSync(temp, { recursive: true });
    await runHook('stop', stopInput('own', own), staged.runtime, () => NOW);
    expect(pendingNames(staged)).toEqual([]);
    expect(await sessionIds(staged)).toEqual(expect.arrayContaining(['crashy', 'own']));
  });

  it('keeps an entry whose deposit fails, counts it, and goes on with the rest', async () => {
    const staged = await deposited();
    // A folder named like a transcript cannot be read as one.
    const unreadable = join(staged.projectsRoot, slugOf(REPO), 'broken.jsonl');
    mkdirSync(unreadable);
    await deferSession(staged.storeDir, unreadable);
    const fine = finished(staged, 'fine');
    await deferSession(staged.storeDir, fine);
    const own = finished(staged, 'own');
    const before = (await readSteps(staged.storeDir)).length;
    await runHook('stop', stopInput('own', own), staged.runtime, () => NOW);
    expect((await listPending(staged.storeDir, 10)).map((entry) => entry.transcript)).toEqual([unreadable]);
    expect((await lastRow(staged, before))?.in).toEqual({ transcript: 1, pending: 2, pendingKept: 1 });
    expect(await sessionIds(staged)).toEqual(expect.arrayContaining(['fine', 'own']));
  });

  it('caps one hook deposit at PENDING_HOOK_CAP, leaves the rest, and never compacts', async () => {
    const staged = await deposited();
    // Leave a superseded rev in the log: only a whole-store deposit compacts it, so a hook that did would remove it.
    const grown = finished(staged, 'grown');
    await runHook('stop', stopInput('grown', grown), staged.runtime, () => NOW);
    appendFileSync(grown, `${readFileSync(grown, 'utf8').split('\n')[0] ?? ''}\n`);
    await runHook('stop', stopInput('grown', grown), staged.runtime, () => NOW);
    expect((await scanLog(paths(staged.storeDir).observations)).superseded).toBe(true);
    const total = PENDING_HOOK_CAP * 2 + 2;
    for (let index = 0; index < total; index += 1) await deferSession(staged.storeDir, finished(staged, `p${String(index).padStart(2, '0')}`));
    const own = finished(staged, 'own');
    const before = (await readSteps(staged.storeDir)).length;
    await runHook('stop', stopInput('own', own), staged.runtime, () => NOW);
    expect(pendingNames(staged)).toHaveLength(total - PENDING_HOOK_CAP);
    expect((await lastRow(staged, before))?.in).toEqual({ transcript: 1, pending: PENDING_HOOK_CAP });
    expect((await scanLog(paths(staged.storeDir).observations)).superseded).toBe(true);
    const ids = await sessionIds(staged);
    expect(ids).toContain('own');
    expect(ids.filter((id) => /^p\d\d$/.test(id))).toHaveLength(PENDING_HOOK_CAP);
    // The next hook takes the next five, and a whole-store deposit takes whatever is left.
    await runHook('stop', stopInput('own', own), staged.runtime, () => NOW);
    expect(pendingNames(staged)).toHaveLength(total - PENDING_HOOK_CAP * 2);
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    expect(pendingNames(staged)).toEqual([]);
    expect((await scanLog(paths(staged.storeDir).observations)).superseded).toBe(false);
  }, 30_000);
});

describe('item 4: a deferred deposit is its own outcome', () => {
  it('logs a deferred row that is not a failed run, not stuck, and countable', async () => {
    const staged = await deposited();
    const transcript = finished(staged, 'deferred');
    hold(staged);
    const before = (await readSteps(staged.storeDir)).length;
    await runHook('stop', stopInput('deferred', transcript), staged.runtime, () => NOW);
    const rows = await stopRows(staged, before);
    expect(rows.map((row) => [row.step, row.status])).toEqual([['deposit', 'deferred']]);
    const row = rows[0];
    expect(row?.error).toContain(LOCK_MESSAGE);
    expect(row?.key).not.toBeNull();
    // The hook-call line is not an error either: the refusal is in the step log, under its own status.
    expect((await readHookCalls(staged.storeDir)).find((call) => call.session === 'deferred')?.error).toBeNull();

    // The test that reads failed runs: the row is in the books and `failures` does not hold it. Repeated, it is still not stuck.
    if (row === undefined) throw new Error('no deferred row');
    for (let repeat = 0; repeat < 3; repeat += 1) await appendStep(staged.storeDir, row);
    const all = await readSteps(staged.storeDir);
    const counters = stepCounters(all);
    expect(counters.failures).toEqual({});
    expect(counters.stuck).toEqual([]);
    expect(stuckSteps(all)).toEqual([]);
    const line = counters.steps.find((entry) => entry.step === 'deposit');
    expect([line?.error, line?.deferred]).toEqual([0, 4]);
    expect(line?.meanMs).toBe(0);
    const text = formatStepCounters(counters);
    expect(text).not.toContain('failed runs');
    expect(text).toMatch(/deposit@\S+ deferred \(store locked\)\s+4/);
  }, 20_000);

  it('does not end a failure streak, and a real failed run still counts as one', () => {
    const base = { at: '2026-11-04T00:00:00Z', run: 'r', trigger: 'stop' as const, step: 'deposit' as const, ms: 1, in: {}, out: {}, cv: '12', ev: '11', key: 'k' };
    const failed = { ...base, status: 'error' as const, error: 'boom' };
    const deferred = { ...base, status: 'deferred' as const, error: LOCK_MESSAGE };
    expect(stuckSteps([failed, deferred, failed, deferred, failed])).toHaveLength(1);
    expect(stepCounters([failed, deferred]).failures).toEqual({ 'deposit@11': 1 });
  });
});
