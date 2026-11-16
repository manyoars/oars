// `npm run run-fake -w packages/fleet-runner -- [--order <file>] [--taskset <folder>] [--fleet <file>] [--out <folder>]`: runs an order end to end through the scripted fake
// harness and writes the unsigned run book. With no flags it runs a demo retest (the test manifest of 8 tasks, 3 repeats, every 9th run hitting a rate limit).
// It opens no network, reads no session store, and spends nothing; a real harness adapter is a later brief.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeFake } from './fake-harness.js';
import { loadTaskSet, parseFleet } from './manifest.js';
import { parseOrder } from './order.js';
import { runOrder } from './runner.js';
import { serializeRunBook } from './runbook.js';
import { FLEET, retestText, taskSet } from './test-fixtures.js';

const flag = (argv: string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

export const main = async (argv: string[], print: (line: string) => void, clock: () => Date = () => new Date()): Promise<number> => {
  const orderPath = flag(argv, '--order');
  const tasksetPath = flag(argv, '--taskset');
  const fleetPath = flag(argv, '--fleet');
  const out = resolve(flag(argv, '--out') ?? (await mkdtemp(join(tmpdir(), 'fleet-run-fake-'))));
  try {
    const fleet = fleetPath === undefined ? FLEET : parseFleet(await readFile(fleetPath, 'utf8'));
    const order = parseOrder(orderPath === undefined ? retestText({ runCap: 60 }) : await readFile(orderPath, 'utf8'), fleet);
    const tasks = tasksetPath === undefined ? taskSet(8) : await loadTaskSet(tasksetPath);
    const book = await runOrder({ order, taskSet: tasks, fleet, adapter: makeFake((request) => (request.sequence % 9 === 0 ? { exit: 'rate-limit' } : {})), clock, operator: 'Many Oars Co.' });
    const path = join(out, `${order.orderId}.run-book.jsonl`);
    await writeFile(path, serializeRunBook(book));
    const voided = book.runs.filter((run) => run.void !== null).length;
    print(`order ${order.orderId} (${order.line}, task set ${order.taskSetVersion}): ${book.header.status}`);
    print(`runs: ${String(book.runs.length)} written, ${String(book.runs.length - voided)} valid, ${String(voided)} void (cap ${String(order.runCap)})`);
    for (const cell of book.header.shortCells) print(`short: ${cell.taskId} ${cell.arm} ${cell.side ?? '-'} ${String(cell.have)}/${String(cell.want)}`);
    print(`run book (unsigned): ${path}`);
    return book.header.status === 'complete' ? 0 : 1;
  } catch (error) {
    print(`run-fake: ${error instanceof Error ? error.message : 'failed'}`);
    return 2;
  }
};
