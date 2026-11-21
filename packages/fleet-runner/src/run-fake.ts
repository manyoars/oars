// `npm run run-fake -w packages/fleet-runner -- [--order <file>] [--taskset <folder>] [--fleet <file>] [--out <folder>] [--terms <file>] [--change-task-set-at <run number>]`: runs an order end to end through the scripted fake
// harness, writes the unsigned run book, files each side and arm's valid runs in its own store folder, runs the `real-work-table` read over each, and saves the rows.
// With no flags it runs a demo retest (the test manifest of 8 tasks, 3 repeats, every 9th run hitting a rate limit).
// It opens no network, reads no session store, and spends nothing; a real harness adapter is a later brief.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeFake, type Script } from './fake-harness.js';
import { loadTaskSet, parseFleet, type TaskSetManifest } from './manifest.js';
import { parseOrder } from './order.js';
import { runOrder } from './runner.js';
import { serializeRunBook, type RunBook } from './runbook.js';
import { refuseInsideRepository } from '../../pool/scripts/real-work-table.js';
import { buildStores, makeStager, readStores, type Stager } from './stores.js';
import { FLEET, retestText, taskSet } from './test-fixtures.js';

const flag = (argv: string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

// The no-flags demo: the default order text and task set, and the adapter script (the run at `changeAt` swaps the task-set version, every 9th run hits a rate limit).
export const demoInputs = (): { orderText: string; taskSet: TaskSetManifest } => ({ orderText: retestText({ runCap: 60 }), taskSet: taskSet(8) });

export const demoScript = (changeAt: number): Script => (request) => (request.sequence === changeAt ? { taskSetVersion: 'changed' } : request.sequence % 9 === 0 ? { exit: 'rate-limit' } : {});

export const runsLine = (book: RunBook, runCap: number): string => {
  const voided = book.runs.filter((run) => run.void !== null).length;
  return `runs: ${String(book.runs.length)} written, ${String(book.runs.length - voided)} valid, ${String(voided)} void (cap ${String(runCap)})`;
};

export const main = async (argv: string[], print: (line: string) => void, clock: () => Date = () => new Date()): Promise<number> => {
  const orderPath = flag(argv, '--order');
  const tasksetPath = flag(argv, '--taskset');
  const fleetPath = flag(argv, '--fleet');
  const changeText = flag(argv, '--change-task-set-at') ?? '0';
  const changeAt = Number(changeText);
  if (!Number.isInteger(changeAt) || changeAt < 0) {
    print(`run-fake: --change-task-set-at needs a run number, got "${changeText}"`);
    return 2;
  }
  const out = resolve(flag(argv, '--out') ?? (await mkdtemp(join(tmpdir(), 'fleet-run-fake-'))));
  let stager: Stager | null = null;
  try {
    // Before anything runs: the run book, signature, stores, staging copies, and rows are published by the page build, never committed.
    refuseInsideRepository(out, 'run book outputs');
    const fleet = fleetPath === undefined ? FLEET : parseFleet(await readFile(fleetPath, 'utf8'));
    const demo = demoInputs();
    const order = parseOrder(orderPath === undefined ? demo.orderText : await readFile(orderPath, 'utf8'), fleet);
    const tasks = tasksetPath === undefined ? demo.taskSet : await loadTaskSet(tasksetPath);
    stager = makeStager(join(out, `${order.orderId}.staging`));
    const book = await runOrder({ order, taskSet: tasks, fleet, adapter: makeFake(demoScript(changeAt)), clock, operator: 'Many Oars Co.', stage: stager.stage });
    const path = join(out, `${order.orderId}.run-book.jsonl`);
    await writeFile(path, serializeRunBook(book));
    print(`order ${order.orderId} (${order.line}, task set ${order.taskSetVersion}): ${book.header.status}`);
    print(runsLine(book, order.runCap));
    for (const cell of book.header.shortCells) print(`short: ${cell.taskId} ${cell.arm} ${cell.side ?? '-'} ${String(cell.have)}/${String(cell.want)}`);
    print(`run book (unsigned): ${path}`);
    const folders = await buildStores(book, stager, out);
    for (const folder of folders) print(`store folder ${folder.name}: ${folder.storeDir} (${String(folder.sessionIds.length)} sessions)`);
    // The demo's exclusion list is invented; an operator passes the real one with --terms.
    const termsFile = flag(argv, '--terms') ?? join(out, `${order.orderId}.demo-terms.txt`);
    if (flag(argv, '--terms') === undefined) {
      await writeFile(termsFile, 'zorblax-demo-term\n');
      print(`demo exclusion terms: ${termsFile}`);
    }
    for (const rows of await readStores(folders, { out, orderId: order.orderId, terms: termsFile, date: book.header.endDate })) {
      print(`rows ${rows.folder}: ${rows.file} (${String(rows.table.header.counted)} sessions, min ${String(rows.table.header.minSessions)})`);
    }
    print(`owners file: ${join(out, `${order.orderId}.stores`, 'owners.json')}`);
    return book.header.status === 'complete' ? 0 : 1;
  } catch (error) {
    print(`run-fake: ${error instanceof Error ? error.message : 'failed'}`);
    return 2;
  } finally {
    // The staging folder holds full transcript copies: it goes on every exit path, not only after buildStores.
    await stager?.clear();
  }
};
