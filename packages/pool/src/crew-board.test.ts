// The founding crew on the boards (t1229): a member's crew number shows beside the nickname on the open board and in a club, only for a member whose consent names it, and no route states a count of members.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldOf, startPool, stubUser, textOf, type TestDb, type TestPool } from './test-pool.js';

let pool: TestPool;
let db: TestDb;
let seen = 9500;

beforeAll(async () => {
  pool = await startPool();
  db = await pool.db();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const consents = async (): Promise<{ club: string; open: string; clubText: string; openText: string }> => {
  const answered = await pool.get('/v1/clubs/consent');
  const [club, open] = [fieldOf(answered.json, 'club'), fieldOf(answered.json, 'open')];
  return { club: textOf(club, 'sha256'), open: textOf(open, 'sha256'), clubText: textOf(club, 'text'), openText: textOf(open, 'text') };
};

const member = async (): Promise<{ token: string; account: string }> => {
  seen += 1;
  return pool.signIn('github', stubUser(String(seen)));
};

const seat = async (nickname: string, crew: number | null): Promise<{ token: string; account: string }> => {
  const who = await member();
  if (crew !== null) await db.prepare('UPDATE accounts SET crew_number = ? WHERE id = ?').bind(crew, who.account).run();
  expect((await pool.post('/v1/clubs/join', { code: 'OPEN', nickname, consent: (await consents()).open }, who.token)).status).toBe(200);
  return who;
};

describe('crew number on the boards', () => {
  it('names the crew number on the open board beside the nickname, and nothing about how many members hold one', async () => {
    await seat('founder-one', 3);
    await seat('plain-one', null);
    const board = await pool.get('/v1/board');
    expect(board.status).toBe(200);
    expect(JSON.stringify(board.json)).not.toMatch(/total|count|seats|members_?count/i);
    const rows = fieldOf(board.json, 'members') as Array<{ nickname: string; crewNumber?: number }>;
    expect(rows.find((row) => row.nickname === 'founder-one')).toMatchObject({ crewNumber: 3 });
    expect(rows.find((row) => row.nickname === 'plain-one')).not.toHaveProperty('crewNumber');
    expect(Object.keys(board.json as object).sort()).toEqual(['board', 'members']);
  });

  it('shows it in a club board to its members', async () => {
    const owner = await member();
    await db.prepare('UPDATE accounts SET crew_number = 9 WHERE id = ?').bind(owner.account).run();
    const made = await pool.post('/v1/clubs', { name: 'Crew club', nickname: 'cox', consent: (await consents()).club }, owner.token);
    const board = await pool.get(`/v1/clubs/${textOf(made.json, 'id')}`, owner.token);
    expect(fieldOf(board.json, 'members')).toEqual([expect.objectContaining({ nickname: 'cox', crewNumber: 9 })]);
  });

  it('hides it for a member whose consent was given to a text that did not name it', async () => {
    // A member seated before this feature: the consent on record is a hash of other text.
    const early = await member();
    await db.prepare('UPDATE accounts SET crew_number = 5 WHERE id = ?').bind(early.account).run();
    await db.prepare("INSERT INTO club_members (club, account, nickname, joined_at) VALUES ('open', ?, 'early-bird', 1)").bind(early.account).run();
    await db.prepare("INSERT INTO club_consents (account, club, text_sha256, accepted_at) VALUES (?, 'open', ?, 1)").bind(early.account, createHash('sha256').update('older text').digest('hex')).run();
    const rows = fieldOf((await pool.get('/v1/board')).json, 'members') as Array<{ nickname: string; crewNumber?: number }>;
    expect(rows.find((row) => row.nickname === 'early-bird')).not.toHaveProperty('crewNumber');
  });

  it('says in both consent texts that a crew number shows beside the nickname', async () => {
    const texts = await consents();
    expect(texts.clubText).toContain('founding crew number');
    expect(texts.openText).toContain('founding crew number');
  });
});
