// `oars pool join` (t1228): the real CLI over a real socket to the pool under workerd, from an empty store to a counting deposit. Only the sign-in provider is stubbed, the terminal is a fake that types the covenant phrase, and every session is an invented fixture.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../cli/src/cli.js';
import { ExitCode } from '../../cli/src/errors.js';
import { deposit } from '../../cli/src/sessions/store.js';
import { cleanup, NOW, settledClock, stage } from '../../cli/src/sessions/test-support.js';
import { harness } from '../../cli/src/test-support.js';
import { TEST_PHRASE } from './test-covenant-texts.js';
import { fieldOf, startPool, stubUser, textOf, type TestDb, type TestPool } from './test-pool.js';

// An invented term: a session holding it would never leave, and a missing file would exclude everything.
const TERM = 'zorblax';

let pool: TestPool;
let db: TestDb;

beforeAll(async () => {
  pool = await startPool();
  db = await pool.db();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

afterEach(cleanup);

describe('oars pool join against the local pool', () => {
  it('takes an empty store to a counting deposit: the typed phrase is the only acceptance, and the fetch cap is lifted', async () => {
    const staged = stage();
    const terms = join(staged.root, 'terms.txt');
    const h = harness({ OARS_EXCLUSION_TERMS: terms, OARS_POOL_URL: await pool.url() });
    h.deps.sessions = staged.runtime;
    h.deps.now = settledClock;
    // The term file does not exist before the run: the terms step makes it, and the person saves a term when it says "Press Enter".
    const write = h.deps.io.stderr;
    h.deps.io.stderr = (text) => {
      write(text);
      if (text.includes('Press Enter')) writeFileSync(terms, `${TERM}
`);
    };
    h.deps.sleep = async () => {
      const issued = /USER-(\d+)/.exec(h.err.join(''))?.[1];
      if (issued !== undefined) pool.stub.approve(`device-${issued}`, stubUser('7001'));
      await db.prepare('UPDATE login_polls SET next_at = 0').run();
    };
    // The store holds sessions (invented) and nothing else: no sign-in, no outbox, no answer to the region question.
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    // The fake terminal types the region answer, Enter for the term file, then the phrase the covenant screen states. Nothing else can accept.
    Object.assign(staged.stdin, { isTTY: true });
    Object.assign(staged.runtime, { stderr: { isTTY: true } });
    expect(existsSync(terms)).toBe(false);
    staged.stdin.write(`no\n\n${TEST_PHRASE}\n`);

    expect(await run(['--json', 'pool', 'join', '--provider', 'github', '--harness-version', '2.1.314'], h.deps)).toBe(ExitCode.OK);
    expect(h.err.join('')).toContain('Press Enter');
    expect(existsSync(terms)).toBe(true);
    const account = await db.prepare('SELECT id, access FROM accounts ORDER BY rowid DESC LIMIT 1').first();
    const id = textOf(account, 'id');
    expect(fieldOf(account, 'access')).toBe('pending');
    expect(await db.prepare('SELECT COUNT(*) AS count FROM deposits WHERE account = ? AND counted_at IS NOT NULL').bind(id).first('count')).toBeGreaterThan(0);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM covenant_acceptances WHERE account = ? AND input = 'typed' AND client LIKE 'oars/%'").bind(id).first('count')).toBe(1);

    // A second fetch in the same ISO week would be refused 429 `fetch_cap` without access: the deposit counted.
    h.out.length = 0;
    expect(await run(['--json', 'pool', 'fetch', '--harness-version', '2.1.314'], h.deps)).toBe(ExitCode.OK);
  }, 90_000);
});
