// The ledger plane has no expiry: the database refuses a delete of a `deposits` row or a `contributors` record, and a guard over the pool's own source fails
// when a delete path or a scheduled trigger appears. The one scheduled trigger allowed is the telemetry rollup (worker.ts calls `rollupRecent`), whose files name no ledger table. A legally required erasure would be one new migration that drops the two `*_no_delete` triggers.
import { createHash } from 'node:crypto';
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

  it('aborts a DELETE of a raw_objects row too: the raw tier\'s ledger row is never deleted', async () => {
    const { token, account } = await pool.signIn('github', stubUser('8603'));
    await pool.post('/v1/covenant/accept', { version: 'v1' }, token);
    const grant = { 'oars-redaction-version': '1', 'oars-capture-version': 'cap-1', 'oars-raw-consent': 'granted' };
    // The pool checks the hash, so the path carries the SHA-256 of the three bytes.
    const hash = createHash('sha256').update(new Uint8Array([1, 2, 3])).digest('hex');
    expect((await pool.send(`/v1/raw/${hash}/parts/1`, { method: 'PUT', body: new Uint8Array([1, 2, 3]) }, token, grant)).status).toBe(200);
    expect((await pool.send(`/v1/raw/${hash}/complete`, { method: 'POST', body: '{"parts":1,"bytes":3}' }, token, grant)).status).toBe(201);
    const db = await pool.db();
    const held = async (): Promise<unknown> => fieldOf(await db.prepare('SELECT COUNT(*) AS held FROM raw_objects WHERE account = ?').bind(account).first(), 'held');
    expect(await held()).toBe(1);
    await expect(db.prepare('DELETE FROM raw_objects').run()).rejects.toThrow(/ledger rows are never deleted/);
    await expect(db.prepare('DELETE FROM raw_objects WHERE sha256 = ?').bind(hash).run()).rejects.toThrow(/ledger rows are never deleted/);
    expect(await held()).toBe(1);
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
const LEDGER_TABLE = `(?:${OPEN}main${CLOSE}\\.)?${OPEN}(?:deposits|contributors|raw_objects)\\b`;
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

// The nightly telemetry rollup is the one scheduled job: `worker.ts` may carry the handler when it runs `rollupRecent`, and the Worker config may carry the cron that fires it. The rollup reads the telemetry
// record and writes its own table, so the files that hold it (checked by the test below) name no ledger table.
// "Runs it" is exact: there is one `scheduled` in the file, its body is this one statement and nothing else, and the config's cron list is this one entry. Anything more (a second job in the handler, a second cron) is an offence.
const ROLLUP_BODY = 'await rollupRecent(env, controller.scheduledTime);';
const ROLLUP_CRONS = '"17 3 * * *"';
/** The statements of the `scheduled` handler: what lies between the braces of its body, nested blocks included, or undefined when none is found. */
const scheduledBody = (body: string): string | undefined => {
  const from = body.search(/\bscheduled\b/);
  const opening = from < 0 ? null : /(?:=>|\))\s*\{/.exec(body.slice(from));
  if (opening === null) return undefined;
  const start = from + opening.index + opening[0].length;
  let depth = 1;
  for (let at = start; at < body.length; at += 1) {
    depth += body[at] === '{' ? 1 : body[at] === '}' ? -1 : 0;
    if (depth === 0) return body.slice(start, at).trim().replace(/\s+/g, ' ');
  }
  return undefined;
};
/** True when every `"crons"` in the config is an array of exactly the rollup's one entry. */
const onlyRollupCron = (body: string): boolean => {
  const arrays = [...body.matchAll(/"crons"\s*:\s*\[([^\]]*)\]/g)].map((one) => (one[1] ?? '').trim());
  return arrays.length === (body.match(/"crons"/g) ?? []).length && arrays.every((one) => one === ROLLUP_CRONS);
};
const ROLLUP_FILES = ['src/telemetry-rollup.ts', 'src/telemetry-fleet.ts'];
const LEDGER_NAME = /\b(?:deposits|contributors|raw_objects)\b/i;

/** What in `files` (name to text) would delete from the ledger or run it on a schedule. */
const offences = (files: { [name: string]: string }): string[] =>
  Object.entries(files).flatMap(([name, text]) => {
    const body = code(text);
    const rollupHandler = name === 'src/worker.ts' && (body.match(/\bscheduled\b/g) ?? []).length === 1 && scheduledBody(body) === ROLLUP_BODY;
    const rollupCron = name === 'wrangler.jsonc' && onlyRollupCron(body);
    return [
      ...(LEDGER_DELETE.test(body) ? [`${name}: DELETE FROM the ledger`] : []),
      ...(LEDGER_REPLACE.test(body) ? [`${name}: a REPLACE that deletes a ledger row`] : []),
      ...(LEDGER_DROP.test(body) ? [`${name}: a DROP TABLE that deletes ledger rows`] : []),
      ...(SCHEDULED_HANDLER.test(body) && !rollupHandler ? [`${name}: a scheduled handler`] : []),
      ...(CRON_CONFIG.test(body) && !rollupCron ? [`${name}: a cron trigger`] : []),
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
    ['DELETE FROM raw_objects', 'DELETE FROM raw_objects WHERE sha256 = ?', 'DELETE FROM the ledger'],
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

  it('lets only the telemetry rollup run on a schedule, and keeps its files clear of the ledger', () => {
    const files = poolFiles();
    // The rollup is the one scheduled job: worker.ts carries the handler, its body is exactly the one `rollupRecent` call, and the config carries exactly its one cron.
    expect(scheduledBody(code(files['src/worker.ts'] ?? ''))).toBe(ROLLUP_BODY);
    expect(code(files['wrangler.jsonc'] ?? '')).toMatch(CRON_CONFIG);
    expect(onlyRollupCron(code(files['wrangler.jsonc'] ?? ''))).toBe(true);
    expect(offences(files)).toEqual([]);
    for (const name of ROLLUP_FILES) {
      expect(Object.keys(files), name).toContain(name);
      expect(code(files[name] ?? ''), name).not.toMatch(LEDGER_NAME);
    }
    // The name guard cannot fall behind the ledger tables the delete guard knows: each must match.
    for (const table of ['deposits', 'contributors', 'raw_objects']) {
      expect(LEDGER_NAME.test(table), table).toBe(true);
      expect(new RegExp(`^${LEDGER_TABLE}$`, 'i').test(table), `${table} is a LEDGER_TABLE`).toBe(true);
    }
    // A handler that does not run the rollup, or one in another file, is still an offence.
    expect(offences({ 'src/worker.ts': 'export default { scheduled(event, env) { sweep(env); } }' })).toEqual(['src/worker.ts: a scheduled handler']);
    const handler = (statements: string): string => `export default { scheduled: async (controller: { scheduledTime: number }, env: Env): Promise<void> => { ${statements} } }`;
    expect(offences({ 'src/other.ts': handler(ROLLUP_BODY) })).toEqual(['src/other.ts: a scheduled handler']);
    expect(offences({ 'src/worker.ts': handler(ROLLUP_BODY) })).toEqual([]);
    expect(offences({ 'src/worker.ts': 'export default { scheduled(controller, env) { await rollupRecent(env, controller.scheduledTime); } }' })).toEqual([]);
    // A handler that also runs another job, or runs the rollup with a nested block, is an offence however it is ordered.
    expect(offences({ 'src/worker.ts': handler(`${ROLLUP_BODY} sweep(env);`) })).toEqual(['src/worker.ts: a scheduled handler']);
    expect(offences({ 'src/worker.ts': handler(`sweep(env); ${ROLLUP_BODY}`) })).toEqual(['src/worker.ts: a scheduled handler']);
    expect(offences({ 'src/worker.ts': handler(`if (env.DB) { ${ROLLUP_BODY} }`) })).toEqual(['src/worker.ts: a scheduled handler']);
    // A second handler after the rollup's own is an offence, though the first one is exact.
    expect(offences({ 'src/worker.ts': `${handler(ROLLUP_BODY)}\nconst again = { scheduled(event, env) { sweep(env); } };` })).toEqual(['src/worker.ts: a scheduled handler']);
    expect(offences({ 'src/worker.ts': 'export default { fetch }' })).toEqual([]);
    // The cron list is exactly the rollup's one entry.
    expect(offences({ 'wrangler.jsonc': '{ "triggers": { "crons": ["17 3 * * *"] } }' })).toEqual([]);
    expect(offences({ 'wrangler.jsonc': '{ "triggers": { "crons": ["17 3 * * *", "0 * * * *"] } }' })).toEqual(['wrangler.jsonc: a cron trigger']);
    expect(offences({ 'wrangler.jsonc': '{ "triggers": { "crons": ["0 * * * *"] } }' })).toEqual(['wrangler.jsonc: a cron trigger']);
    expect(offences({ 'wrangler.jsonc': '{ "triggers": { "crons": ["17 3 * * *"] }, "env": { "x": { "triggers": { "crons": ["5 * * * *"] } } } }' })).toEqual(['wrangler.jsonc: a cron trigger']);
    expect(offences({ 'wrangler.jsonc': '{ "triggers": { "crons": "17 3 * * *" } }' })).toEqual(['wrangler.jsonc: a cron trigger']);
    expect(offences({ 'src/other.json': '{ "crons": ["0 3 * * *"] }' })).toEqual(['src/other.json: a cron trigger']);
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
