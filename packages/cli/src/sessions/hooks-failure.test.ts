import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as HookIndex from './hook-index.js';
import { runHook } from './hooks.js';
import { readSteps } from './steps.js';
import { cleanup, NOW, stage } from './test-support.js';

vi.mock('./hook-index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof HookIndex>()),
  readIndex: () => Promise.reject(new Error('cannot read the index for dev@corp.example\nsecond line')),
}));

afterEach(cleanup);

describe('a lookup hook that fails', () => {
  it('logs an error recall row whose line is redacted like every other text the store keeps', async () => {
    const staged = stage();
    await runHook('post-tool', JSON.stringify({ session_id: 's1', tool_name: 'Bash', error: 'Exit code 1\nboom' }), staged.runtime, () => NOW);
    const rows = await readSteps(staged.storeDir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step: 'recall', trigger: 'post-tool', status: 'error' });
    expect(rows[0]?.error).toContain('cannot read the index');
    expect(rows[0]?.error).not.toContain('dev@corp.example');
    expect(rows[0]?.key).toMatch(/^[0-9a-f]{16}$/);
  });
});
