// Invite codes and the account read (t1229; supply move M2): a founding or standing account makes at most three open codes, a code works once, a self-invite is refused, a machine key gets 403, and `GET /v1/me` states the crew number, the founding mark, and the vouches given.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fieldOf, startPool, stubUser, textOf, type TestDb, type TestPool } from './test-pool.js';

let pool: TestPool;
let db: TestDb;
let seen = 9100;

beforeAll(async () => {
  pool = await startPool();
  db = await pool.db();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const member = async (fresh = false): Promise<{ token: string; account: string }> => {
  seen += 1;
  return pool.signIn('github', stubUser(String(seen)), { fresh });
};

const make = (token: string): ReturnType<TestPool['post']> => pool.post('/v1/invites', {}, token);

describe('POST /v1/invites', () => {
  it('refuses a caller with no token', async () => {
    expect((await pool.post('/v1/invites', {})).status).toBe(401);
  });

  it('refuses an account that is neither founding nor standing', async () => {
    const fresh = await member(true);
    const answered = await make(fresh.token);
    expect(answered.status).toBe(403);
    expect(fieldOf(answered.json, 'error')).toBe('not_vouching');
  });

  it('lets a standing account make three open codes and refuses a fourth', async () => {
    const inviter = await member();
    const codes: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const answered = await make(inviter.token);
      expect(answered.status).toBe(201);
      codes.push(textOf(answered.json, 'code'));
    }
    expect(new Set(codes).size).toBe(3);
    const fourth = await make(inviter.token);
    expect(fourth.status).toBe(409);
    expect(fieldOf(fourth.json, 'error')).toBe('invite_limit');
    // The pool keeps the hash only.
    const stored = (await db.prepare('SELECT code_hash FROM invites WHERE inviter = ?').bind(inviter.account).all()).results.map((row) => String(fieldOf(row, 'code_hash')));
    expect(stored.sort()).toEqual(codes.map((code) => createHash('sha256').update(`invite-code:${code}`).digest('hex')).sort());
  });

  it('lets a founding account that has not stood make codes', async () => {
    const founder = await member(true);
    await db.prepare('UPDATE accounts SET crew_number = 7 WHERE id = ?').bind(founder.account).run();
    expect((await make(founder.token)).status).toBe(201);
  });

  it('gives a used code back its slot only by being used: a used code no longer counts as open', async () => {
    const inviter = await member();
    const first = await make(inviter.token);
    await make(inviter.token);
    await make(inviter.token);
    const invitee = await member(true);
    expect((await pool.post('/v1/invites/redeem', { code: textOf(first.json, 'code') }, invitee.token)).status).toBe(200);
    expect((await make(inviter.token)).status).toBe(201);
  });

  it('refuses a machine key with 403', async () => {
    const inviter = await member();
    const enrolled = await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'invite probe' }, inviter.token);
    const key = textOf(enrolled.json, 'token');
    await pool.post('/v1/machines/activate', {}, key);
    expect((await make(key)).status).toBe(403);
    expect((await pool.post('/v1/invites/redeem', { code: 'ABCDEFGH' }, key)).status).toBe(403);
    expect((await pool.get('/v1/me', key)).status).toBe(403);
  });
});

describe('POST /v1/invites/redeem', () => {
  it('works once: the second use is refused and the vouch edge is written once', async () => {
    const inviter = await member();
    const code = textOf((await make(inviter.token)).json, 'code');
    const one = await member(true);
    const two = await member(true);
    const used = await pool.post('/v1/invites/redeem', { code }, one.token);
    expect(used.status).toBe(200);
    const again = await pool.post('/v1/invites/redeem', { code }, two.token);
    expect(again.status).toBe(409);
    expect(fieldOf(again.json, 'error')).toBe('invite_used');
    const edges = (await db.prepare('SELECT invitee FROM vouch_edges WHERE inviter = ?').bind(inviter.account).all()).results;
    expect(edges).toEqual([{ invitee: one.account }]);
  });

  it('refuses a self-invite and leaves the code open', async () => {
    const inviter = await member();
    const code = textOf((await make(inviter.token)).json, 'code');
    const answered = await pool.post('/v1/invites/redeem', { code }, inviter.token);
    expect(answered.status).toBe(422);
    expect(fieldOf(answered.json, 'error')).toBe('self_invite');
    expect((await pool.post('/v1/invites/redeem', { code }, (await member(true)).token)).status).toBe(200);
  });

  it('refuses a code nobody holds as not found, and brakes repeated guesses', async () => {
    const guesser = await member(true);
    const first = await pool.post('/v1/invites/redeem', { code: 'NOSUCHCODE' }, guesser.token);
    expect(first.status).toBe(404);
    let last = first;
    for (let n = 0; n < 12 && last.status === 404; n += 1) last = await pool.post('/v1/invites/redeem', { code: `GUESS${String(n)}` }, guesser.token);
    expect(last.status).toBe(429);
  });

  it('refuses an account that was already vouched for', async () => {
    const inviter = await member();
    const one = textOf((await make(inviter.token)).json, 'code');
    const two = textOf((await make(inviter.token)).json, 'code');
    const invitee = await member(true);
    expect((await pool.post('/v1/invites/redeem', { code: one }, invitee.token)).status).toBe(200);
    const again = await pool.post('/v1/invites/redeem', { code: two }, invitee.token);
    expect(again.status).toBe(409);
    expect(fieldOf(again.json, 'error')).toBe('already_vouched');
    // The second code stays open.
    expect((await pool.post('/v1/invites/redeem', { code: two }, (await member(true)).token)).status).toBe(200);
  });

  it('refuses a body with no code', async () => {
    expect((await pool.post('/v1/invites/redeem', {}, (await member(true)).token)).status).toBe(422);
  });
});

describe('GET /v1/me', () => {
  it('states the crew number, the founding mark, and the vouches given', async () => {
    const founder = await member(true);
    await db.prepare('UPDATE accounts SET crew_number = 12 WHERE id = ?').bind(founder.account).run();
    const code = textOf((await make(founder.token)).json, 'code');
    await make(founder.token);
    await pool.post('/v1/invites/redeem', { code }, (await member(true)).token);
    const me = await pool.get('/v1/me', founder.token);
    expect(me.status).toBe(200);
    expect(me.json).toEqual({ account: founder.account, crewNumber: 12, founding: true, vouchesGiven: 1, invitesOpen: 1, invitesLeft: 2 });
  });

  it('answers an account with no crew number as not founding', async () => {
    const plain = await member(true);
    expect((await pool.get('/v1/me', plain.token)).json).toEqual({ account: plain.account, crewNumber: null, founding: false, vouchesGiven: 0, invitesOpen: 0, invitesLeft: 3 });
  });

  it('answers 401 with no token', async () => {
    expect((await pool.get('/v1/me')).status).toBe(401);
  });
});
