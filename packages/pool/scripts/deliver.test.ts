// The hand-over register for lot 1 (plan S5, 2.2): fixtures only. A pack is written by hand here; no store, transcript root, or network is read.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliver, keyIdOf, main, recipientsOf, type Delivery } from './deliver.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BUYER_KEY = 'buyer-key-one';
const BUILT = '2026-06-10T12:00:00.000Z';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-1111-4111-8111-111111111111';
const M1 = 'a1'.repeat(32);
const M2 = 'b2'.repeat(32);

interface Fixture {
  root: string;
  owners: string;
  pack: string;
}

/** A pack as `buildPack` leaves it (pack.json, manifest.jsonl, sessions/<match id>/main.jsonl) and the operator's index beside the owners file. */
const fixture = (extra: { built?: string; keyId?: string; parent?: string } = {}): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'oars-deliver-'));
  dirs.push(root);
  const owners = join(root, 'owners.json');
  writeFileSync(owners, '[]');
  const pack = join(extra.parent ?? root, 'lot-1');
  mkdirSync(join(pack, 'sessions', M1), { recursive: true });
  mkdirSync(join(pack, 'sessions', M2), { recursive: true });
  writeFileSync(join(pack, 'sessions', M1, 'main.jsonl'), '{"text":"ask Priya Raman about the schema"}\n');
  writeFileSync(join(pack, 'sessions', M2, 'main.jsonl'), '{"text":"run the build"}\n');
  writeFileSync(join(pack, 'pack.json'), JSON.stringify({ built: extra.built ?? BUILT, keyId: extra.keyId ?? keyIdOf(BUYER_KEY) }));
  writeFileSync(join(pack, 'manifest.jsonl'), [M1, M2].map((matchId) => `${JSON.stringify({ matchId })}\n`).join(''));
  writeFileSync(join(root, 'index.jsonl'), [{ pack, session: S1, project: 'p', matchId: M1 }, { pack, session: S2, project: 'p', matchId: M2 }].map((row) => `${JSON.stringify(row)}\n`).join(''));
  return { root, owners, pack };
};

const args = (f: Fixture, extra: Partial<Parameters<typeof deliver>[0]> = {}): Parameters<typeof deliver>[0] => ({
  pack: f.pack, recipient: 'Acme Evals Inc.', license: 'term-sheet-v1', buyerKey: BUYER_KEY, owners: f.owners, now: () => new Date('2026-06-12T08:00:00.000Z'), ...extra,
});

const rowsOf = (f: Fixture): Delivery[] =>
  readFileSync(join(f.root, 'deliveries.jsonl'), 'utf8').split('\n').filter((row) => row !== '').map((row): Delivery => JSON.parse(row) as Delivery);

describe('deliver (plan S5, Art. 15(1)(c) and 19)', () => {
  it('appends one row per session for the recipient, never the key', async () => {
    const f = fixture();

    const written = await deliver(args(f));

    const keyId = createHash('sha256').update(BUYER_KEY).digest('hex').slice(0, 16);
    expect(rowsOf(f)).toEqual([
      { recipient: 'Acme Evals Inc.', lot: 'lot-1', keyId, matchId: M1, session: S1, deliveredAt: '2026-06-12T08:00:00.000Z', license: 'term-sheet-v1' },
      { recipient: 'Acme Evals Inc.', lot: 'lot-1', keyId, matchId: M2, session: S2, deliveredAt: '2026-06-12T08:00:00.000Z', license: 'term-sheet-v1' },
    ]);
    expect(written).toHaveLength(2);
    expect(readFileSync(join(f.root, 'deliveries.jsonl'), 'utf8')).not.toContain(BUYER_KEY);
  });

  it('appends to rows already there, so a second recipient adds to the register', async () => {
    const f = fixture();
    await deliver(args(f));
    await deliver(args(f, { recipient: 'Beta Labs Ltd', license: 'term-sheet-v2' }));
    expect(rowsOf(f).map((row) => [row.recipient, row.license])).toEqual([
      ['Acme Evals Inc.', 'term-sheet-v1'], ['Acme Evals Inc.', 'term-sheet-v1'], ['Beta Labs Ltd', 'term-sheet-v2'], ['Beta Labs Ltd', 'term-sheet-v2'],
    ]);
  });

  it('refuses a pack built before the newest objection, and writes nothing', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'objections.jsonl'), `${JSON.stringify({ name: 'Priya Raman', received: '2026-06-11T09:00:00.000Z', scope: 'sale' })}\n`);
    await expect(deliver(args(f))).rejects.toThrow(/built before the newest objection/);
    expect(() => readFileSync(join(f.root, 'deliveries.jsonl'))).toThrow();
  });

  it('delivers a pack built after the newest objection', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'objections.jsonl'), `${JSON.stringify({ name: 'Priya Raman', received: '2026-06-09T09:00:00.000Z', scope: 'sale' })}\n`);
    expect(await deliver(args(f))).toHaveLength(2);
  });

  it('refuses a pack folder inside a git repository', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'oars-deliver-repo-'));
    dirs.push(parent);
    mkdirSync(join(parent, '.git'));
    const f = fixture({ parent });
    await expect(deliver(args(f))).rejects.toThrow(/inside a git repository/);
    expect(() => readFileSync(join(f.root, 'deliveries.jsonl'))).toThrow();
  });

  it('refuses a buyer key that is not the one the pack was built under', async () => {
    const f = fixture();
    await expect(deliver(args(f, { buyerKey: 'another-key' }))).rejects.toThrow(/buyer key/);
  });

  it('refuses a pack whose match id the index does not know', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'index.jsonl'), '');
    await expect(deliver(args(f))).rejects.toThrow(/index/);
  });

  it('refuses an empty recipient or license', async () => {
    const f = fixture();
    await expect(deliver(args(f, { recipient: ' ' }))).rejects.toThrow(/recipient/);
    await expect(deliver(args(f, { license: '' }))).rejects.toThrow(/license/);
  });

  it('makes no network call', async () => {
    const f = fixture();
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const printed: string[] = [];
    const code = await main(['--pack', f.pack, '--recipient', 'Acme Evals Inc.', '--license', 'term-sheet-v1', '--buyer-key', BUYER_KEY, '--owners', f.owners], { print: (text) => printed.push(text) });
    expect(code).toBe(0);
    expect(rowsOf(f)).toHaveLength(2);
    expect(fetched).toHaveBeenCalledTimes(0);
  });

  it('exits 2 with the reason on a refusal, and with usage on a missing option', async () => {
    const f = fixture({ keyId: 'ffffffffffffffff' });
    const printed: string[] = [];
    const io = { print: (text: string) => printed.push(text) };
    expect(await main(['--pack', f.pack, '--recipient', 'A', '--license', 'L', '--buyer-key', BUYER_KEY, '--owners', f.owners], io)).toBe(2);
    expect(printed.join('\n')).toMatch(/buyer key/);
    printed.length = 0;
    expect(await main(['--pack', f.pack], io)).toBe(2);
    expect(printed.join('\n')).toMatch(/Usage: deliver/);
    printed.length = 0;
    expect(await main(['recipients'], io)).toBe(2);
    expect(printed.join('\n')).toMatch(/Usage: deliver/);
  });
});

describe('deliver recipients (Art. 15(1)(c) and 19)', () => {
  it('names each recipient of a session with the id that recipient holds it under', async () => {
    const f = fixture();
    await deliver(args(f));
    await deliver(args(f, { recipient: 'Beta Labs Ltd' }));

    const found = await recipientsOf(f.owners, S1);

    expect(found.map((row) => [row.recipient, row.matchId, row.session])).toEqual([['Acme Evals Inc.', M1, S1], ['Beta Labs Ltd', M1, S1]]);
  });

  it('finds the sessions that name a person by reading the packs in the index', async () => {
    const f = fixture();
    await deliver(args(f));
    const found = await recipientsOf(f.owners, 'priya raman');
    expect(found.map((row) => row.session)).toEqual([S1]);
  });

  it('prints none and exits 0 for a session never delivered', async () => {
    const f = fixture();
    const printed: string[] = [];
    const code = await main(['recipients', S1, '--owners', f.owners], { print: (text) => printed.push(text) });
    expect(code).toBe(0);
    expect(printed.join('\n')).toMatch(/No recipient/);
  });

  it('prints each recipient and its match id', async () => {
    const f = fixture();
    await deliver(args(f));
    const printed: string[] = [];
    expect(await main(['recipients', S2, '--owners', f.owners], { print: (text) => printed.push(text) })).toBe(0);
    expect(printed.join('\n')).toContain(`Acme Evals Inc.\tmatch id ${M2}`);
  });
});
