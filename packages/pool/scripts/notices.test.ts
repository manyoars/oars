// The erasure-notice register: fixtures only, written by hand in a temp folder. No store, key file, or network is read.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, noticeOf, noticesOf, NOTICES_FILE, USAGE } from './notices.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-1111-4111-8111-111111111111';
const M1 = 'a1'.repeat(32);
const M2 = 'b2'.repeat(32);
const M3 = 'c3'.repeat(32);
const ACME = 'Acme Evals Inc.';
const BETA = 'Beta Labs Ltd';
const OWNER = 'Quillfeather Holdings';
const PROJECT = 'C:/Users/quillfeather/work/ledger';
const BUYER_KEY = 'buyer-key-one-never-printed';
const PACK = 'C:/Users/quillfeather/packs/lot-1';
const T1 = '2026-07-01T09:00:00.000Z';
const T2 = '2026-07-03T10:30:00.000Z';

/** An operator folder with the deliveries `deliver` leaves: Acme holds M1 and M2, Beta holds M2 and M3. */
const fixture = (): { root: string; operator: string } => {
  const root = mkdtempSync(join(tmpdir(), 'oars-notices-'));
  dirs.push(root);
  vi.stubEnv('APPDATA', root);
  const operator = join(root, 'operator');
  mkdirSync(operator, { recursive: true });
  const delivery = (recipient: string, matchId: string, session: string): string => `${JSON.stringify({ recipient, lot: 'lot-1', keyId: '0123456789abcdef', matchId, session, deliveredAt: '2026-06-12T08:00:00.000Z', license: 'term-sheet-v1' })}\n`;
  writeFileSync(join(operator, 'deliveries.jsonl'), [delivery(ACME, M1, S1), delivery(ACME, M2, S2), delivery(BETA, M2, S2), delivery(BETA, M3, S1)].join(''));
  writeFileSync(join(operator, 'index.jsonl'), `${JSON.stringify({ pack: PACK, session: S1, project: PROJECT, matchId: M1 })}\n`);
  writeFileSync(join(operator, 'owners.json'), JSON.stringify([{ folder: `${PROJECT}/**`, owner: OWNER, license: null }]));
  return { root, operator };
};

const run = async (argv: readonly string[], at = T1): Promise<{ code: number; text: string }> => {
  const printed: string[] = [];
  const code = await main(argv, { print: (text) => printed.push(text), now: () => new Date(at) });
  return { code, text: printed.join('\n') };
};

const registerOf = (operator: string): string => readFileSync(join(operator, NOTICES_FILE), 'utf8');
const rowsOf = (operator: string): unknown[] => registerOf(operator).split('\n').filter((row) => row !== '').map((row): unknown => JSON.parse(row));
const snapshot = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((item) => item.isFile()).map((item) => `${join(item.parentPath, item.name)}\n${readFileSync(join(item.parentPath, item.name), 'utf8')}`).sort();

describe('notices sent', () => {
  it('appends one line for the recipient and the match id, with the time of the call', async () => {
    const f = fixture();

    const { code, text } = await run(['sent', M1, '--recipient', ACME, '--operator', f.operator]);

    expect(code).toBe(0);
    expect(rowsOf(f.operator)).toEqual([{ recipient: ACME, matchId: M1, sentAt: T1 }]);
    expect(text).toMatch(/Recorded 1 erasure notice as sent to Acme Evals Inc\. in notices\.jsonl \(0 already recorded, skipped\)\. Nothing was sent: send the notice yourself\./);
  });

  it('takes a file of match ids, in any case and with blank lines, and writes one line each', async () => {
    const f = fixture();
    writeFileSync(join(f.operator, 'ids.txt'), `${M2.toUpperCase()}\n\n${M3}\n`);

    expect((await run(['sent', '--ids', join(f.operator, 'ids.txt'), '--recipient', BETA, '--operator', f.operator])).code).toBe(0);

    expect(rowsOf(f.operator)).toEqual([{ recipient: BETA, matchId: M2, sentAt: T1 }, { recipient: BETA, matchId: M3, sentAt: T1 }]);
  });

  it('refuses a match id with no delivery to that recipient, and writes nothing, not even for the ids that have one', async () => {
    const f = fixture();
    writeFileSync(join(f.operator, 'ids.txt'), `${M1}\n${M3}\n`);
    const before = snapshot(f.root);

    const { code, text } = await run(['sent', '--ids', join(f.operator, 'ids.txt'), '--recipient', ACME, '--operator', f.operator]);

    expect(code).toBe(2);
    expect(text).toContain(`No delivery to this recipient holds match id ${M3}`);
    expect(text).not.toContain(M1);
    expect(snapshot(f.root)).toEqual(before);
  });

  it('refuses when the operator folder holds no deliveries at all', async () => {
    const f = fixture();
    rmSync(join(f.operator, 'deliveries.jsonl'));

    expect((await run(['sent', M1, '--recipient', ACME, '--operator', f.operator])).code).toBe(2);
    expect(() => readFileSync(join(f.operator, NOTICES_FILE))).toThrow(/ENOENT/);
  });

  it('skips a notice already recorded and counts it, so a repeat run adds no second line', async () => {
    const f = fixture();
    await run(['sent', M1, '--recipient', ACME, '--operator', f.operator]);

    const again = await run(['sent', M1, '--recipient', ACME, '--operator', f.operator], T2);

    expect(again.code).toBe(0);
    expect(again.text).toMatch(/Recorded 0 erasure notices .* \(1 already recorded, skipped\)/);
    expect(rowsOf(f.operator)).toEqual([{ recipient: ACME, matchId: M1, sentAt: T1 }]);
  });

  it('keeps one recipient\'s notice apart from another\'s for the same match id', async () => {
    const f = fixture();
    await run(['sent', M2, '--recipient', ACME, '--operator', f.operator]);
    await run(['sent', M2, '--recipient', BETA, '--operator', f.operator], T2);

    expect(rowsOf(f.operator)).toEqual([{ recipient: ACME, matchId: M2, sentAt: T1 }, { recipient: BETA, matchId: M2, sentAt: T2 }]);
  });
});

describe('notices confirmed', () => {
  it('appends a second line that carries the notice\'s time and the confirmation\'s, and rewrites nothing before it', async () => {
    const f = fixture();
    await run(['sent', M1, '--recipient', ACME, '--operator', f.operator]);
    const first = registerOf(f.operator);

    const { code, text } = await run(['confirmed', M1, '--recipient', ACME, '--operator', f.operator], T2);

    expect(code).toBe(0);
    expect(text).toMatch(/Recorded 1 erasure confirmation from Acme Evals Inc\./);
    expect(registerOf(f.operator).startsWith(first)).toBe(true);
    expect(rowsOf(f.operator)).toEqual([{ recipient: ACME, matchId: M1, sentAt: T1 }, { recipient: ACME, matchId: M1, sentAt: T1, confirmedAt: T2 }]);
  });

  it('refuses a confirmation with no notice, and writes nothing', async () => {
    const f = fixture();
    await run(['sent', M1, '--recipient', ACME, '--operator', f.operator]);
    const before = snapshot(f.root);

    const { code, text } = await run(['confirmed', M2, '--recipient', ACME, '--operator', f.operator], T2);

    expect(code).toBe(2);
    expect(text).toContain(`No erasure notice to this recipient is recorded for match id ${M2}`);
    expect(snapshot(f.root)).toEqual(before);
  });

  it('refuses a confirmation for a match id that was never delivered to the recipient', async () => {
    const f = fixture();

    const { code, text } = await run(['confirmed', M3, '--recipient', ACME, '--operator', f.operator]);

    expect(code).toBe(2);
    expect(text).toContain(`No delivery to this recipient holds match id ${M3}`);
  });

  it('confirms every id or none: one id with no notice stops the whole call', async () => {
    const f = fixture();
    await run(['sent', M1, '--recipient', ACME, '--operator', f.operator]);
    writeFileSync(join(f.operator, 'ids.txt'), `${M1}\n${M2}\n`);
    const before = snapshot(f.root);

    expect((await run(['confirmed', '--ids', join(f.operator, 'ids.txt'), '--recipient', ACME, '--operator', f.operator], T2)).code).toBe(2);

    expect(snapshot(f.root)).toEqual(before);
  });

  it('skips a confirmation already recorded and keeps the first date', async () => {
    const f = fixture();
    await run(['sent', M1, '--recipient', ACME, '--operator', f.operator]);
    await run(['confirmed', M1, '--recipient', ACME, '--operator', f.operator], T2);

    const again = await run(['confirmed', M1, '--recipient', ACME, '--operator', f.operator], '2026-08-01T00:00:00.000Z');

    expect(again.text).toMatch(/\(1 already recorded, skipped\)/);
    expect(rowsOf(f.operator)).toHaveLength(2);
  });
});

describe('the register', () => {
  it('reads the newest line per recipient and match id, whatever the order of other recipients\' lines', async () => {
    const f = fixture();
    await run(['sent', M2, '--recipient', ACME, '--operator', f.operator]);
    await run(['sent', M2, '--recipient', BETA, '--operator', f.operator], T2);
    await run(['confirmed', M2, '--recipient', ACME, '--operator', f.operator], T2);

    const notices = await noticesOf(f.operator);

    expect(notices).toHaveLength(3);
    expect(noticeOf(notices, ACME, M2)).toEqual({ recipient: ACME, matchId: M2, sentAt: T1, confirmedAt: T2 });
    expect(noticeOf(notices, BETA, M2)).toEqual({ recipient: BETA, matchId: M2, sentAt: T2, confirmedAt: undefined });
    expect(noticeOf(notices, ACME, M1)).toBeUndefined();
  });

  it('reads an operator folder with no register as holding no notice', async () => {
    expect(await noticesOf(fixture().operator)).toEqual([]);
  });

  it('refuses a line that is not JSON, or not a notice, without quoting it', async () => {
    const f = fixture();
    writeFileSync(join(f.operator, NOTICES_FILE), `{"recipient":"${ACME}","session":"${S1}"\n`);
    await expect(noticesOf(f.operator)).rejects.toThrow(/^notices\.jsonl holds a line that is not JSON\.$/);

    writeFileSync(join(f.operator, NOTICES_FILE), `{"recipient":"${ACME}","matchId":"${M1}"}\n`);
    await expect(noticesOf(f.operator)).rejects.toThrow(/^Line 1 of notices\.jsonl is not a notice\.$/);

    writeFileSync(join(f.operator, NOTICES_FILE), `{"recipient":"${ACME}","matchId":"${M1}","sentAt":"${T1}","confirmedAt":7}\n`);
    await expect(noticesOf(f.operator)).rejects.toThrow(/is not a notice/);
  });
});

describe('notices (the command)', () => {
  it('exits 2 with the reason and the usage on a bad call', async () => {
    const f = fixture();
    const base = ['--recipient', ACME, '--operator', f.operator];
    const cases: [readonly string[], RegExp][] = [
      [[], /Say whether the notice was sent or confirmed/],
      [['told', M1, ...base], /Say whether the notice was sent or confirmed/],
      [['sent', ...base], /Give a match id, or a file of them with --ids/],
      [['sent', M1, '--ids', join(f.operator, 'ids.txt'), ...base], /Give a match id, or a file of them with --ids/],
      [['sent', M1, M2, ...base], /one match id/],
      [['sent', M1, '--operator', f.operator], /Missing --recipient/],
      [['sent', M1, '--recipient', '  ', '--operator', f.operator], /Missing --recipient/],
      [['sent', M1, '--recipient', ACME], /Missing --operator/],
      [['sent', M1, ...base, '--recipient'], /Missing the value of --recipient/],
      [['sent', M1, ...base, '--verbose'], /Unknown option\./],
      [['sent', 'abc', ...base], /64 hex characters/],
    ];
    for (const [argv, reason] of cases) {
      const { code, text } = await run(argv);
      expect(code).toBe(2);
      expect(text).toMatch(reason);
      expect(text).toContain(USAGE);
    }
    writeFileSync(join(f.operator, 'ids.txt'), `${M1}\nnot-an-id\n`);
    expect((await run(['sent', '--ids', join(f.operator, 'ids.txt'), ...base])).text).toMatch(/Line 2 of the --ids file is not a match id/);
    writeFileSync(join(f.operator, 'ids.txt'), '\n\n');
    expect((await run(['sent', '--ids', join(f.operator, 'ids.txt'), ...base])).text).toMatch(/names no match id/);
  });

  it('refuses an operator folder inside a git repository, where the register would be committed', async () => {
    const f = fixture();
    mkdirSync(join(f.root, '.git'));

    const { code, text } = await run(['sent', M1, '--recipient', ACME, '--operator', f.operator]);

    expect(code).toBe(2);
    expect(text).toMatch(/inside a git repository/);
  });

  it('rethrows a failure that is not a refusal', async () => {
    const f = fixture();
    mkdirSync(join(f.operator, NOTICES_FILE));

    await expect(run(['sent', M1, '--recipient', ACME, '--operator', f.operator])).rejects.toThrow();
  });

  it('prints no session id, owner, project folder, pack path, or key, in any output or refusal', async () => {
    const f = fixture();
    const secrets = [S1, S2, OWNER, PROJECT, 'quillfeather', PACK, BUYER_KEY, f.root, f.root.replaceAll('\\', '\\\\')];
    const asked = ['--recipient', ACME, '--operator', f.operator];
    const outputs = [
      (await run(['sent', M1, ...asked])).text,
      (await run(['sent', M1, ...asked])).text,
      (await run(['confirmed', M1, ...asked], T2)).text,
      // Mistakes an operator can make: a session id where the match id goes, the key as a stray word, as a flag, and as the recipient, a match id nobody holds, and a confirmation with no notice.
      (await run(['sent', S1, ...asked])).text,
      (await run(['sent', M1, BUYER_KEY, ...asked])).text,
      (await run(['sent', M1, `--${BUYER_KEY}`, ...asked])).text,
      (await run(['sent', M1, '--recipient', BUYER_KEY, '--operator', f.operator])).text,
      (await run(['confirmed', M2, ...asked])).text,
      (await run(['sent', 'f9'.repeat(32), ...asked])).text,
    ];
    // A register line, a delivery line, and an ids line cut short.
    writeFileSync(join(f.operator, NOTICES_FILE), `{"recipient":"${ACME}","session":"${S1}"\n`, { flag: 'a' });
    outputs.push((await run(['sent', M2, ...asked])).text);
    writeFileSync(join(f.operator, 'deliveries.jsonl'), `{"recipient":"${ACME}","session":"${S1}"\n`, { flag: 'a' });
    outputs.push((await run(['sent', M2, ...asked])).text);
    writeFileSync(join(f.operator, 'ids.txt'), `${M1}\n${S1}\n`);
    outputs.push((await run(['sent', '--ids', join(f.operator, 'ids.txt'), ...asked])).text);

    expect(outputs).toHaveLength(12);
    for (const output of outputs) {
      expect(output).not.toBe('');
      for (const secret of secrets) expect(output).not.toContain(secret);
    }
  });

  it('makes no network call', async () => {
    const f = fixture();
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);

    await run(['sent', M1, '--recipient', ACME, '--operator', f.operator]);

    expect(fetched).toHaveBeenCalledTimes(0);
  });
});
