// The operator's change of an account's source: a dry run changes nothing, --confirm writes the value and prints the audit line, a value outside the three is refused, an unseen account is refused, and the command line runs against a fake wrangler.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldOf, startPool, stubUser, type TestDb, type TestPool } from '../src/test-pool.js';
import type { EraseStore } from './erase.js';
import type { ObjectFiles } from './erase-wrangler.js';
import { main, setSource, USAGE, type Io } from './set-source.js';

let pool: TestPool;
let db: TestDb;

beforeAll(async () => {
  pool = await startPool();
  db = await pool.db();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const NOW = new Date('2026-11-16T12:00:00Z');

const storeOf = (): Pick<EraseStore, 'rows' | 'run'> => ({
  rows: async (sql, binds) => (await db.prepare(sql).bind(...binds).all()).results,
  run: async (sql, binds) => Number(fieldOf(fieldOf(await db.prepare(sql).bind(...binds).run(), 'meta'), 'changes')),
});

const accountId = async (n: number): Promise<string> => (await pool.signIn('github', stubUser(String(n)))).account;

const sourceOf = async (account: string): Promise<unknown> => (await db.prepare('SELECT source FROM accounts WHERE id = ?').bind(account).all()).results[0];

describe('setSource', () => {
  it('moves a user account to operator-fleet and back, answering the value before and after', async () => {
    const account = await accountId(9201);
    expect(await sourceOf(account)).toEqual({ source: 'user' });
    expect(await setSource(storeOf(), { account, source: 'operator-fleet', by: ' owner ', reason: ' the fleet ' })).toEqual({ account, before: 'user', after: 'operator-fleet' });
    expect(await sourceOf(account)).toEqual({ source: 'operator-fleet' });
    expect(await setSource(storeOf(), { account, source: 'user', by: 'owner', reason: 'undo' })).toEqual({ account, before: 'operator-fleet', after: 'user' });
    expect(await sourceOf(account)).toEqual({ source: 'user' });
  });

  it('accepts seed, and a value already held changes nothing', async () => {
    const account = await accountId(9202);
    expect((await setSource(storeOf(), { account, source: 'seed', by: 'm', reason: 'r' })).after).toBe('seed');
    expect(await setSource(storeOf(), { account, source: 'seed', by: 'm', reason: 'r' })).toEqual({ account, before: 'seed', after: 'seed' });
  });

  it('refuses a value outside user, operator-fleet, and seed, an account the pool has not seen, a malformed id, and a missing who or why', async () => {
    const account = await accountId(9203);
    await expect(setSource(storeOf(), { account, source: 'input', by: 'm', reason: 'r' })).rejects.toThrow(/user, operator-fleet, or seed/);
    expect(await sourceOf(account)).toEqual({ source: 'user' });
    await expect(setSource(storeOf(), { account: 'acct_nobody', source: 'seed', by: 'm', reason: 'r' })).rejects.toThrow(/No account acct_nobody/);
    await expect(setSource(storeOf(), { account: "x'; DROP", source: 'seed', by: 'm', reason: 'r' })).rejects.toThrow(/not a pool id/);
    await expect(setSource(storeOf(), { account, source: 'seed', by: ' ', reason: 'r' })).rejects.toThrow(/required/);
    await expect(setSource(storeOf(), { account, source: 'seed', by: 'm', reason: '' })).rejects.toThrow(/required/);
    expect(await sourceOf(account)).toEqual({ source: 'user' });
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

describe('the set-source command', () => {
  const full = ['--account', 'acct_1', '--source', 'operator-fleet', '--by', 'owner', '--reason', 'the fleet'];

  it('says the before and after value without --confirm, and writes nothing', async () => {
    const { io, calls, printed } = fake([{ source: 'user' }]);
    expect(await main(full, io)).toBe(0);
    expect(printed.join('\n')).toMatch(/Would set the source of account acct_1 in the remote pool from user to operator-fleet .*run again with --confirm/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[6]).toMatch(/^SELECT/);
  });

  it('writes with --confirm, against local state with --local, and prints one audit line', async () => {
    const { io, calls, printed } = fake([{ source: 'user' }]);
    expect(await main([...full, '--confirm', '--local'], io)).toBe(0);
    expect(printed).toEqual([JSON.stringify({ audit: 'set-source', account: 'acct_1', before: 'user', after: 'operator-fleet', by: 'owner', reason: 'the fleet', at: NOW.toISOString(), where: 'local' })]);
    expect(calls.at(-1)?.slice(0, 5)).toEqual(['d1', 'execute', 'oars-pool', '--local', '--json']);
    expect(calls.at(-1)?.[6]).toContain('UPDATE accounts SET source');
  });

  it('names the remote pool in the audit line without --local', async () => {
    const { io, printed } = fake([{ source: 'user' }]);
    expect(await main([...full, '--confirm'], io)).toBe(0);
    expect(printed.join('\n')).toContain('"where":"remote"');
  });

  it('refuses an account it cannot find, dry run or not, and a refused value, with exit 1', async () => {
    for (const extra of [[], ['--confirm']]) {
      const { io, printed } = fake([]);
      expect(await main([...full, ...extra], io)).toBe(1);
      expect(printed.join('\n')).toMatch(/No account acct_1/);
    }
    for (const extra of [[], ['--confirm']]) {
      const { io, printed, calls } = fake([{ source: 'user' }]);
      expect(await main(['--account', 'acct_1', '--source', 'input', '--by', 'o', '--reason', 'r', ...extra], io)).toBe(1);
      expect(printed.join('\n')).toMatch(/user, operator-fleet, or seed/);
      expect(calls.every((call) => /^SELECT/.test(call[6] ?? ''))).toBe(true);
    }
  });

  it('prints the usage on a missing option, an unknown one, or an option without a value, with exit 2', async () => {
    for (const argv of [[], ['--account', 'a'], ['--wat'], ['--account'], ['--account', '--by']]) {
      const { io, printed, calls } = fake([]);
      expect(await main(argv, io), argv.join(' ')).toBe(2);
      expect(printed.join('\n')).toContain('Usage: set-source');
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
