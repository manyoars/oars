import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

  it('prints the voided status and exits 1 when the task set changes mid-order', async () => {
    const out = await mkdtemp(join(tmpdir(), 'fleet-out-'));
    try {
      const lines: string[] = [];
      expect(await main(['--out', out, '--change-task-set-at', '3'], (line) => lines.push(line), fixedClock())).toBe(1);
      expect(lines[0]).toBe('order o-1 (retest, task set v1): voided');
      expect(lines[1]).toBe('runs: 3 written, 0 valid, 3 void (cap 60)');
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
});
