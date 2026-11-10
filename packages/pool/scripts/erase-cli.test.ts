// The command line and its wrangler store, against a fake wrangler: what it would run, with nothing run for real.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { main, USAGE, type Io } from './erase-cli.js';
import { inline, wranglerStore, type ObjectFiles } from './erase-wrangler.js';

const ACCOUNT = 'acct_0123456789abcdef0123456789abcdef';
const SHA = 'ab'.repeat(32);
const NOW = new Date('2026-11-08T12:00:00Z');

/** The pieces handed out one at a time, as a stream: each is made only when asked for. */
const asyncPieces = (pieces: Iterable<Uint8Array>): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]: () => {
    const next = pieces[Symbol.iterator]();
    return { next: () => Promise.resolve(next.next()) };
  },
});

interface Fake {
  io: Io;
  calls: string[][];
  printed: string[];
  /** The scratch files the fake has made and not yet removed. */
  scratch: Set<string>;
}

/** An `Io` whose wrangler answers like `d1 execute --json` (one successful statement changing one row, `rows` as its results) and records every call. `objects` are the R2 objects `r2 object get --file` would write: by key, the bytes. */
const fake = (options: { rows?: unknown[]; stdin?: string; success?: boolean; answer?: (sql: string) => unknown[]; objects?: ReadonlyMap<string, string>; getFails?: string } = {}): Fake => {
  const calls: string[][] = [];
  const printed: string[] = [];
  const scratch = new Set<string>();
  const written = new Map<string, string>();
  let made = 0;
  const files: ObjectFiles = {
    temp: () => {
      made += 1;
      scratch.add(`scratch-${String(made)}`);
      return Promise.resolve(`scratch-${String(made)}`);
    },
    read: (path) => {
      const text = written.get(path) ?? '';
      const pieces: Uint8Array[] = [];
      for (let at = 0; at < text.length; at += 4) pieces.push(Buffer.from(text.slice(at, at + 4)));
      return asyncPieces(pieces);
    },
    write: (path, text) => {
      written.set(path, text);
      return Promise.resolve();
    },
    remove: (path) => {
      scratch.delete(path);
      return Promise.resolve();
    },
  };
  return {
    calls,
    printed,
    scratch,
    io: {
      stdin: () => Promise.resolve(options.stdin ?? ''),
      print: (text) => printed.push(text),
      now: () => NOW,
      files,
      wrangler: (args) => {
        calls.push([...args]);
        if (args[0] === 'r2' && args[2] === 'get') {
          if (options.getFails !== undefined) return Promise.reject(new Error(options.getFails));
          const key = (args[3] ?? '').replace(/^oars-[a-z-]+\//, '');
          written.set(args[5] ?? '', options.objects?.get(key) ?? '');
          return Promise.resolve('Download complete.');
        }
        return Promise.resolve(args[0] === 'd1' ? JSON.stringify([{ results: options.answer?.(args[6] ?? '') ?? options.rows ?? [], success: options.success ?? true, meta: { changes: 1 } }]) : '');
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
  const target = { database: 'oars-pool', bucket: 'oars-pool-raw', telemetryBucket: 'oars-telemetry', local: false };

  it('reads rows and counts changes through d1 execute against the remote database', async () => {
    const { io, calls } = fake({ rows: [{ id: 'a' }] });
    const store = wranglerStore(io.wrangler, target, io.files);
    expect(await store.rows('SELECT id FROM deposits WHERE account = ?', ['x'])).toEqual([{ id: 'a' }]);
    expect(await store.run('UPDATE deposits SET erased_on = ? WHERE id = ?', ['2026-11-08', 'a'])).toBe(1);
    expect(calls[0]).toEqual(['d1', 'execute', 'oars-pool', '--remote', '--json', '--command', "SELECT id FROM deposits WHERE account = 'x'"]);
    expect(calls[1]?.slice(0, 5)).toEqual(['d1', 'execute', 'oars-pool', '--remote', '--json']);
  });

  it('reads, writes, and deletes a telemetry batch in the telemetry bucket, and lists through the lister it is given', async () => {
    const { io, calls, scratch } = fake({ objects: new Map([['telemetry/2026-11-08/a.json', '{"x":1}']]) });
    const store = wranglerStore(io.wrangler, target, io.files, (prefix) => Promise.resolve([`${prefix}a.json`]));
    expect(await store.telemetry.list('telemetry/2026-11-08/')).toEqual(['telemetry/2026-11-08/a.json']);
    expect(await store.telemetry.read('telemetry/2026-11-08/a.json')).toBe('{"x":1}');
    await store.telemetry.write('telemetry/2026-11-08/b.json', '{"y":2}');
    await store.telemetry.remove('telemetry/2026-11-08/a.json');
    expect(calls).toEqual([
      ['r2', 'object', 'get', 'oars-telemetry/telemetry/2026-11-08/a.json', '--file', 'scratch-1', '--remote'],
      ['r2', 'object', 'put', 'oars-telemetry/telemetry/2026-11-08/b.json', '--file', 'scratch-2', '--content-type', 'application/json', '--remote'],
      ['r2', 'object', 'delete', 'oars-telemetry/telemetry/2026-11-08/a.json', '--remote'],
    ]);
    expect(scratch.size).toBe(0);
  });

  it('reads a missing telemetry batch as null, passes any other fault on, and says what to export when no lister was given', async () => {
    expect(await wranglerStore(fake({ getFails: 'The specified key does not exist.' }).io.wrangler, target, fake().io.files).telemetry.read('telemetry/x')).toBeNull();
    await expect(wranglerStore(fake({ getFails: 'not logged in' }).io.wrangler, target, fake().io.files).telemetry.read('telemetry/x')).rejects.toThrow(/not logged in/);
    await expect(wranglerStore(fake().io.wrangler, target, fake().io.files).telemetry.list('telemetry/')).rejects.toThrow(/R2_ACCESS_KEY_ID/);
  });

  it('deletes an object through r2 object delete, and uses local state when asked', async () => {
    const { io, calls } = fake();
    await wranglerStore(io.wrangler, { ...target, local: true }, io.files).deleteObject(`raw/${ACCOUNT}/${SHA}`);
    await wranglerStore(io.wrangler, target, io.files).deleteObject('raw/x/y');
    expect(calls).toEqual([
      ['r2', 'object', 'delete', `oars-pool-raw/raw/${ACCOUNT}/${SHA}`, '--local'],
      ['r2', 'object', 'delete', 'oars-pool-raw/raw/x/y', '--remote'],
    ]);
  });

  it('downloads an object to a scratch file with r2 object get, streams it, and removes the file when the stream ends', async () => {
    const { io, calls, scratch } = fake({ objects: new Map([['raw/x/y', 'hello world']]) });
    const pieces = await wranglerStore(io.wrangler, target, io.files).readObject('raw/x/y');
    expect(calls).toEqual([['r2', 'object', 'get', 'oars-pool-raw/raw/x/y', '--file', 'scratch-1', '--remote']]);
    expect(scratch.size).toBe(1);
    const read: string[] = [];
    for await (const piece of pieces ?? []) read.push(Buffer.from(piece).toString());
    expect(read.join('')).toBe('hello world');
    expect(scratch.size).toBe(0);
    await wranglerStore(io.wrangler, { ...target, local: true }, io.files).readObject('raw/x/y');
    expect(calls[1]?.at(-1)).toBe('--local');
  });

  it('removes the scratch file of a stream that is left early, and answers null for an object R2 does not hold', async () => {
    const early = fake({ objects: new Map([['raw/x/y', 'hello world']]) });
    const pieces = await wranglerStore(early.io.wrangler, target, early.io.files).readObject('raw/x/y');
    for await (const piece of pieces ?? []) {
      expect(piece.length).toBeGreaterThan(0);
      break;
    }
    expect(early.scratch.size).toBe(0);
    const gone = fake({ getFails: 'wrangler r2 object get failed: The specified key does not exist.' });
    expect(await wranglerStore(gone.io.wrangler, target, gone.io.files).readObject('raw/x/y')).toBeNull();
    expect(gone.scratch.size).toBe(0);
  });

  it('throws any other failure to read an object, and leaves no scratch file', async () => {
    const broken = fake({ getFails: 'wrangler r2 object get failed: not logged in' });
    await expect(wranglerStore(broken.io.wrangler, target, broken.io.files).readObject('raw/x/y')).rejects.toThrow(/not logged in/);
    expect(broken.scratch.size).toBe(0);
  });

  it('fails when wrangler does not report success, and reads no rows from an answer without any', async () => {
    await expect(wranglerStore(fake({ success: false }).io.wrangler, target, fake().io.files).run('SELECT 1', [])).rejects.toThrow(/did not report success/);
    const none = wranglerStore(() => Promise.resolve('[{"success":true}]'), target, fake().io.files);
    expect(await none.rows('SELECT 1', [])).toEqual([]);
    expect(await none.run('SELECT 1', [])).toBe(0);
    await expect(wranglerStore(() => Promise.resolve('{}'), target, fake().io.files).run('SELECT 1', [])).rejects.toThrow(/did not report success/);
  });
});

describe('main', () => {
  it('changes nothing without --confirm and says what it would do', async () => {
    for (const argv of [['raw', `raw/${ACCOUNT}/${SHA}`], ['row', '--account', ACCOUNT, '--id', 's1'], ['row', '--account', ACCOUNT, '--id', 's1', '--value-stdin'], ['account', '--account', ACCOUNT]]) {
      const { io, calls, printed } = fake({ rows: [{ found: 1 }] });
      expect(await main(argv, io)).toBe(0);
      // The only call a dry run makes is the SELECT that checks the row named.
      expect(calls.map((call) => (call[6] ?? '').split(' ')[0])).toEqual(argv[0] === 'row' ? ['SELECT'] : []);
      expect(printed.join('\n')).toMatch(/^Would .*Nothing was changed: run again with --confirm\.$/);
    }
  });

  it('says a row does not exist in the dry run, and writes no tombstone for it when confirmed', async () => {
    const dry = fake({ rows: [] });
    expect(await main(['row', '--account', ACCOUNT, '--id', 'mistyped'], dry.io)).toBe(1);
    expect(dry.printed.join('')).toContain('No deposit row for account');
    expect(dry.calls.map((call) => (call[6] ?? '').split(' ')[0])).toEqual(['SELECT']);

    const confirmed = fake({ rows: [] });
    expect(await main(['row', '--account', ACCOUNT, '--id', 'mistyped', '--confirm'], confirmed.io)).toBe(1);
    expect(confirmed.printed.join('')).toContain('no deposit row');
    // One SELECT, and no INSERT, UPDATE, or DELETE: no tombstone and no audit row.
    expect(confirmed.calls.map((call) => (call[6] ?? '').split(' ')[0])).toEqual(['SELECT']);
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
    const value = 'AKIAFAKEKEY0000SECRET';
    const { io, calls, printed } = fake({
      stdin: `${value}\n`,
      answer: (sql) => {
        if (sql.startsWith('SELECT 1 AS found')) return [{ found: 1 }];
        if (sql.includes('FROM deposits')) return [{ account: ACCOUNT, id: 's2', skeleton: `{"program":"${value}"}`, extensions: '[]' }];
        if (sql.includes('FROM motifs')) return [{ motif_id: 'm1', motif: `run ${value} now` }];
        if (sql.includes('FROM cells')) return [{ rowid: 4, key: `m1/claude-code/2.1.x/${value}/day/1`, harness_bucket: '2.1.x', frame_bucket: `claude-code/2.1.x/${value}` }];
        if (sql.includes('FROM contributors')) return [{ kind: 'cell', key: `m1/claude-code/2.1.x/${value}/day/1`, account: ACCOUNT, day: '2026-11-08' }];
        return [];
      },
    });
    expect(await main(['row', '--account', ACCOUNT, '--id', 's1', '--value-stdin', '--confirm'], io)).toBe(0);
    // The value is on no wrangler argument at all, though a cell and a contributor hold it: the rows come back whole and the match is made here.
    expect(calls.flat().some((arg) => arg.includes(value))).toBe(false);
    const sql = calls.map((call) => call[6] ?? '');
    expect(sql).toContain("SELECT rowid, key, harness_bucket, frame_bucket FROM cells ORDER BY rowid LIMIT 25 OFFSET 0");
    // A cell is changed by its rowid and a contributor by the text around the value; the marker carries 12 hex of the value's SHA-256, not the value.
    const marker = `[erased:${createHash('sha256').update(value).digest('hex').slice(0, 12)}]`;
    expect(sql).toContain(`UPDATE cells SET key = 'm1/claude-code/2.1.x/${marker}/day/1', harness_bucket = '2.1.x', frame_bucket = 'claude-code/2.1.x/${marker}' WHERE rowid = 4`);
    expect(sql.some((text) => text.startsWith(`UPDATE contributors SET key = 'm1/claude-code/2.1.x/${marker}/day/1' WHERE kind = 'cell'`) && text.includes('substr(key, 1, 21)') && text.includes('length(key) = ') && text.includes('ORDER BY key LIMIT 1 OFFSET 0'))).toBe(true);
    expect(sql.some((text) => text.startsWith('UPDATE pool_generation SET generation = generation + 1'))).toBe(true);
    // Rows are changed by key, the motif by its scrubbed text, and the tombstone carries the SHA-256.
    // Staged parts are sealed, so they are dropped by account (the named one and the one whose row held the value), never matched by text.
    expect(sql).toContain(`DELETE FROM deposit_parts WHERE account = '${ACCOUNT}' AND deposit IS NULL`);
    expect(sql).toContain("UPDATE motifs SET motif = 'run [erased] now' WHERE motif_id = 'm1'");
    expect(sql.some((text) => text.startsWith('UPDATE deposits SET') && text.includes("id = 's2'"))).toBe(true);
    expect(sql.some((text) => text.includes('INSERT OR IGNORE INTO erasure_tombstones') && text.includes("'value'"))).toBe(true);
    expect(printed).toHaveLength(1);
  });

  it('stops when the contributor record it was to change is not the one it read', async () => {
    const value = 'AKIAFAKEKEY0000SECRET';
    const { io, calls, printed } = fake({
      stdin: value,
      answer: (sql) => {
        if (sql.startsWith('SELECT 1 AS found')) return [{ found: 1 }];
        if (sql.startsWith('SELECT kind, key, account, day FROM contributors')) return [{ kind: 'cell', key: `m1/${value}/1`, account: ACCOUNT, day: '2026-11-08' }];
        return [];
      },
    });
    expect(await main(['row', '--account', ACCOUNT, '--id', 's1', '--value-stdin', '--confirm'], io)).toBe(1);
    expect(printed.join('')).toContain('changed while it was read');
    expect(calls.map((call) => call[6] ?? '').some((sql) => sql.startsWith('UPDATE contributors'))).toBe(false);
  });

  it('reads a table of more than one page in key order, by cursor, and scrubs every motif that holds the value', async () => {
    const value = 'AKIAFAKEKEY0000SECRET';
    const motifs = Array.from({ length: 26 }, (_, at) => ({ motif_id: `m${String(at).padStart(2, '0')}`, motif: `run ${value}` }));
    const { io, calls } = fake({
      stdin: value,
      answer: (sql) => {
        if (sql.startsWith('SELECT 1 AS found')) return [{ found: 1 }];
        if (!sql.includes('FROM motifs')) return [];
        return sql.includes("> ('')") ? motifs.slice(0, 25) : motifs.slice(25);
      },
    });
    expect(await main(['row', '--account', ACCOUNT, '--id', 's1', '--value-stdin', '--confirm'], io)).toBe(0);
    const sql = calls.map((call) => call[6] ?? '');
    expect(sql.filter((text) => text.startsWith('UPDATE motifs'))).toHaveLength(26);
    expect(sql).toContain("SELECT motif_id, motif FROM motifs WHERE (motif_id) > ('m24') ORDER BY motif_id LIMIT 25");
    expect(calls.flat().some((arg) => arg.includes(value))).toBe(false);
  });

  it('erases an account, and moves the generation when it held links to the totals', async () => {
    // The count of links is a SELECT that always answers one row; the rest of the account's rows are empty.
    const { io, calls, printed } = fake({ answer: (sql) => (sql.includes('AS held') ? [{ held: 2 }] : []) });
    const listed: string[] = [];
    expect(await main(['account', '--account', ACCOUNT, '--confirm'], { ...io, list: (prefix) => { listed.push(prefix); return Promise.resolve([]); } })).toBe(0);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toMatch(/^\{"rowsErased":\d+,"objectsErased":\d+\}$/);
    expect(calls.flat().some((arg) => arg.startsWith('UPDATE pool_generation'))).toBe(true);
    // The batch step lists the 91 days within retention.
    expect(listed).toHaveLength(91);
  });

  it('says what to export when the account erasure has no R2 token to list the telemetry bucket with, after every other step', async () => {
    const { io, calls, printed } = fake();
    expect(await main(['account', '--account', ACCOUNT, '--confirm'], io)).toBe(1);
    expect(printed.join(' ')).toMatch(/R2_ACCESS_KEY_ID/);
    expect(calls.flat().some((arg) => arg.startsWith('INSERT INTO erasure_audit'))).toBe(false);
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

describe('main: the find', () => {
  const NAME = 'Jane Quentin Tenant';
  const KEY = `raw/${ACCOUNT}/${SHA}`;
  const ledger = (sql: string): unknown[] => (sql.startsWith('SELECT account, sha256, bytes FROM raw_objects') ? [{ account: ACCOUNT, sha256: SHA, bytes: 31 }] : []);
  const verbs = (calls: string[][]): string[] => calls.map((call) => (call[0] === 'd1' ? (call[6] ?? '').split(' ')[0] ?? '' : call.slice(0, 3).join(' ')));

  it('reads the text from stdin, reports each object that holds it by key, account, and size, and counts what it read', async () => {
    const { io, calls, printed } = fake({ stdin: `${NAME}\n`, answer: ledger, objects: new Map([[KEY, `before ${NAME} after`]]) });
    expect(await main(['raw', '--contains', '--value-stdin', '--account', ACCOUNT], io)).toBe(0);
    expect(printed).toEqual([JSON.stringify({ key: KEY, account: ACCOUNT, bytes: 31 }), JSON.stringify({ objectsRead: 1, objectsMatched: 1, objectsMissing: 0 })]);
    // One SELECT of the ledger and one object read: nothing is written to D1 or R2, and the text is in no wrangler argument.
    expect(verbs(calls)).toEqual(['SELECT', 'r2 object get']);
    expect(calls.flat().join('\n')).not.toContain(NAME);
    expect(calls[0]?.[6]).toContain(`account = '${ACCOUNT}'`);
  });

  it('looks in every account with --all-accounts, and needs no --confirm because it changes nothing', async () => {
    const { io, calls, printed } = fake({ stdin: NAME, answer: ledger, objects: new Map([[KEY, 'no one is named here']]) });
    expect(await main(['raw', '--contains', '--value-stdin', '--all-accounts'], io)).toBe(0);
    expect(printed).toEqual([JSON.stringify({ objectsRead: 1, objectsMatched: 0, objectsMissing: 0 })]);
    expect(calls[0]?.[6]).not.toContain('account = ');
    expect(calls[0]?.[6]).toContain('erased_on IS NULL');
  });

  it('counts an object R2 no longer holds', async () => {
    const { io, printed } = fake({ stdin: NAME, answer: ledger, getFails: 'The specified key does not exist.' });
    expect(await main(['raw', '--contains', '--value-stdin', '--all-accounts', '--local'], io)).toBe(1);
    expect(printed).toEqual([JSON.stringify({ objectsRead: 0, objectsMatched: 0, objectsMissing: 1 })]);
  });

  it('prints neither the text nor the bytes around it', async () => {
    const { io, printed } = fake({ stdin: NAME, answer: ledger, objects: new Map([[KEY, `AROUNDTEXT ${NAME} AROUNDTEXT`]]) });
    await main(['raw', '--contains', '--value-stdin', '--all-accounts'], io);
    expect(printed.join('\n')).not.toMatch(/Jane|Quentin|Tenant|AROUNDTEXT/);
  });

  it('refuses neither or both account flags, a short text, and a text that is not on stdin, without echoing the text', async () => {
    for (const argv of [['raw', '--contains', '--value-stdin'], ['raw', '--contains', '--value-stdin', '--account', ACCOUNT, '--all-accounts']]) {
      const { io, calls, printed } = fake({ stdin: NAME, answer: ledger });
      expect(await main(argv, io)).toBe(1);
      expect(printed).toEqual(['name exactly one of an account and every account']);
      expect(calls).toEqual([]);
    }
    const short = fake({ stdin: 'Jane Do\n', answer: ledger });
    expect(await main(['raw', '--contains', '--value-stdin', '--all-accounts'], short.io)).toBe(1);
    expect(short.printed[0]).toMatch(/at least 8 characters/);
    expect(short.printed.join('')).not.toContain('Jane Do');
    expect(short.calls).toEqual([]);
    // The text is never an argument: without --value-stdin, or with a key, it is the usage.
    for (const argv of [['raw', '--contains', '--all-accounts'], ['raw', KEY, '--contains', '--value-stdin', '--all-accounts']]) {
      const { io, printed } = fake({ stdin: NAME });
      expect(await main(argv, io)).toBe(2);
      expect(printed).toEqual([USAGE]);
    }
  });

  it('says how to use it in the usage text', () => {
    expect(USAGE).toContain('raw --contains --value-stdin');
    expect(USAGE).toContain('--all-accounts');
  });
});
