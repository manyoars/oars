// The whole path a person walks: the real CLI commands over a real socket to the handler and its D1 store under workerd. Only the sign-in provider is stubbed, and every session is an invented fixture.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../cli/src/cli.js';
import { ExitCode } from '../../cli/src/errors.js';
import { verifySlice } from '../../cli/src/sessions/pool-wire.js';
import { deposit } from '../../cli/src/sessions/store.js';
import { cleanup, NOW, stage, type Staged } from '../../cli/src/sessions/test-support.js';
import { harness, type Harness } from '../../cli/src/test-support.js';
import { fieldOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

// An invented term: a session holding it would never leave, and a missing file would exclude everything.
const TERM = 'zorblax';

interface Person {
  h: Harness;
  staged: Staged;
  cli: (...args: string[]) => Promise<ExitCode>;
  last: () => unknown;
}

const person = async (pool: TestPool, id: string): Promise<Person> => {
  const staged = stage();
  const terms = join(staged.root, 'terms.txt');
  writeFileSync(terms, `${TERM}\n`);
  const h = harness({ OARS_EXCLUSION_TERMS: terms, OARS_POOL_URL: await pool.url() });
  h.deps.sessions = staged.runtime;
  // The person approves the code the command just printed, at the provider, while it waits.
  h.deps.sleep = () => {
    const issued = /USER-(\d+)/.exec(h.err.join(''))?.[1];
    if (issued !== undefined) pool.stub.approve(`device-${issued}`, stubUser(id));
    return Promise.resolve();
  };
  await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
  return {
    h,
    staged,
    cli: (...args) => run(['--json', 'pool', ...args], h.deps),
    last: () => {
      const parsed: unknown = JSON.parse(h.out.at(-1) ?? 'null');
      return parsed;
    },
  };
};

afterEach(cleanup);

describe('login, deposit, and pull against a local server', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool();
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('three accounts: a covenant to accept, and a read only at the third, verified and kept', async () => {
    const people = await Promise.all(['4001', '4002', '4003'].map((id) => person(pool, id)));
    const readsAfter: unknown[] = [];
    for (const one of people) {
      expect(await one.cli('login', '--provider', 'github')).toBe(ExitCode.OK);
      expect(one.last()).toMatchObject({ ok: true, server: await pool.url() });

      // V10 at the server's word: nothing goes up before the covenant is accepted.
      expect(await one.cli('deposit')).toBe(ExitCode.AUTH);
      expect(JSON.stringify(one.last())).toContain('covenant_not_accepted');
      expect(await one.cli('deposit', '--accept-covenant', 'v1')).toBe(ExitCode.OK);
      // The four invented sessions in the fixture folder.
      expect(one.last()).toMatchObject({ ok: true, sessions: 4, deposited: 4, uncaptured: 0, refused: 0, tooLarge: 0, excluded: { term: 0, noRaw: 0, noTerms: 0, unreadable: 0 } });

      expect(await one.cli('pull', '--stack', 'all')).toBe(ExitCode.OK);
      readsAfter.push(fieldOf(one.last(), 'reads'));
    }
    expect(readsAfter.slice(0, 2)).toEqual([0, 0]);
    expect(readsAfter[2]).toBeGreaterThan(0);

    const [third] = people.slice(-1);
    if (third === undefined) throw new Error('no third person');
    const kept: unknown = JSON.parse(readFileSync(textOf(third.last(), 'file'), 'utf8'));
    const verified = await verifySlice(kept, pool.signingKey(), 'all');
    if (!verified.ok) throw new Error(verified.reason);
    for (const read of verified.slice.reads) expect(read.clusters).toBe(3);

    const db = await pool.db();
    expect(await db.prepare('SELECT COUNT(DISTINCT account) AS count FROM deposits').first('count')).toBe(3);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBe(12);
  }, 60_000);

  it('refuses a pull with no sign-in, and sends nothing for a deposit with none', async () => {
    const one = await person(pool, '4004');
    expect(await one.cli('pull', '--stack', 'all')).toBe(ExitCode.AUTH);
    expect(await one.cli('deposit')).toBe(ExitCode.AUTH);
    expect(existsSync(join(one.staged.storeDir, 'pool-replica'))).toBe(false);
  }, 60_000);
});

describe('a pool with no covenant published', () => {
  it('takes no deposit from the CLI, whatever it offers to accept, and still serves a pull', async () => {
    const closed = await startPool({ COVENANT_VERSION: '' });
    try {
      const one = await person(closed, '4101');
      expect(await one.cli('login', '--provider', 'google')).toBe(ExitCode.OK);
      expect(await one.cli('deposit', '--accept-covenant', 'v1')).toBe(ExitCode.AUTH);
      expect(JSON.stringify(one.last())).toContain('deposits_closed');
      expect(await (await closed.db()).prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBe(0);
      expect(await one.cli('pull', '--stack', 'all')).toBe(ExitCode.OK);
    } finally {
      await closed.dispose();
    }
  }, 60_000);
});
