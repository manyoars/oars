// The operator's pull of third-party deposits: what it keeps, what it leaves out, and that it cannot write.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Of } from '../src/covenant.js';
import { COVENANT_TEXTS, COVENANT_VERSION_2, COVENANT_VERSION_2_1 } from '../src/covenant-texts.js';
import { objectKey } from '../src/raw.js';
import { startPool, stubUser, type TestPool } from '../src/test-pool.js';
import type { EraseStore } from './erase.js';
import { storeOf } from './erase-test-store.js';
import type { ExportFolder } from './export-account.js';
import { insideRepository, main, pullDeposits, USAGE } from './pull-deposits.js';

let pool: TestPool;
let next = 9400;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const screenHash = (version: string): string => sha256Of(COVENANT_TEXTS.get(version) ?? '');

/** A folder in memory: each file's text by its name. */
const memory = (): { folder: ExportFolder; files: Map<string, string> } => {
  const files = new Map<string, string>();
  return {
    files,
    folder: {
      write: async (name, content) => {
        if (typeof content === 'string') files.set(name, content);
        else {
          const chunks: Buffer[] = [];
          for await (const piece of content) chunks.push(Buffer.from(piece));
          files.set(name, Buffer.concat(chunks).toString('utf8'));
        }
      },
      remove: (name) => {
        files.delete(name);
        return Promise.resolve();
      },
    },
  };
};

const store = async (): Promise<EraseStore> => storeOf(await pool.db(), await pool.rawBucket(), await pool.bucket());

interface Seed {
  restrictedAt?: number | null;
  rawYes?: string | null;
  /** Acceptances by version; `hash` and `input` default to a proved one. */
  acceptances?: { version: string; at: number; hash?: string | null; input?: string | null }[];
  deposits?: { id: string; tier?: string; countedAt?: number | null; erasedOn?: string | null }[];
  raw?: { text: string; erasedOn?: string | null; stored?: boolean }[];
}

/** A signed-in account with the seeded rows, written straight into the local pool. */
const seeded = async (seed: Seed = {}): Promise<string> => {
  next += 1;
  const { account } = await pool.signIn('github', stubUser(String(next)));
  const db = await pool.db();
  await db.prepare('UPDATE accounts SET restricted_at = ?, raw_consent_version = ? WHERE id = ?').bind(seed.restrictedAt ?? null, seed.rawYes === undefined ? 'v1' : seed.rawYes, account).run();
  for (const found of seed.acceptances ?? [{ version: COVENANT_VERSION_2_1, at: 1000 }]) {
    const hash = found.hash === undefined ? screenHash(found.version) : found.hash;
    const input = found.input === undefined ? 'I accept' : found.input;
    await db.prepare('INSERT INTO covenant_acceptances (account, version, accepted_at, text_sha256, input) VALUES (?, ?, ?, ?, ?)').bind(account, found.version, found.at, hash, input).run();
  }
  for (const found of seed.deposits ?? []) {
    await db.prepare("INSERT INTO deposits (account, id, skeleton, tier, counted_at, erased_on, request_country, deltas) VALUES (?, ?, ?, ?, ?, ?, 'US', '[]')").bind(account, found.id, `{"id":"${found.id}"}`, found.tier ?? 'skeleton', found.countedAt === undefined ? 2000 : found.countedAt, found.erasedOn ?? null).run();
  }
  for (const found of seed.raw ?? []) {
    await db.prepare("INSERT INTO raw_objects (account, sha256, bytes, capture_version, redaction_version, stored_at, erased_on) VALUES (?, ?, ?, 'cap-1', '1', 1, ?)").bind(account, sha(found.text), found.text.length, found.erasedOn ?? null).run();
    if (found.stored !== false) await (await pool.rawBucket()).put(objectKey(account, sha(found.text)), found.text);
  }
  return account;
};

const jsonl = (text: string | undefined): unknown[] => (text ?? '').split('\n').filter((row) => row !== '').map((row): unknown => JSON.parse(row));

const fieldOf = (row: unknown, key: string): unknown => (typeof row === 'object' && row !== null ? Reflect.get(row, key) : undefined);

const pulledAccounts = (files: Map<string, string>): string[] => jsonl(files.get('accounts.jsonl')).map((row) => String(fieldOf(row, 'account')));

describe('pull-deposits', () => {
  it('pulls an account with a proved acceptance', async () => {
    const account = await seeded({
      acceptances: [{ version: COVENANT_VERSION_2, at: 1000 }, { version: COVENANT_VERSION_2_1, at: 3000 }],
      deposits: [{ id: 'd1', countedAt: 2000 }, { id: 'd2', tier: 'none', countedAt: null }],
      raw: [{ text: '{"line":1}\n' }],
    });
    const { folder, files } = memory();
    const done = await pullDeposits(await store(), folder);
    expect(done.failed).toEqual([]);
    expect(jsonl(files.get('accounts.jsonl'))).toContainEqual({
      account,
      acceptances: [
        { version: COVENANT_VERSION_2, text_sha256: screenHash(COVENANT_VERSION_2), accepted_at: 1000 },
        { version: COVENANT_VERSION_2_1, text_sha256: screenHash(COVENANT_VERSION_2_1), accepted_at: 3000 },
      ],
    });
    // The tier and country ride with each row for the build; a tier none row is the build's to leave out.
    expect(jsonl(files.get(`${account}/deposits.jsonl`))).toEqual([
      { id: 'd1', tier: 'skeleton', counted_at: 2000, request_country: 'US', skeleton: '{"id":"d1"}' },
      { id: 'd2', tier: 'none', counted_at: null, request_country: 'US', skeleton: '{"id":"d2"}' },
    ]);
    expect(files.get(`${account}/projects/deposit/${sha('{"line":1}\n')}.jsonl`)).toBe('{"line":1}\n');
  });

  it('leaves out an acceptance with no text hash', async () => {
    const bare = await seeded({ acceptances: [{ version: COVENANT_VERSION_2_1, at: 1000, hash: null, input: null }], deposits: [{ id: 'b1' }] });
    const noInput = await seeded({ acceptances: [{ version: COVENANT_VERSION_2_1, at: 1000, input: null }], deposits: [{ id: 'b2' }] });
    const wrong = await seeded({ acceptances: [{ version: COVENANT_VERSION_2_1, at: 1000, hash: sha('another screen') }], deposits: [{ id: 'b3' }] });
    const unknown = await seeded({ acceptances: [{ version: '9.9-unheld', at: 1000, hash: sha('x') }], deposits: [{ id: 'b4' }] });
    const mixed = await seeded({ acceptances: [{ version: COVENANT_VERSION_2, at: 1000, hash: null }, { version: COVENANT_VERSION_2_1, at: 2000 }], deposits: [{ id: 'b5' }] });
    const { folder, files } = memory();
    await pullDeposits(await store(), folder);
    const kept = pulledAccounts(files);
    for (const account of [bare, noInput, wrong, unknown]) {
      expect(kept).not.toContain(account);
      expect(files.has(`${account}/deposits.jsonl`)).toBe(false);
    }
    // An account keeps only the acceptances that are proved.
    expect(jsonl(files.get('accounts.jsonl'))).toContainEqual({ account: mixed, acceptances: [{ version: COVENANT_VERSION_2_1, text_sha256: screenHash(COVENANT_VERSION_2_1), accepted_at: 2000 }] });
  });

  it('leaves out a restricted account and one with no raw yes', async () => {
    const restricted = await seeded({ restrictedAt: 5, deposits: [{ id: 'r1' }], raw: [{ text: 'restricted' }] });
    const noYes = await seeded({ rawYes: null, deposits: [{ id: 'n1' }], raw: [{ text: 'no yes' }] });
    const ok = await seeded({ deposits: [{ id: 'k1' }] });
    const { folder, files } = memory();
    const done = await pullDeposits(await store(), folder);
    expect(pulledAccounts(files)).toContain(ok);
    for (const account of [restricted, noYes]) {
      expect(pulledAccounts(files)).not.toContain(account);
      expect([...files.keys()].filter((name) => name.startsWith(`${account}/`))).toEqual([]);
    }
    expect(done.leftOut.restricted).toBeGreaterThanOrEqual(1);
    expect(done.leftOut.noRawYes).toBeGreaterThanOrEqual(1);
  });

  it('leaves out erased rows', async () => {
    const account = await seeded({
      deposits: [{ id: 'e1', erasedOn: '2026-11-01' }, { id: 'e2' }],
      raw: [{ text: 'erased copy', erasedOn: '2026-11-01', stored: true }, { text: 'standing copy' }],
    });
    const { folder, files } = memory();
    const done = await pullDeposits(await store(), folder);
    expect(done.failed).toEqual([]);
    expect(jsonl(files.get(`${account}/deposits.jsonl`)).map((row) => fieldOf(row, 'id'))).toEqual(['e2']);
    expect([...files.keys()].filter((name) => name.startsWith(`${account}/projects/`))).toEqual([`${account}/projects/deposit/${sha('standing copy')}.jsonl`]);
  });

  it('reads accounts and deposits a page of 25 at a time, and misses none past the first page', async () => {
    const account = await seeded({ deposits: Array.from({ length: 27 }, (_, n) => ({ id: `p${String(n).padStart(2, '0')}` })) });
    // More accounts than one page, so the account read must page too.
    const others: string[] = [];
    for (let n = 0; n < 26; n += 1) others.push(await seeded({ deposits: [{ id: `q${String(n)}` }] }));
    const real = await store();
    const statements: string[] = [];
    const counting: EraseStore = { ...real, rows: (sql, binds) => (statements.push(sql), real.rows(sql, binds)) };
    const { folder, files } = memory();
    await pullDeposits(counting, folder);
    expect(jsonl(files.get(`${account}/deposits.jsonl`)).map((row) => fieldOf(row, 'id'))).toEqual(Array.from({ length: 27 }, (_, n) => `p${String(n).padStart(2, '0')}`));
    expect(pulledAccounts(files)).toEqual(expect.arrayContaining([account, ...others]));
    for (const table of ['accounts', 'deposits']) {
      const reads = statements.filter((sql) => sql.includes(`FROM ${table} `));
      expect(reads.length).toBeGreaterThan(0);
      for (const sql of reads) expect(sql).toMatch(/ AND id > \? ORDER BY id LIMIT 25$| WHERE id > \? ORDER BY id LIMIT 25$/);
    }
    expect(statements.filter((sql) => sql.includes('FROM deposits ') && sql.includes('LIMIT 25')).length).toBeGreaterThanOrEqual(2);
  });

  it('leaves out an erased: account and its deposits', async () => {
    const account = await seeded({ deposits: [{ id: 'x1' }] });
    const db = await pool.db();
    const erased = `erased:${'ab12'.repeat(8)}`;
    // The row `erase account` leaves: a minimal accounts row, with the deposits moved onto it.
    await db.prepare('INSERT INTO accounts (id, source) SELECT ?, source FROM accounts WHERE id = ?').bind(erased, account).run();
    await db.prepare("INSERT INTO deposits (account, id, skeleton, tier, counted_at, request_country, deltas) VALUES (?, 'x2', '{}', 'skeleton', 2000, 'US', '[]')").bind(erased).run();
    const { folder, files } = memory();
    const before = await (await store()).rows('SELECT COUNT(*) AS n FROM accounts WHERE id LIKE ?', ['erased:%']);
    const done = await pullDeposits(await store(), folder);
    expect(fieldOf(before[0], 'n')).toBeGreaterThanOrEqual(1);
    expect(pulledAccounts(files)).toContain(account);
    expect(pulledAccounts(files)).not.toContain(erased);
    expect([...files.keys()].filter((name) => name.startsWith('erased:'))).toEqual([]);
    expect(done.leftOut.erased).toBeGreaterThanOrEqual(1);
  });

  it('names a raw copy the bucket does not hold or that does not hash to its name, and does not write it', async () => {
    const account = await seeded({ raw: [{ text: 'missing', stored: false }, { text: 'altered', stored: false }] });
    await (await pool.rawBucket()).put(objectKey(account, sha('altered')), 'something else');
    const { folder, files } = memory();
    const done = await pullDeposits(await store(), folder);
    expect(done.failed).toEqual(expect.arrayContaining([`${sha('missing')} of ${account} is not in the bucket`, `${sha('altered')} of ${account} does not hash to its name`]));
    expect([...files.keys()].filter((name) => name.startsWith(`${account}/projects/`))).toEqual([]);
  });

  it('calls neither run nor deleteObject', async () => {
    await seeded({ deposits: [{ id: 'w1' }], raw: [{ text: 'read only' }] });
    const real = await store();
    const statements: string[] = [];
    const refuse = (what: string) => (): never => {
      throw new Error(`the pull called ${what}`);
    };
    const guarded: EraseStore = {
      telemetry: { list: refuse('telemetry.list'), read: refuse('telemetry.read'), write: refuse('telemetry.write'), remove: refuse('telemetry.remove') },
      listRaw: refuse('listRaw'),
      run: refuse('run'),
      deleteObject: refuse('deleteObject'),
      readObject: (key) => real.readObject(key),
      rows: (sql, binds) => {
        statements.push(sql);
        return real.rows(sql, binds);
      },
    };
    const { folder } = memory();
    const done = await pullDeposits(guarded, folder);
    expect(done.deposits).toBeGreaterThan(0);
    expect(statements.length).toBeGreaterThan(3);
    for (const sql of statements) expect(sql).toMatch(/^SELECT /);
    for (const sql of statements) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE)\b/);
  });
});

describe('pull-deposits command', () => {
  const io = (inRepository: boolean) => {
    const printed: string[] = [];
    let wrangled = 0;
    return {
      printed,
      wrangled: () => wrangled,
      io: {
        print: (text: string) => printed.push(text),
        wrangler: () => {
          wrangled += 1;
          return Promise.reject(new Error('wrangler is down'));
        },
        files: { temp: () => Promise.resolve('t'), read: () => (async function* none() {})(), write: () => Promise.resolve(), remove: () => Promise.resolve() },
        folder: () => memory().folder,
        inRepository: () => Promise.resolve(inRepository),
      },
    };
  };

  it('refuses a folder inside a repository', async () => {
    const run = io(true);
    expect(await main(['--out', 'inside'], run.io)).toBe(1);
    expect(run.printed.join('\n')).toContain('inside a git repository');
    expect(run.wrangled()).toBe(0);
  });

  it('finds a repository above the folder, and none above a bare one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oars-pull-'));
    try {
      await mkdir(join(root, 'repo', '.git'), { recursive: true });
      await mkdir(join(root, 'repo', 'deep', 'out'), { recursive: true });
      await mkdir(join(root, 'bare', 'out'), { recursive: true });
      expect(await insideRepository(join(root, 'repo', 'deep', 'out'))).toBe(true);
      expect(await insideRepository(join(root, 'bare', 'out'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('prints usage for a missing or unknown option', async () => {
    for (const argv of [[], ['--out'], ['--out', '--local'], ['--bogus']]) {
      const run = io(false);
      expect(await main(argv, run.io)).toBe(2);
      expect(run.printed).toEqual([USAGE]);
    }
  });

  it('reports a store that fails', async () => {
    const run = io(false);
    expect(await main(['--out', 'elsewhere', '--local'], run.io)).toBe(1);
    expect(run.printed.join('\n')).toContain('wrangler is down');
  });
});
