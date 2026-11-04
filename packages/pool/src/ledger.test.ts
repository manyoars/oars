// The ledger plane has no expiry: the database refuses a delete of a `deposits` row or a `contributors` record, and a guard over the pool's own source fails
// when a delete path or a scheduled trigger appears. A legally required erasure would be one new migration that drops the two `*_no_delete` triggers.
import { readdirSync, readFileSync } from 'node:fs';
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

  // SQLite runs a delete trigger for the row a REPLACE conflict removes only when `recursive_triggers` is on. Pinned here, so the source guard below
  // (which names REPLACE) rests on a check and not on a belief; if D1 ever turns it on, this fails and the guard's REPLACE rule can be relaxed.
  it('does not run the delete trigger for a row an INSERT OR REPLACE removes', async () => {
    const db = await pool.db();
    const before = await count('deposits');
    await db
      .prepare("INSERT OR REPLACE INTO deposits (account, id, skeleton, deltas, tier, counted_at, ingest) SELECT account, id, skeleton, deltas, tier, counted_at, ingest FROM deposits WHERE id = '0000000000008601'")
      .run();
    expect(await count('deposits')).toBe(before);
  }, 60_000);
});

/** SQL or TypeScript text with its comments removed, so prose that names a delete is not one. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--).*$/gm, '');

const LEDGER_DELETE = /\bDELETE\s+FROM\s+(deposits|contributors)\b/i;
// `REPLACE` as a conflict clause deletes the row it replaces without running the delete trigger (the test above pins that), and so does `DROP TABLE`.
const LEDGER_REPLACE = /\bREPLACE\s+INTO\s+(deposits|contributors)\b|\bON\s+CONFLICT\s+REPLACE\b|\bINSERT\s+OR\s+REPLACE\b|\bUPDATE\s+OR\s+REPLACE\s+(deposits|contributors)\b/i;
const LEDGER_DROP = /\bDROP\s+TABLE\s+(IF\s+EXISTS\s+)?(deposits|contributors)\b/i;
const SCHEDULED_HANDLER = /\bscheduled\s*(\(|:|=)/;
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

const poolFiles = (): { [name: string]: string } => {
  const sources = readdirSync(here('.')).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'test-pool.ts');
  const migrations = readdirSync(here('../migrations/')).filter((file) => file.endsWith('.sql'));
  return {
    ...Object.fromEntries(sources.map((file) => [`src/${file}`, readFileSync(here(file), 'utf8')])),
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

  it('names a planted delete, replace, drop, scheduled handler, and cron', () => {
    expect(offences({ a: 'await env.DB.prepare("DELETE FROM deposits WHERE account = ?")' })).toEqual(['a: DELETE FROM the ledger']);
    expect(offences({ b: 'delete  from  Contributors' })).toEqual(['b: DELETE FROM the ledger']);
    expect(offences({ c: 'INSERT OR REPLACE INTO deposits (id) VALUES (1)' })).toEqual(['c: a REPLACE that deletes a ledger row']);
    expect(offences({ c2: 'REPLACE INTO deposits (id) VALUES (1)' })).toEqual(['c2: a REPLACE that deletes a ledger row']);
    expect(offences({ c3: 'UPDATE OR REPLACE deposits SET id = 2' })).toEqual(['c3: a REPLACE that deletes a ledger row']);
    expect(offences({ c4: 'CREATE TABLE t (a TEXT, PRIMARY KEY (a) ON CONFLICT REPLACE)' })).toEqual(['c4: a REPLACE that deletes a ledger row']);
    expect(offences({ c5: 'DROP TABLE deposits' })).toEqual(['c5: a DROP TABLE that deletes ledger rows']);
    expect(offences({ c6: 'drop table if exists Contributors;' })).toEqual(['c6: a DROP TABLE that deletes ledger rows']);
    expect(offences({ d: 'export default { fetch, scheduled(event, env) {} }' })).toEqual(['d: a scheduled handler']);
    expect(offences({ e: '{ "triggers": { "crons": ["0 3 * * *"] } }' })).toEqual(['e: a cron trigger']);
  });

  it('lets the token sweep, a comment, and the refusing trigger pass', () => {
    expect(offences({ f: "DELETE FROM tokens WHERE expires_at <= ?" })).toEqual([]);
    expect(offences({ g: '// the old plan was DELETE FROM deposits\n-- DELETE FROM deposits' })).toEqual([]);
    expect(offences({ h: "CREATE TRIGGER deposits_no_delete BEFORE DELETE ON deposits BEGIN SELECT RAISE(ABORT, 'x'); END;" })).toEqual([]);
  });
});
