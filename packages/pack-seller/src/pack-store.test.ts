import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from './config.js';
import {
  ENV_INDEX_KEY_FILE,
  ENV_OWNERS_FILE,
  ENV_PACKS_DIR,
  ENV_PROJECTS_DIR,
  ENV_STORE_DIR,
  ENV_TERMS_FILE,
  fileLedger,
  loadPackInputs,
  OFFERS_FILE,
} from './pack-store.js';
import { cleanWorlds, makeWorld } from './test-world.js';

afterEach(cleanWorlds);

const envOf = (inputs: { packsDir: string; terms: string; owners: string; indexKey: string; storeDir: string; projectsDir: string }): NodeJS.ProcessEnv => ({
  [ENV_PACKS_DIR]: inputs.packsDir,
  [ENV_TERMS_FILE]: inputs.terms,
  [ENV_OWNERS_FILE]: inputs.owners,
  [ENV_INDEX_KEY_FILE]: inputs.indexKey,
  [ENV_STORE_DIR]: inputs.storeDir,
  [ENV_PROJECTS_DIR]: inputs.projectsDir,
});

describe('loadPackInputs', () => {
  it('reads the six operator-local paths, resolved', async () => {
    const world = await makeWorld();
    expect(world.root.startsWith(tmpdir())).toBe(true);
    expect(loadPackInputs(envOf(world.inputs))).toEqual(world.inputs);
  });

  it.each([ENV_PACKS_DIR, ENV_TERMS_FILE, ENV_OWNERS_FILE, ENV_INDEX_KEY_FILE, ENV_STORE_DIR, ENV_PROJECTS_DIR])('refuses a missing %s, naming it', async (name) => {
    const world = await makeWorld();
    const env = { ...envOf(world.inputs), [name]: undefined };
    expect(() => loadPackInputs(env)).toThrow(new ConfigError(`${name} is not set.`));
  });

  it.each([ENV_PACKS_DIR, ENV_TERMS_FILE, ENV_OWNERS_FILE, ENV_INDEX_KEY_FILE, ENV_STORE_DIR, ENV_PROJECTS_DIR])('refuses %s inside a git repository with one line naming it', async (name) => {
    const world = await makeWorld();
    const repo = mkdtempSync(join(tmpdir(), 'oars-seller-repo-'));
    try {
      mkdirSync(join(repo, '.git'));
      const env = envOf(world.inputs);
      env[name] = join(repo, 'inside');
      let message = '';
      try {
        loadPackInputs(env);
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toBe(`${name} is inside a git repository: keep it on this machine, outside every repository.`);
      expect(message).not.toContain('\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('the pack store catalog', () => {
  it('lists a pack with its priceRef, and its page carries the pack record, census, card, and the four terms fields', async () => {
    const world = await makeWorld();
    const { catalog } = await world.store();
    expect(catalog.list().map(({ packId, priceRef, title }) => ({ packId, priceRef, title }))).toEqual([{ packId: 'alpha', priceRef: 'pack-alpha', title: 'Alpha pack' }]);
    const page = catalog.find('alpha');
    expect(page?.terms).toHaveLength(1);
    expect(page?.terms[0]).toMatchObject({ sourceLicense: 'Apache-2.0' });
    expect(Object.keys(page?.terms[0] ?? {}).sort()).toEqual(['harnessTerms', 'permittedUses', 'sourceLicense', 'training']);
    expect(page?.census).toMatchObject({});
    expect(page?.card).toBeNull();
    expect(page?.pack).toMatchObject({ size: 5, minTurns: 1 });
  });

  it('leaves the operator key id and the objections hash out of the page', async () => {
    const world = await makeWorld();
    const page = (await world.store()).catalog.find('alpha');
    expect(JSON.stringify(page)).not.toContain('keyId');
    expect(JSON.stringify(page)).not.toContain('objections');
  });

  it('answers undefined for a pack it does not hold', async () => {
    const world = await makeWorld();
    expect((await world.store()).catalog.find('beta')).toBeUndefined();
  });

  it('refuses at start a pack whose id would make a priceRef over 64 characters', async () => {
    const world = await makeWorld();
    const long = 'a'.repeat(60);
    mkdirSync(join(world.inputs.packsDir, long));
    writeFileSync(join(world.inputs.packsDir, long, 'listing.json'), JSON.stringify({ title: 'Long' }));
    await expect(world.store()).rejects.toThrow(/Pack a+: The priceRef pack-<packId> is over 64 characters\./);
  });

  it('refuses a pack with a listing but no built preview', async () => {
    const world = await makeWorld();
    mkdirSync(join(world.inputs.packsDir, 'beta'));
    writeFileSync(join(world.inputs.packsDir, 'beta', 'listing.json'), JSON.stringify({ title: 'Beta' }));
    await expect(world.store()).rejects.toThrow('Pack beta has no built preview (pack.json, census.json, manifest.jsonl).');
  });

  it.each([
    [{}, 'has no title'],
    [{ title: 'T', size: 0 }, 'has a size that is not a positive whole number'],
    [{ title: 'T', seed: 1 }, 'has a seed that is not text'],
    [{ title: 'T', skeletonOnly: 'yes' }, 'has a skeletonOnly that is not true or false'],
  ])('refuses a listing %j', async (listing, reason) => {
    const world = await makeWorld();
    writeFileSync(join(world.inputs.packsDir, 'alpha', 'listing.json'), JSON.stringify(listing));
    await expect(world.store()).rejects.toThrow(`listing.json of pack alpha ${reason}.`);
  });

  it('refuses a packs folder that cannot be read, naming the variable', async () => {
    const world = await makeWorld();
    rmSync(world.inputs.packsDir, { recursive: true });
    await expect(world.open()).rejects.toThrow(`${ENV_PACKS_DIR} names a folder that cannot be read.`);
  });

  it('ignores a folder with no listing and the builds folder', async () => {
    const world = await makeWorld();
    mkdirSync(join(world.inputs.packsDir, 'notes'));
    mkdirSync(join(world.inputs.packsDir, 'builds'));
    expect((await world.store()).packs()).toEqual([{ packId: 'alpha', title: 'Alpha pack' }]);
  });
});

describe('the offer record on disk', () => {
  const entry = { customerRef: 'c_0123456789abcdef0123456789abcdef', packId: 'alpha', recipientLegalName: 'Acme Evals Inc.', licenseVersion: 'term-sheet-v1', recordedAt: 1000 };

  it('sits beside deliveries.jsonl and survives a restart', async () => {
    const world = await makeWorld();
    const first = await world.store();
    first.ledger.record(entry);
    const reopened = await world.store();
    expect(reopened.ledger.find(entry.customerRef)).toEqual(entry);
    expect(readFileSync(join(world.root, 'operator', OFFERS_FILE), 'utf8')).toContain('Acme Evals Inc.');
  });

  it('finds nothing for an unknown ref or before any offer was recorded', async () => {
    const world = await makeWorld();
    const { ledger } = await world.store();
    expect(ledger.find(entry.customerRef)).toBeUndefined();
    ledger.record(entry);
    expect(ledger.find('c_other0123456789abcdef0123456789')).toBeUndefined();
  });

  it('answers with the latest line for a ref and skips a line that is not an offer', () => {
    const root = mkdtempSync(join(tmpdir(), 'oars-seller-ledger-'));
    try {
      const file = join(root, OFFERS_FILE);
      const ledger = fileLedger(file);
      ledger.record(entry);
      writeFileSync(file, `${readFileSync(file, 'utf8')}${JSON.stringify({ customerRef: entry.customerRef, packId: 7 })}\n`);
      expect(ledger.find(entry.customerRef)).toEqual(entry);
      ledger.record({ ...entry, licenseVersion: 'term-sheet-v2' });
      expect(ledger.find(entry.customerRef)?.licenseVersion).toBe('term-sheet-v2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
