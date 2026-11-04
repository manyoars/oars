// The mode every hook write asks for, seen at the call so it holds on a platform where a file's mode cannot be read back. `hook.test.ts` and `hook-process.test.ts` stat the
// created files where the platform keeps modes; this runs everywhere.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ async: [] as Array<{ file: string; options: unknown }>, sync: [] as Array<{ file: string; options: unknown }> }));

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    appendFile: (file: string, data: string, options?: unknown) => {
      calls.async.push({ file: String(file), options });
      return actual.appendFile(file, data, options as never);
    },
  };
});

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync: (file: string, data: string, options?: unknown) => {
      calls.sync.push({ file: String(file), options });
      actual.appendFileSync(file, data, options as never);
    },
  };
});

const { crossingsPath, gateHook, registryCachePath } = await import('./hook.js');
const { indexFile } = await import('./novelty.js');
const { runHookProcess } = await import('./hook-process.js');

const made: string[] = [];
afterEach(() => {
  calls.async.length = 0;
  calls.sync.length = 0;
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const folder = (): string => {
  const one = mkdtempSync(join(tmpdir(), 'oars-gate-mode-'));
  made.push(one);
  return one;
};

const PAYLOAD = JSON.stringify({ session_id: 's1', tool_use_id: 'u1', tool_name: 'Bash', tool_input: { command: 'npm install left-pad@1.3.0' }, cwd: tmpdir(), permission_mode: 'default' });
const base = (storeDir: string) => ({ storeDir, now: () => Date.parse('2026-11-04T10:00:00.000Z'), clock: () => 0, deadlineMs: 800 });

describe('every file the hook creates is asked for private to the user', () => {
  it('appends the record, the registry answers, and the index with mode 0600', async () => {
    const store = folder();
    await gateHook(PAYLOAD, { ...base(store), registry: () => Promise.resolve({ state: 'found', latest: '1.3.0', created: null }) });
    const modes = new Map(calls.async.map((call) => [call.file, call.options]));
    for (const file of [crossingsPath(store), registryCachePath(store), indexFile(store)]) {
      expect(modes.get(file), file).toMatchObject({ mode: 0o600 });
    }
  });

  it('appends the staged record at the deadline with mode 0600', async () => {
    const store = folder();
    const exit = vi.fn();
    void runHookProcess({
      stdin: () => Promise.resolve(PAYLOAD),
      deps: (stage) => ({ ...base(store), stage, append: () => new Promise<void>(() => undefined) }),
      exit,
      deadlineMs: 100,
    });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 2_000 });
    expect(calls.sync).toEqual([{ file: crossingsPath(store), options: { mode: 0o600 } }]);
  });
});
