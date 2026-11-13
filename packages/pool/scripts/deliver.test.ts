// The hand-over register for lot 1 (plan S5, 2.2): fixtures only. A pack is written by hand here; no store, transcript root, or network is read.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deposit, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { USAGE, accountRecipientsOf, deliver, main, recipientsOf, type Delivery } from './deliver.js';
import { buildPack, keyIdOf } from './sample-pack.js';

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

const KEY_ID = keyIdOf(BUYER_KEY);
const CODEX = 'codex-cccc3333-3333-4333-8333-333333333333';
const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Fixture {
  root: string;
  owners: string;
  pack: string;
}

/** A pack as `buildPack` leaves it (pack.json, manifest.jsonl, sessions/<match id>/main.jsonl) and the operator's index beside the owners file. */
const fixture = (extra: { built?: string; keyId?: string; parent?: string; git?: boolean; objections?: readonly object[]; packJson?: object; sessions?: readonly [string, string] } = {}): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'oars-deliver-'));
  dirs.push(root);
  if (extra.git === true) mkdirSync(join(root, '.git'));
  const [first, second] = extra.sessions ?? [S1, S2];
  const objections = extra.objections?.map((row) => `${JSON.stringify(row)}\n`).join('');
  if (objections !== undefined) writeFileSync(join(root, 'objections.jsonl'), objections);
  const owners = join(root, 'owners.json');
  writeFileSync(owners, '[]');
  const pack = join(extra.parent ?? root, 'lot-1');
  mkdirSync(join(pack, 'sessions', M1), { recursive: true });
  mkdirSync(join(pack, 'sessions', M2), { recursive: true });
  writeFileSync(join(pack, 'sessions', M1, 'main.jsonl'), '{"text":"ask Priya Raman about the schema"}\n');
  writeFileSync(join(pack, 'sessions', M2, 'main.jsonl'), '{"text":"run the build"}\n');
  writeFileSync(join(pack, 'pack.json'), JSON.stringify(extra.packJson ?? { built: extra.built ?? BUILT, keyId: extra.keyId ?? KEY_ID, objections: objections === undefined ? 'none' : hashOf(objections) }));
  writeFileSync(join(pack, 'manifest.jsonl'), [M1, M2].map((matchId) => `${JSON.stringify({ matchId })}\n`).join(''));
  writeFileSync(join(root, 'index.jsonl'), [{ pack, session: first, project: 'p', matchId: M1 }, { pack, session: second, project: 'p', matchId: M2 }].map((row) => `${JSON.stringify(row)}\n`).join(''));
  return { root, owners, pack };
};

const args = (f: Fixture, extra: Partial<Parameters<typeof deliver>[0]> = {}): Parameters<typeof deliver>[0] => ({
  pack: f.pack, recipient: 'Acme Evals Inc.', license: 'term-sheet-v1', buyerKey: BUYER_KEY, owners: f.owners, now: () => new Date('2026-06-12T08:00:00.000Z'), ...extra,
});

const isDelivery = (value: unknown): value is Delivery => typeof value === 'object' && value !== null && 'recipient' in value && 'matchId' in value && 'session' in value;

const rowsOf = (f: Fixture): Delivery[] =>
  readFileSync(join(f.root, 'deliveries.jsonl'), 'utf8').split('\n').filter((row) => row !== '').map((row): Delivery => {
    const value: unknown = JSON.parse(row);
    if (!isDelivery(value)) throw new Error('a delivery row with no recipient');
    return value;
  });

describe('deliver (plan S5, Art. 15(1)(c) and 19)', () => {
  it('appends one row per session for the recipient, never the key', async () => {
    const f = fixture();

    const { rows: written } = await deliver(args(f));

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

  it('refuses a pack built before an objection that arrived after the build, and writes nothing', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'objections.jsonl'), `${JSON.stringify({ name: 'Priya Raman', received: '2026-06-11T09:00:00.000Z', scope: 'sale' })}\n`);
    await expect(deliver(args(f))).rejects.toThrow(/objections changed since the build: rebuild/);
    expect(() => readFileSync(join(f.root, 'deliveries.jsonl'))).toThrow();
  });

  it('refuses a pack built before an objection that arrived before the build but was recorded after it', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'objections.jsonl'), `${JSON.stringify({ name: 'Priya Raman', received: '2026-06-09T09:00:00.000Z', scope: 'sale' })}\n`);
    await expect(deliver(args(f))).rejects.toThrow(/objections changed since the build: rebuild/);
    expect(() => readFileSync(join(f.root, 'deliveries.jsonl'))).toThrow();
  });

  it('deliver refuses a pack built before an account line', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'objections.jsonl'), `${JSON.stringify({ account: 'acct_one', right: 'restriction', received: '2026-06-09T09:00:00.000Z', scope: 'sale' })}\n`);
    await expect(deliver(args(f))).rejects.toThrow(/objections changed since the build: rebuild/);
    expect(() => readFileSync(join(f.root, 'deliveries.jsonl'))).toThrow();
  });

  it('delivers a pack built under the objections file as it is now', async () => {
    const f = fixture({ objections: [{ name: 'Priya Raman', received: '2026-06-09T09:00:00.000Z', scope: 'sale' }] });
    expect((await deliver(args(f))).rows).toHaveLength(2);
  });

  it('refuses a pack that buildPack wrote when an objection is recorded after it, even one received before the build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oars-deliver-build-'));
    dirs.push(root);
    const cwd = join(root, 'work', 'app');
    mkdirSync(cwd, { recursive: true });
    const projects = join(root, 'projects', '-work-oars');
    mkdirSync(projects, { recursive: true });
    const session = S1;
    const row = (type: string, uuid: string, parentUuid: string | null, timestamp: string, message: object): string =>
      JSON.stringify({ type, uuid, parentUuid, isSidechain: false, timestamp, version: '2.1.300', sessionId: session, cwd, requestId: 'req_011Cdeliver1', message });
    writeFileSync(join(projects, `${session}.jsonl`), [
      row('user', 'aaaaaaaa-b001-4222-8222-222222222222', null, '2026-06-01T10:00:01.000Z', { role: 'user', content: 'add a test' }),
      row('assistant', 'aaaaaaaa-a001-4222-8222-222222222222', 'aaaaaaaa-b001-4222-8222-222222222222', '2026-06-01T10:00:02.000Z', { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 20 } }),
    ].join(String.fromCharCode(10)) + String.fromCharCode(10));
    const runtime: SessionsRuntime = { storeDir: join(root, 'store'), projectsRoot: join(root, 'projects'), sources: [], stdin: process.stdin, stdout: { write: () => true } };
    await deposit(runtime, { allow: [], redactDomains: [], now: () => Date.parse('2026-06-10T00:00:00Z') });
    const terms = join(root, 'terms.txt');
    writeFileSync(terms, 'zorblax');
    const owners = join(root, 'owners.json');
    writeFileSync(owners, JSON.stringify([{ folder: '*-oars*', owner: 'Many Oars Co.', license: 'Apache-2.0' }]));
    const indexKey = join(root, 'index.key');
    writeFileSync(indexKey, 'ab'.repeat(32));
    const out = join(root, 'lot-1');
    await buildPack(runtime, { terms, owners, indexKey, buyerKey: BUYER_KEY, out, size: 25, seed: '1', minTurns: 1 });

    writeFileSync(join(root, 'objections.jsonl'), `${JSON.stringify({ name: 'Priya Raman', received: '2026-05-01T09:00:00.000Z', scope: 'sale' })}
`);
    await expect(deliver({ pack: out, recipient: 'Acme Evals Inc.', license: 'term-sheet-v1', buyerKey: BUYER_KEY, owners })).rejects.toThrow(/objections changed since the build/);
    expect(() => readFileSync(join(root, 'deliveries.jsonl'))).toThrow();
  });

  it('refuses a pack with no manifest.jsonl as a refusal, not a raw read error', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'deliveries.jsonl'), '');
    rmSync(join(f.pack, 'manifest.jsonl'));
    await expect(deliver(args(f))).rejects.toThrow(/manifest.jsonl is missing/);
    expect(readFileSync(join(f.root, 'deliveries.jsonl'), 'utf8')).toBe('');
  });

  it('refuses a pack folder inside a git repository', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'oars-deliver-repo-'));
    dirs.push(parent);
    mkdirSync(join(parent, '.git'));
    const f = fixture({ parent });
    await expect(deliver(args(f))).rejects.toThrow(/inside a git repository/);
    expect(() => readFileSync(join(f.root, 'deliveries.jsonl'))).toThrow();
  });

  it('refuses the owners file in a git repository, with the pack outside, and writes nothing', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'oars-deliver-out-'));
    dirs.push(outside);
    const f = fixture({ git: true, parent: outside });
    await expect(deliver(args(f))).rejects.toThrow(/owners file is inside a git repository/);
    expect(() => readFileSync(join(f.root, 'deliveries.jsonl'))).toThrow();
  });

  it('refuses a folder with no pack.json, leaving deliveries.jsonl as it was', async () => {
    const f = fixture();
    writeFileSync(join(f.root, 'deliveries.jsonl'), '');
    rmSync(join(f.pack, 'pack.json'));
    await expect(deliver(args(f))).rejects.toThrow(/pack\.json is missing/);
    expect(readFileSync(join(f.root, 'deliveries.jsonl'), 'utf8')).toBe('');
  });

  it('refuses a pack.json with no build time, leaving deliveries.jsonl as it was', async () => {
    const f = fixture({ packJson: { keyId: KEY_ID, objections: 'none' } });
    writeFileSync(join(f.root, 'deliveries.jsonl'), '');
    await expect(deliver(args(f))).rejects.toThrow(/no build time/);
    expect(readFileSync(join(f.root, 'deliveries.jsonl'), 'utf8')).toBe('');
  });

  it('refuses a manifest row with no match id, leaving deliveries.jsonl as it was', async () => {
    const f = fixture();
    writeFileSync(join(f.pack, 'manifest.jsonl'), `${JSON.stringify({ harness: 'codex' })}\n`);
    writeFileSync(join(f.root, 'deliveries.jsonl'), '');
    await expect(deliver(args(f))).rejects.toThrow(/row with no match id/);
    expect(readFileSync(join(f.root, 'deliveries.jsonl'), 'utf8')).toBe('');
  });

  it('refuses a deliveries.jsonl line that is not a delivery, leaving the file as it was, and makes recipients exit 2', async () => {
    const f = fixture();
    const bad = `${JSON.stringify({ recipient: 'Acme Evals Inc.' })}\n`;
    writeFileSync(join(f.root, 'deliveries.jsonl'), bad);
    await expect(deliver(args(f))).rejects.toThrow(/not a delivery/);
    expect(readFileSync(join(f.root, 'deliveries.jsonl'), 'utf8')).toBe(bad);
    const printed: string[] = [];
    expect(await main(['recipients', S1, '--owners', f.owners], { print: (text) => printed.push(text) })).toBe(2);
    expect(printed.join('\n')).toMatch(/not a delivery/);
  });

  it('skips a (recipient, lot, match id) already recorded, and says how many', async () => {
    const f = fixture();
    await deliver(args(f));
    const again = await deliver(args(f));
    expect(again).toMatchObject({ rows: [], skipped: 2 });
    expect(rowsOf(f)).toHaveLength(2);
    const printed: string[] = [];
    const io = { print: (text: string) => printed.push(text), now: () => new Date('2026-06-13T08:00:00.000Z') };
    expect(await main(['--pack', f.pack, '--recipient', 'Acme Evals Inc.', '--license', 'term-sheet-v1', '--buyer-key', BUYER_KEY, '--owners', f.owners], io)).toBe(0);
    expect(printed.join('\n')).toMatch(/2 already recorded/);
    expect(rowsOf(f)).toHaveLength(2);
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

  it('finds a person whose name sits in a JSON escape in a delivered pack file', async () => {
    const f = fixture();
    // The pack file spells the name with a \u escape and a \n between the names, so the raw bytes never hold "Zoë Quill".
    writeFileSync(join(f.pack, 'sessions', M1, 'main.jsonl'), `{"text":"thanks Zo${String.fromCharCode(92)}u00eb${String.fromCharCode(92)}nQuill"}${String.fromCharCode(10)}`);
    await deliver(args(f));

    const found = await recipientsOf(f.owners, 'Zoë Quill');

    expect(found.map((row) => row.session)).toEqual([S1]);
  });

  it('answers a query by the bare transcript id of a delivered Codex session', async () => {
    const f = fixture({ sessions: [CODEX, S2] });
    await deliver(args(f));
    const found = await recipientsOf(f.owners, 'cccc3333-3333-4333-8333-333333333333');
    expect(found.map((row) => [row.recipient, row.matchId, row.session])).toEqual([['Acme Evals Inc.', M1, CODEX]]);
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

describe('deliver recipients --account (Art. 15(1)(c))', () => {
  const indexed = (f: Fixture, accounts: readonly [string | undefined, string | undefined]): void => {
    writeFileSync(join(f.root, 'index.jsonl'), [[S1, M1, accounts[0]], [S2, M2, accounts[1]]].map(([session, matchId, account]) => `${JSON.stringify({ pack: f.pack, session, project: 'p', matchId, ...(account === undefined ? {} : { account }) })}\n`).join(''));
  };

  it('deliver recipients --account lists each recipient and match id', async () => {
    const f = fixture();
    indexed(f, ['acct_one', 'acct_two']);
    await deliver(args(f));
    await deliver(args(f, { recipient: 'Beta Labs Ltd' }));
    const printed: string[] = [];
    expect(await main(['recipients', '--account', 'acct_one', '--owners', f.owners], { print: (text) => printed.push(text) })).toBe(0);
    const lines = printed.join('\n').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`Acme Evals Inc.\tmatch id ${M1}`);
    expect(lines[1]).toContain(`Beta Labs Ltd\tmatch id ${M1}`);
    expect(printed.join('\n')).not.toContain(M2);
    expect((await accountRecipientsOf(f.owners, 'acct_one')).map((row) => row.session)).toEqual([S1, S1]);
  });

  it('says so when nothing was delivered for the account, and wants an id', async () => {
    const f = fixture();
    indexed(f, ['acct_one', undefined]);
    const printed: string[] = [];
    expect(await main(['recipients', '--account', 'acct_one', '--owners', f.owners], { print: (text) => printed.push(text) })).toBe(0);
    expect(printed.join('\n')).toMatch(/No recipient holds a session of this account/);
    expect(await main(['recipients', '--account', '', '--owners', f.owners], { print: (text) => printed.push(text) })).toBe(2);
  });
});

describe('--buyer-key-file', () => {
  const argv = (f: Fixture, ...key: string[]): string[] => ['--pack', f.pack, '--recipient', 'Acme Evals Inc.', '--license', 'term-sheet-v1', ...key, '--owners', f.owners];
  const keyFile = (f: Fixture, text: string): string => {
    const file = join(f.root, 'buyer.key');
    writeFileSync(file, text);
    return file;
  };

  it('accepts a key from a file, with the same effect as the same key by flag', async () => {
    const byFlag = fixture();
    expect(await main(argv(byFlag, '--buyer-key', BUYER_KEY), { print: () => undefined })).toBe(0);
    const byFile = fixture();
    expect(await main(argv(byFile, '--buyer-key-file', keyFile(byFile, BUYER_KEY)), { print: () => undefined })).toBe(0);
    expect(rowsOf(byFile).map((row) => [row.keyId, row.matchId])).toEqual(rowsOf(byFlag).map((row) => [row.keyId, row.matchId]));
  });

  it('trims a trailing newline and whitespace from the file', async () => {
    const f = fixture();
    expect(await main(argv(f, '--buyer-key-file', keyFile(f, `${BUYER_KEY}\r\n \n`)), { print: () => undefined })).toBe(0);
    expect(rowsOf(f)[0]?.keyId).toBe(KEY_ID);
  });

  it('lists --buyer-key-file in the usage text as the route for a real key', () => {
    expect(USAGE).toMatch(/--buyer-key-file <path>[^\n]*logged by npm and just/);
  });

  it('refuses both --buyer-key and --buyer-key-file', async () => {
    const f = fixture();
    const printed: string[] = [];
    expect(await main(argv(f, '--buyer-key', BUYER_KEY, '--buyer-key-file', keyFile(f, BUYER_KEY)), { print: (text) => printed.push(text) })).toBe(2);
    expect(printed.join('\n')).toMatch(/not both/);
    expect(printed.join('\n')).not.toContain(BUYER_KEY);
  });

  it('refuses a missing file', async () => {
    const f = fixture();
    const printed: string[] = [];
    expect(await main(argv(f, '--buyer-key-file', join(f.root, 'absent.key')), { print: (text) => printed.push(text) })).toBe(2);
    expect(printed.join('\n')).toMatch(/Cannot read the --buyer-key-file/);
    expect(existsSync(join(f.root, 'deliveries.jsonl'))).toBe(false);
  });

  it('refuses an empty file', async () => {
    const f = fixture();
    const printed: string[] = [];
    expect(await main(argv(f, '--buyer-key-file', keyFile(f, '\n')), { print: (text) => printed.push(text) })).toBe(2);
    expect(printed.join('\n')).toMatch(/is empty/);
    expect(existsSync(join(f.root, 'deliveries.jsonl'))).toBe(false);
  });

  it('refuses a key from a file that is not the pack\'s, without printing the key', async () => {
    const f = fixture();
    const printed: string[] = [];
    expect(await main(argv(f, '--buyer-key-file', keyFile(f, 'another-secret-key')), { print: (text) => printed.push(text) })).toBe(2);
    expect(printed.join('\n')).toMatch(/buyer key is not the one/);
    expect(printed.join('\n')).not.toContain('another-secret-key');
    expect(existsSync(join(f.root, 'deliveries.jsonl'))).toBe(false);
  });
});
