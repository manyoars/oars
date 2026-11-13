// The operator's grant of standing on the open board: a dry run changes nothing, --confirm writes one row, an unknown account is refused, and the command line runs against a fake wrangler.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldOf, startPool, stubUser, type TestDb, type TestPool } from '../src/test-pool.js';
import type { EraseStore } from './erase.js';
import type { ObjectFiles } from './erase-wrangler.js';
import { grantStanding, main, USAGE, type Io } from './grant-standing.js';

let pool: TestPool;
let db: TestDb;

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

const accountId = async (n: number): Promise<string> => (await pool.signIn('github', stubUser(String(n)))).account;

const rowsOf = async (account: string): Promise<readonly unknown[]> => (await db.prepare('SELECT granted_at, granted_by, reason FROM board_standing WHERE account = ?').bind(account).all()).results;

describe('grantStanding', () => {
  it('writes one row with who, when, and why, and holds on a second grant', async () => {
    const account = await accountId(9101);
    expect(await grantStanding(storeOf(), { account, by: ' owner ', reason: ' the fleet ' }, NOW)).toBe('granted');
    expect(await rowsOf(account)).toEqual([{ granted_at: NOW.getTime(), granted_by: 'owner', reason: 'the fleet' }]);
    expect(await grantStanding(storeOf(), { account, by: 'other', reason: 'again' }, NOW)).toBe('held');
    expect(await rowsOf(account)).toHaveLength(1);
  });

  it('refuses an account the pool has not seen, a malformed id, and a missing who or why', async () => {
    await expect(grantStanding(storeOf(), { account: 'acct_nobody', by: 'm', reason: 'r' }, NOW)).rejects.toThrow(/No account acct_nobody/);
    await expect(grantStanding(storeOf(), { account: "x'; DROP", by: 'm', reason: 'r' }, NOW)).rejects.toThrow(/not a pool id/);
    const account = await accountId(9102);
    await expect(grantStanding(storeOf(), { account, by: ' ', reason: 'r' }, NOW)).rejects.toThrow(/required/);
    await expect(grantStanding(storeOf(), { account, by: 'm', reason: '' }, NOW)).rejects.toThrow(/required/);
    expect(await rowsOf(account)).toEqual([]);
  });
});

interface Fake {
  io: Io;
  calls: string[][];
  printed: string[];
}

/** An `Io` whose wrangler answers like `d1 execute --json`: `rows` for every statement, one row changed. */
const fake = (rows: unknown[]): Fake => {
  const calls: string[][] = [];
  const printed: string[] = [];
  const files: ObjectFiles = { temp: () => Promise.resolve('x'), read: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }) }), write: () => Promise.resolve(), remove: () => Promise.resolve() };
  return {
    calls,
    printed,
    io: {
      print: (text) => printed.push(text),
      now: () => NOW,
      files,
      wrangler: (args) => {
        calls.push([...args]);
        return Promise.resolve(JSON.stringify([{ results: rows, success: true, meta: { changes: 1 } }]));
      },
    },
  };
};

describe('the grant-standing command', () => {
  const full = ['--account', 'acct_1', '--by', 'owner', '--reason', 'the fleet'];

  it('says what it would do without --confirm, and writes nothing', async () => {
    const { io, calls, printed } = fake([{ found: 1 }]);
    expect(await main(full, io)).toBe(0);
    expect(printed.join('\n')).toMatch(/Would grant standing .* acct_1 in the remote pool .*run again with --confirm/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[6]).toMatch(/^SELECT/);
  });

  it('writes the grant with --confirm, against local state with --local', async () => {
    const { io, calls, printed } = fake([{ found: 1 }]);
    expect(await main([...full, '--confirm', '--local'], io)).toBe(0);
    expect(printed).toEqual([JSON.stringify({ account: 'acct_1', result: 'granted' })]);
    expect(calls.at(-1)?.slice(0, 5)).toEqual(['d1', 'execute', 'oars-pool', '--local', '--json']);
    expect(calls.at(-1)?.[6]).toContain('INSERT OR IGNORE INTO board_standing');
  });

  it('refuses an account it cannot find, dry run or not, with exit 1', async () => {
    for (const extra of [[], ['--confirm']]) {
      const { io, printed } = fake([]);
      expect(await main([...full, ...extra], io)).toBe(1);
      expect(printed.join('\n')).toMatch(/No account acct_1/);
    }
  });

  it('prints the usage on a missing option, an unknown one, or an option without a value, with exit 2', async () => {
    for (const argv of [[], ['--account', 'a'], ['--wat'], ['--account'], ['--account', '--by']]) {
      const { io, printed, calls } = fake([]);
      expect(await main(argv, io), argv.join(' ')).toBe(2);
      expect(printed.join('\n')).toContain('Usage: grant-standing');
      expect(calls).toEqual([]);
    }
    expect(USAGE).toContain('--confirm');
  });

  it('prints the message of a wrangler failure', async () => {
    const { io, printed } = fake([]);
    io.wrangler = () => Promise.reject(new Error('not logged in'));
    expect(await main([...full, '--confirm'], io)).toBe(1);
    expect(printed).toEqual(['not logged in']);
  });
});
