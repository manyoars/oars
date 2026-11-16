import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTaskSet, parseFleet, parseTaskSet } from './manifest.js';
import { FLEET, taskSet } from './test-fixtures.js';

describe('manifests', () => {
  it('round-trips the fleet manifest', () => {
    expect(parseFleet(JSON.stringify(FLEET))).toEqual(FLEET);
  });

  it('reads a task-set manifest from a folder', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'fleet-taskset-'));
    try {
      await writeFile(join(folder, 'manifest.json'), JSON.stringify(taskSet(2)));
      expect(await loadTaskSet(folder)).toEqual(taskSet(2));
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('rejects an empty or duplicate task list and a non-string model id', () => {
    expect(() => parseTaskSet(JSON.stringify({ ...taskSet(2), tasks: [] }))).toThrow(/empty/);
    expect(() => parseTaskSet(JSON.stringify({ ...taskSet(2), tasks: [{ id: 'a', category: 'x' }, { id: 'a', category: 'x' }] }))).toThrow(/distinct/);
    expect(() => parseFleet(JSON.stringify({ version: 'f', harnesses: [{ name: 'h', version: '1', provider: 'p', region: 'r', modelIds: [1] }] }))).toThrow(/strings/);
  });
});
