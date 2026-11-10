// The weekly counts a board is made of (t1083): ingest writes `account_weeks` in the transaction that writes a deposit's cells, from the deposits that count, and from nothing else.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoWeekOf } from './week.js';
import { sampleSkeleton } from './sample.js';
import { acceptanceOf, startPool, stubUser, type TestDb, type TestPool } from './test-pool.js';

let pool: TestPool;
let db: TestDb;

beforeAll(async () => {
  pool = await startPool();
  db = await pool.db();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const accountOn = async (id: string): Promise<{ token: string; account: string }> => {
  const signedIn = await pool.signIn('github', stubUser(id));
  await pool.post('/v1/covenant/accept', acceptanceOf('v1'), signedIn.token);
  return signedIn;
};

const weeksOf = async (account: string): Promise<unknown[]> => [...(await db.prepare('SELECT week, sessions, tool_steps, failed_steps, day_mask, harnesses FROM account_weeks WHERE account = ? ORDER BY week').bind(account).all()).results];

const thisWeek = (): string => isoWeekOf(Date.now());
const todayBit = (): number => 1 << ((new Date().getUTCDay() + 6) % 7);

/** The sample session with its first step marked as an error. */
const withFailedStep = (id: string): ReturnType<typeof sampleSkeleton> => {
  const base = sampleSkeleton(id);
  return { ...base, transcripts: base.transcripts.map((transcript) => ({ ...transcript, tools: transcript.tools.map((tool, at) => (at === 0 ? { ...tool, steps: tool.steps.map((step) => ({ ...step, status: 'error' as const })) } : tool)) })) };
};

describe('account_weeks', () => {
  it('sums two deposits of one week, and counts a session sent again once', async () => {
    const { token, account } = await accountOn('8301');
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000830101'), token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', withFailedStep('0000000000830102'), token)).status).toBe(201);
    expect(await weeksOf(account)).toEqual([{ week: thisWeek(), sessions: 2, tool_steps: 4, failed_steps: 1, day_mask: todayBit(), harnesses: '["claude-code"]' }]);
    // The second session sent again, now without the failure: the session stays one, the failed step is taken back.
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000830102'), token)).status).toBe(201);
    expect(await weeksOf(account)).toEqual([{ week: thisWeek(), sessions: 2, tool_steps: 4, failed_steps: 0, day_mask: todayBit(), harnesses: '["claude-code"]' }]);
  });

  it('unions the harnesses of a week', async () => {
    const { token, account } = await accountOn('8302');
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000830201'), token)).status).toBe(201);
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000830202', { languages: ['typescript'] }, '2026-11-01', 'cursor'), token)).status).toBe(201);
    expect(await weeksOf(account)).toEqual([expect.objectContaining({ sessions: 2, harnesses: '["claude-code","cursor"]' })]);
  });

  it('keeps a session in the week it first counted in when it is sent again', async () => {
    const { token, account } = await accountOn('8304');
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000830401'), token)).status).toBe(201);
    // The session counted a week ago: its row and its date move back, as if the deposit had come then.
    const lastWeek = Date.now() - 7 * 24 * 60 * 60 * 1000;
    await db.prepare('UPDATE deposits SET counted_at = ? WHERE account = ?').bind(lastWeek, account).run();
    await db.prepare('UPDATE account_weeks SET week = ? WHERE account = ?').bind(isoWeekOf(lastWeek), account).run();
    expect((await pool.post('/v1/deposits', withFailedStep('0000000000830401'), token)).status).toBe(201);
    expect(await weeksOf(account)).toEqual([expect.objectContaining({ week: isoWeekOf(lastWeek), sessions: 1, failed_steps: 1 })]);
  });

  it('writes nothing for a deposit that does not count', async () => {
    const { token, account } = await accountOn('8303');
    const empty = sampleSkeleton('0000000000830301');
    const bare = { ...empty, transcripts: empty.transcripts.map((transcript) => ({ ...transcript, tools: [] })) };
    expect((await pool.post('/v1/deposits', bare, token)).status).toBe(201);
    expect(await weeksOf(account)).toEqual([]);
  });
});
