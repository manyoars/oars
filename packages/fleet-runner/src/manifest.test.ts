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

describe('the package fleet manifest', () => {
  it('names the Claude Code on Bedrock and Codex on Azure harnesses with their real pins', () => {
    expect(FLEET.version).toBe('fleet-1');
    expect(FLEET.harnesses).toEqual([
      { name: 'claude-code-bedrock', version: '2.1.326', provider: 'bedrock', region: 'us-east-1', modelIds: ['global.anthropic.claude-sonnet-5-5'] },
      { name: 'codex-azure', version: '0.169.0', provider: 'azure-openai', region: 'global-standard', modelIds: ['gpt-6.1-sol'] },
    ]);
  });
});
