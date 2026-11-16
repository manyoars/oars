import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { objectAt, parseJson } from './json.js';
import { main } from './run-fake.js';
import { FLEET, retestText, taskSet } from './test-fixtures.js';

const fixedClock = (): (() => Date) => {
  let ticks = 0;
  return () => new Date(Date.UTC(2026, 10, 16, 12, 0, ticks++));
};

describe('run-fake', () => {
  it('runs the demo retest and writes an unsigned run book', async () => {
    const out = await mkdtemp(join(tmpdir(), 'fleet-out-'));
    try {
      const lines: string[] = [];
      expect(await main(['--out', out], (line) => lines.push(line), fixedClock())).toBe(0);
      expect(lines[0]).toBe('order o-1 (retest, task set v1): complete');
      expect(lines[1]).toBe('runs: 53 written, 48 valid, 5 void (cap 60)');
      expect((await readFile(join(out, 'o-1.run-book.jsonl'), 'utf8')).trimEnd().split('\n')).toHaveLength(54);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('runs the whole chain and prints one line per output file', async () => {
    const out = await mkdtemp(join(tmpdir(), 'fleet-out-'));
    try {
      const lines: string[] = [];
      expect(await main(['--out', out], (line) => lines.push(line), fixedClock())).toBe(0);
      expect(lines.slice(2).map((line) => line.replace(out, '<out>').replaceAll('\\', '/'))).toEqual([
        'run book (unsigned): <out>/o-1.run-book.jsonl',
        'store folder before-playwright: <out>/o-1.stores/before-playwright/store (24 sessions)',
        'store folder after-playwright: <out>/o-1.stores/after-playwright/store (24 sessions)',
        'rows before-playwright: <out>/o-1.before-playwright.rows.json (24 sessions, min 3)',
        'rows after-playwright: <out>/o-1.after-playwright.rows.json (24 sessions, min 3)',
      ]);
      const book = (await readFile(join(out, 'o-1.run-book.jsonl'), 'utf8')).trimEnd().split('\n').slice(1).map((line) => objectAt(parseJson(line, 'run line'), 'run line'));
      expect(book.filter((run) => run.void === null).every((run) => typeof run.poolSessionId === 'string')).toBe(true);
      expect(book.filter((run) => run.void !== null).every((run) => run.poolSessionId === null)).toBe(true);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('prints the voided status and exits 1 when the task set changes mid-order', async () => {
    const out = await mkdtemp(join(tmpdir(), 'fleet-out-'));
    try {
      const lines: string[] = [];
      expect(await main(['--out', out, '--change-task-set-at', '3'], (line) => lines.push(line), fixedClock())).toBe(1);
      expect(lines[0]).toBe('order o-1 (retest, task set v1): voided');
      expect(lines[1]).toBe('runs: 3 written, 0 valid, 3 void (cap 60)');
      expect(lines.some((line) => line.startsWith('store folder'))).toBe(false);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('reads an order, fleet manifest, and task-set folder, and exits 1 on an incomplete order, 2 on a bad order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-in-'));
    try {
      await writeFile(join(dir, 'order.json'), retestText({ runCap: 5 }));
      await writeFile(join(dir, 'fleet.json'), JSON.stringify(FLEET));
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(taskSet(2)));
      const lines: string[] = [];
      const args = ['--order', join(dir, 'order.json'), '--fleet', join(dir, 'fleet.json'), '--taskset', dir, '--out', dir];
      expect(await main(args, (line) => lines.push(line), fixedClock())).toBe(1);
      expect(lines.some((line) => line.startsWith('short: '))).toBe(true);
      await writeFile(join(dir, 'order.json'), '{');
      expect(await main(args, (line) => lines.push(line), fixedClock())).toBe(2);
      expect(lines.at(-1)).toMatch(/^run-fake: order is not valid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-numeric --change-task-set-at with a message and exit 2', async () => {
    const lines: string[] = [];
    expect(await main(['--change-task-set-at', 'soon'], (line) => lines.push(line), fixedClock())).toBe(2);
    expect(lines).toEqual(['run-fake: --change-task-set-at needs a run number, got "soon"']);
  });

  it('refuses an --out inside a git repository with exit 2 and writes nothing', async () => {
    const inside = join(dirname(fileURLToPath(import.meta.url)), '..', '.guard-out');
    const lines: string[] = [];
    expect(await main(['--out', inside], (line) => lines.push(line), fixedClock())).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^run-fake: The output folder is inside a git repository/);
    expect(existsSync(inside)).toBe(false);
  });

  it('clears the staging folder when the chain fails between the runs and the store folders', async () => {
    const out = await mkdtemp(join(tmpdir(), 'fleet-out-'));
    try {
      // A folder where the run book belongs makes the write fail after every run is staged and before buildStores.
      await mkdir(join(out, 'o-1.run-book.jsonl'));
      const lines: string[] = [];
      expect(await main(['--out', out], (line) => lines.push(line), fixedClock())).toBe(2);
      expect(lines.at(-1)).toMatch(/^run-fake: /);
      expect(existsSync(join(out, 'o-1.staging'))).toBe(false);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
