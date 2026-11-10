// Boards, the pool side (t1083; P100 (19) to (21)): private clubs joined by a code, one open board, ranked by weeks rowing then active days. A club shows its members at once; the open board lists an account only after 90 days of standing or a hand grant.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAccount, type EraseStore } from '../scripts/erase.js';
import { telemetryOf } from '../scripts/erase-test-telemetry.js';
import { createClub as createClubRoute, joinClub } from './clubs.js';
import type { Bound, Env, PoolDb } from './http.js';
import { isoWeekOf } from './week.js';
import { acceptanceOf, fieldOf, poolDbOf, startPool, stubUser, textOf, type TestDb, type TestPool } from './test-pool.js';

let pool: TestPool;
let db: TestDb;
let seen = 8400;

beforeAll(async () => {
  pool = await startPool();
  db = await pool.db();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The consent hashes the pool says a person is shown, read the way the CLI will. */
const consents = async (): Promise<{ club: string; open: string }> => {
  const answered = await pool.get('/v1/clubs/consent');
  return { club: textOf(fieldOf(answered.json, 'club'), 'sha256'), open: textOf(fieldOf(answered.json, 'open'), 'sha256') };
};

/** A signed-in account. `fresh` leaves its access unlatched (the pool's test sign-in grants `standing` otherwise), which the open board's standing rule needs. */
const member = async (fresh = false): Promise<{ token: string; account: string }> => {
  seen += 1;
  return pool.signIn('github', stubUser(String(seen)), { fresh });
};

const createClub = async (token: string, nickname = 'skipper', name = 'Friday crew'): Promise<{ id: string; code: string }> => {
  const answered = await pool.post('/v1/clubs', { name, nickname, consent: (await consents()).club }, token);
  expect(answered.status).toBe(201);
  return { id: textOf(answered.json, 'id'), code: textOf(answered.json, 'code') };
};

const join = async (token: string, code: string, nickname: string): Promise<{ status: number; json: unknown }> => pool.post('/v1/clubs/join', { code, nickname, consent: (await consents()).club }, token);

const leave = (token: string, id: string): ReturnType<TestPool['send']> => pool.send(`/v1/clubs/${id}/me`, { method: 'DELETE' }, token);

/** Weekly counts as ingest would have written them: `weeksAgo` lists the weeks (0 is this one) with a counting deposit. */
const weeks = async (account: string, weeksAgo: readonly number[], options: { mask?: number; sessions?: number; steps?: number } = {}): Promise<void> => {
  for (const ago of weeksAgo) {
    await db
      .prepare("INSERT INTO account_weeks (account, week, sessions, tool_steps, failed_steps, day_mask, harnesses) VALUES (?, ?, ?, ?, 0, ?, '[\"claude-code\"]')")
      .bind(account, isoWeekOf(Date.now() - ago * WEEK), options.sessions ?? 2, options.steps ?? 10, options.mask ?? 1)
      .run();
  }
};

/** A counting deposit row `ageDays` old, which is what the open board's standing rule reads. */
const countedAgo = async (account: string, ageDays: number): Promise<void> => {
  await db
    .prepare("INSERT INTO deposits (account, id, skeleton, tier, counted_at, extensions, deltas) VALUES (?, ?, '{}', 'skeleton', ?, '[]', '[]')")
    .bind(account, `aged-${account.slice(-6)}`, Date.now() - ageDays * DAY)
    .run();
};

const rowsOf = (json: unknown): unknown[] => {
  const members = fieldOf(json, 'members');
  return Array.isArray(members) ? members : [];
};

const namesOf = (json: unknown): string[] => rowsOf(json).map((row) => textOf(row, 'nickname'));

describe('creating and joining a club', () => {
  it('creates a club, returns its code once, stores only a hash, and seats the creator', async () => {
    const owner = await member();
    const club = await createClub(owner.token);
    expect(club.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    const stored = await db.prepare('SELECT code_hash FROM clubs WHERE id = ?').bind(club.id).first('code_hash');
    expect(stored).toBe(sha256(`club-code:${club.code}`));
    expect(JSON.stringify((await db.prepare('SELECT * FROM clubs').all()).results)).not.toContain(club.code);
    const board = await pool.get(`/v1/clubs/${club.id}`, owner.token);
    expect(board.status).toBe(200);
    expect(namesOf(board.json)).toEqual(['skipper']);
  });

  it('records the consent text hash and time of each join, append-only', async () => {
    const owner = await member();
    const guest = await member();
    const club = await createClub(owner.token);
    const before = Date.now();
    expect((await join(guest.token, club.code, 'bow')).status).toBe(200);
    const row = await db.prepare('SELECT text_sha256, accepted_at, club FROM club_consents WHERE account = ?').bind(guest.account).first();
    expect(row).toMatchObject({ text_sha256: (await consents()).club, club: club.id });
    expect(Number(fieldOf(row, 'accepted_at'))).toBeGreaterThanOrEqual(before);
    expect(JSON.stringify(row)).not.toContain('bow');
    await expect(db.prepare('DELETE FROM club_consents').run()).rejects.toThrow(/never deleted/);
    await expect(db.prepare('UPDATE club_consents SET accepted_at = 1').run()).rejects.toThrow(/never changed/);
  });

  it('refuses a join without the consent hash, with an unknown code, with a bad nickname, with a taken nickname, and a second time', async () => {
    const owner = await member();
    const guest = await member();
    const club = await createClub(owner.token);
    expect((await pool.post('/v1/clubs/join', { code: club.code, nickname: 'bow' }, guest.token)).status).toBe(422);
    expect((await pool.post('/v1/clubs/join', { code: club.code, nickname: 'bow', consent: sha256('something else') }, guest.token)).json).toMatchObject({ error: 'consent_required' });
    expect(await join(guest.token, 'ZZZZZZ', 'bow')).toMatchObject({ status: 404, json: { error: 'not_found' } });
    expect((await join(guest.token, club.code, '  ')).status).toBe(422);
    expect((await join(guest.token, club.code, '<script>')).status).toBe(422);
    expect(await join(guest.token, club.code, 'SKIPPER')).toMatchObject({ status: 409, json: { error: 'nickname_taken' } });
    expect((await join(guest.token, club.code, 'bow')).status).toBe(200);
    expect(await join(guest.token, club.code, 'stroke')).toMatchObject({ status: 409, json: { error: 'already_member' } });
  });

  it('refuses the 51st member and still takes the 50th', async () => {
    const owner = await member();
    const club = await createClub(owner.token, 'm00');
    for (let n = 1; n < 50; n += 1) {
      const guest = await member();
      expect((await join(guest.token, club.code, `m${String(n).padStart(2, '0')}`)).status, String(n)).toBe(200);
    }
    const late = await member();
    expect(await join(late.token, club.code, 'late')).toMatchObject({ status: 409, json: { error: 'club_full' } });
    expect(await db.prepare('SELECT COUNT(*) AS held FROM club_members WHERE club = ?').bind(club.id).first('held')).toBe(50);
  }, 120_000);

  it('needs a sign-in on every club route', async () => {
    expect((await pool.post('/v1/clubs', {})).status).toBe(401);
    expect((await pool.post('/v1/clubs/join', {})).status).toBe(401);
    expect((await pool.get('/v1/clubs/abc')).status).toBe(401);
    expect((await pool.send('/v1/clubs/abc/me', { method: 'DELETE' })).status).toBe(401);
  });

  it('refuses a machine key on every club route, as it does the other account routes', async () => {
    const owner = await member();
    await pool.post('/v1/covenant/accept', acceptanceOf('v1'), owner.token);
    const key = textOf((await pool.post('/v1/machines/enroll', { hostClass: 'vps', launcher: 'scheduled', label: 'box' }, owner.token)).json, 'token');
    const club = await createClub(owner.token, 'own');
    const refused = [
      await pool.post('/v1/clubs', { name: 'x', nickname: 'x', consent: (await consents()).club }, key),
      await pool.post('/v1/clubs/join', { code: club.code, nickname: 'y', consent: (await consents()).club }, key),
      await pool.get(`/v1/clubs/${club.id}`, key),
      await pool.send(`/v1/clubs/${club.id}/me`, { method: 'DELETE' }, key),
      await pool.get('/v1/board', key),
    ];
    for (const answered of refused) expect(answered).toMatchObject({ status: 403, json: { error: 'deposit_only' } });
    expect(namesOf((await pool.get(`/v1/clubs/${club.id}`, owner.token)).json)).toEqual(['own']);
  });
});

describe('GET /v1/clubs/:id', () => {
  it('answers a non-member 404, the same as a club that does not exist', async () => {
    const owner = await member();
    const stranger = await member();
    const club = await createClub(owner.token);
    const hidden = await pool.get(`/v1/clubs/${club.id}`, stranger.token);
    const missing = await pool.get('/v1/clubs/00000000-0000-4000-8000-000000000000', stranger.token);
    expect(hidden).toMatchObject({ status: 404, json: { error: 'not_found' } });
    expect(hidden.json).toEqual(missing.json);
  });

  it('shows a member with no counting deposit as ashore, with no numbers', async () => {
    const owner = await member();
    const guest = await member();
    const club = await createClub(owner.token, 'ashore-one');
    await join(guest.token, club.code, 'rowing-one');
    await weeks(guest.account, [0, 1]);
    const rows = rowsOf((await pool.get(`/v1/clubs/${club.id}`, owner.token)).json);
    expect(rows).toEqual([
      { place: 1, nickname: 'rowing-one', ashore: false, weeksRowing: 2, activeDays: 2, sessions: 4, strokesThisWeek: 10 },
      { place: 2, nickname: 'ashore-one', ashore: true },
    ]);
  });

  it('removes a member who leaves from every view at once, and tells a non-member nothing', async () => {
    const owner = await member();
    const guest = await member();
    const club = await createClub(owner.token, 'one');
    await join(guest.token, club.code, 'two');
    expect(namesOf((await pool.get(`/v1/clubs/${club.id}`, owner.token)).json)).toEqual(['one', 'two']);
    expect((await leave(guest.token, club.id)).status).toBe(204);
    expect(namesOf((await pool.get(`/v1/clubs/${club.id}`, owner.token)).json)).toEqual(['one']);
    expect((await pool.get(`/v1/clubs/${club.id}`, guest.token)).status).toBe(404);
    expect((await leave(guest.token, club.id)).status).toBe(404);
    // The consent the person gave stays as the record of it; the nickname does not.
    expect(await db.prepare('SELECT COUNT(*) AS held FROM club_consents WHERE account = ?').bind(guest.account).first('held')).toBe(1);
    // And the person may come back under a new nickname.
    expect((await join(guest.token, club.code, 'three')).status).toBe(200);
  });
});

describe('ranking', () => {
  it('orders by weeks rowing, then active days, then nickname, and shows strokes and sessions without ranking on them', async () => {
    const owner = await member();
    const club = await createClub(owner.token, 'zed');
    const fixture: { nickname: string; ago: number[]; mask: number; sessions?: number }[] = [
      { nickname: 'bravo', ago: [0, 1, 2], mask: 0b11111 },
      { nickname: 'alpha', ago: [0, 1, 2], mask: 0b11111 },
      { nickname: 'charlie', ago: [0, 1, 2], mask: 0b111111 },
      { nickname: 'delta', ago: [0, 1, 2, 3], mask: 0b1 },
      // A great deal of work in one week: volume is not ranked.
      { nickname: 'echo', ago: [0], mask: 0b1111111, sessions: 5000 },
      // A streak that held through last week counts; one that ended two weeks ago has lapsed to zero.
      { nickname: 'foxtrot', ago: [1, 2], mask: 0b1 },
      { nickname: 'golf', ago: [2, 3, 4], mask: 0b1 },
    ];
    for (const entry of fixture) {
      const guest = await member();
      await join(guest.token, club.code, entry.nickname);
      await weeks(guest.account, entry.ago, { mask: entry.mask, ...(entry.sessions === undefined ? {} : { sessions: entry.sessions }) });
    }
    // A hole in the streak ends it there: two weeks, then a gap, then a long run. Same streak as foxtrot, more active days across its weeks, so it ranks above.
    const gap = await member();
    await join(gap.token, club.code, 'hotel');
    await weeks(gap.account, [0, 1, 3, 4, 5, 6], { mask: 0b1 });

    const answered = await pool.get(`/v1/clubs/${club.id}`, owner.token);
    expect(namesOf(answered.json)).toEqual(['delta', 'charlie', 'alpha', 'bravo', 'hotel', 'foxtrot', 'echo', 'golf', 'zed']);
    const echo = rowsOf(answered.json).find((row) => textOf(row, 'nickname') === 'echo');
    expect(echo).toMatchObject({ weeksRowing: 1, activeDays: 7, sessions: 5000, strokesThisWeek: 10 });
    expect(rowsOf(answered.json).find((row) => textOf(row, 'nickname') === 'golf')).toMatchObject({ weeksRowing: 0 });
    expect(rowsOf(answered.json).map((row) => fieldOf(row, 'place'))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('returns no token, cost, or duration field anywhere on a board', async () => {
    const owner = await member();
    const club = await createClub(owner.token, 'solo');
    await weeks(owner.account, [0]);
    const text = JSON.stringify((await pool.get(`/v1/clubs/${club.id}`, owner.token)).json);
    expect(text).not.toMatch(/token|cost|usd|duration|price/i);
    expect(text).not.toContain(owner.account);
    for (const row of rowsOf(JSON.parse(text))) expect(Object.keys(typeof row === 'object' && row !== null ? row : {}).sort()).toEqual(['activeDays', 'ashore', 'nickname', 'place', 'sessions', 'strokesThisWeek', 'weeksRowing']);
  });
});

// The open board: the reserved `OPEN` join, `GET /v1/board`, and the standing rule (90 days past the first counting deposit, a latched flag, or a hand grant).
describe('the open board', () => {
  const joinOpen = async (token: string, nickname: string): Promise<{ status: number; json: unknown }> => pool.post('/v1/clubs/join', { code: 'OPEN', nickname, consent: (await consents()).open }, token);

  it('lists an 89-day account never, a 90-day account and a granted account always, and drops either when it leaves', async () => {
    const young = await member(true);
    const old = await member(true);
    const granted = await member(true);
    const nobody = await member(true);
    await countedAgo(young.account, 89);
    await countedAgo(old.account, 90);
    await weeks(young.account, [0]);
    await weeks(old.account, [0, 1]);
    await weeks(granted.account, [0]);
    await db.prepare('INSERT INTO board_standing (account, granted_at, granted_by, reason) VALUES (?, ?, ?, ?)').bind(granted.account, Date.now(), 'operator', 'the fleet').run();
    for (const [who, nickname] of [[young, 'young-oar'], [old, 'old-oar'], [granted, 'fleet-oar'], [nobody, 'never-deposited']] as const) expect((await joinOpen(who.token, nickname)).status, nickname).toBe(200);

    const listed = await pool.get('/v1/board');
    expect(listed.status).toBe(200);
    expect(namesOf(listed.json)).toEqual(['old-oar', 'fleet-oar']);
    expect(JSON.stringify(listed.json)).not.toMatch(/young-oar|never-deposited/);

    expect((await leave(old.token, 'open')).status).toBe(204);
    expect((await leave(granted.token, 'open')).status).toBe(204);
    expect(namesOf((await pool.get('/v1/board')).json)).toEqual([]);
  });

  it('is public, is not a club anyone can read through the members route, and takes its own consent text', async () => {
    const who = await member(true);
    expect((await pool.post('/v1/clubs/join', { code: 'OPEN', nickname: 'wrong-text', consent: (await consents()).club }, who.token)).json).toMatchObject({ error: 'consent_required' });
    expect((await joinOpen(who.token, 'right-text')).status).toBe(200);
    expect((await pool.get('/v1/clubs/open', who.token)).status).toBe(404);
    expect((await pool.get('/v1/board')).json).toMatchObject({ board: 'open' });
  });

  it('keeps listing an account whose standing flag was latched, even when its deposits later stopped counting', async () => {
    const latched = await member();
    await weeks(latched.account, [0]);
    expect((await joinOpen(latched.token, 'latched-oar')).status).toBe(200);
    expect(namesOf((await pool.get('/v1/board')).json)).toContain('latched-oar');
  });

  it('drops a closed account from the open board and from its clubs, and keeps its rows', async () => {
    const owner = await member();
    const closing = await member(true);
    const club = await createClub(owner.token, 'club-owner');
    await join(closing.token, club.code, 'closing-oar');
    expect((await joinOpen(closing.token, 'closing-open')).status).toBe(200);
    await weeks(closing.account, [0]);
    await countedAgo(closing.account, 100);
    expect(namesOf((await pool.get('/v1/board')).json)).toContain('closing-open');
    expect(namesOf((await pool.get(`/v1/clubs/${club.id}`, owner.token)).json)).toContain('closing-oar');

    const bucket = await pool.rawBucket();
    const store: EraseStore = {
      telemetry: telemetryOf(await pool.bucket()),
      rows: async (sql, binds) => (await db.prepare(sql).bind(...binds).all()).results,
      run: async (sql, binds) => Number(fieldOf(fieldOf(await db.prepare(sql).bind(...binds).run(), 'meta'), 'changes')),
      deleteObject: (key) => bucket.delete([key]),
      readObject: () => Promise.resolve(null),
    };
    await closeAccount(store, closing.account, new Date());

    expect(namesOf((await pool.get('/v1/board')).json)).not.toContain('closing-open');
    expect(namesOf((await pool.get(`/v1/clubs/${club.id}`, owner.token)).json)).toEqual(['club-owner']);
    expect(await db.prepare('SELECT COUNT(*) AS held FROM club_members WHERE account = ?').bind(closing.account).first('held')).toBe(2);
  });

  it('has no code of its own to guess', async () => {
    expect(await db.prepare("SELECT code_hash FROM clubs WHERE id = 'open'").first('code_hash')).toBeNull();
  });
});

describe('GET /v1/clubs/consent', () => {
  it('states both texts and their hashes, to anyone', async () => {
    const answered = await pool.get('/v1/clubs/consent');
    expect(answered.status).toBe(200);
    for (const kind of ['club', 'open']) {
      const entry = fieldOf(answered.json, kind);
      expect(sha256(textOf(entry, 'text'))).toBe(textOf(entry, 'sha256'));
    }
    expect(textOf(fieldOf(answered.json, 'open'), 'text')).toMatch(/public/i);
    // The rule is 90 days past the first counting deposit, not the account's age, and the text a person agrees to says so.
    expect(textOf(fieldOf(answered.json, 'open'), 'text')).toContain('90 days of standing (90 days after its first counting deposit)');
    expect(textOf(fieldOf(answered.json, 'club'), 'text')).toMatch(/nickname/i);
  });
});

/** A pool database for a route called directly, in which the reads that look for an existing row see nothing until the write has run: the other request's insert had not happened when they ran, and has when the write does. */
const blind = (hidden: RegExp): PoolDb => {
  const base = poolDbOf(db);
  const real = new WeakMap<Bound, ReturnType<TestDb['prepare']>>();
  let written = false;
  return {
    prepare: (sql) => ({
      bind: (...values): Bound => {
        const bound = base.prepare(sql).bind(...values);
        const seen: Bound = hidden.test(sql) && !written ? { ...bound, first: () => Promise.resolve(null) } : bound;
        real.set(seen, db.prepare(sql).bind(...values));
        return seen;
      },
    }),
    batch: async (statements) => {
      written = true;
      const done: unknown = await db.batch(statements.flatMap((statement) => real.get(statement) ?? []));
      return (Array.isArray(done) ? done : []).map((one) => ({ meta: { changes: Number(fieldOf(fieldOf(one, 'meta'), 'changes')) } }));
    },
  };
};

const envOf = (hidden: RegExp): Env => ({ DB: blind(hidden) });

const requestOf = async (path: string, token: string, body: object): Promise<Request> =>
  new Request(`https://pool.test${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, consent: (await consents()).club }) });

const answered = async (response: Response): Promise<{ status: number; json: unknown }> => ({ status: response.status, json: await response.json() });

describe('joins that race past the checks', () => {
  const checks = /^SELECT 1 AS held FROM club_members/;

  it('answers already_member when the same account was seated between the check and the write', async () => {
    const owner = await member();
    const guest = await member();
    const club = await createClub(owner.token);
    expect((await join(guest.token, club.code, 'first')).status).toBe(200);
    const raced = await joinClub(await requestOf('/v1/clubs/join', guest.token, { code: club.code, nickname: 'second' }), envOf(checks));
    expect(await answered(raced)).toMatchObject({ status: 409, json: { error: 'already_member' } });
  });

  it('answers nickname_taken when another account took the nickname between the check and the write', async () => {
    const owner = await member();
    const guest = await member();
    const club = await createClub(owner.token, 'taken');
    const raced = await joinClub(await requestOf('/v1/clubs/join', guest.token, { code: club.code, nickname: 'TAKEN' }), envOf(checks));
    expect(await answered(raced)).toMatchObject({ status: 409, json: { error: 'nickname_taken' } });
  });

  it('answers club_full only when the club holds the cap, and seats the account while it has room', async () => {
    const owner = await member();
    const club = await createClub(owner.token, 'm00');
    const guest = await member();
    expect((await answered(await joinClub(await requestOf('/v1/clubs/join', guest.token, { code: club.code, nickname: 'room' }), envOf(checks)))).status).toBe(200);
    for (let n = 1; n < 49; n += 1) await db.prepare('INSERT INTO club_members (club, account, nickname, joined_at) VALUES (?, ?, ?, ?)').bind(club.id, (await member()).account, `f${String(n)}`, Date.now()).run();
    const late = await member();
    const raced = await joinClub(await requestOf('/v1/clubs/join', late.token, { code: club.code, nickname: 'late' }), envOf(checks));
    expect(await answered(raced)).toMatchObject({ status: 409, json: { error: 'club_full' } });
  });
});

describe('creating a club is one write', () => {
  it('leaves no club behind when seating its creator fails', async () => {
    const owner = await member();
    const before = await db.prepare('SELECT COUNT(*) AS held FROM clubs').first('held');
    await db.prepare("CREATE TRIGGER doomed_seat BEFORE INSERT ON club_members WHEN NEW.nickname = 'doomed-bow' BEGIN SELECT RAISE(ABORT, 'doomed'); END").run();
    try {
      await expect(createClubRoute(await requestOf('/v1/clubs', owner.token, { name: 'Doomed', nickname: 'doomed-bow' }), envOf(/^$/))).rejects.toThrow();
    } finally {
      await db.prepare('DROP TRIGGER doomed_seat').run();
    }
    expect(await db.prepare('SELECT COUNT(*) AS held FROM clubs').first('held')).toBe(before);
  });
});
