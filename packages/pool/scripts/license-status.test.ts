// The license status read: fixtures only, written by hand in a temp folder. No store, key file, or network is read, and `deliver` itself writes the delivery rows, so the read is held to what the writer writes.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliver } from './deliver.js';
import { main as notices } from './notices.js';
import { licenseStatus, main, USAGE, type LicenseStatus, type StatusReport } from './license-status.js';
import { HARNESS_TERMS, keyIdOf, PackError, PERMITTED_USES, type IndexRow } from './sample-pack.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BUYER_KEY = 'buyer-key-one-never-printed';
const OTHER_KEY = 'buyer-key-two-never-printed';
const KEY_ID = keyIdOf(BUYER_KEY);
const BUILT = '2026-06-10T12:00:00.000Z';
const SENT = '2026-06-12T08:00:00.000Z';
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-1111-4111-8111-111111111111';
const BARE = 'cccc3333-3333-4333-8333-333333333333';
const M1 = 'a1'.repeat(32);
const M2 = 'b2'.repeat(32);
const M3 = 'c3'.repeat(32);
const ABSENT = 'd4'.repeat(32);
const OWNER = 'Quillfeather Holdings';
const PROJECT = 'C:/Users/quillfeather/work/ledger';
const PERSON = 'Priya Raman';
const TERMS = HARNESS_TERMS['claude-code']?.terms ?? [];

interface Fixture {
  root: string;
  operator: string;
  owners: string;
}

/** An operator folder as the build and `deliver` leave it: the owners file, and beside it the index, the objections, and (after a `deliver`) the deliveries. A key file sits there too, as the runbook keeps one, and nothing may read it. */
const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'oars-license-status-'));
  dirs.push(root);
  vi.stubEnv('APPDATA', root);
  const operator = join(root, 'operator');
  mkdirSync(join(operator, 'buyer-keys'), { recursive: true });
  writeFileSync(join(operator, 'buyer-keys', 'acme.key'), BUYER_KEY);
  const owners = join(operator, 'owners.json');
  writeFileSync(owners, JSON.stringify([{ folder: `${PROJECT}/**`, owner: OWNER, license: null }]));
  writeFileSync(join(operator, 'index.jsonl'), '');
  return { root, operator, owners };
};

/** A pack as `buildPack` leaves it, with its index lines appended as the build appends them. */
const packOf = (f: Fixture, lot: string, sessions: readonly (readonly [string, string])[], extra: { buyerKey?: string; indexOnly?: boolean; text?: string } = {}): string => {
  const pack = join(f.root, 'packs', lot);
  if (extra.indexOnly !== true) {
    for (const [, matchId] of sessions) {
      mkdirSync(join(pack, 'sessions', matchId), { recursive: true });
      writeFileSync(join(pack, 'sessions', matchId, 'main.jsonl'), `${JSON.stringify({ text: matchId === M1 ? (extra.text ?? `ask ${PERSON} about the schema`) : 'run the build' })}\n`);
    }
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, 'pack.json'), JSON.stringify({ built: BUILT, keyId: keyIdOf(extra.buyerKey ?? BUYER_KEY), objections: 'none' }));
    writeFileSync(join(pack, 'manifest.jsonl'), sessions.map(([, matchId]) => `${JSON.stringify({ matchId, harness: 'claude-code', repoOwner: OWNER, sourceLicense: null, harnessTerms: TERMS, permittedUses: PERMITTED_USES, training: 'not-offered' })}\n`).join(''));
  }
  const rows: IndexRow[] = sessions.map(([session, matchId]) => ({ pack, session, project: PROJECT, matchId }));
  writeFileSync(join(f.operator, 'index.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { flag: 'a' });
  return pack;
};

const send = async (f: Fixture, pack: string, recipient: string, license: string, at = SENT): Promise<void> => {
  await deliver({ pack, recipient, license, buyerKey: BUYER_KEY, owners: f.owners, now: () => new Date(at) });
};

const object = (f: Fixture, rows: readonly object[]): void => {
  writeFileSync(join(f.operator, 'objections.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
};

/** Records a notice or its confirmation through the command, as the operator does. */
const notice = async (f: Fixture, kind: 'sent' | 'confirmed', recipient: string, matchId: string, at: string): Promise<void> => {
  expect(await notices([kind, matchId, '--recipient', recipient, '--operator', f.operator], { print: () => undefined, now: () => new Date(at) })).toBe(0);
};

const only = (report: StatusReport): LicenseStatus => {
  const [row] = report.rows;
  if (row === undefined || report.rows.length !== 1) throw new Error('expected one row');
  return row;
};

const LOT_1 = { lot: 'lot-1', built: BUILT, listed: true, harnessTerms: TERMS, permittedUses: [...PERMITTED_USES], training: 'not-offered' };

describe('licenseStatus', () => {
  it('reads a row built into a lot and never delivered as built, with the terms its manifest row states', async () => {
    const f = fixture();
    packOf(f, 'lot-1', [[S1, M1], [S2, M2]]);

    expect(only(await licenseStatus(f.operator, KEY_ID, [M2]))).toEqual({
      matchId: M2, state: 'built', keyVerified: true, lots: [LOT_1], deliveries: [], withdrawn: [], erasure: 'none-due', covenant: 'unknown',
    });
  });

  it('license-status prints the covenant of a deposit row', async () => {
    const f = fixture();
    const pack = packOf(f, 'lot-1', [[S1, M1], [S2, M2], [BARE, M3]]);
    const manifest = join(pack, 'manifest.jsonl');
    const rows = readFileSync(manifest, 'utf8').split('\n').filter((line) => line !== '').map((line): { [key: string]: unknown } => {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
    });
    const deposit = rows.map((row) => (row.matchId === M2
      ? { ...row, repoOwner: 'depositor:0123456789abcdef', sourceLicense: 'manyoars-covenant 2.1 sha256:' + 'ab'.repeat(32), acceptedAt: '2026-07-01T00:00:00.000Z' }
      : row.matchId === M3 ? { ...row, sourceLicense: 'manyoars-covenant 2.0 sha256:' + 'cd'.repeat(32) } : row));
    writeFileSync(manifest, deposit.map((row) => `${JSON.stringify(row)}\n`).join(''));
    const report = await licenseStatus(f.operator, KEY_ID, [M1, M2, M3]);
    expect(report.rows.map(({ matchId, covenant }) => [matchId, covenant])).toEqual([[M1, 'unknown'], [M2, '2.1, accepted 2026-07-01T00:00:00.000Z'], [M3, '2.0']]);
    const out: string[] = [];
    expect(await main([M2, '--key-id', KEY_ID, '--operator', f.operator], { print: (line) => out.push(line) })).toBe(0);
    expect(out.join('\n')).toContain('2.1, accepted 2026-07-01T00:00:00.000Z');
  });

  it('reads a delivered row with its recipient, license, and date', async () => {
    const f = fixture();
    await send(f, packOf(f, 'lot-1', [[S1, M1], [S2, M2]]), 'Acme Evals Inc.', 'term-sheet-v1');

    expect(only(await licenseStatus(f.operator, KEY_ID, [M2]))).toEqual({
      matchId: M2, state: 'delivered', keyVerified: true, lots: [LOT_1], deliveries: [{ lot: 'lot-1', recipient: 'Acme Evals Inc.', license: 'term-sheet-v1', deliveredAt: SENT, erasure: { state: 'none-due', at: undefined } }], withdrawn: [], erasure: 'none-due', covenant: 'unknown',
    });
  });

  it('reads a row objected to after its delivery as withdrawn, its erasure at the recipient unknown', async () => {
    const f = fixture();
    await send(f, packOf(f, 'lot-1', [[S1, M1], [S2, M2]]), 'Acme Evals Inc.', 'term-sheet-v1');
    object(f, [{ session: S2, received: '2026-06-13T09:00:00Z', scope: 'all' }]);

    const report = await licenseStatus(f.operator, KEY_ID, [M1, M2]);

    expect(report.rows.map((row) => [row.matchId, row.state, row.erasure])).toEqual([[M1, 'delivered', 'none-due'], [M2, 'withdrawn', 'unknown']]);
    expect(report.rows[1]?.withdrawn).toEqual([{ received: '2026-06-13T09:00:00Z', scope: 'all', basis: 'session' }]);
    expect(report.rows[1]?.deliveries).toHaveLength(1);
  });

  it('reads a row objected to before any delivery as withdrawn with no erasure due', async () => {
    const f = fixture();
    packOf(f, 'lot-1', [[S1, M1], [S2, M2]]);
    object(f, [{ session: S2, received: '2026-06-11T09:00:00Z', scope: 'sale' }]);

    expect(only(await licenseStatus(f.operator, KEY_ID, [M2]))).toMatchObject({ state: 'withdrawn', deliveries: [], erasure: 'none-due' });
  });

  it('matches an objection that names a Codex session by its bare transcript id', async () => {
    const f = fixture();
    packOf(f, 'lot-1', [[`codex-${BARE}`, M1], [S2, M2]]);
    object(f, [{ session: BARE, received: '2026-06-13T09:00:00Z', scope: 'training' }]);

    expect(only(await licenseStatus(f.operator, KEY_ID, [M1]))).toMatchObject({ state: 'withdrawn', withdrawn: [{ received: '2026-06-13T09:00:00Z', scope: 'training', basis: 'session' }] });
  });

  it('finds an objection by a person\'s name in the delivered text, and only in the row that holds it', async () => {
    const f = fixture();
    await send(f, packOf(f, 'lot-1', [[S1, M1], [S2, M2]], { text: 'ask PRIYA   raman about the schema' }), 'Acme Evals Inc.', 'term-sheet-v1');
    object(f, [{ name: PERSON, received: '2026-06-13T09:00:00Z', scope: 'sale' }]);

    const report = await licenseStatus(f.operator, KEY_ID, [M1, M2]);

    expect(report.rows.map((row) => [row.state, row.withdrawn, row.erasure])).toEqual([
      ['withdrawn', [{ received: '2026-06-13T09:00:00Z', scope: 'sale', basis: 'name' }], 'unknown'],
      ['delivered', [], 'none-due'],
    ]);
  });

  it('reads the withdrawal as unknown when an objection names a person and the row\'s text is no longer on the machine', async () => {
    const f = fixture();
    const pack = packOf(f, 'lot-1', [[S1, M1], [S2, M2]]);
    await send(f, pack, 'Acme Evals Inc.', 'term-sheet-v1');
    rmSync(pack, { recursive: true });
    object(f, [{ name: PERSON, received: '2026-06-13T09:00:00Z', scope: 'sale' }]);

    expect(only(await licenseStatus(f.operator, KEY_ID, [M1]))).toMatchObject({ state: 'delivered', keyVerified: true, withdrawn: 'unknown', erasure: 'unknown', lots: [{ lot: 'lot-1', built: 'unknown', listed: 'unknown', harnessTerms: 'unknown', permittedUses: 'unknown', training: 'unknown' }] });
  });

  it('reads an id the register does not hold as unknown', async () => {
    const f = fixture();
    packOf(f, 'lot-1', [[S1, M1], [S2, M2]]);

    const report = await licenseStatus(f.operator, KEY_ID, [ABSENT]);

    expect(only(report)).toEqual({ matchId: ABSENT, state: 'unknown', keyVerified: false, lots: [], deliveries: [], withdrawn: 'unknown', erasure: 'unknown', covenant: 'unknown' });
    expect(report.underAnotherKey).toBe(0);
  });

  it('reads an id held under another buyer key as unknown, and counts it', async () => {
    const f = fixture();
    packOf(f, 'lot-1', [[S1, M1], [S2, M2]], { buyerKey: OTHER_KEY });

    const report = await licenseStatus(f.operator, KEY_ID, [M1, ABSENT]);

    expect(report.rows.map((row) => [row.state, row.lots])).toEqual([['unknown', []], ['unknown', []]]);
    expect(report).toMatchObject({ keyId: KEY_ID, underAnotherKey: 1 });
  });

  it('reads a row present in two lots as one row, with each lot and each delivery', async () => {
    const f = fixture();
    await send(f, packOf(f, 'lot-1', [[S1, M1], [S2, M2]]), 'Acme Evals Inc.', 'term-sheet-v1');
    await send(f, packOf(f, 'lot-2', [[S1, M1], [S2, M3]]), 'Beta Labs Ltd', 'term-sheet-v2', '2026-07-01T10:00:00.000Z');

    const row = only(await licenseStatus(f.operator, KEY_ID, [M1, M1]));

    expect(row.state).toBe('delivered');
    expect(row.lots).toEqual([LOT_1, { ...LOT_1, lot: 'lot-2' }]);
    expect(row.deliveries).toEqual([
      { lot: 'lot-1', recipient: 'Acme Evals Inc.', license: 'term-sheet-v1', deliveredAt: SENT, erasure: { state: 'none-due', at: undefined } },
      { lot: 'lot-2', recipient: 'Beta Labs Ltd', license: 'term-sheet-v2', deliveredAt: '2026-07-01T10:00:00.000Z', erasure: { state: 'none-due', at: undefined } },
    ]);
  });

  it('says so when a rebuild left the row out of the pack the index still names', async () => {
    const f = fixture();
    packOf(f, 'lot-1', [[S1, M1], [S2, M2]], { indexOnly: true });
    packOf(f, 'lot-1', [[S2, M2]]);

    expect(only(await licenseStatus(f.operator, KEY_ID, [M1]))).toMatchObject({ state: 'built', keyVerified: false, lots: [{ lot: 'lot-1', built: 'unknown', listed: false }] });
    expect(only(await licenseStatus(f.operator, KEY_ID, [M2]))).toMatchObject({ state: 'built', keyVerified: true, lots: [LOT_1] });
  });

  it('keeps a built row whose pack folder is gone, with the key not verified', async () => {
    const f = fixture();
    packOf(f, 'lot-1', [[S1, M1]], { indexOnly: true });

    expect(only(await licenseStatus(f.operator, KEY_ID, [M1]))).toMatchObject({ state: 'built', keyVerified: false, withdrawn: [], lots: [{ lot: 'lot-1', listed: 'unknown' }] });
  });

  it('reads the erasure at each recipient from the notice register: unknown with no notice, then notice-sent and confirmed with their dates', async () => {
    const f = fixture();
    const pack = packOf(f, 'lot-1', [[S1, M1], [S2, M2]]);
    await send(f, pack, 'Acme Evals Inc.', 'term-sheet-v1');
    await send(f, pack, 'Beta Labs Ltd', 'term-sheet-v2');
    object(f, [{ session: S2, received: '2026-06-13T09:00:00Z', scope: 'all' }]);
    const erasures = async (): Promise<unknown> => {
      const row = only(await licenseStatus(f.operator, KEY_ID, [M2]));
      return [row.erasure, row.deliveries.map(({ recipient, erasure }) => [recipient, erasure])];
    };

    expect(await erasures()).toEqual(['unknown', [['Acme Evals Inc.', { state: 'unknown', at: undefined }], ['Beta Labs Ltd', { state: 'unknown', at: undefined }]]]);

    await notice(f, 'sent', 'Acme Evals Inc.', M2, '2026-07-01T09:00:00.000Z');
    expect(await erasures()).toEqual(['unknown', [['Acme Evals Inc.', { state: 'notice-sent', at: '2026-07-01T09:00:00.000Z' }], ['Beta Labs Ltd', { state: 'unknown', at: undefined }]]]);

    await notice(f, 'confirmed', 'Acme Evals Inc.', M2, '2026-07-03T10:30:00.000Z');
    await notice(f, 'sent', 'Beta Labs Ltd', M2, '2026-07-02T09:00:00.000Z');
    expect(await erasures()).toEqual(['notice-sent', [['Acme Evals Inc.', { state: 'confirmed', at: '2026-07-03T10:30:00.000Z' }], ['Beta Labs Ltd', { state: 'notice-sent', at: '2026-07-02T09:00:00.000Z' }]]]);

    await notice(f, 'confirmed', 'Beta Labs Ltd', M2, '2026-07-04T08:00:00.000Z');
    expect(await erasures()).toEqual(['confirmed', [['Acme Evals Inc.', { state: 'confirmed', at: '2026-07-03T10:30:00.000Z' }], ['Beta Labs Ltd', { state: 'confirmed', at: '2026-07-04T08:00:00.000Z' }]]]);
  });

  it('reads a notice recorded for a row no objection covers as it stands, and leaves the other rows none-due', async () => {
    const f = fixture();
    await send(f, packOf(f, 'lot-1', [[S1, M1], [S2, M2]]), 'Acme Evals Inc.', 'term-sheet-v1');
    await notice(f, 'sent', 'Acme Evals Inc.', M1, '2026-07-01T09:00:00.000Z');

    const report = await licenseStatus(f.operator, KEY_ID, [M1, M2]);

    expect(report.rows.map((row) => [row.state, row.erasure])).toEqual([['delivered', 'notice-sent'], ['delivered', 'none-due']]);
  });

  it('reads a row confirmed at one recipient and none-due at the other as confirmed, whichever delivery comes first', async () => {
    const reads: string[] = [];
    for (const confirmedAt of ['Acme Evals Inc.', 'Beta Labs Ltd']) {
      const f = fixture();
      await send(f, packOf(f, 'lot-1', [[S1, M1]]), 'Acme Evals Inc.', 'term-sheet-v1');
      await send(f, packOf(f, 'lot-2', [[S1, M1]]), 'Beta Labs Ltd', 'term-sheet-v2');
      await notice(f, 'sent', confirmedAt, M1, '2026-07-01T09:00:00.000Z');
      await notice(f, 'confirmed', confirmedAt, M1, '2026-07-02T09:00:00.000Z');
      const row = only(await licenseStatus(f.operator, KEY_ID, [M1]));
      reads.push(`${row.erasure}:${row.deliveries.map(({ recipient, erasure }) => `${recipient}=${erasure.state}`).join(',')}`);
    }

    expect(reads).toEqual(['confirmed:Acme Evals Inc.=confirmed,Beta Labs Ltd=none-due', 'confirmed:Acme Evals Inc.=none-due,Beta Labs Ltd=confirmed']);
  });

  it('refuses a register line that is cut, naming the file and not quoting it', async () => {
    const f = fixture();
    await send(f, packOf(f, 'lot-1', [[S1, M1]]), 'Acme Evals Inc.', 'term-sheet-v1');
    writeFileSync(join(f.operator, 'notices.jsonl'), `{"recipient":"Acme Evals Inc.","session":"${S1}"
`);

    await expect(licenseStatus(f.operator, KEY_ID, [M1])).rejects.toThrow(/^notices\.jsonl holds a line that is not JSON\.$/);
  });

  it('refuses a pack folder it cannot read, naming the lot and not the path', async () => {
    const f = fixture();
    const pack = packOf(f, 'lot-1', [[S1, M1]]);
    rmSync(join(pack, 'pack.json'));
    mkdirSync(join(pack, 'pack.json'));

    const error: unknown = await licenseStatus(f.operator, KEY_ID, [M1]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PackError);
    expect(String(error)).toMatch(/pack folder of lot lot-1 cannot be read\./);
    expect(String(error)).not.toContain(f.root);
  });

  it('refuses delivered text it cannot read, naming the lot and not the path', async () => {
    const f = fixture();
    const pack = packOf(f, 'lot-1', [[S1, M1]]);
    object(f, [{ name: PERSON, received: '2026-06-13T09:00:00Z', scope: 'sale' }]);
    rmSync(join(pack, 'sessions', M1), { recursive: true });
    writeFileSync(join(pack, 'sessions', M1), 'a file where the folder of the row should be');

    const error: unknown = await licenseStatus(f.operator, KEY_ID, [M1]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PackError);
    expect(String(error)).toMatch(/pack folder of lot lot-1 cannot be read\./);
    expect(String(error)).not.toContain(f.root);
  });

  it('refuses a folder with no index, so a mistyped folder never reads as every id unknown', async () => {
    const f = fixture();
    await expect(licenseStatus(join(f.root, 'no-such-folder'), KEY_ID, [M1])).rejects.toThrow(/index\.jsonl/);
  });
});

const run = async (argv: readonly string[]): Promise<{ code: number; text: string }> => {
  const printed: string[] = [];
  const code = await main(argv, { print: (text) => printed.push(text) });
  return { code, text: printed.join('\n') };
};

/** Every file under a folder with its bytes, so a run that wrote, removed, or changed anything shows. */
const snapshot = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((item) => item.isFile()).map((item) => `${join(item.parentPath, item.name)}\n${readFileSync(join(item.parentPath, item.name), 'utf8')}`).sort();

/** Two lots, both delivered, one row withdrawn by session and one by name: every kind of row a run can print. */
const full = async (): Promise<Fixture> => {
  const f = fixture();
  await send(f, packOf(f, 'lot-1', [[S1, M1], [`codex-${BARE}`, M2]]), 'Acme Evals Inc.', 'term-sheet-v1');
  await send(f, packOf(f, 'lot-2', [[S1, M1], [S2, M3]]), 'Beta Labs Ltd', 'term-sheet-v2');
  object(f, [{ session: BARE, received: '2026-06-13T09:00:00Z', scope: 'all' }, { name: PERSON, received: '2026-06-14T09:00:00Z', scope: 'sale' }]);
  writeFileSync(join(f.operator, 'ids.txt'), `${M1}\n\n${M2.toUpperCase()}\n${M3}\n${ABSENT}\n`);
  return f;
};

describe('license-status (the command)', () => {
  it('prints a table with one line per match id, then the count', async () => {
    const f = await full();

    const { code, text } = await run(['--ids', join(f.operator, 'ids.txt'), '--key-id', KEY_ID, '--operator', f.operator]);

    expect(code).toBe(0);
    const lines = text.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^match id\s+state\s+lots\s+delivered to\s+withdrawn\s+recipient erasure\s+covenant$/);
    expect(lines[1]).toMatch(new RegExp(`^${M1}\\s+withdrawn\\s+lot-1; lot-2\\s+Acme Evals Inc\\. \\(lot-1, term-sheet-v1, ${SENT}\\); Beta Labs Ltd \\(lot-2, term-sheet-v2, ${SENT}\\)\\s+2026-06-14T09:00:00Z sale \\(name\\)\\s+unknown\\s+unknown$`));
    expect(lines[2]).toMatch(new RegExp(`^${M2}\\s+withdrawn\\s+lot-1\\s+.*2026-06-13T09:00:00Z all \\(session\\)\\s+unknown\\s+unknown$`));
    expect(lines[3]).toMatch(new RegExp(`^${M3}\\s+delivered\\s+lot-2\\s+Beta Labs Ltd \\(lot-2, term-sheet-v2, ${SENT}\\)\\s+-\\s+none-due\\s+unknown$`));
    expect(lines[4]).toMatch(new RegExp(`^${ABSENT}\\s+unknown\\s+-\\s+-\\s+unknown\\s+unknown\\s+unknown$`));
    expect(lines[5]).toBe(`4 match ids under key id ${KEY_ID}: 1 unknown.`);
  });

  it('prints the erasure at each recipient with its date in the table and in the JSON', async () => {
    const f = await full();
    await notice(f, 'sent', 'Acme Evals Inc.', M1, '2026-07-01T09:00:00.000Z');
    await notice(f, 'confirmed', 'Acme Evals Inc.', M1, '2026-07-03T10:30:00.000Z');
    await notice(f, 'sent', 'Beta Labs Ltd', M1, '2026-07-02T09:00:00.000Z');

    const table = await run([M1, '--key-id', KEY_ID, '--operator', f.operator]);
    const json = await run([M1, '--key-id', KEY_ID, '--operator', f.operator, '--json']);

    expect(table.text.split('\n')[1]).toMatch(/Acme Evals Inc\. confirmed 2026-07-03T10:30:00\.000Z; Beta Labs Ltd notice-sent 2026-07-02T09:00:00\.000Z\s+unknown$/);
    expect(JSON.parse(json.text)).toMatchObject({ rows: [{ erasure: 'notice-sent', deliveries: [{ recipient: 'Acme Evals Inc.', erasure: { state: 'confirmed', at: '2026-07-03T10:30:00.000Z' } }, { recipient: 'Beta Labs Ltd', erasure: { state: 'notice-sent', at: '2026-07-02T09:00:00.000Z' } }] }] });
  });

  it('prints the same rows as one JSON document with --json', async () => {
    const f = await full();

    const { code, text } = await run([M3, '--json', '--key-id', KEY_ID, '--operator', f.operator]);

    expect(code).toBe(0);
    const printed: unknown = JSON.parse(text);
    const report: unknown = JSON.parse(JSON.stringify(await licenseStatus(f.operator, KEY_ID, [M3])));
    expect(printed).toEqual(report);
    expect(printed).toMatchObject({ keyId: KEY_ID, underAnotherKey: 0, rows: [{ matchId: M3, state: 'delivered' }] });
  });

  it('says how many ids sit under another key id, so a wrong key id does not read as an empty register', async () => {
    const f = await full();

    const { text } = await run([M1, '--key-id', keyIdOf(OTHER_KEY), '--operator', f.operator]);

    expect(text.split('\n').pop()).toBe(`1 match id under key id ${keyIdOf(OTHER_KEY)}: 1 unknown, 1 of them recorded under another key id.`);
  });

  it('marks a row whose key no file on the machine confirms', async () => {
    const f = fixture();
    packOf(f, 'lot-1', [[S1, M1]], { indexOnly: true });

    expect((await run([M1, '--key-id', KEY_ID, '--operator', f.operator])).text).toMatch(/built \(key not verified\)\s+lot-1 /);
  });

  it('never prints a session id, an owner, a project folder, a person\'s name, or a key', async () => {
    const f = await full();
    const secrets = [S1, S2, BARE, OWNER, PROJECT, 'quillfeather', PERSON, 'Raman', BUYER_KEY, OTHER_KEY, f.root, f.root.replaceAll('\\', '\\\\')];
    const asked = ['--ids', join(f.operator, 'ids.txt'), '--key-id', KEY_ID, '--operator', f.operator];

    const outputs = [
      (await run(asked)).text,
      (await run([...asked, '--json'])).text,
      // Mistakes an operator can make: a session id where the match id goes, the key where its id goes, a key as a stray word, and a register line cut short.
      (await run([S1, '--key-id', KEY_ID, '--operator', f.operator])).text,
      (await run([M1, '--key-id', BUYER_KEY, '--operator', f.operator])).text,
      (await run([M1, BUYER_KEY, '--key-id', KEY_ID, '--operator', f.operator])).text,
      (await run([M1, `--${BUYER_KEY}`, '--key-id', KEY_ID, '--operator', f.operator])).text,
    ];
    writeFileSync(join(f.operator, 'ids.txt'), `${M1}\n${S1}\n`);
    outputs.push((await run(asked)).text);
    writeFileSync(join(f.operator, 'deliveries.jsonl'), `{"recipient":"Acme Evals Inc.","session":"${S1}"\n`, { flag: 'a' });
    outputs.push((await run([M1, '--key-id', KEY_ID, '--operator', f.operator])).text);
    writeFileSync(join(f.operator, 'index.jsonl'), `{"session":"${S1}",\n`, { flag: 'a' });
    outputs.push((await run([M1, '--key-id', KEY_ID, '--operator', f.operator])).text);

    // The register cut on a fresh fixture, so index.jsonl and deliveries.jsonl are sound and the run reaches the notices refusal itself.
    const cut = await full();
    writeFileSync(join(cut.operator, 'notices.jsonl'), `{"recipient":"Acme Evals Inc.","session":"${S1}"\n`);
    const cutOutput = (await run([M1, '--key-id', KEY_ID, '--operator', cut.operator])).text;
    expect(cutOutput).toContain('notices.jsonl holds a line that is not JSON.');
    outputs.push(cutOutput);

    expect(outputs).toHaveLength(10);
    for (const output of outputs) {
      expect(output).not.toBe('');
      for (const secret of secrets) expect(output).not.toContain(secret);
    }
    expect(cutOutput).not.toContain(cut.root);
    expect(USAGE).toMatch(/never the key/);
  });

  it('writes nothing and makes no network call', async () => {
    const f = await full();
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const before = snapshot(f.root);

    expect((await run(['--ids', join(f.operator, 'ids.txt'), '--key-id', KEY_ID, '--operator', f.operator, '--json'])).code).toBe(0);

    expect(snapshot(f.root)).toEqual(before);
    expect(fetched).toHaveBeenCalledTimes(0);
  });

  it('exits 2 with the reason and the usage on a bad call', async () => {
    const f = await full();
    const base = ['--key-id', KEY_ID, '--operator', f.operator];
    const cases: [readonly string[], RegExp][] = [
      [base, /Give a match id, or a file of them with --ids/],
      [[M1, '--ids', join(f.operator, 'ids.txt'), ...base], /Give a match id, or a file of them with --ids/],
      [[M1, M2, ...base], /one match id/],
      [[M1, '--operator', f.operator], /Missing --key-id/],
      [[M1, '--key-id', KEY_ID], /Missing --operator/],
      [[M1, '--key-id', KEY_ID.toUpperCase(), '--operator', f.operator], /16 hex characters/],
      [[M1, ...base, '--ids'], /Missing the value of --ids/],
      [[M1, ...base, '--verbose'], /Unknown option\./],
      [['abc', ...base], /64 hex characters/],
    ];
    for (const [argv, reason] of cases) {
      const { code, text } = await run(argv);
      expect([code, reason.test(text), text.includes('Usage: license-status')]).toEqual([2, true, true]);
    }
  });

  it('exits 2 on a missing or empty ids file and on a folder that is not the operator folder', async () => {
    const f = await full();
    writeFileSync(join(f.operator, 'empty.txt'), '\n\n');
    const cases: [readonly string[], RegExp][] = [
      [['--ids', join(f.operator, 'none.txt'), '--key-id', KEY_ID, '--operator', f.operator], /--ids file is missing/],
      [['--ids', join(f.operator, 'empty.txt'), '--key-id', KEY_ID, '--operator', f.operator], /names no match id/],
      [[M1, '--key-id', KEY_ID, '--operator', join(f.root, 'packs')], /index\.jsonl/],
    ];
    for (const [argv, reason] of cases) {
      const { code, text } = await run(argv);
      expect([code, reason.test(text)]).toEqual([2, true]);
    }
  });
});
