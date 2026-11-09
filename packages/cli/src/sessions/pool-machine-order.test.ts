// A machine's Stop notes its batch key before it writes the batch, so a person's sweep that runs between the two lines still sees the key.
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { harness } from '../test-support.js';
import type * as Outbox from './pool-outbox.js';
import { machineKeys } from './pool-outbox.js';
import { poolDeposit } from './pool-command.js';
import { deposit } from './store.js';
import { addProject, cleanup, stage } from './test-support.js';

const seen: { held: string[]; wrote: number }[] = [];

vi.mock('./pool-outbox.js', async (importActual) => {
  const actual = await importActual<typeof Outbox>();
  return {
    ...actual,
    writeBatch: async (...given: Parameters<typeof actual.writeBatch>): ReturnType<typeof actual.writeBatch> => {
      seen.push({ held: [...(await actual.machineKeys(given[0]))], wrote: seen.length });
      return actual.writeBatch(...given);
    },
  };
});

afterEach(() => {
  cleanup();
  seen.length = 0;
});

it('holds the key of a machine batch in the key log by the time the batch is written', async () => {
  const staged = stage();
  if (!staged.root.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  rmSync(join(staged.projectsRoot, 'proj'), { recursive: true, force: true });
  const session = '88888888-8888-4888-8888-000000000001';
  addProject(staged, 'zz-order-repo', session, [JSON.stringify({ type: 'user', sessionId: session, cwd: '/w', timestamp: '2026-05-01T01:00:00Z', permissionMode: 'default', message: { role: 'user', content: 'a plain request' } })]);
  await deposit(staged.runtime, { allow: ['zz-order-repo'], redactDomains: [], now: Date.now });
  const terms = join(staged.root, 'terms.txt');
  writeFileSync(terms, 'zorblax\n');
  const h = harness({ OARS_EXCLUSION_TERMS: terms, APPDATA: staged.root, OARS_HOST_CLASS: 'cloud' });
  h.deps.sessions = staged.runtime;
  h.deps.now = Date.now;
  await poolDeposit(h.deps, { server: 'https://pool.test', session });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.held).toHaveLength(1);
  const outbox = join(staged.storeDir, 'pool-outbox');
  const [server] = readdirSync(outbox);
  expect([...(await machineKeys(join(outbox, server ?? '')))]).toEqual(seen[0]?.held);
});
