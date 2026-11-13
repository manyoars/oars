// `oars club` and `oars board` (t1091): the real CLI over a real socket to the pool under workerd, like full-run.test.ts. Only the sign-in provider is stubbed. Every run uses a temp store and OARS_POOL_URL set to the local pool.
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../cli/src/cli.js';
import { ExitCode } from '../../cli/src/errors.js';
import { cleanup, stage, type Staged } from '../../cli/src/sessions/test-support.js';
import { harness, type Harness } from '../../cli/src/test-support.js';
import { isoWeekOf } from './week.js';
import { fieldOf, startPool, stubUser, textOf, type TestDb, type TestPool } from './test-pool.js';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const WEEK = 7 * 24 * 60 * 60 * 1000;

interface Person {
  h: Harness;
  staged: Staged;
  /** Runs `oars --json <args>`. */
  cli: (...args: string[]) => Promise<ExitCode>;
  /** Runs `oars <args>` and answers what a person reads on stdout. */
  words: (...args: string[]) => Promise<{ code: ExitCode; text: string }>;
  last: () => unknown;
  /** Puts the person at a terminal and types these lines. */
  types: (...lines: string[]) => void;
}

let pool: TestPool;
let db: TestDb;
let seen = 9100;

const person = async (signedIn = true): Promise<Person> => {
  seen += 1;
  const id = String(seen);
  const staged = stage();
  const h = harness({ OARS_POOL_URL: await pool.url() });
  h.deps.sessions = staged.runtime;
  h.deps.sleep = async () => {
    const issued = /USER-(\d+)/.exec(h.err.join(''))?.[1];
    if (issued !== undefined) pool.stub.approve(`device-${issued}`, stubUser(id));
    await db.prepare('UPDATE login_polls SET next_at = 0').run();
  };
  const cli = (...args: string[]): Promise<ExitCode> => run(['--json', ...args], h.deps);
  const last = (): unknown => {
    const parsed: unknown = JSON.parse(h.out.at(-1) ?? 'null');
    return parsed;
  };
  if (signedIn) {
    expect(await cli('pool', 'login', '--provider', 'github')).toBe(ExitCode.OK);
    h.err.length = 0;
  }
  return {
    h,
    staged,
    cli,
    last,
    words: async (...args) => {
      h.out.length = 0;
      const code = await run(args, h.deps);
      return { code, text: h.out.join('') };
    },
    types: (...lines) => {
      Object.assign(staged.stdin, { isTTY: true });
      Object.assign(staged.runtime, { stderr: { isTTY: true } });
      staged.stdin.write(`${lines.join('\n')}\n`);
    },
  };
};

beforeAll(async () => {
  pool = await startPool();
  db = await pool.db();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

afterEach(cleanup);

/** A club the person created, with the code it printed. */
const created = async (owner: Person, nickname = 'skipper', name = 'Friday crew'): Promise<{ id: string; code: string }> => {
  owner.types('yes');
  expect(await owner.cli('club', 'create', name, '--nickname', nickname)).toBe(ExitCode.OK);
  return { id: textOf(owner.last(), 'id'), code: textOf(owner.last(), 'code') };
};

const problemOf = (value: unknown): { code: string; title: string } => ({ code: textOf(fieldOf(value, 'problem'), 'code'), title: textOf(fieldOf(value, 'problem'), 'title') });

describe('oars club create', () => {
  it('shows the consent text, records the hash it showed, and prints the code once with a line on sharing it', async () => {
    const owner = await person();
    owner.types('yes');
    const { code, text } = await owner.words('club', 'create', 'Friday crew', '--nickname', 'skipper');
    expect(code).toBe(ExitCode.OK);
    const shown = textOf(fieldOf((await pool.get('/v1/clubs/consent')).json, 'club'), 'text');
    expect(owner.h.err.join('')).toContain(shown);
    const printedCode = /\b([A-HJ-NP-Z2-9]{6})\b/.exec(text)?.[1] ?? '';
    expect(printedCode).not.toBe('');
    expect(text).toMatch(/shown once|only time/i);
    expect(text).toMatch(/share/i);
    const hash = String(fieldOf(await db.prepare('SELECT text_sha256 FROM club_consents ORDER BY id DESC LIMIT 1').first(), 'text_sha256'));
    expect(hash).toBe(sha256(shown));
  });

  it('with --json gives the id, name, nickname, and code', async () => {
    const owner = await person();
    owner.types('yes');
    expect(await owner.cli('club', 'create', 'Friday crew', '--nickname', 'skipper')).toBe(ExitCode.OK);
    expect(owner.last()).toMatchObject({ ok: true, name: 'Friday crew', nickname: 'skipper' });
    expect(String(fieldOf(owner.last(), 'code'))).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it('creates nothing when the person does not type yes, or is not at a terminal', async () => {
    const owner = await person();
    const before = await db.prepare('SELECT COUNT(*) AS n FROM clubs').first('n');
    owner.types('no');
    expect(await owner.cli('club', 'create', 'Friday crew', '--nickname', 'skipper')).toBe(ExitCode.AUTH);
    expect(problemOf(owner.last()).code).toBe('consent_not_given');
    const piped = await person();
    piped.staged.stdin.write('yes\n');
    expect(await piped.cli('club', 'create', 'Friday crew', '--nickname', 'skipper')).toBe(ExitCode.AUTH);
    expect(problemOf(piped.last()).code).toBe('consent_not_given');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM clubs').first('n')).toBe(before);
  });

  it('says not_signed_in first, before it shows any consent text', async () => {
    const stranger = await person(false);
    stranger.types('yes');
    expect(await stranger.cli('club', 'create', 'Friday crew', '--nickname', 'skipper')).toBe(ExitCode.AUTH);
    expect(problemOf(stranger.last()).code).toBe('not_signed_in');
    expect(problemOf(stranger.last()).title).toMatch(/^not_signed_in: /);
    expect(stranger.h.err.join('')).not.toContain('Members of this club');
  });
});

describe('oars club join, show, and leave', () => {
  it('joins by code, shows the board in the pool\'s order, and leaves', async () => {
    const owner = await person();
    const guest = await person();
    const club = await created(owner);
    guest.types('yes');
    expect(await guest.cli('club', 'join', club.code, '--nickname', 'bow')).toBe(ExitCode.OK);
    expect(guest.last()).toMatchObject({ ok: true, id: club.id, name: 'Friday crew', nickname: 'bow' });
    const account = String(fieldOf(await db.prepare("SELECT account FROM club_members WHERE club = ? AND nickname = 'skipper'").bind(club.id).first(), 'account'));
    for (const ago of [0, 1]) await db.prepare("INSERT INTO account_weeks (account, week, sessions, tool_steps, failed_steps, day_mask, harnesses) VALUES (?, ?, 2, 10, 0, 3, '[\"claude-code\"]')").bind(account, isoWeekOf(Date.now() - ago * WEEK)).run();
    expect(await guest.cli('club', 'show', club.id)).toBe(ExitCode.OK);
    expect(guest.last()).toMatchObject({ ok: true, name: 'Friday crew', members: [{ place: 1, nickname: 'skipper', weeksRowing: 2, activeDays: 4, sessions: 4, strokesThisWeek: 10 }, { place: 2, nickname: 'bow', ashore: true }] });
    const shown = await guest.words('club', 'show', club.id);
    expect(shown.text).toMatch(/skipper\D+2\D+4\D+4\D+10/);
    expect(shown.text).toMatch(/bow\D+ashore/);
    expect(shown.text.indexOf('skipper')).toBeLessThan(shown.text.indexOf('bow'));
    expect(await guest.cli('club', 'leave', club.id)).toBe(ExitCode.OK);
    expect(guest.last()).toMatchObject({ ok: true, id: club.id, left: true });
    expect(await guest.cli('club', 'show', club.id)).toBe(ExitCode.INVALID);
    expect(problemOf(guest.last()).code).toBe('not_found');
  });

  it('names the cause first when the nickname is taken, the club is full, or the code is wrong', async () => {
    const owner = await person();
    const guest = await person();
    const club = await created(owner);
    guest.types('yes');
    expect(await guest.cli('club', 'join', club.code, '--nickname', 'SKIPPER')).toBe(ExitCode.CONFLICT);
    expect(problemOf(guest.last())).toMatchObject({ code: 'nickname_taken' });
    expect(problemOf(guest.last()).title).toMatch(/^nickname_taken: /);
    guest.types('yes');
    expect(await guest.cli('club', 'join', 'ZZZZZZ', '--nickname', 'bow')).toBe(ExitCode.INVALID);
    expect(problemOf(guest.last()).code).toBe('not_found');
    for (let n = 0; n < 49; n += 1) {
      await db.prepare('INSERT INTO accounts (id) VALUES (?)').bind(`filler-${String(n)}-${String(seen)}`).run();
      await db.prepare('INSERT INTO club_members (club, account, nickname, joined_at) VALUES (?, ?, ?, ?)').bind(club.id, `filler-${String(n)}-${String(seen)}`, `f${String(n)}`, Date.now()).run();
    }
    guest.types('yes');
    expect(await guest.cli('club', 'join', club.code, '--nickname', 'bow')).toBe(ExitCode.CONFLICT);
    expect(problemOf(guest.last())).toMatchObject({ code: 'club_full' });
    expect(problemOf(guest.last()).title).toMatch(/^club_full: /);
  });

  it('says rate_limited first, with when to try again, once the account has used its wrong codes', async () => {
    const guesser = await person();
    const club = await created(guesser);
    const account = String(fieldOf(await db.prepare("SELECT account FROM club_members WHERE club = ? AND nickname = 'skipper'").bind(club.id).first(), 'account'));
    for (let n = 0; n < 10; n += 1) await db.prepare("INSERT INTO club_attempts (account, kind, at) VALUES (?, 'guess', ?)").bind(account, Date.now() - n).run();
    guesser.types('yes');
    expect(await guesser.cli('club', 'join', 'ZZZZZZ', '--nickname', 'bow')).toBe(ExitCode.RATE_LIMITED);
    expect(problemOf(guesser.last()).code).toBe('rate_limited');
    expect(problemOf(guesser.last()).title).toMatch(/^rate_limited: .* Try again in \d+ minutes\.$/);
  });

  it('says nickname_invalid first, with the rule', async () => {
    const guest = await person();
    guest.types('yes');
    expect(await guest.cli('club', 'join', 'ZZZZZZ', '--nickname', 'bow@example')).toBe(ExitCode.INVALID);
    expect(problemOf(guest.last()).code).toBe('nickname_invalid');
    expect(problemOf(guest.last()).title).toMatch(/^nickname_invalid: /);
  });

  it('says not_signed_in, and to sign in again, when the pool no longer knows the token', async () => {
    const owner = await person();
    const club = await created(owner);
    const account = String(fieldOf(await db.prepare("SELECT account FROM club_members WHERE club = ? AND nickname = 'skipper'").bind(club.id).first(), 'account'));
    await db.prepare('DELETE FROM tokens WHERE account = ?').bind(account).run();
    expect(await owner.cli('club', 'show', club.id)).toBe(ExitCode.AUTH);
    expect(problemOf(owner.last()).code).toBe('not_signed_in');
    expect(problemOf(owner.last()).title).toMatch(/^not_signed_in: .*Run oars pool login first\.$/);
  });

  it('refuses a join without typed consent and seats nobody', async () => {
    const owner = await person();
    const guest = await person();
    const club = await created(owner);
    guest.types('maybe');
    expect(await guest.cli('club', 'join', club.code, '--nickname', 'bow')).toBe(ExitCode.AUTH);
    expect(problemOf(guest.last()).code).toBe('consent_not_given');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM club_members WHERE club = ?').bind(club.id).first('n')).toBe(1);
  });

  it('says not_signed_in for show and leave too', async () => {
    const stranger = await person(false);
    for (const verb of ['show', 'leave']) {
      expect(await stranger.cli('club', verb, 'any-club')).toBe(ExitCode.AUTH);
      expect(problemOf(stranger.last()).code).toBe('not_signed_in');
    }
  });
});

describe('the open board', () => {
  it('joins with the word open under the open board\'s own text, and oars board needs no sign-in', async () => {
    const rower = await person();
    const reader = await person(false);
    rower.types('yes');
    expect(await rower.cli('club', 'join', 'open', '--nickname', 'Oarsman')).toBe(ExitCode.OK);
    const shown = textOf(fieldOf((await pool.get('/v1/clubs/consent')).json, 'open'), 'text');
    expect(rower.h.err.join('')).toContain(shown);
    const hash = String(fieldOf(await db.prepare('SELECT text_sha256 FROM club_consents ORDER BY id DESC LIMIT 1').first(), 'text_sha256'));
    expect(hash).toBe(sha256(shown));
    const account = String(fieldOf(await db.prepare("SELECT account FROM club_members WHERE club = 'open' AND nickname = 'Oarsman'").first(), 'account'));
    await db.prepare("UPDATE accounts SET access = 'standing' WHERE id = ?").bind(account).run();
    await db.prepare("INSERT INTO account_weeks (account, week, sessions, tool_steps, failed_steps, day_mask, harnesses) VALUES (?, ?, 1, 5, 0, 1, '[\"claude-code\"]')").bind(account, isoWeekOf(Date.now())).run();
    expect(await reader.cli('board')).toBe(ExitCode.OK);
    expect(reader.last()).toMatchObject({ ok: true, board: 'open' });
    const members = fieldOf(reader.last(), 'members');
    expect(Array.isArray(members) ? members : []).toContainEqual(expect.objectContaining({ nickname: 'Oarsman', weeksRowing: 1 }));
    const text = await reader.words('board');
    expect(text.text).toContain('Oarsman');
  });

  it('prints the crew number beside a founding nickname, a column only while a row carries one, and no count', async () => {
    await db.prepare("DELETE FROM club_members WHERE club = 'open'").run();
    const rower = await person();
    rower.types('yes');
    expect(await rower.cli('club', 'join', 'open', '--nickname', 'Founder')).toBe(ExitCode.OK);
    const account = String(fieldOf(await db.prepare("SELECT account FROM club_members WHERE club = 'open' AND nickname = 'Founder'").first(), 'account'));
    await db.prepare("UPDATE accounts SET access = 'standing', crew_number = 4 WHERE id = ?").bind(account).run();
    const reader = await person(false);
    const text = await reader.words('board');
    expect(text.text).toContain('crew');
    expect(text.text).toMatch(/Founder\s+founding crew #4/);
    expect(text.text).not.toMatch(/\bof 100\b|\bseats\b|\bleft\b/);
    await db.prepare('UPDATE accounts SET crew_number = NULL WHERE id = ?').bind(account).run();
    expect((await reader.words('board')).text).not.toContain('crew');
  });

  it('prints an empty open board as a plain sentence', async () => {
    await db.prepare("DELETE FROM club_members WHERE club = 'open'").run();
    const reader = await person(false);
    const text = await reader.words('board');
    expect(text.code).toBe(ExitCode.OK);
    expect(text.text).toMatch(/no one/i);
  });
});
