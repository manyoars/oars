import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as HookIndex from './hook-index.js';
import { runHook } from './hooks.js';
import { readSteps } from './steps.js';
import { cleanup, NOW, stage } from './test-support.js';

// The home folder is a stand-in the test controls: a throwing `homedir` (a service account with no home) and the path forms an
// operator's machine can produce.
const home = vi.hoisted(() => ({ read: (): string => 'C:\\Users\\alice' }));
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<object>()), homedir: () => home.read() }));

const reasons = vi.hoisted(() => ({ message: 'cannot read the index' }));
vi.mock('./hook-index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof HookIndex>()),
  readIndex: () => Promise.reject(new Error(reasons.message)),
}));

afterEach(() => {
  home.read = (): string => 'C:\\Users\\alice';
  reasons.message = 'cannot read the index';
  cleanup();
});

const failing = async (): Promise<string> => {
  const staged = stage();
  const result = await runHook('post-tool', JSON.stringify({ session_id: 's1', tool_name: 'Bash', error: 'Exit code 1\nboom' }), staged.runtime, () => NOW);
  expect(result).toBeUndefined();
  const [row] = await readSteps(staged.storeDir);
  expect(row?.status).toBe('error');
  return readFileSync(join(staged.storeDir, 'hook-calls.jsonl'), 'utf8');
};

describe('the failure line masks the home folder in any form', () => {
  it('resolves, with an unknown-error line, when the home folder cannot be read (spec 4.4)', async () => {
    home.read = (): string => {
      throw new Error('ENOENT: no home');
    };
    expect(await failing()).toContain('unknown error');
  });

  it.each([
    ['forward slashes', 'cannot open C:/Users/alice/AppData/x.json'],
    ['a lower-case drive', 'cannot open c:\\Users\\alice\\AppData\\x.json'],
  ])('reduces a home path written with %s to <home>', async (_name, message) => {
    reasons.message = message;
    const calls = await failing();
    expect(calls).toContain('<home>');
    expect(calls).not.toContain('alice');
  });

  it('leaves the message whole when the home folder is empty', async () => {
    home.read = (): string => '';
    reasons.message = 'cannot open the index';
    expect(await failing()).toContain('cannot open the index');
  });
});
