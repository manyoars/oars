// The panel (section 20 rule 1, step 2): accounts that deposited in the last four weeks, as one total. Operator-fleet and seed accounts are inputs and are not counted as depositors.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyBundle, VOCAB_VERSION, type Books } from '../../cli/src/sessions/pool-wire.js';
import { startPool, stubUser, type TestPool } from './test-pool.js';

const PATH = `/bundle/claude-code/2.1.314/${VOCAB_VERSION}`;
const DAY_MS = 24 * 60 * 60 * 1000;

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const deposit = async (account: string, id: string, daysAgo: number | null, over: { source?: string; tier?: string } = {}): Promise<void> => {
  const db = await pool.db();
  await db.prepare('INSERT OR IGNORE INTO accounts (id, source) VALUES (?, ?)').bind(account, over.source ?? 'user').run();
  await db.prepare('INSERT INTO deposits (account, id, skeleton, tier, counted_at) VALUES (?, ?, ?, ?, ?)').bind(account, id, '{}', over.tier ?? 'committed', daysAgo === null ? null : Date.now() - daysAgo * DAY_MS).run();
};

const booksOf = async (reader: string): Promise<Books> => {
  const { token } = await pool.signIn('github', stubUser(reader));
  const answer = await pool.raw(PATH, token);
  const verified = await verifyBundle(answer.json, pool.pinned(), 'claude-code', '2.1.314');
  if (!verified.ok || verified.bundle.books === undefined) throw new Error('no books');
  return verified.bundle.books;
};

describe('the panel', () => {
  it('counts an account at 27 days, not one at 29, not a seed account, and each account once', async () => {
    await deposit('in-window', 'a', 27);
    await deposit('in-window', 'b', 1);
    await deposit('stale', 'a', 29);
    await deposit('seeded', 'a', 1, { source: 'seed' });
    await deposit('fleet', 'a', 1, { source: 'operator-fleet' });
    await deposit('no-count', 'a', 1, { tier: 'none' });
    await deposit('uncounted', 'a', null);
    expect((await booksOf('9001')).panel).toEqual({ state: 'value', value: 1 });
  }, 60_000);

  it('reads the ledger once a day: a deposit after the first read of the day waits for the next day, and the fetch reads one cached row', async () => {
    await deposit('late', 'a', 0);
    expect((await booksOf('9002')).panel).toEqual({ state: 'value', value: 1 });
    const db = await pool.db();
    await db.prepare('UPDATE panel SET day = ?').bind('2000-01-01').run();
    expect((await booksOf('9003')).panel).toEqual({ state: 'value', value: 2 });
  }, 60_000);

  it('states the day the count was taken', async () => {
    expect((await booksOf('9004')).panelDay).toBe(new Date().toISOString().slice(0, 10));
  }, 60_000);
});
