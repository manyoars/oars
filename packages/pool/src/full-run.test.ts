// The whole path a person walks: the real CLI commands over a real socket to the handler and its D1 store under workerd. Only the sign-in provider is stubbed, and every session is an invented fixture.
// The CLI signs in through the pool's start and poll routes only; the Worker runs the provider's device flow against the stub.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../cli/src/cli.js';
import { ExitCode } from '../../cli/src/errors.js';
import { networkSender, poolDeposit } from '../../cli/src/sessions/pool-command.js';
import { verifyBundle } from '../../cli/src/sessions/pool-wire.js';
import { deposit } from '../../cli/src/sessions/store.js';
import { cleanup, NOW, settledClock, stage, type Staged } from '../../cli/src/sessions/test-support.js';
import { harness, type Harness } from '../../cli/src/test-support.js';
import { fieldOf, startPool, stubUser, textOf, type TestPool } from './test-pool.js';

// An invented term: a session holding it would never leave, and a missing file would exclude everything.
const TERM = 'zorblax';

interface Person {
  h: Harness;
  staged: Staged;
  cli: (...args: string[]) => Promise<ExitCode>;
  last: () => unknown;
  /** The command line sends no batch yet. This builds the outbox, prints it, and sends one batch through the sender the lock is tested with, so the lock, the covenant, and the request run against the real server. */
  send: (index: number, acceptCovenant?: string) => Promise<unknown>;
}

const person = async (pool: TestPool, id: string): Promise<Person> => {
  const server = await pool.url();
  const staged = stage();
  const terms = join(staged.root, 'terms.txt');
  writeFileSync(terms, `${TERM}\n`);
  const h = harness({ OARS_EXCLUSION_TERMS: terms, OARS_POOL_URL: await pool.url() });
  h.deps.sessions = staged.runtime;
  h.deps.now = settledClock;
  // The person approves the code the command just printed, at the provider, while it waits to poll the pool. The wait is stubbed, so the interval the pool holds per handle is made to pass here, as the real wait would let it.
  h.deps.sleep = async () => {
    const issued = /USER-(\d+)/.exec(h.err.join(''))?.[1];
    if (issued !== undefined) pool.stub.approve(`device-${issued}`, stubUser(id));
    await (await pool.db()).prepare('UPDATE login_polls SET next_at = 0').run();
  };
  await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
  const cli = (...args: string[]): Promise<ExitCode> => run(['--json', 'pool', ...args], h.deps);
  const last = (): unknown => {
    const parsed: unknown = JSON.parse(h.out.at(-1) ?? 'null');
    return parsed;
  };
  return {
    h,
    staged,
    cli,
    last,
    send: async (index, acceptCovenant) => {
      expect(await cli('outbox')).toBe(ExitCode.OK);
      const batches: unknown = fieldOf(last(), 'batches');
      if (!Array.isArray(batches)) throw new Error('outbox listed no batches');
      const entry: unknown = batches[index];
      return poolDeposit(h.deps, { server, send: textOf(entry, 'hash'), via: networkSender(h.deps, 'deposit'), ...(acceptCovenant === undefined ? {} : { acceptCovenant }) });
    },
  };
};

afterEach(cleanup);

describe('login, deposit, and fetch against a local server', () => {
  let pool: TestPool;

  beforeAll(async () => {
    pool = await startPool();
  }, 60_000);

  afterAll(async () => {
    await pool.dispose();
  });

  it('five accounts: a covenant to accept, and a read only at the fifth, verified and kept', async () => {
    const people = await Promise.all(['4001', '4002', '4003', '4004', '4005'].map((id) => person(pool, id)));
    const readsAfter: unknown[] = [];
    for (const one of people) {
      expect(await one.cli('login', '--provider', 'github')).toBe(ExitCode.OK);
      expect(one.last()).toMatchObject({ ok: true, server: await pool.url() });
      // The floor counts accounts that have stood (S13): this one has, as a person who has deposited for 90 days has.
      await (await pool.db()).prepare("UPDATE accounts SET access = 'standing'").run();

      // The four invented sessions in the fixture folder are built into the outbox, and `deposit` itself sends nothing.
      expect(await one.cli('deposit')).toBe(ExitCode.OK);
      expect(one.last()).toMatchObject({ ok: true, sessions: 4, batched: 4, uncaptured: 0, refused: 0, excluded: { term: 0, noRaw: 0, noTerms: 0, unreadable: 0 } });
      // At the server's word: nothing goes up before the covenant is accepted.
      await expect(one.send(0)).rejects.toMatchObject({ exitCode: ExitCode.AUTH, problem: { code: 'covenant_not_accepted' } });
      expect(await one.send(0, 'v1')).toMatchObject({ document: { ok: true, sent: true } });
      for (const index of [1, 2, 3]) expect(await one.send(index)).toMatchObject({ document: { ok: true, sent: true } });

      expect(await one.cli('fetch', '--harness-version', '2.1.314')).toBe(ExitCode.OK);
      readsAfter.push(fieldOf(one.last(), 'reads'));
    }
    expect(readsAfter.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(readsAfter[4]).toBeGreaterThan(0);

    const [fifth] = people.slice(-1);
    if (fifth === undefined) throw new Error('no fifth person');
    const kept: unknown = JSON.parse(readFileSync(textOf(fifth.last(), 'file'), 'utf8'));
    const verified = await verifyBundle(kept, pool.pinned(), 'claude-code', '2.1.314');
    if (!verified.ok) throw new Error(verified.reason);
    for (const read of verified.bundle.reads) expect(read.clusters).toBe(5);

    const db = await pool.db();
    expect(await db.prepare('SELECT COUNT(DISTINCT account) AS count FROM deposits').first('count')).toBe(5);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBe(20);
  }, 60_000);

  it('refuses a fetch with no sign-in, and sends nothing for a deposit with none', async () => {
    const one = await person(pool, '4009');
    expect(await one.cli('fetch', '--harness-version', '2.1.314')).toBe(ExitCode.AUTH);
    expect(await one.cli('deposit')).toBe(ExitCode.AUTH);
    expect(existsSync(join(one.staged.storeDir, 'pool-replica'))).toBe(false);
  }, 60_000);
});

describe('a pool with no covenant published', () => {
  it('takes no deposit from the CLI, whatever it offers to accept, and still serves a fetch', async () => {
    const closed = await startPool({ COVENANT_VERSION: '' });
    try {
      const one = await person(closed, '4101');
      expect(await one.cli('login', '--provider', 'google')).toBe(ExitCode.OK);
      expect(await one.cli('deposit')).toBe(ExitCode.OK);
      await expect(one.send(0, 'v1')).rejects.toMatchObject({ exitCode: ExitCode.AUTH, problem: { code: 'deposits_closed' } });
      expect(await (await closed.db()).prepare('SELECT COUNT(*) AS count FROM deposits').first('count')).toBe(0);
      expect(await one.cli('fetch', '--harness-version', '2.1.314')).toBe(ExitCode.OK);
    } finally {
      await closed.dispose();
    }
  }, 60_000);
});
