// The deposit build on a machine (`OARS_HOST_CLASS`): the open session is built as it stands, with the gates unchanged and no sign-in, nothing is swept, one session is built when the Stop names it, and a cloud machine carries no delta.
// The store is a temp folder (`stage`), and APPDATA is the same folder; the test confirms the store path is under the temp folder before it runs.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from '../test-support.js';
import { poolDeposit } from './pool-command.js';
import { deposit } from './store.js';
import { addProject, cleanup, stage, type Staged } from './test-support.js';

afterEach(cleanup);

const POOL = 'https://pool.test';
const FOLDER = 'zz-machine-repo';
const sid = (n: number): string => `88888888-8888-4888-8888-${String(n).padStart(12, '0')}`;
const lineOf = (session: string, day: string, mode: string): string => JSON.stringify({ type: 'user', sessionId: session, cwd: '/w', timestamp: `2026-05-${day}T01:00:00Z`, permissionMode: mode, message: { role: 'user', content: 'a plain request' } });

interface Scene {
  staged: Staged;
  h: Harness;
}

/** A store holding the sessions, all captured and written just now, so every one is inside `session_idle_hours`. */
const scene = async (env: NodeJS.ProcessEnv, sessions: readonly { id: string; day: string; mode: string }[]): Promise<Scene> => {
  const staged = stage();
  if (!staged.root.startsWith(tmpdir())) throw new Error('the test store is not under the temp folder');
  rmSync(join(staged.projectsRoot, 'proj'), { recursive: true, force: true });
  for (const { id, day, mode } of sessions) addProject(staged, FOLDER, id, [lineOf(id, day, mode)]);
  await deposit(staged.runtime, { allow: [FOLDER], redactDomains: [], now: Date.now });
  const terms = join(staged.root, 'terms.txt');
  writeFileSync(terms, 'zorblax\n');
  const h = harness({ OARS_EXCLUSION_TERMS: terms, APPDATA: staged.root, ...env });
  h.deps.sessions = staged.runtime;
  h.deps.now = Date.now;
  return { staged, h };
};

const signedIn = (staged: Staged): void => {
  writeFileSync(join(staged.storeDir, 'pool-accounts.json'), JSON.stringify([{ server: POOL, account: 'acct_one', token: 'a-pool-token', expiresAt: Date.parse('2099-01-01T00:00:00Z'), signingKey: { kty: 'OKP', crv: 'Ed25519', x: 'k' } }]));
};

const batches = (staged: Staged): string[] => {
  const root = join(staged.storeDir, 'pool-outbox');
  return existsSync(root) ? readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.jsonl')).sort() : [];
};

const document = async (given: Scene, options: { session?: string; send?: string } = {}): Promise<{ [field: string]: unknown }> => {
  const { document: built } = await poolDeposit(given.h.deps, { server: POOL, ...options });
  return Object.fromEntries(Object.entries(built));
};

const ONE = [{ id: sid(1), day: '01', mode: 'default' }];

describe('poolDeposit on a machine', () => {
  it('without machine configuration, a session inside session_idle_hours is not ended: nothing is built', async () => {
    const given = await scene({}, ONE);
    signedIn(given.staged);
    expect(await document(given)).toMatchObject({ sessions: 1, batched: 0, notEnded: 1 });
    expect(batches(given.staged)).toEqual([]);
  });

  it('with machine configuration, the same session is built as it stands, with no sign-in, and nothing is withdrawn', async () => {
    const given = await scene({ OARS_HOST_CLASS: 'vps', OARS_MACHINE: 'm-1' }, ONE);
    expect(existsSync(join(given.staged.storeDir, 'pool-accounts.json'))).toBe(false);
    expect(await document(given)).toMatchObject({ sessions: 1, batched: 1, notEnded: 0, withdrawn: 0 });
    expect(batches(given.staged)).toHaveLength(1);
  });

  it('rebuilds the open session at the next Stop, replacing its batch, and withdraws nothing', async () => {
    const given = await scene({ OARS_HOST_CLASS: 'cloud' }, ONE);
    await document(given);
    const [first] = batches(given.staged);
    expect(await document(given)).toMatchObject({ batched: 1, withdrawn: 0 });
    expect(batches(given.staged)).toEqual([first]);
  });

  it("builds the one session the Stop names and leaves another session's batch where it is", async () => {
    const two = [...ONE, { id: sid(2), day: '02', mode: 'default' }];
    const given = await scene({ OARS_HOST_CLASS: 'cloud' }, two);
    expect(await document(given, { session: sid(1) })).toMatchObject({ sessions: 1, batched: 1 });
    expect(batches(given.staged)).toHaveLength(1);
    expect(await document(given, { session: sid(2) })).toMatchObject({ sessions: 1, batched: 1, withdrawn: 0 });
    expect(batches(given.staged)).toHaveLength(2);
  });

  it('applies the gates unchanged: a folder off the allow list is built into nothing', async () => {
    const given = await scene({ OARS_HOST_CLASS: 'vps' }, ONE);
    const state = join(given.staged.storeDir, 'state.json');
    const saved: unknown = JSON.parse(readFileSync(state, 'utf8'));
    expect(typeof saved).toBe('object');
    writeFileSync(state, JSON.stringify({ ...(typeof saved === 'object' && saved !== null ? saved : {}), allow: ['some-other-folder'] }));
    expect(await document(given)).toMatchObject({ sessions: 1, batched: 0, excluded: { folder: 1 } });
    expect(batches(given.staged)).toEqual([]);
  });

  it('fails closed with no exclusion terms: nothing is built', async () => {
    const given = await scene({ OARS_HOST_CLASS: 'vps' }, ONE);
    given.h.deps.env.OARS_EXCLUSION_TERMS = join(given.staged.root, 'no-such-terms.txt');
    expect(await document(given)).toMatchObject({ batched: 0, excluded: { noTerms: 1 } });
    expect(batches(given.staged)).toEqual([]);
  });

  it('sends nothing: --send is refused on a machine', async () => {
    const given = await scene({ OARS_HOST_CLASS: 'vps' }, ONE);
    await expect(poolDeposit(given.h.deps, { server: POOL, send: 'a'.repeat(64) })).rejects.toThrow(/builds batches into its outbox and sends none/);
  });
});

describe('deltas on a machine', () => {
  // Five sessions in a first week and five in the next, in another mode: the fifth of the later ones fills the after window, as in the signed-in tests.
  const weeks = [
    ...[0, 1, 2, 3, 4].map((n) => ({ id: sid(10 + n), day: '01', mode: 'default' })),
    ...[0, 1, 2, 3, 4].map((n) => ({ id: sid(20 + n), day: '09', mode: 'plan' })),
  ];
  /** How many batches in the outbox carry at least one delta. */
  const carried = (staged: Staged): number =>
    batches(staged).filter((name) => {
      const parsed: unknown = JSON.parse(readFileSync(join(staged.storeDir, 'pool-outbox', name), 'utf8'));
      const deltas: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'deltas') : undefined;
      return Array.isArray(deltas) && deltas.length > 0;
    }).length;

  it('a vps machine carries the delta its own history shows', async () => {
    const given = await scene({ OARS_HOST_CLASS: 'vps' }, weeks);
    expect(await document(given)).toMatchObject({ batched: 10 });
    expect(carried(given.staged)).toBe(1);
  });

  it('a cloud machine carries none: every VM starts clean, so it has no history to compare against', async () => {
    const given = await scene({ OARS_HOST_CLASS: 'cloud' }, weeks);
    expect(await document(given)).toMatchObject({ batched: 10 });
    expect(carried(given.staged)).toBe(0);
  });
});
