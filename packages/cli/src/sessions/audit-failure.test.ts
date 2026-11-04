// One raw file that cannot be read reports that session `not run`, and the audit goes on.
import type * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A real unreadable file (EACCES, EBUSY) cannot be made portably, so `readFile` fails for one path.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsp>();
  const readFile = vi.fn(actual.readFile);
  readFile.mockImplementation((file, options) =>
    typeof file === 'string' && file.endsWith(join('raw', 'proj', 'errors-a.jsonl')) ? Promise.reject(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })) : actual.readFile(file, options),
  );
  return { ...actual, readFile };
});

const { auditStore } = await import('./audit.js');
const { deposit, loadStore, readSkeletons } = await import('./store.js');
const { cleanup, NOW, stage } = await import('./test-support.js');

afterEach(cleanup);

describe('auditStore, one raw file that fails', () => {
  it('reports that session not run at tier skeleton and still audits the others', async () => {
    const staged = stage();
    await deposit(staged.runtime, { allow: ['proj'], redactDomains: [], now: () => NOW });
    const store = await loadStore(staged.storeDir);
    const { skeletons } = await readSkeletons(staged.storeDir);
    const audits = await auditStore(staged.runtime, store.sessions, skeletons);
    const failed = audits.find((audit) => audit.session === 'errors-a');
    expect(failed).toMatchObject({ result: 'not run', tier: 'skeleton', mode: null });
    expect(audits.filter((audit) => audit.session !== 'errors-a').every((audit) => audit.result === 'root matches and the counts bind')).toBe(true);
  });
});
