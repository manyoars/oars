// The command line and its wrangler store, against a fake wrangler: what it would run, with nothing run for real.
import { describe, expect, it } from 'vitest';
import { main, USAGE, type Io } from './erase-cli.js';
import { inline, wranglerStore } from './erase-wrangler.js';

const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const SHA = 'ab'.repeat(32);
const NOW = new Date('2026-11-08T12:00:00Z');

interface Fake {
  io: Io;
  calls: string[][];
  printed: string[];
}

/** An `Io` whose wrangler answers like `d1 execute --json` (one successful statement changing one row, `rows` as its results) and records every call. */
const fake = (options: { rows?: unknown[]; stdin?: string; success?: boolean } = {}): Fake => {
  const calls: string[][] = [];
  const printed: string[] = [];
  return {
    calls,
    printed,
    io: {
      stdin: () => Promise.resolve(options.stdin ?? ''),
      print: (text) => printed.push(text),
      now: () => NOW,
      wrangler: (args) => {
        calls.push([...args]);
        return Promise.resolve(args[0] === 'd1' ? JSON.stringify([{ results: options.rows ?? [], success: options.success ?? true, meta: { changes: 1 } }]) : '');
      },
    },
  };
};

describe('inline', () => {
  it('writes values into placeholders, doubling quotes and keeping a NULL', () => {
    expect(inline('UPDATE t SET a = ?, b = ?, c = ? WHERE d = ?', ["it's", 7, null, 'x'])).toBe("UPDATE t SET a = 'it''s', b = 7, c = NULL WHERE d = 'x'");
  });

  it('refuses a count that does not match, a number that is not whole, and a NUL', () => {
    expect(() => inline('SELECT ?', [])).toThrow(/1 placeholders and 0 values/);
    expect(() => inline('SELECT ?', [1.5])).toThrow(/whole number/);
    expect(() => inline('SELECT ?', ['a\0b'])).toThrow(/NUL/);
  });
});

describe('the wrangler store', () => {
  const target = { database: 'oars-pool', bucket: 'oars-pool-raw', local: false };

  it('reads rows and counts changes through d1 execute against the remote database', async () => {
    const { io, calls } = fake({ rows: [{ id: 'a' }] });
    const store = wranglerStore(io.wrangler, target);
    expect(await store.rows('SELECT id FROM deposits WHERE account = ?', ['x'])).toEqual([{ id: 'a' }]);
    expect(await store.run('UPDATE deposits SET erased_on = ? WHERE id = ?', ['2026-11-08', 'a'])).toBe(1);
    expect(calls[0]).toEqual(['d1', 'execute', 'oars-pool', '--remote', '--json', '--command', "SELECT id FROM deposits WHERE account = 'x'"]);
    expect(calls[1]?.slice(0, 5)).toEqual(['d1', 'execute', 'oars-pool', '--remote', '--json']);
  });

  it('deletes an object through r2 object delete, and uses local state when asked', async () => {
    const { io, calls } = fake();
    await wranglerStore(io.wrangler, { ...target, local: true }).deleteObject(`raw/${ACCOUNT}/${SHA}`);
    await wranglerStore(io.wrangler, target).deleteObject('raw/x/y');
    expect(calls).toEqual([
      ['r2', 'object', 'delete', `oars-pool-raw/raw/${ACCOUNT}/${SHA}`, '--local'],
      ['r2', 'object', 'delete', 'oars-pool-raw/raw/x/y', '--remote'],
    ]);
  });

  it('fails when wrangler does not report success, and reads no rows from an answer without any', async () => {
    await expect(wranglerStore(fake({ success: false }).io.wrangler, target).run('SELECT 1', [])).rejects.toThrow(/did not report success/);
    const none = wranglerStore(() => Promise.resolve('[{"success":true}]'), target);
    expect(await none.rows('SELECT 1', [])).toEqual([]);
    expect(await none.run('SELECT 1', [])).toBe(0);
    await expect(wranglerStore(() => Promise.resolve('{}'), target).run('SELECT 1', [])).rejects.toThrow(/did not report success/);
  });
});

describe('main', () => {
  it('changes nothing without --confirm and says what it would do', async () => {
    for (const argv of [['raw', `raw/${ACCOUNT}/${SHA}`], ['row', '--account', ACCOUNT, '--id', 's1'], ['row', '--account', ACCOUNT, '--id', 's1', '--value-stdin'], ['account', '--account', ACCOUNT]]) {
      const { io, calls, printed } = fake();
      expect(await main(argv, io)).toBe(0);
      expect(calls).toEqual([]);
      expect(printed.join('\n')).toMatch(/^Would .*Nothing was changed: run again with --confirm\.$/);
    }
  });

  it('names the local state in its plan when --local is given', async () => {
    const { io, printed } = fake();
    await main(['account', '--account', ACCOUNT, '--local'], io);
    expect(printed.join('')).toContain('local state');
  });

  it('erases a raw object: tombstone, R2 delete, ledger mark, and audit, in that order, all against the remote', async () => {
    const { io, calls, printed } = fake();
    expect(await main(['raw', `raw/${ACCOUNT}/${SHA}`, '--confirm'], io)).toBe(0);
    expect(calls.map((call) => call.slice(0, 2).join(' ') + (call[0] === 'd1' ? ` ${(call[6] ?? '').split(' ').slice(0, 3).join(' ')}` : ''))).toEqual(['d1 execute INSERT OR IGNORE', 'r2 object', 'd1 execute UPDATE raw_objects SET', 'd1 execute INSERT INTO erasure_audit']);
    expect(calls.every((call) => call.includes('--remote'))).toBe(true);
    expect(printed).toEqual(['{"rowsErased":0,"objectsErased":1}']);
  });

  it('reads the leaked value from stdin, never from an argument, and writes only its digest', async () => {
    const { io, calls, printed } = fake({ stdin: 'AKIAFAKEKEY0000SECRET\n', rows: [] });
    expect(await main(['row', '--account', ACCOUNT, '--id', 's1', '--value-stdin', '--confirm'], io)).toBe(0);
    const sql = calls.map((call) => call[6] ?? '');
    // The value reaches wrangler only in the statements that look for it, and the tombstone carries its SHA-256.
    expect(sql.some((text) => text.includes("kind, digest") && text.includes('AKIAFAKEKEY0000SECRET'))).toBe(false);
    expect(sql.some((text) => text.includes('INSERT OR IGNORE INTO erasure_tombstones') && text.includes("'value'"))).toBe(true);
    expect(sql.some((text) => text.includes('erasure_audit') && text.includes('AKIAFAKEKEY0000SECRET'))).toBe(false);
    expect(printed).toHaveLength(1);
  });

  it('erases an account', async () => {
    const { io, printed } = fake();
    expect(await main(['account', '--account', ACCOUNT, '--confirm'], io)).toBe(0);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toMatch(/^\{"rowsErased":\d+,"objectsErased":\d+\}$/);
  });

  it('answers a usage error with exit code 2 and the usage', async () => {
    for (const argv of [[], ['nothing'], ['raw'], ['raw', 'k', 'extra'], ['row', '--account', ACCOUNT], ['account'], ['account', '--account', ACCOUNT, '--id', 's'], ['raw', 'k', '--account', ACCOUNT]]) {
      const { io, calls, printed } = fake();
      expect(await main(argv, io)).toBe(2);
      expect(calls).toEqual([]);
      expect(printed).toEqual([USAGE]);
    }
  });

  it('answers a bad option or a missing option value with exit code 2', async () => {
    for (const argv of [['--nope'], ['row', '--account'], ['row', '--account', '--id', 'x']]) {
      const { io, printed } = fake();
      expect(await main(argv, io)).toBe(2);
      expect(printed[0]).toMatch(/^(unknown option --nope|--account needs a value)\n/);
    }
  });

  it('answers a failure with exit code 1 and its message, and not a stack', async () => {
    const { io, printed } = fake();
    expect(await main(['raw', 'staging/a/b', '--confirm'], io)).toBe(1);
    expect(printed).toEqual(['a raw key is raw/<account>/<sha256, 64 lowercase hex>']);
    const broken = fake({ success: false });
    expect(await main(['account', '--account', ACCOUNT, '--confirm'], broken.io)).toBe(1);
    expect(broken.printed[0]).toMatch(/did not report success/);
    const rejected: Io = { ...fake().io, wrangler: () => Promise.reject(new Error('wrangler is not logged in')) };
    expect(await main(['account', '--account', ACCOUNT, '--confirm'], rejected)).toBe(1);
  });
});
