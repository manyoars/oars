// The operator's hide of a nickname: it removes that member's row, records who and why, refuses what it cannot find, and does not bar the account from joining again. The command line runs against a fake wrangler.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldOf, startPool, stubUser, type TestDb, type TestPool } from '../src/test-pool.js';
import type { EraseStore } from './erase.js';
import type { ObjectFiles } from './erase-wrangler.js';
import { hideNickname, main, USAGE, type Io } from './hide-nickname.js';

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

const clubConsent = async (): Promise<string> => String(fieldOf(fieldOf((await pool.get('/v1/clubs/consent')).json, 'club'), 'sha256'));

/** A club with its creator (nickname `owner`) and one guest under `nickname`. */
const seated = async (n: number, nickname: string): Promise<{ club: string; code: string; guest: { account: string; token: string } }> => {
  const owner = await pool.signIn('github', stubUser(String(9200 + n)));
  const guest = await pool.signIn('github', stubUser(String(9300 + n)));
  const consent = await clubConsent();
  const made = await pool.post('/v1/clubs', { name: `Hide ${String(n)}`, nickname: 'owner', consent }, owner.token);
  const club = String(fieldOf(made.json, 'id'));
  const code = String(fieldOf(made.json, 'code'));
  expect((await pool.post('/v1/clubs/join', { code, nickname, consent }, guest.token)).status).toBe(200);
  return { club, code, guest: { account: guest.account, token: guest.token } };
};

const membersOf = async (club: string): Promise<readonly unknown[]> => (await db.prepare('SELECT nickname FROM club_members WHERE club = ? ORDER BY nickname').bind(club).all()).results.map((row) => fieldOf(row, 'nickname'));

describe('hideNickname', () => {
  it('removes the member row, records who, when, and why, and leaves the others', async () => {
    const { club, guest } = await seated(1, 'Rude Name');
    expect(await hideNickname(storeOf(), { club, nickname: 'rude name', by: ' matt ', reason: ' abuse report ' }, NOW)).toBe('hidden');
    expect(await membersOf(club)).toEqual(['owner']);
    const record = (await db.prepare('SELECT club, account, nickname, hidden_at, hidden_by, reason FROM club_hides WHERE club = ?').bind(club).all()).results;
    expect(record).toEqual([{ club, account: guest.account, nickname: 'Rude Name', hidden_at: NOW.getTime(), hidden_by: 'matt', reason: 'abuse report' }]);
  });

  it('answers absent for a nickname nobody holds, and records nothing', async () => {
    const { club } = await seated(2, 'Fine Name');
    expect(await hideNickname(storeOf(), { club, nickname: 'nobody', by: 'matt', reason: 'x' }, NOW)).toBe('absent');
    expect(await membersOf(club)).toEqual(['Fine Name', 'owner']);
    expect((await db.prepare('SELECT 1 AS n FROM club_hides WHERE club = ?').bind(club).all()).results).toEqual([]);
  });

  it('does not bar the account from joining the same club again', async () => {
    const { club, code, guest } = await seated(3, 'Rude Name');
    await hideNickname(storeOf(), { club, nickname: 'Rude Name', by: 'matt', reason: 'abuse' }, NOW);
    expect((await pool.post('/v1/clubs/join', { code, nickname: 'Kind Name', consent: await clubConsent() }, guest.token)).status).toBe(200);
  });

  it('records one hide when the delete failed and the command is run again, and a rejoin hidden later records another', async () => {
    const { club, code, guest } = await seated(4, 'Rude Name');
    const later = new Date();
    const failing: Pick<EraseStore, 'rows' | 'run'> = { rows: storeOf().rows, run: async (sql, binds) => (sql.startsWith('DELETE') ? Promise.reject(new Error('wrangler failed')) : storeOf().run(sql, binds)) };
    await expect(hideNickname(failing, { club, nickname: 'Rude Name', by: 'matt', reason: 'abuse' }, later)).rejects.toThrow('wrangler failed');
    expect(await membersOf(club)).toEqual(['Rude Name', 'owner']);
    expect(await hideNickname(storeOf(), { club, nickname: 'Rude Name', by: 'matt', reason: 'abuse' }, later)).toBe('hidden');
    expect(await membersOf(club)).toEqual(['owner']);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM club_hides WHERE club = ?').bind(club).first('n')).toBe(1);
    // Time passes: the first hide is now older than the seating the member is about to take again.
    await db.prepare('UPDATE club_hides SET hidden_at = hidden_at - 10000 WHERE club = ?').bind(club).run();
    expect((await pool.post('/v1/clubs/join', { code, nickname: 'Rude Name', consent: await clubConsent() }, guest.token)).status).toBe(200);
    expect(await hideNickname(storeOf(), { club, nickname: 'Rude Name', by: 'matt', reason: 'again' }, new Date())).toBe('hidden');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM club_hides WHERE club = ?').bind(club).first('n')).toBe(2);
  });

  it('refuses a malformed club id, a missing nickname, and a missing who or why, changing nothing', async () => {
    const { club } = await seated(4, 'Keep Me');
    await expect(hideNickname(storeOf(), { club: "x'; DROP", nickname: 'Keep Me', by: 'm', reason: 'r' }, NOW)).rejects.toThrow(/not a club id/);
    await expect(hideNickname(storeOf(), { club, nickname: ' ', by: 'm', reason: 'r' }, NOW)).rejects.toThrow(/nickname/);
    await expect(hideNickname(storeOf(), { club, nickname: 'Keep Me', by: ' ', reason: 'r' }, NOW)).rejects.toThrow(/required/);
    await expect(hideNickname(storeOf(), { club, nickname: 'Keep Me', by: 'm', reason: '' }, NOW)).rejects.toThrow(/required/);
    expect(await membersOf(club)).toEqual(['Keep Me', 'owner']);
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

describe('the hide-nickname command', () => {
  const full = ['--club', 'club_1', '--nickname', 'Rude Name', '--by', 'matt', '--reason', 'abuse'];

  it('says what it would do without --confirm, and writes nothing', async () => {
    const { io, calls, printed } = fake([{ account: 'acct_1', nickname: 'Rude Name' }]);
    expect(await main(full, io)).toBe(0);
    expect(printed.join('\n')).toMatch(/Would hide "Rude Name" in club club_1 in the remote pool .*run again with --confirm/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[6]).toMatch(/^SELECT/);
  });

  it('hides with --confirm, against local state with --local', async () => {
    const { io, calls, printed } = fake([{ account: 'acct_1', nickname: 'Rude Name' }]);
    expect(await main([...full, '--confirm', '--local'], io)).toBe(0);
    expect(printed).toEqual([JSON.stringify({ club: 'club_1', nickname: 'Rude Name', result: 'hidden' })]);
    expect(calls.at(-1)?.slice(0, 5)).toEqual(['d1', 'execute', 'oars-pool', '--local', '--json']);
    const sql = calls.map((call) => call[6]).join('\n');
    expect(sql).toContain('INSERT INTO club_hides');
    expect(sql).toContain('DELETE FROM club_members');
  });

  it('exits 1 when nobody holds the nickname, dry run or not', async () => {
    for (const extra of [[], ['--confirm']]) {
      const { io, printed } = fake([]);
      expect(await main([...full, ...extra], io)).toBe(1);
      expect(printed.join('\n')).toMatch(/No member "Rude Name" in club club_1/);
    }
  });

  it('prints the usage on a missing option, an unknown one, or an option without a value, with exit 2', async () => {
    for (const argv of [[], ['--club', 'a'], ['--wat'], ['--club'], ['--club', '--by']]) {
      const { io, printed, calls } = fake([]);
      expect(await main(argv, io), argv.join(' ')).toBe(2);
      expect(printed.join('\n')).toContain('Usage: hide-nickname');
      expect(calls).toEqual([]);
    }
    expect(USAGE).toContain('--confirm');
  });

  it('prints the message of a failure', async () => {
    const boom = fake([]);
    boom.io.wrangler = () => Promise.reject(new Error('boom'));
    expect(await main(full, boom.io)).toBe(1);
    expect(boom.printed.join('\n')).toBe('boom');
  });
});
