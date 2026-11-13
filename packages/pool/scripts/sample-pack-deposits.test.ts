// Brief 2 of docs/pool-deposit-title.md section 5: `sample-pack --deposits`. Fixtures only: no real store, no network, and every folder is a temp one.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentHash } from '../../cli/src/sessions/read.js';
import { redactTranscript } from '../../cli/src/sessions/redact.js';
import { deposit, loadStore, paths, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { citedAcceptance, depositorOf, type DepositAcceptance } from './deposit-input.js';
import { buildPack, main, matchIdOf, serverKeyOf, type PackCounts, type PackOptions } from './sample-pack.js';
import { validate } from './validate-pack.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = '11111111-1111-4111-8111-111111111111';
const line = (value: object): string => JSON.stringify(value);
const at = (n: number): string => `2026-06-01T10:00:${String(n).padStart(2, '0')}.000Z`;
// What a depositor's machine holds before `oars pool deposit` redacts it: an email address, a home path, and a key-shaped value.
const SECRET = 'AKIAIOSFODNN7EXAMPLE';
const original = (): string =>
  [
    line({ type: 'user', uuid: '11111111-b001-4222-8222-222222222222', parentUuid: null, isSidechain: false, timestamp: at(1), version: '2.1.300', sessionId: SESSION, cwd: '/home/dana/work/app', message: { role: 'user', content: `mail dana@example.com about ${SECRET}` } }),
    line({ type: 'assistant', uuid: '11111111-a001-4222-8222-222222222222', parentUuid: '11111111-b001-4222-8222-222222222222', isSidechain: false, timestamp: at(2), version: '2.1.300', sessionId: SESSION, requestId: 'req_011C11111111x1', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 20 } } }),
  ].join('\n') + '\n';

interface Folder {
  root: string;
  runtime: SessionsRuntime;
}

/** A pulled account folder as `pull-deposits` lays it out (`<account>/projects/deposit/<sha256>.jsonl`), and the throwaway store that captures it. */
const pulled = (text: string): Folder & { sha: string } => {
  const root = mkdtempSync(join(tmpdir(), 'oars-deposits-'));
  dirs.push(root);
  const sha = createHash('sha256').update(text).digest('hex');
  const projectsRoot = join(root, 'acct', 'projects');
  mkdirSync(join(projectsRoot, 'deposit'), { recursive: true });
  writeFileSync(join(projectsRoot, 'deposit', `${sha}.jsonl`), text);
  return { root, sha, runtime: { storeDir: join(root, 'store'), projectsRoot, sources: [], stdin: process.stdin, stdout: { write: () => true } } };
};

const captured = async (folder: Folder): Promise<Awaited<ReturnType<typeof loadStore>>> => {
  await deposit(folder.runtime, { allow: [], redactDomains: [], now: () => Date.parse('2026-06-10T00:00:00Z') });
  return loadStore(folder.runtime.storeDir);
};

describe('the two assumptions of the deposit input (docs/pool-deposit-title.md section 2)', () => {
  it('capture reads a redacted Raw Copy', async () => {
    const redacted = redactTranscript(original(), [], ['dana']);
    // The redactor ran: the address and the key are gone, so what is captured below is the redacted text and not the original.
    expect(redacted.masked).toBeGreaterThan(0);
    expect(redacted.text).not.toContain('dana@example.com');
    expect(redacted.text).not.toContain(SECRET);
    const folder = pulled(redacted.text);
    const store = await captured(folder);
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]).toMatchObject({ project: 'deposit', userTurns: 1, assistantTurns: 1, badLines: 0 });
    // The turns are those of the unredacted transcript: redaction costs capture nothing.
    const plain = await captured(pulled(original()));
    expect(store.sessions[0]).toMatchObject({ userTurns: plain.sessions[0]?.userTurns, assistantTurns: plain.sessions[0]?.assistantTurns, lines: plain.sessions[0]?.lines });
  });

  it('a captured line keeps sessionId, while the store names the session by the file', async () => {
    const redacted = redactTranscript(original(), [], ['dana']);
    const folder = pulled(redacted.text);
    const store = await captured(folder);
    // The store's session id is the file name, here the Raw Copy's hash: the harness id is not what names a pulled session, so the builder must read it from the line.
    expect(store.sessions[0]?.session).toBe(folder.sha);
    const archived = readFileSync(join(paths(folder.runtime.storeDir).raw, 'deposit', `${folder.sha}.jsonl`), 'utf8');
    const ids = archived.split('\n').filter((row) => row !== '').map((row): unknown => {
      const parsed: unknown = JSON.parse(row);
      return typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'sessionId') : undefined;
    });
    expect(ids).toEqual([SESSION, SESSION]);
  });
});

const ACCT = 'acct_one';
const ACC_A: DepositAcceptance = { version: '2.0-4c538c50d706', text_sha256: 'a'.repeat(64), accepted_at: Date.parse('2026-05-01T00:00:00Z') };
const ACC_B: DepositAcceptance = { version: '2.1-ec0ca3f6ff73', text_sha256: 'b'.repeat(64), accepted_at: Date.parse('2026-07-01T00:00:00Z') };
const KEYED_SKELETON = '{"frame":{"repoKey":"0123456789abcdef"}}';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const SID = (n: number): string => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;

interface Part {
  session: string;
  text?: string;
  tier?: string;
  countedAt?: number | null;
  country?: string | null;
  /** The deposit row; false leaves the Raw Copy with none. */
  row?: boolean;
  skeleton?: string;
}

/** A transcript for one harness session, redacted as the depositor's machine does before it is queued. */
const copyOf = (session: string, prompt = 'please rename the helper in parse.ts'): string => {
  const head = session.slice(0, 8);
  const rows = [
    line({ type: 'user', uuid: `${head}-b001-4222-8222-222222222222`, parentUuid: null, isSidechain: false, timestamp: at(1), version: '2.1.300', sessionId: session, cwd: '/home/dana/work/app', message: { role: 'user', content: prompt } }),
    line({ type: 'assistant', uuid: `${head}-a001-4222-8222-222222222222`, parentUuid: `${head}-b001-4222-8222-222222222222`, isSidechain: false, timestamp: at(2), version: '2.1.300', sessionId: session, requestId: `req_011C${head}x1`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'reasoning about parse', signature: 'sig' }, { type: 'text', text: 'renamed' }], usage: { input_tokens: 10, output_tokens: 20 } } }),
  ];
  return redactTranscript(`${rows.join('\n')}\n`, [], ['dana']).text;
};

interface Pulled {
  root: string;
  folder: string;
  runtime: SessionsRuntime;
  terms: string;
  owners: string;
  indexKey: string;
  out: string;
}

/** A folder as `pull-deposits` writes it, an operator runtime with an empty store, and the files a build needs beside them. */
const pull = (parts: readonly Part[], acceptances: readonly DepositAcceptance[] = [ACC_B]): Pulled => {
  const root = mkdtempSync(join(tmpdir(), 'oars-deposit-pack-'));
  dirs.push(root);
  const folder = join(root, 'pulled');
  mkdirSync(join(folder, ACCT, 'projects', 'deposit'), { recursive: true });
  writeFileSync(join(folder, 'accounts.jsonl'), `${line({ account: ACCT, acceptances })}\n`);
  const rows = parts
    .filter((part) => part.row !== false)
    .map((part) => line({ id: contentHash([ACCT, part.session]), tier: part.tier ?? 'skeleton', counted_at: part.countedAt === undefined ? Date.parse('2026-08-01T00:00:00Z') : part.countedAt, request_country: part.country === undefined ? 'US' : part.country, skeleton: part.skeleton ?? KEYED_SKELETON }));
  writeFileSync(join(folder, ACCT, 'deposits.jsonl'), rows.map((row) => `${row}\n`).join(''));
  for (const part of parts) {
    const text = part.text ?? copyOf(part.session);
    writeFileSync(join(folder, ACCT, 'projects', 'deposit', `${sha256(text)}.jsonl`), text);
  }
  mkdirSync(join(root, 'opprojects'));
  const terms = join(root, 'terms.txt');
  writeFileSync(terms, 'zorblax\n');
  const owners = join(root, 'owners.json');
  writeFileSync(owners, JSON.stringify([{ folder: '*-oars*', owner: 'Many Oars Co.', license: 'Apache-2.0' }]));
  const indexKey = join(root, 'index.key');
  writeFileSync(indexKey, 'ab'.repeat(32));
  return { root, folder, terms, owners, indexKey, out: join(root, 'pack'), runtime: { storeDir: join(root, 'opstore'), projectsRoot: join(root, 'opprojects'), sources: [], stdin: process.stdin, stdout: { write: () => true } } };
};

const optionsOf = (p: Pulled, extra: Partial<PackOptions> = {}): PackOptions => ({ terms: p.terms, owners: p.owners, indexKey: p.indexKey, buyerKey: 'sample', out: p.out, size: 25, seed: '1', minTurns: 1, deposits: p.folder, ...extra });

const built = (p: Pulled, extra: Partial<PackOptions> = {}): Promise<PackCounts> => buildPack(p.runtime, optionsOf(p, extra));

const rowsOf = (file: string): unknown[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((row) => row !== '')
    .map((row): unknown => JSON.parse(row));

const fieldOf = (row: unknown, key: string): unknown => (typeof row === 'object' && row !== null ? Reflect.get(row, key) : undefined);

const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));

const packText = (out: string): string => filesUnder(out).map((file) => readFileSync(file, 'utf8')).join('\n');

describe('sample-pack --deposits (docs/pool-deposit-title.md section 5, brief 2)', () => {
  it('a deposit row carries the depositor value, the covenant license, and acceptedAt', async () => {
    const p = pull([{ session: SID(1) }]);
    const counts = await built(p);
    expect(counts.emitted).toBe(1);
    const [row] = rowsOf(join(p.out, 'manifest.jsonl'));
    expect(row).toMatchObject({ repoOwner: depositorOf('sample', ACCT), sourceLicense: `manyoars-covenant ${ACC_B.version} sha256:${ACC_B.text_sha256}`, acceptedAt: '2026-07-01T00:00:00.000Z' });
    expect(String(fieldOf(row, 'repoOwner'))).toMatch(/^depositor:[0-9a-f]{16}$/);
    // The account and the exact time stay in the operator's index, never in the pack.
    expect(rowsOf(join(p.root, 'index.jsonl'))[0]).toMatchObject({ account: ACCT, covenant: ACC_B.version, acceptedAt: ACC_B.accepted_at });
    expect(packText(p.out)).not.toContain(ACCT);
  });

  it('a deposit cites the acceptance with accepted_at at or before counted_at, else the newest', async () => {
    const before = Date.parse('2026-06-01T00:00:00Z');
    expect(citedAcceptance([ACC_A, ACC_B], Date.parse('2026-08-01T00:00:00Z'))).toBe(ACC_B);
    expect(citedAcceptance([ACC_A, ACC_B], before)).toBe(ACC_A);
    expect(citedAcceptance([ACC_A, ACC_B], ACC_B.accepted_at)).toBe(ACC_B);
    // Counted before every acceptance, or never: the newest stands (section 14.2 carries the grant back).
    expect(citedAcceptance([ACC_A, ACC_B], Date.parse('2026-01-01T00:00:00Z'))).toBe(ACC_B);
    expect(citedAcceptance([ACC_A, ACC_B], null)).toBe(ACC_B);
    expect(citedAcceptance([], before)).toBeUndefined();
    const p = pull([{ session: SID(1), countedAt: before }], [ACC_A, ACC_B]);
    await built(p);
    expect(rowsOf(join(p.out, 'manifest.jsonl'))[0]).toMatchObject({ sourceLicense: `manyoars-covenant ${ACC_A.version} sha256:${ACC_A.text_sha256}`, acceptedAt: '2026-05-01T00:00:00.000Z' });
  });

  it('two buyer keys give two depositor values, and one key gives one across packs', async () => {
    const p = pull([{ session: SID(1) }]);
    await built(p);
    const first = fieldOf(rowsOf(join(p.out, 'manifest.jsonl'))[0], 'repoOwner');
    rmSync(p.out, { recursive: true, force: true });
    await built(p, { buyerKey: 'another' });
    const second = fieldOf(rowsOf(join(p.out, 'manifest.jsonl'))[0], 'repoOwner');
    expect(first).toBe(depositorOf('sample', ACCT));
    expect(second).toBe(depositorOf('another', ACCT));
    expect(first).not.toBe(second);
    expect(depositorOf('sample', 'acct_two')).not.toBe(first);
  });

  it('a Raw Copy with no deposit row is counted unlinked', async () => {
    const p = pull([{ session: SID(1) }, { session: SID(2), row: false }]);
    const counts = await built(p);
    expect(counts.emitted).toBe(1);
    expect(counts.deposits).toEqual({ unlinked: 1, tierNone: 0, protectedRegion: 0, noGrant: 0 });
  });

  it('tier none and a protected country are left out', async () => {
    const p = pull([{ session: SID(1) }, { session: SID(2), tier: 'none' }, { session: SID(3), country: 'DE' }, { session: SID(4), country: 'GB' }]);
    const counts = await built(p);
    expect(counts.emitted).toBe(1);
    expect(counts.deposits).toEqual({ unlinked: 0, tierNone: 1, protectedRegion: 2, noGrant: 0 });
  });

  it('an account with no acceptance is counted noGrant', async () => {
    const p = pull([{ session: SID(1) }], []);
    const counts = await built(p);
    expect(counts.emitted).toBe(0);
    expect(counts.deposits).toEqual({ unlinked: 0, tierNone: 0, protectedRegion: 0, noGrant: 1 });
  });

  it('leaves out a deposit whose skeleton holds no repository key', async () => {
    const p = pull([{ session: SID(1), skeleton: '{"frame":{}}' }]);
    const counts = await built(p);
    expect(counts.emitted).toBe(0);
    expect(counts.noRepo).toBe(1);
  });

  it('leaves out a pulled transcript that holds an exclusion term', async () => {
    const p = pull([{ session: SID(1), text: copyOf(SID(1), 'ask zorblax about it') }, { session: SID(2) }]);
    const counts = await built(p);
    expect(counts.emitted).toBe(1);
    expect(counts.excluded.term).toBe(1);
  });

  it('redacts again and strips reasoning on request: a key-shaped value and the thinking never reach the pack', async () => {
    const dirty = copyOf(SID(1), 'use the key').replace('use the key', `use ${SECRET}`);
    const p = pull([{ session: SID(1), text: dirty }]);
    await built(p, { stripThinking: true });
    const body = packText(p.out);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain('reasoning about parse');
    expect(rowsOf(join(p.out, 'manifest.jsonl'))[0]).toMatchObject({ reasoning: 'stripped' });
  });

  it('keeps reasoning by default', async () => {
    const p = pull([{ session: SID(1) }]);
    await built(p);
    expect(packText(p.out)).toContain('reasoning about parse');
  });

  it('honors an objection that names the harness session id, though the store names the copy by its hash', async () => {
    const p = pull([{ session: SID(1) }, { session: SID(2) }]);
    writeFileSync(join(p.root, 'objections.jsonl'), `${line({ session: SID(1), received: '2026-11-01T00:00:00.000Z', scope: 'sale' })}\n`);
    const counts = await built(p);
    expect(counts.objected).toBe(1);
    expect(counts.emitted).toBe(1);
  });

  it('a deposit pack passes validate-pack, acceptedAt included', async () => {
    const p = pull([{ session: SID(1) }]);
    await built(p);
    const result = await validate(p.out);
    expect(result?.violations).toEqual([]);
    expect(result).toMatchObject({ rows: 1, records: 1 });
  });

  it('writes nothing into the pulled folder', async () => {
    const p = pull([{ session: SID(1) }]);
    const before = filesUnder(p.folder).sort();
    await built(p);
    expect(filesUnder(p.folder).sort()).toEqual(before);
  });

  it('a deposit row takes its match id from the harness session id, so one session has one match id per buyer', async () => {
    const p = pull([{ session: SID(1) }]);
    await built(p);
    const indexKey = readFileSync(p.indexKey, 'utf8');
    expect(fieldOf(rowsOf(join(p.out, 'manifest.jsonl'))[0], 'matchId')).toBe(matchIdOf('sample', serverKeyOf(indexKey, SID(1))));
  });

  it('two Raw Copies of one harness session ship as one row', async () => {
    const p = pull([{ session: SID(1) }, { session: SID(1), text: copyOf(SID(1), 'a longer, different prompt for the same session') }]);
    const counts = await built(p);
    expect(counts.emitted).toBe(1);
    expect(rowsOf(join(p.out, 'manifest.jsonl'))).toHaveLength(1);
  });

  it('--deposits on the command line builds from the folder and prints what was left out', async () => {
    const p = pull([{ session: SID(1) }, { session: SID(2), row: false }]);
    const printed: string[] = [];
    const code = await main(['--terms', p.terms, '--owners', p.owners, '--index-key', p.indexKey, '--buyer-key', 'sample', '--out', p.out, '--min-turns', '1', '--deposits', p.folder], { runtime: p.runtime, print: (text) => printed.push(text) });
    expect(code).toBe(0);
    expect(rowsOf(join(p.out, 'manifest.jsonl'))).toHaveLength(1);
    expect(printed.join(' ')).toContain('Left out of the deposits: 1 with no deposit row');
  });

  it('builds without --deposits as before: no deposits count in the counts or in pack.json', async () => {
    const p = pull([]);
    mkdirSync(join(p.root, 'opprojects', 'repos-oars'), { recursive: true });
    const counts = await buildPack(p.runtime, optionsOf(p, { deposits: undefined }));
    expect(counts.deposits).toBeUndefined();
    expect(readFileSync(join(p.out, 'pack.json'), 'utf8')).not.toContain('"deposits"');
    expect(readFileSync(join(p.out, 'manifest.jsonl'), 'utf8')).not.toContain('acceptedAt');
  });
});
