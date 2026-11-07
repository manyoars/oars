import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { slugOf } from './allow.js';
import { readHookCalls } from './hook-calls.js';
import { runHook } from './hooks.js';
import { deferSession, failPending, listPending, PENDING_HOOK_CAP, PENDING_MAX_FAILURES, pendingDir, removePending, type PendingEntry } from './pending.js';
import type { StepCounts } from './schema.js';
import { appendStep, formatStepCounters, readSteps, stepCounters, stuckSteps } from './steps.js';
import { deposit, loadStore, paths, scanLog, type DepositTrace } from './store.js';
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

    // What the walk alone does, without the pending list: a whole-store deposit finds the transcript because state.json never saw it.
    rmSync(pendingDir(staged.storeDir), { recursive: true });
    await rm(join(staged.storeDir, 'store.lock'));
    const walked = await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    expect(walked.sessions).toBe(1);
    expect(await sessionIds(staged)).toContain('missed');
  }, 20_000); // the hook waits out its 3 s lock wait

  it('with the pending list, the whole-store deposit drains the session first and the walk finds nothing left', async () => {
    const staged = await deposited();
    const baseline = await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    const transcript = finished(staged, 'missed');
    const lock = hold(staged);
    await runHook('stop', stopInput('missed', transcript), staged.runtime, () => NOW);
    expect(pendingNames(staged)).toHaveLength(1);
    await rm(lock);
    const result = await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    // The drained session is in the result and is not "unchanged": the drain changed it.
    expect(result.sessions).toBe(1);
    expect(result.unchanged).toBe(baseline.unchanged);
    expect(result.lines).toBeGreaterThan(0);
    expect(result.observations).toBeGreaterThan(0);
    expect(await sessionIds(staged)).toContain('missed');
    expect(pendingNames(staged)).toEqual([]);
  }, 20_000);

  it('counts a drained session’s subagent transcript as a subagent, and not as unchanged, in a whole-store run', async () => {
    const staged = await deposited();
    const baseline = await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    const transcript = finished(staged, 'missed');
    const subagents = join(staged.projectsRoot, slugOf(REPO), 'missed', 'subagents');
    mkdirSync(subagents, { recursive: true });
    copyFileSync(join(FIXTURES, 'proj', 'sidechain.jsonl'), join(subagents, 'agent-x.jsonl'));
    await deferSession(staged.storeDir, transcript);
    const result = await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    expect(result.sessions).toBe(1);
    expect(result.subagents).toBe(1);
    expect(result.unchanged).toBe(baseline.unchanged);
    expect(pendingNames(staged)).toEqual([]);
  });
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
    // Two deferrals are two files (a drain removes only the names it read) and one entry.
    const names = pendingNames(staged);
    expect(names).toHaveLength(2);
    expect(await listPending(staged.storeDir, 10)).toHaveLength(1);
    for (const name of names) expect(JSON.parse(readFileSync(join(pendingDir(staged.storeDir), name), 'utf8'))).toEqual({ transcript });
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

describe('the allowlist holds under a held lock', () => {
  it('writes nothing for an off-allowlist session when the lock is held: no pending entry, no deferred row', async () => {
    const staged = await deposited();
    const other = join(staged.projectsRoot, 'not-named');
    mkdirSync(other);
    const stray = join(other, 'stray.jsonl');
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), stray);
    hold(staged);
    const before = (await readSteps(staged.storeDir)).length;
    await runHook('stop', stopInput('stray', stray), staged.runtime, () => NOW);
    expect(existsSync(pendingDir(staged.storeDir))).toBe(false);
    expect((await readSteps(staged.storeDir)).slice(before).filter((row) => row.status === 'deferred')).toEqual([]);
  }, 20_000);

  it('creates no salt and no skeletons folder for an off-allowlist session on an unstaged store', async () => {
    const staged = stage(slugOf(REPO));
    const other = join(staged.projectsRoot, 'not-named');
    mkdirSync(other);
    const stray = join(other, 'stray.jsonl');
    copyFileSync(join(FIXTURES, 'proj', 'tldr.jsonl'), stray);
    // Every folder is allowed until a list names some, so the list here names only the repository.
    mkdirSync(staged.storeDir, { recursive: true });
    writeFileSync(paths(staged.storeDir).state, JSON.stringify({ files: {}, redactDomains: [], allow: [slugOf(REPO)] }));
    await runHook('stop', stopInput('stray', stray), staged.runtime, () => NOW);
    expect(existsSync(paths(staged.storeDir).salt)).toBe(false);
    expect(existsSync(paths(staged.storeDir).skeletons)).toBe(false);
  });
});

/** A transcript the deposit cannot read: a folder named like one. */
const broken = (staged: Staged, name: string): string => {
  const folder = join(staged.projectsRoot, slugOf(REPO), `${name}.jsonl`);
  mkdirSync(folder);
  return folder;
};

const quietly = async (work: () => Promise<void>): Promise<string[]> => {
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await work();
    return write.mock.calls.map((call) => String(call[0]));
  } finally {
    write.mockRestore();
  }
};

describe('pending entries', () => {
  it('never loses a session that defers again between a drain reading its entry and removing it', async () => {
    const staged = await deposited();
    const transcript = finished(staged, 'again');
    await deferSession(staged.storeDir, transcript);
    const read = await listPending(staged.storeDir, 10);
    await deferSession(staged.storeDir, transcript);
    await removePending(staged.storeDir, read);
    const left = await listPending(staged.storeDir, 10);
    expect(left.map((entry) => entry.transcript)).toEqual([transcript]);
    expect(pendingNames(staged)).toHaveLength(1);
  });

  it('lists one entry per transcript when it deferred twice, and removes both files once settled', async () => {
    const staged = await deposited();
    const transcript = finished(staged, 'twice');
    await deferSession(staged.storeDir, transcript);
    await deferSession(staged.storeDir, transcript);
    expect(pendingNames(staged)).toHaveLength(2);
    const listed = await listPending(staged.storeDir, 10);
    expect(listed).toHaveLength(1);
    await removePending(staged.storeDir, listed);
    expect(pendingNames(staged)).toEqual([]);
  });

  it('leaves a deposit ok when a pending entry is a folder, keeps it, and counts it as kept', async () => {
    const staged = await deposited();
    mkdirSync(join(pendingDir(staged.storeDir), 'x.json'), { recursive: true });
    const own = finished(staged, 'own');
    const before = (await readSteps(staged.storeDir)).length;
    await quietly(async () => {
      await runHook('stop', stopInput('own', own), staged.runtime, () => NOW);
    });
    const rows = await stopRows(staged, before);
    expect(rows.map((row) => row.status)).toEqual(['ok']);
    expect(rows[0]?.in).toEqual({ transcript: 1, pending: 1, pendingKept: 1 });
    expect(pendingNames(staged)).toEqual(['x.json']);
    expect(await sessionIds(staged)).toContain('own');
    await quietly(async () => {
      expect((await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW })).sessions).toBe(0);
    });
    expect(pendingNames(staged)).toEqual(['x.json']);
  });

  it('treats a file where the pending folder should be as an empty list, says so once, and still deposits', async () => {
    const staged = await deposited();
    writeFileSync(pendingDir(staged.storeDir), 'a file where the pending folder should be');
    const own = finished(staged, 'own');
    const lines = await quietly(async () => {
      await runHook('stop', stopInput('own', own), staged.runtime, () => NOW);
    });
    expect(lines.filter((line) => line.includes('pending list'))).toHaveLength(1);
    expect(await sessionIds(staged)).toContain('own');
  });

  it('counts an entry failures and removes it at PENDING_MAX_FAILURES, counted as dropped, with its own session deposited each time', async () => {
    const staged = await deposited();
    await deferSession(staged.storeDir, broken(staged, 'bad'));
    const rows: (StepCounts | undefined)[] = [];
    for (let run = 1; run <= PENDING_MAX_FAILURES; run += 1) {
      const before = (await readSteps(staged.storeDir)).length;
      await quietly(async () => {
        await runHook('stop', stopInput('own', finished(staged, `own${String(run)}`)), staged.runtime, () => NOW);
      });
      rows.push((await stopRows(staged, before)).at(-1)?.in);
    }
    expect(rows.slice(0, -1)).toEqual(Array.from({ length: PENDING_MAX_FAILURES - 1 }, () => ({ transcript: 1, pending: 1, pendingKept: 1 })));
    expect(rows.at(-1)).toEqual({ transcript: 1, pending: 1, pendingDropped: 1 });
    expect(pendingNames(staged)).toEqual([]);
  });

  it('lists entries with no failures first, so entries that always fail cannot fill the hook cap', async () => {
    const staged = await deposited();
    for (let index = 0; index < PENDING_HOOK_CAP; index += 1) await deferSession(staged.storeDir, broken(staged, `bad${String(index)}`));
    await quietly(async () => {
      await runHook('stop', stopInput('own', finished(staged, 'own')), staged.runtime, () => NOW);
    });
    await deferSession(staged.storeDir, finished(staged, 'fine'));
    const before = (await readSteps(staged.storeDir)).length;
    await quietly(async () => {
      await runHook('stop', stopInput('own', finished(staged, 'own2')), staged.runtime, () => NOW);
    });
    expect((await stopRows(staged, before)).at(-1)?.in).toEqual({ transcript: 1, pending: PENDING_HOOK_CAP, pendingKept: PENDING_HOOK_CAP - 1 });
    expect(await sessionIds(staged)).toContain('fine');
    expect(pendingNames(staged)).toHaveLength(PENDING_HOOK_CAP);
  });
});

describe('a whole-store drain', () => {
  const whole = (staged: Staged, trace?: DepositTrace) => deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW }, trace);

  it('leaves the entry when the whole-store run dies before state.json is written, and a rerun settles it', async () => {
    const staged = await deposited();
    await deferSession(staged.storeDir, finished(staged, 'crashy'));
    const temp = `${paths(staged.storeDir).state}.${String(process.pid)}.tmp`;
    mkdirSync(temp);
    await expect(whole(staged)).rejects.toThrow();
    expect(pendingNames(staged)).toHaveLength(1);
    expect(readdirSync(staged.storeDir)).not.toContain('store.lock');
    rmSync(temp, { recursive: true });
    await whole(staged);
    expect(pendingNames(staged)).toEqual([]);
    expect(await sessionIds(staged)).toContain('crashy');
  });

  it('drops and counts a gone transcript in a whole-store run', async () => {
    const staged = await deposited();
    await deferSession(staged.storeDir, join(staged.projectsRoot, slugOf(REPO), 'gone.jsonl'));
    const trace: DepositTrace = { kinds: {} };
    await whole(staged, trace);
    expect(trace.pending).toEqual({ pending: 1, pendingDropped: 1 });
    expect(pendingNames(staged)).toEqual([]);
  });

  it('treats an already-current pending session as a no-op in a whole-store run', async () => {
    const staged = await deposited();
    await deferSession(staged.storeDir, join(staged.projectsRoot, slugOf(REPO), 'tldr.jsonl'));
    const logBefore = statSync(paths(staged.storeDir).observations).size;
    const trace: DepositTrace = { kinds: {} };
    const result = await whole(staged, trace);
    expect(statSync(paths(staged.storeDir).observations).size).toBe(logBefore);
    expect(trace.pending).toEqual({ pending: 1 });
    expect(result.sessions).toBe(0);
    expect(pendingNames(staged)).toEqual([]);
  });
});

describe('leftover temp files', () => {
  it('has a whole-store run remove a pending temp file older than the stale-lock age, and nothing newer, and a hook remove none', async () => {
    const staged = await deposited();
    mkdirSync(pendingDir(staged.storeDir), { recursive: true });
    const old = join(pendingDir(staged.storeDir), 'old.tmp');
    const fresh = join(pendingDir(staged.storeDir), 'fresh.tmp');
    writeFileSync(old, '{}');
    writeFileSync(fresh, '{}');
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(old, hourAgo, hourAgo);
    await runHook('stop', stopInput('own', finished(staged, 'own')), staged.runtime, () => NOW);
    expect(pendingNames(staged).sort()).toEqual(['fresh.tmp', 'old.tmp']);
    await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    expect(pendingNames(staged)).toEqual(['fresh.tmp']);
  });
});

describe('housekeeping never fails a deposit', () => {
  it('resolves a whole-store deposit when pending holds a folder named like an old temp file, and leaves the folder', async () => {
    const staged = await deposited();
    const folder = join(pendingDir(staged.storeDir), 'old.tmp');
    mkdirSync(folder, { recursive: true });
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(folder, hourAgo, hourAgo);
    const lines = await quietly(async () => {
      await deposit(staged.runtime, { allow: [REPO], redactDomains: [], now: () => NOW });
    });
    expect(pendingNames(staged)).toEqual(['old.tmp']);
    expect(lines.filter((line) => line.includes('old.tmp'))).toHaveLength(1);
  });

  it('guards removePending: a file it cannot remove costs one line and that file, not the rest', async () => {
    const staged = await deposited();
    const dir = pendingDir(staged.storeDir);
    mkdirSync(join(dir, 'refused.json'), { recursive: true });
    writeFileSync(join(dir, 'settled.json'), '{}');
    const entry: PendingEntry = { names: ['refused.json', 'settled.json'], transcript: undefined, unreadable: false, failures: 0 };
    const lines = await quietly(async () => {
      await removePending(staged.storeDir, [entry]);
    });
    expect(pendingNames(staged)).toEqual(['refused.json']);
    expect(lines.filter((line) => line.includes('refused.json'))).toHaveLength(1);
  });

  it('guards failPending: a file it cannot rename costs one line and does not throw', async () => {
    const staged = await deposited();
    mkdirSync(pendingDir(staged.storeDir), { recursive: true });
    const entry: PendingEntry = { names: ['vanished.json'], transcript: undefined, unreadable: false, failures: 0 };
    const lines = await quietly(async () => {
      await failPending(staged.storeDir, entry);
    });
    expect(lines.filter((line) => line.includes('vanished.json'))).toHaveLength(1);
  });
});

describe('an unreadable entry neither goes first nor fills the cap', () => {
  it('lists unreadable entries after the readable ones, and reads past them to fill the limit', async () => {
    const staged = await deposited();
    const dir = pendingDir(staged.storeDir);
    // '!0.json' to '!4.json' sort ahead of every hash-named entry, whatever the hashes start with: '!' sorts before every hex digit.
    for (let index = 0; index < PENDING_HOOK_CAP; index += 1) mkdirSync(join(dir, `!${String(index)}.json`), { recursive: true });
    for (let index = 0; index < PENDING_HOOK_CAP; index += 1) await deferSession(staged.storeDir, finished(staged, `fine${String(index)}`));
    const listed = await listPending(staged.storeDir, PENDING_HOOK_CAP);
    expect(listed.map((entry) => entry.unreadable)).toEqual([...Array.from({ length: PENDING_HOOK_CAP }, () => false), ...Array.from({ length: PENDING_HOOK_CAP }, () => true)]);
  });

  it('has a hook deposit take its readable pending session although unreadable ones sort first, and count the unreadable as kept', async () => {
    const staged = await deposited();
    const dir = pendingDir(staged.storeDir);
    for (let index = 0; index < PENDING_HOOK_CAP; index += 1) mkdirSync(join(dir, `!${String(index)}.json`), { recursive: true });
    await deferSession(staged.storeDir, finished(staged, 'fine'));
    const before = (await readSteps(staged.storeDir)).length;
    await quietly(async () => {
      await runHook('stop', stopInput('own', finished(staged, 'own')), staged.runtime, () => NOW);
    });
    expect(await sessionIds(staged)).toContain('fine');
    expect((await stopRows(staged, before)).at(-1)?.in).toEqual({ transcript: 1, pending: PENDING_HOOK_CAP + 1, pendingKept: PENDING_HOOK_CAP });
  });
});

describe('the failure ordering is pinned', () => {
  it('lists the entry with fewer failures first although its name sorts last', async () => {
    const staged = await deposited();
    const dir = pendingDir(staged.storeDir);
    mkdirSync(dir, { recursive: true });
    const failing = finished(staged, 'failing');
    const fresh = finished(staged, 'fresh');
    writeFileSync(join(dir, `${'0'.repeat(32)}.a.f1.json`), JSON.stringify({ transcript: failing }));
    writeFileSync(join(dir, `${'f'.repeat(32)}.b.json`), JSON.stringify({ transcript: fresh }));
    expect((await listPending(staged.storeDir, 1)).map((entry) => entry.transcript)).toEqual([fresh]);
  });
});
