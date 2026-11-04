// t776: `verify` lists a folder no allow entry names and never opens a file in it, not even a subagent's `.meta.json`.
import type * as fsp from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const opened: string[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  const readFile = vi.fn(actual.readFile);
  readFile.mockImplementation((...args: Parameters<typeof actual.readFile>) => {
    if (typeof args[0] === 'string') opened.push(args[0]);
    return actual.readFile(...args);
  });
  return { ...actual, readFile };
});

const { deposit, skippedFolders } = await import('./store.js');
const { cleanup, NOW, stage } = await import('./test-support.js');

afterEach(cleanup);

describe('the scope listing of a folder off the allowlist', () => {
  it('opens no file in it, including a subagent meta file', async () => {
    const staged = stage();
    const subagents = join(staged.projectsRoot, 'omega-app', 'sess-one', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, 'agent-a.jsonl'), '{}\n');
    writeFileSync(join(subagents, 'agent-a.meta.json'), '{"agentType":"x","toolUseId":"t"}');
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    opened.length = 0;
    expect(await skippedFolders(staged.runtime)).toEqual({ folders: 1, transcripts: 0, names: ['omega-app'] });
    expect(opened.filter((path) => path.includes('omega-app'))).toEqual([]);
  });
});
