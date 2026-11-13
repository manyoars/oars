// The operator's founding-crew grant (t1229): a dry run changes nothing, --confirm numbers the first 100 counting accounts and grants board standing, a vouched account is granted after its second counting week, a vouch inside one cluster earns nothing, and a closed or restricted account earns nothing. Fixture rows only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fieldOf, startPool, stubUser, type TestDb, type TestPool } from '../src/test-pool.js';
import type { EraseStore } from './erase.js';
import type { ObjectFiles } from './erase-wrangler.js';
import { CREW_CAP, main, planCrew, USAGE, writeCrew, type Io } from './grant-crew.js';

let pool: TestPool;
let db: TestDb;
let seen = 9800;

beforeAll(async () => {
  pool = await startPool();
  db = await pool.db();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const NOW = new Date('2026-11-10T12:00:00Z');

const storeOf = (): Pick<EraseStore, 'rows' | 'run'> => ({
  rows: async (sql, binds) => (await db.prepare(sql).bind(...binds).all()).results,
  run: async (sql, binds) => Number(fieldOf(fieldOf(await db.prepare(sql).bind(...binds).run(), 'meta'), 'changes')),
});

/** A clean slate: no crew, no standing, no deposits, no edges, so each test owns its fixtures. */
beforeEach(async () => {
  for (const table of ['vouch_edges', 'invites', 'board_standing', 'account_weeks', 'account_repo_keys', 'deposit_hours']) await db.prepare(`DELETE FROM ${table}`).run();
  // Deposits are a ledger and never deleted: an earlier test's rows stop counting instead.
  await db.prepare('UPDATE deposits SET counted_at = NULL').run();
  await db.prepare("DELETE FROM accounts WHERE id LIKE 'held-%'").run();
  await db.prepare('UPDATE accounts SET crew_number = NULL, closed_at = NULL, restricted_at = NULL').run();
});

const account = async (): Promise<string> => {
  seen += 1;
  return (await pool.signIn('github', stubUser(String(seen)), { fresh: true })).account;
};

/** An account whose first counting deposit was at `countedAt`. Its signals differ from every other account's unless the test says otherwise: a distinct repo key set, an hour no other account uses, and a creation time far from the others. */
const counting = async (countedAt: number, options: { weeks?: number; repoKeys?: readonly string[]; created?: number } = {}): Promise<string> => {
  const id = await account();
  await db.prepare("INSERT INTO deposits (account, id, skeleton, tier, counted_at, extensions, deltas) VALUES (?, ?, '{}', 'skeleton', ?, '[]', '[]')").bind(id, `s-${id}`, countedAt).run();
  await db.prepare('UPDATE accounts SET provider_created = ? WHERE id = ?').bind(options.created ?? countedAt - 400 * 86_400_000 - seen * 3 * 86_400_000, id).run();
  for (const key of options.repoKeys ?? [`${id}-a`, `${id}-b`, `${id}-c`]) await db.prepare('INSERT INTO account_repo_keys (account, repo_key) VALUES (?, ?)').bind(id, key).run();
  for (let n = 0; n < (options.weeks ?? 0); n += 1) await db.prepare("INSERT INTO account_weeks (account, week, sessions, tool_steps, failed_steps, day_mask, harnesses) VALUES (?, ?, 2, 5, 0, 1, '[]')").bind(id, `2026-W0${String(n + 1)}`).run();
  return id;
};

/** All 100 numbers held by filler accounts, so a counting account earns standing only by a vouch. */
const fillCrew = async (): Promise<void> => {
  for (let crew = 1; crew <= CREW_CAP; crew += 1) await db.prepare('INSERT OR REPLACE INTO accounts (id, crew_number) VALUES (?, ?)').bind(`held-${String(crew)}`, crew).run();
};

const vouch = async (inviter: string, invitee: string): Promise<void> => {
  await db.prepare('INSERT INTO vouch_edges (inviter, invitee, at) VALUES (?, ?, ?)').bind(inviter, invitee, 1).run();
};

const crewOf = async (id: string): Promise<unknown> => fieldOf(await db.prepare('SELECT crew_number FROM accounts WHERE id = ?').bind(id).first(), 'crew_number');
const standingOf = async (id: string): Promise<readonly unknown[]> => (await db.prepare('SELECT granted_by, reason FROM board_standing WHERE account = ?').bind(id).all()).results;
const DAY = 86_400_000;
const NO_FILES: ObjectFiles = { temp: () => Promise.resolve('x'), read: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) }), write: () => Promise.resolve(), remove: () => Promise.resolve() };

describe('planCrew', () => {
  it('numbers the first counting accounts in the order they first counted, and skips accounts that never counted, are closed, or are restricted', async () => {
    const second = await counting(2 * DAY);
    const first = await counting(1 * DAY);
    const closed = await counting(0);
    await db.prepare('UPDATE accounts SET closed_at = 1 WHERE id = ?').bind(closed).run();
    const restricted = await counting(0);
    await db.prepare('UPDATE accounts SET restricted_at = 1 WHERE id = ?').bind(restricted).run();
    const idle = await account();
    const plan = await planCrew(storeOf());
    expect(plan.founding).toEqual([{ account: first, crew: 1 }, { account: second, crew: 2 }]);
    expect(plan.founding.map((row) => row.account)).not.toContain(idle);
  });

  it('stops at 100 across what is already numbered, keeps existing numbers, and fills a freed number first', async () => {
    const ids: string[] = [];
    for (let n = 0; n < 4; n += 1) ids.push(await counting((n + 1) * DAY));
    // Ninety-seven numbered already, with 1 and 50 not among them: the plan has 3 left, and the lowest free numbers go first.
    const held = Array.from({ length: CREW_CAP }, (_, n) => n + 1).filter((n) => n !== 1 && n !== 50 && n !== 99);
    expect(held).toHaveLength(97);
    for (const [at, crew] of held.entries()) {
      await db.prepare("INSERT INTO accounts (id, crew_number) VALUES (?, ?)").bind(`held-${String(at)}`, crew).run();
    }
    const plan = await planCrew(storeOf());
    expect(plan.founding).toEqual([{ account: ids[0], crew: 1 }, { account: ids[1], crew: 50 }, { account: ids[2], crew: 99 }]);
    await db.prepare("DELETE FROM accounts WHERE id LIKE 'held-%'").run();
  });

  it('grants a vouched account after its second counting week, not before', async () => {
    await fillCrew();
    const inviter = await counting(1 * DAY, { weeks: 3 });
    const early = await counting(10 * DAY, { weeks: 1 });
    const ready = await counting(11 * DAY, { weeks: 2 });
    await vouch(inviter, early);
    await vouch(inviter, ready);
    const plan = await planCrew(storeOf());
    expect(plan.vouched).toEqual([{ account: ready, inviter }]);
    expect(plan.founding).toEqual([]);
  });

  it('earns nothing for a vouch inside one cluster, by shared repo keys or a shared creation window and hour', async () => {
    await fillCrew();
    const shared = ['k1', 'k2', 'k3'];
    const inviter = await counting(1 * DAY, { weeks: 3, repoKeys: shared });
    const twin = await counting(10 * DAY, { weeks: 2, repoKeys: shared });
    const other = await counting(11 * DAY, { weeks: 2 });
    await vouch(inviter, twin);
    await vouch(inviter, other);
    const plan = await planCrew(storeOf());
    expect(plan.vouched).toEqual([{ account: other, inviter }]);
    expect(plan.skipped).toContainEqual({ account: twin, reason: 'same cluster as its inviter' });
  });

  it('earns nothing when the invitee is closed or restricted, and not twice when it already holds standing', async () => {
    await fillCrew();
    const inviter = await counting(1 * DAY, { weeks: 3 });
    const closed = await counting(10 * DAY, { weeks: 2 });
    const held = await counting(11 * DAY, { weeks: 2 });
    await vouch(inviter, closed);
    await vouch(inviter, held);
    await db.prepare('UPDATE accounts SET closed_at = 1 WHERE id = ?').bind(closed).run();
    await db.prepare("INSERT INTO board_standing (account, granted_at, granted_by, reason) VALUES (?, 1, 'x', 'y')").bind(held).run();
    expect((await planCrew(storeOf())).vouched).toEqual([]);
  });

  it('earns nothing when the inviter is closed or restricted', async () => {
    await fillCrew();
    const inviter = await counting(1 * DAY, { weeks: 3 });
    const invitee = await counting(10 * DAY, { weeks: 2 });
    await vouch(inviter, invitee);
    await db.prepare('UPDATE accounts SET restricted_at = 1 WHERE id = ?').bind(inviter).run();
    expect((await planCrew(storeOf())).vouched).toEqual([]);
  });
});

describe('writeCrew', () => {
  it('writes the number and the standing, once, and says what it did', async () => {
    const first = await counting(1 * DAY);
    const plan = await planCrew(storeOf());
    const written = await writeCrew(storeOf(), plan, { by: 'operator-x' }, NOW);
    expect(written).toEqual({ founding: 1, vouched: 0 });
    expect(await crewOf(first)).toBe(1);
    expect(await standingOf(first)).toEqual([{ granted_by: 'operator-x', reason: 'founding crew #1' }]);
    expect(await writeCrew(storeOf(), plan, { by: 'operator-x' }, NOW)).toEqual({ founding: 0, vouched: 0 });
  });

  it('writes standing for a vouched account with the vouch as the reason', async () => {
    await fillCrew();
    const inviter = await counting(1 * DAY, { weeks: 3 });
    const invitee = await counting(10 * DAY, { weeks: 2 });
    await vouch(inviter, invitee);
    expect(await writeCrew(storeOf(), await planCrew(storeOf()), { by: 'operator-x' }, NOW)).toEqual({ founding: 0, vouched: 1 });
    expect(await standingOf(invitee)).toEqual([{ granted_by: 'operator-x', reason: 'vouched by a founding or standing account, two counting weeks' }]);
    expect(await crewOf(invitee)).toBeNull();
  });
});

describe('main', () => {
  const ioOf = (): { io: Io; printed: string[]; calls: string[] } => {
    const printed: string[] = [];
    const calls: string[] = [];
    const io: Io = { print: (text) => printed.push(text), wrangler: (args) => { calls.push(args.join(' ')); return Promise.resolve('[]'); }, files: NO_FILES, now: () => NOW };
    return { io, printed, calls };
  };

  it('prints the usage and exits 2 for a missing or unknown argument', async () => {
    const { io, printed } = ioOf();
    expect(await main([], io)).toBe(2);
    expect(printed.join('')).toContain(USAGE);
    expect(await main(['--by'], io)).toBe(2);
    expect(await main(['--nope'], io)).toBe(2);
  });

  it('is a dry run without --confirm: it says what it would grant and writes nothing', async () => {
    const { io, printed } = ioOf();
    expect(await main(['--by', 'operator-x'], { ...io, store: storeOf() })).toBe(0);
    const said = printed.join('\n');
    expect(said).toContain('Nothing was changed: run again with --confirm.');
    expect(JSON.parse(said.split('\n')[0] ?? '{}')).toMatchObject({ dryRun: true, founding: [], vouched: [] });
  });

  it('writes with --confirm and prints the counts', async () => {
    const first = await counting(1 * DAY);
    const { io, printed } = ioOf();
    expect(await main(['--by', 'operator-x', '--confirm'], { ...io, store: storeOf() })).toBe(0);
    expect(JSON.parse(printed.join('\n'))).toEqual({ founding: 1, vouched: 0 });
    expect(await crewOf(first)).toBe(1);
  });

  it('reads through wrangler when no store is passed, against local state with --local, and writes nothing without --confirm', async () => {
    const { io, calls, printed } = ioOf();
    const wrangler: Io['wrangler'] = (args) => { calls.push(args.join(' ')); return Promise.resolve(JSON.stringify([{ results: [], success: true, meta: { changes: 0 } }])); };
    expect(await main(['--by', 'operator-x', '--local'], { ...io, wrangler })).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.includes('--local') && !/INSERT|UPDATE|DELETE/.test(call))).toBe(true);
    expect(printed.join('\n')).toContain('"dryRun":true');
  });

  it('prints the failure and exits 1 when the store fails', async () => {
    const { io, printed } = ioOf();
    const broken = { rows: () => Promise.reject(new Error('no store')), run: () => Promise.resolve(0) };
    expect(await main(['--by', 'operator-x'], { ...io, store: broken })).toBe(1);
    expect(printed.join('')).toContain('no store');
  });
});
