// A machine's Stop notes its batch key before it writes the batch, so a person's sweep that runs between the two lines still sees the key.
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { harness } from '../test-support.js';
import type * as Outbox from './pool-outbox.js';
import { machineKeys } from './pool-outbox.js';
import { poolDeposit } from './pool-command.js';
import { deposit } from './store.js';
import { addProject, cleanup, stage } from './test-support.js';

const seen: { held: string[]; key: string }[] = [];
const LATE = 'c'.repeat(16);
let late: { folder: string; hash: string } | undefined;
let lateOn = false;

vi.mock('./pool-outbox.js', async (importActual) => {
  const actual = await importActual<typeof Outbox>();
  return {
    ...actual,
    writeBatch: async (...given: Parameters<typeof actual.writeBatch>): ReturnType<typeof actual.writeBatch> => {
      if (lateOn) return actual.writeBatch(...given);
      seen.push({ held: [...(await actual.machineKeys(given[0]))], key: given[1] });
      return actual.writeBatch(...given);
    },
    // A machine's Stop that notes its key and writes its batch after a sweep has started but before the sweep lists its folder.
    removeBatchesExcept: async (...given: Parameters<typeof actual.removeBatchesExcept>): ReturnType<typeof actual.removeBatchesExcept> => {
      if (lateOn) {
        await actual.noteMachineKey(given[0], LATE);
        late = await actual.writeBatch(given[0], LATE, { late: true });
      }
      return actual.removeBatchesExcept(...given);
    },
  };
});

afterEach(() => {
  cleanup();
  seen.length = 0;
  late = undefined;
  lateOn = false;
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
  expect(seen[0]?.held).toContain(seen[0]?.key);
  const outbox = join(staged.storeDir, 'pool-outbox');
  const [server] = readdirSync(outbox);
  expect([...(await machineKeys(join(outbox, server ?? '')))]).toEqual(seen[0]?.held);
});

it("a person's sweep keeps a batch a machine noted and wrote after the sweep began", async () => {
  const staged = stage();
  if (!staged.root.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  rmSync(join(staged.projectsRoot, 'proj'), { recursive: true, force: true });
  const session = '88888888-8888-4888-8888-000000000002';
  addProject(staged, 'zz-order-repo', session, [JSON.stringify({ type: 'user', sessionId: session, cwd: '/w', timestamp: '2026-05-01T01:00:00Z', permissionMode: 'default', message: { role: 'user', content: 'a plain request' } })]);
  await deposit(staged.runtime, { allow: ['zz-order-repo'], redactDomains: [], now: Date.now });
  const terms = join(staged.root, 'terms.txt');
  writeFileSync(terms, 'zorblax\n');
  writeFileSync(join(staged.storeDir, 'pool-accounts.json'), JSON.stringify([{ server: 'https://pool.test', account: 'acct_one', token: 'a-pool-token', expiresAt: Date.parse('2099-01-01T00:00:00Z'), signingKey: { kty: 'OKP', crv: 'Ed25519', x: 'k' } }]));
  const person = harness({ OARS_EXCLUSION_TERMS: terms, APPDATA: staged.root });
  person.deps.sessions = staged.runtime;
  person.deps.now = Date.now;
  lateOn = true;
  await poolDeposit(person.deps, { server: 'https://pool.test' });
  expect(late).toBeDefined();
  expect(existsSync(join(late?.folder ?? '', `${LATE}.${late?.hash ?? ''}.jsonl`))).toBe(true);
});
