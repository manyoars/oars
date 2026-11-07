// The ledger plane has no expiry: the database refuses a delete of a `deposits` row or a `contributors` record, and a guard over the pool's own source fails
// when a delete path or a scheduled trigger appears. A legally required erasure would be one new migration that drops the two `*_no_delete` triggers.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sampleSkeleton } from './sample.js';
import { fieldOf, startPool, stubUser, type TestPool } from './test-pool.js';

const here = (relative: string): URL => new URL(relative, import.meta.url);

let pool: TestPool;

beforeAll(async () => {
  pool = await startPool();
}, 60_000);

afterAll(async () => {
  await pool.dispose();
});

const count = async (table: 'deposits' | 'contributors'): Promise<number> => {
  const row = await (await pool.db()).prepare(`SELECT COUNT(*) AS held FROM ${table}`).first();
  const held = fieldOf(row, 'held');
  if (typeof held !== 'number') throw new Error(`no count for ${table}`);
  return held;
};

describe('the server refuses a ledger delete', () => {
  it('aborts a DELETE of a deposits row or a contributors record and keeps the rows', async () => {
    const { token } = await pool.signIn('github', stubUser('8601'));
    await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000008601'), token)).status).toBe(201);
    const deposits = await count('deposits');
    const contributors = await count('contributors');
    expect(deposits).toBeGreaterThan(0);
    expect(contributors).toBeGreaterThan(0);

    const db = await pool.db();
    await expect(db.prepare('DELETE FROM deposits').run()).rejects.toThrow(/ledger rows are never deleted/);
    await expect(db.prepare('DELETE FROM contributors').run()).rejects.toThrow(/ledger rows are never deleted/);
    // A delete of one named row is refused the same way as a sweep.
    await expect(db.prepare("DELETE FROM deposits WHERE id = '0000000000008601'").run()).rejects.toThrow(/ledger rows are never deleted/);
    expect(await count('deposits')).toBe(deposits);
    expect(await count('contributors')).toBe(contributors);
  }, 60_000);

  // SQLite runs a delete trigger for the row a REPLACE conflict removes only when `recursive_triggers` is on. Pinned for the test runtime (Miniflare's D1);
  // production D1's setting is unverified, so the source guard below keeps its REPLACE rule either way.
  it('does not run the delete trigger for a row an INSERT OR REPLACE removes', async () => {
    const { token } = await pool.signIn('github', stubUser('8602'));
    await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
    expect((await pool.post('/v1/deposits', sampleSkeleton('0000000000008602'), token)).status).toBe(201);
    const db = await pool.db();
    const held = async (): Promise<unknown> => fieldOf(await db.prepare("SELECT COUNT(*) AS held FROM deposits WHERE id = '0000000000008602'").first(), 'held');
    expect(await held()).toBe(1);
    const before = await count('deposits');
    await db
      .prepare("INSERT OR REPLACE INTO deposits (account, id, skeleton, deltas, tier, counted_at, ingest) SELECT account, id, skeleton, deltas, tier, counted_at, ingest FROM deposits WHERE id = '0000000000008602'")
      .run();
    expect(await held()).toBe(1);
    expect(await count('deposits')).toBe(before);
  }, 60_000);
});

/** SQL or TypeScript text with its comments removed, so prose that names a delete is not one. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--).*$/gm, '');

// A table name as SQL writes it: bare, quoted with a double quote, single quote, or backtick, or in brackets, and optionally qualified with `main.`.
const OPEN = '["\'`\\[]?';
const CLOSE = '["\'`\\]]?';
const LEDGER_TABLE = `(?:${OPEN}main${CLOSE}\\.)?${OPEN}(?:deposits|contributors)\\b`;
const LEDGER_DELETE = new RegExp(`\\bDELETE\\s+FROM\\s+${LEDGER_TABLE}`, 'i');
// `REPLACE` as a conflict clause deletes the row it replaces without running the delete trigger (the test above pins that for the test runtime, not for production D1, so the guard keeps the rule either way), and so does `DROP TABLE`.
const LEDGER_REPLACE = new RegExp(
  `\\bREPLACE\\s+INTO\\s+${LEDGER_TABLE}|\\bON\\s+CONFLICT\\s+REPLACE\\b|\\bINSERT\\s+OR\\s+REPLACE\\b|\\bUPDATE\\s+OR\\s+REPLACE\\s+${LEDGER_TABLE}`,
  'i',
);
const LEDGER_DROP = new RegExp(`\\bDROP\\s+TABLE\\s+(IF\\s+EXISTS\\s+)?${LEDGER_TABLE}`, 'i');
// `scheduled(`, `scheduled:`, `scheduled =`, and the shorthand `{ fetch, scheduled }`.
const SCHEDULED_HANDLER = /\bscheduled\s*(\(|:|=|,|\})/;
const CRON_CONFIG = /"crons"/;

/** What in `files` (name to text) would delete from the ledger or run it on a schedule. */
const offences = (files: { [name: string]: string }): string[] =>
  Object.entries(files).flatMap(([name, text]) => {
    const body = code(text);
    return [
      ...(LEDGER_DELETE.test(body) ? [`${name}: DELETE FROM the ledger`] : []),
      ...(LEDGER_REPLACE.test(body) ? [`${name}: a REPLACE that deletes a ledger row`] : []),
      ...(LEDGER_DROP.test(body) ? [`${name}: a DROP TABLE that deletes ledger rows`] : []),
      ...(SCHEDULED_HANDLER.test(body) ? [`${name}: a scheduled handler`] : []),
      ...(CRON_CONFIG.test(body) ? [`${name}: a cron trigger`] : []),
    ];
  });

/** The pool's own `.ts` source under `dir` (every folder below it), keyed `src/<path>`; tests and the test harness are not pool code. */
const sourceFilesIn = (dir: string): { [name: string]: string } =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .map((file) => file.replaceAll(String.fromCharCode(92), '/'))
      .filter((file) => file.endsWith('.ts') && !basename(file).endsWith('.test.ts') && basename(file) !== 'test-pool.ts')
      .map((file) => [`src/${file}`, readFileSync(join(dir, file), 'utf8')]),
  );

const poolFiles = (): { [name: string]: string } => {
  const migrations = readdirSync(here('../migrations/')).filter((file) => file.endsWith('.sql'));
  return {
    ...sourceFilesIn(fileURLToPath(here('.'))),
    ...Object.fromEntries(migrations.map((file) => [`migrations/${file}`, readFileSync(here(`../migrations/${file}`), 'utf8')])),
    'wrangler.jsonc': readFileSync(here('../wrangler.jsonc'), 'utf8'),
  };
};

describe('the pool has no path that deletes the ledger', () => {
  it('finds no DELETE on the ledger tables and no scheduled trigger in the source, the migrations, or the Worker config', () => {
    const files = poolFiles();
    // The migration that refuses a delete is the allowed exception: it says `BEFORE DELETE`, not `DELETE FROM`, so it passes on its own text. Check the scan reached it.
    expect(Object.keys(files)).toContain('migrations/0009_ledger_no_delete.sql');
    expect(Object.keys(files)).toContain('src/identity.ts');
    expect(offences(files)).toEqual([]);
  });

  // One row per planted case, so each fails on its own when its regex is missing.
  it.each([
    ['DELETE FROM deposits', 'await env.DB.prepare("DELETE FROM deposits WHERE account = ?")', 'DELETE FROM the ledger'],
    ['delete from Contributors', 'delete  from  Contributors', 'DELETE FROM the ledger'],
    ['INSERT OR REPLACE INTO deposits', 'INSERT OR REPLACE INTO deposits (id) VALUES (1)', 'a REPLACE that deletes a ledger row'],
    ['REPLACE INTO deposits', 'REPLACE INTO deposits (id) VALUES (1)', 'a REPLACE that deletes a ledger row'],
    ['UPDATE OR REPLACE deposits', 'UPDATE OR REPLACE deposits SET id = 2', 'a REPLACE that deletes a ledger row'],
    ['ON CONFLICT REPLACE', 'CREATE TABLE t (a TEXT, PRIMARY KEY (a) ON CONFLICT REPLACE)', 'a REPLACE that deletes a ledger row'],
    ['DROP TABLE deposits', 'DROP TABLE deposits', 'a DROP TABLE that deletes ledger rows'],
    ['drop table if exists Contributors', 'drop table if exists Contributors;', 'a DROP TABLE that deletes ledger rows'],
    ['a quoted DELETE FROM "deposits"', 'DELETE FROM "deposits"', 'DELETE FROM the ledger'],
    ['a qualified DELETE FROM main.deposits', 'DELETE FROM main.deposits', 'DELETE FROM the ledger'],
    ['a bracketed DELETE FROM [main].[contributors]', 'DELETE FROM [main].[contributors]', 'DELETE FROM the ledger'],
    ['a quoted REPLACE INTO "deposits"', 'REPLACE INTO "deposits" (id) VALUES (1)', 'a REPLACE that deletes a ledger row'],
    ['a qualified UPDATE OR REPLACE main.deposits', 'UPDATE OR REPLACE main.deposits SET id = 2', 'a REPLACE that deletes a ledger row'],
    ['a quoted DROP TABLE "contributors"', 'DROP TABLE "contributors"', 'a DROP TABLE that deletes ledger rows'],
    ['a qualified DROP TABLE main.deposits', 'DROP TABLE IF EXISTS main.deposits', 'a DROP TABLE that deletes ledger rows'],
    ['a scheduled method', 'export default { fetch, scheduled(event, env) {} }', 'a scheduled handler'],
    ['a scheduled shorthand', 'export default { fetch, scheduled }', 'a scheduled handler'],
    ['a leading scheduled shorthand', 'export default { scheduled, fetch }', 'a scheduled handler'],
    ['a crons array', '{ "triggers": { "crons": ["0 3 * * *"] } }', 'a cron trigger'],
  ])('names %s', (_label, text, offence) => {
    expect(offences({ planted: text })).toEqual([`planted: ${offence}`]);
  });

  it('reads a source file in a subfolder of src', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-guard-'));
    try {
      mkdirSync(join(dir, 'jobs'));
      writeFileSync(join(dir, 'jobs', 'sweep.ts'), 'await db.prepare("DELETE FROM deposits")');
      writeFileSync(join(dir, 'jobs', 'sweep.test.ts'), 'DELETE FROM deposits');
      writeFileSync(join(dir, 'jobs', 'test-pool.ts'), 'DELETE FROM deposits');
      expect(offences(sourceFilesIn(dir))).toEqual(['src/jobs/sweep.ts: DELETE FROM the ledger']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets the token sweep, a comment, and the refusing trigger pass', () => {
    expect(offences({ f: "DELETE FROM tokens WHERE expires_at <= ?" })).toEqual([]);
    expect(offences({ g: '// the old plan was DELETE FROM deposits\n-- DELETE FROM deposits' })).toEqual([]);
    expect(offences({ h: "CREATE TRIGGER deposits_no_delete BEFORE DELETE ON deposits BEGIN SELECT RAISE(ABORT, 'x'); END;" })).toEqual([]);
  });
});
