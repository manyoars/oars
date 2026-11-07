import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bundleOf, keep, pair, SERVER } from './pool-books-fixture.js';
import { replicaFile, sessionBundle } from './pool-replica.js';

const dirs: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'oars-replica-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('sessionBundle', () => {
  it('returns the kept bundle for the session harness and version', async () => {
    const dir = fresh();
    await keep(dir, bundleOf(undefined, '2.1.314'), await pair());
    const found = await sessionBundle(dir, { harness: 'claude-code', harnessVersion: '2.1.314' });
    expect(found?.harness).toBe('claude-code');
    expect(found?.harnessVersion).toBe('2.1.314');
  });

  it('reads the replica where a fetch keeps it', async () => {
    const dir = fresh();
    const file = await keep(dir, bundleOf(undefined, '2.1.314'), await pair());
    expect(replicaFile(dir, SERVER, 'claude-code', '2.1.314')).toBe(file);
  });

  it('answers nothing for another harness, another version, or no setup', async () => {
    const dir = fresh();
    await keep(dir, { ...bundleOf(undefined, '2.1.314'), harness: 'codex' }, await pair());
    expect(await sessionBundle(dir, { harness: 'claude-code', harnessVersion: '2.1.314' })).toBeUndefined();
    expect(await sessionBundle(dir, { harness: 'codex', harnessVersion: '2.1.315' })).toBeUndefined();
    expect(await sessionBundle(dir, undefined)).toBeUndefined();
    expect(await sessionBundle(dir, { harness: 'codex', harnessVersion: 'not a version' })).toBeUndefined();
  });

  it('answers nothing when nothing was fetched', async () => {
    expect(await sessionBundle(fresh(), { harness: 'claude-code', harnessVersion: '2.1.314' })).toBeUndefined();
  });

  it('fails open on a corrupt replica, one signed by another key, and a damaged sign-in file', async () => {
    const dir = fresh();
    const file = await keep(dir, bundleOf(undefined, '2.1.314'), await pair());
    const setup = { harness: 'claude-code', harnessVersion: '2.1.314' } as const;
    writeFileSync(file, '{"payload": torn');
    expect(await sessionBundle(dir, setup)).toBeUndefined();
    const other = fresh();
    const kept = await keep(other, bundleOf(undefined, '2.1.314'), await pair());
    const intruder = await pair();
    const payload = JSON.stringify(bundleOf(undefined, '2.1.314'));
    writeFileSync(kept, JSON.stringify({ payload, signature: await intruder.sign(payload) }));
    expect(await sessionBundle(other, setup)).toBeUndefined();
    writeFileSync(join(dir, 'pool-accounts.json'), 'not json');
    expect(await sessionBundle(dir, setup)).toBeUndefined();
  });
});
