import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadStore } from '../../cli/src/sessions/store.js';
import { CLEAN, makeFake, type Script } from './fake-harness.js';
import { parseJson } from './json.js';
import { parseOrder } from './order.js';
import { runOrder } from './runner.js';
import { serializeRunBook, type RunBook } from './runbook.js';
import { buildStores, folderOf, makeStager, readStores, type StoreFolder } from './stores.js';
import { FLEET, retestText, taskSet } from './test-fixtures.js';

const stepClock = (): (() => Date) => {
  let ticks = 0;
  return () => new Date(Date.UTC(2026, 10, 16, 12, 0, ticks++));
};

let root = '';
let fakeHome = '';
const saved = { APPDATA: process.env.APPDATA, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

// APPDATA and the home folders point at an empty temp folder for every test: any code that reached for the real store would write there, and a test sees it.
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet-stores-'));
  fakeHome = join(root, 'home');
  await mkdir(fakeHome);
  process.env.APPDATA = fakeHome;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.XDG_CONFIG_HOME = fakeHome;
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const TERMS = 'zorblax-fake-term';

const order = (patch: { repeats?: number; runCap?: number } = {}) => parseOrder(retestText({ repeats: patch.repeats ?? 3, runCap: patch.runCap ?? 80 }), FLEET);

/** Runs an order through the fake with the stager on, and builds the store folders; returns the book, the folders, and the stager. */
const chain = async (script: Script, tasks: number, patch: { repeats?: number; runCap?: number } = {}): Promise<{ book: RunBook; folders: StoreFolder[] }> => {
  const stager = makeStager(join(root, 'staging'));
  const book = await runOrder({ order: order(patch), taskSet: taskSet(tasks), fleet: FLEET, adapter: makeFake(script), clock: stepClock(), operator: 'Many Oars Co.', stage: stager.stage });
  return { book, folders: await buildStores(book, stager, join(root, 'out')) };
};

describe('store folders per side and arm', () => {
  it('names one folder per side and arm', () => {
    expect(folderOf('before', 'playwright')).toBe('before-playwright');
    expect(folderOf(null, 'no-tool')).toBe('no-tool');
  });

  it('puts each side and arm valid runs in its own store folder, void runs in none, and fills the pool session id', async () => {
    const { book, folders } = await chain((request) => (request.sequence % 9 === 0 ? { exit: 'rate-limit' } : {}), 8);
    expect(folders.map((folder) => folder.name)).toEqual(['before-playwright', 'after-playwright']);
    for (const folder of folders) {
      const stored = (await loadStore(folder.storeDir)).sessions.map((session) => session.session).sort();
      const wanted = book.runs.filter((run) => run.void === null && folderOf(run.side, run.arm) === folder.name).map((run) => run.poolSessionId ?? '');
      expect(wanted).toHaveLength(24);
      expect(stored).toEqual([...wanted].sort());
      console.log(`store folder ${folder.name}: ${folder.storeDir} (${String(stored.length)} sessions)`);
    }
    expect(book.runs.filter((run) => run.void !== null).every((run) => run.poolSessionId === null)).toBe(true);
    expect(await readdir(join(root, 'staging')).catch(() => [])).toEqual([]);
  });

  it('reads no real store: the fake home that APPDATA names stays empty', async () => {
    const { folders } = await chain(CLEAN, 2);
    expect(folders).toHaveLength(2);
    expect(await readdir(fakeHome)).toEqual([]);
  });

  it('stores nothing for an order that the task set change voided', async () => {
    const { book, folders } = await chain((request) => (request.sequence === 3 ? { taskSetVersion: 'changed' } : {}), 2);
    expect(book.header.status).toBe('voided');
    expect(book.runs.every((run) => run.poolSessionId === null)).toBe(true);
    expect(folders).toEqual([]);
  });

  it('voids a clean run whose transcript has no session id and reruns it', async () => {
    const { book } = await chain((request) => (request.sequence === 1 ? { transcriptText: 'not a claude code transcript\n' } : {}), 1, { repeats: 1, runCap: 10 });
    expect(book.runs.map((run) => run.void)).toEqual(['transcript-missing', null, null]);
  });

  it('is byte-identical on a second run', async () => {
    const first = serializeRunBook((await chain(CLEAN, 2, { repeats: 1 })).book);
    const second = serializeRunBook((await chain(CLEAN, 2, { repeats: 1 })).book);
    expect(second).toBe(first);
  });
});

describe('the real-work-table read over each store folder', () => {
  it('gives one row file per side and arm whose session counts match the run book, and prints a cell under 3 as thin', async () => {
    // The tool is called in all of the before sessions and in only 2 of the after ones.
    const { book, folders } = await chain((request) => (request.side === 'after' && !(request.repeat === 1 && request.taskId <= 't2') ? { noToolCall: true } : {}), 8);
    await writeFile(join(root, 'terms.txt'), `${TERMS}\n`);
    const rows = await readStores(folders, { out: join(root, 'out'), orderId: 'o-1', terms: join(root, 'terms.txt'), date: '2026-11-16' });
    expect(rows.map((row) => row.file.slice(join(root, 'out').length + 1))).toEqual(['o-1.before-playwright.rows.json', 'o-1.after-playwright.rows.json']);
    for (const row of rows) {
      // The saved file is the table the read returned.
      expect(parseJson(await readFile(row.file, 'utf8'), 'rows file')).toEqual(parseJson(JSON.stringify(row.table), 'table'));
      expect(row.table.header.counted).toBe(book.runs.filter((run) => run.void === null && folderOf(run.side, run.arm) === row.folder).length);
      expect(row.table.header.minSessions).toBe(3);
      console.log(`${row.folder}: ${String(row.table.header.counted)} sessions; ${row.table.rows.map((entry) => (entry.kind === 'server' || entry.kind === 'skill' ? `${entry.kind} ${entry.name} n=${String(entry.sessions)}${entry.thin ? ' thin' : ''}` : `${entry.kind} n=${String(entry.sessions)}`)).join('; ')}`);
    }
    const server = (index: number) => rows[index]?.table.rows.find((row) => row.kind === 'server' && row.name === 'playwright');
    expect(server(0)).toMatchObject({ sessions: 24, thin: false });
    expect(server(1)).toMatchObject({ sessions: 2, thin: true, failureRate: null });
  });

  it('refuses to write the stores or the rows inside a git repository, for a direct caller too', async () => {
    const inside = join(dirname(fileURLToPath(import.meta.url)), '..', '.guard-out');
    const stager = makeStager(join(root, 'staging'));
    const book = await runOrder({ order: order({ repeats: 1 }), taskSet: taskSet(1), fleet: FLEET, adapter: makeFake(CLEAN), clock: stepClock(), operator: 'Many Oars Co.', stage: stager.stage });
    await expect(buildStores(book, stager, inside)).rejects.toThrow(/inside a git repository/);
    await expect(readStores([], { out: inside, orderId: 'o-1', terms: TERMS, date: '2026-11-16' })).rejects.toThrow(/inside a git repository/);
    expect(existsSync(inside)).toBe(false);
  });
});
