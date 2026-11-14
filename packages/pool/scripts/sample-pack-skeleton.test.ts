// The skeleton-only release (distribution page, M2, brief 1): fixture stores built in a temp folder, with an invented exclusion term.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LITERAL, PRIVATE, PUBLIC_PROGRAMS } from '../../cli/src/sessions/public-vocabulary.js';
import { ERROR_CODES, PROMPT_CLASSES, PROMPT_INTERVENTIONS } from '../../cli/src/sessions/schema.js';
import { deposit, type SessionsRuntime } from '../../cli/src/sessions/store.js';
import { namesFilterOf } from './skeleton-only.js';
import { buildPack, HARNESS_TERMS, main, NO_OBJECTIONS, PERMITTED_USES, type ManifestRow, type PackOptions } from './sample-pack.js';
import { cardOf, writeCard } from './skeleton-card.js';
import { validate } from './validate-pack.js';

const TERM = 'zorblax';
const NOW = Date.parse('2026-11-13T00:00:00Z');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const S = (n: number): string => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const line = (value: object): string => JSON.stringify(value);
const uuidOf = (session: string, kind: 'a' | 'b', n: number): string => `${session.slice(0, 8)}-${kind}${String(n).padStart(3, '0')}-4222-8222-222222222222`;
const session = (id: string, cwd: string, day: string, prompt: string, tools: false | string = false): string[] => [
  line({ type: 'user', uuid: uuidOf(id, 'b', 1), parentUuid: null, isSidechain: false, timestamp: `${day}T10:00:01.000Z`, version: '2.1.300', sessionId: id, cwd, message: { role: 'user', content: prompt } }),
  line({ type: 'assistant', uuid: uuidOf(id, 'a', 1), parentUuid: uuidOf(id, 'b', 1), isSidechain: false, timestamp: `${day}T10:00:02.000Z`, version: '2.1.300', sessionId: id, requestId: `req_011C${id.slice(0, 8)}x1`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 20 } } }),
  ...(tools === false ? [] : toolTurns(id, cwd, day, tools)),
];
// A Bash call with free text in its message, an Edit of a file path, and a failed tool result: the keys the skeleton carries for tools.
const toolTurns = (id: string, cwd: string, day: string, edited = 'parse.ts'): string[] => {
  const use = (n: number, name: string, input: object): string =>
    line({ type: 'assistant', uuid: uuidOf(id, 'a', n), parentUuid: uuidOf(id, 'a', n - 1), isSidechain: false, timestamp: `${day}T10:00:0${String(n + 1)}.000Z`, version: '2.1.300', sessionId: id, cwd, requestId: `req_011C${id.slice(0, 8)}x${String(n)}`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `toolu_${id.slice(0, 8)}${String(n)}`, name, input }], usage: { input_tokens: 10, output_tokens: 20 } } });
  const result = (n: number, text: string, failed: boolean): string =>
    line({ type: 'user', uuid: uuidOf(id, 'b', n), parentUuid: uuidOf(id, 'a', n), isSidechain: false, timestamp: `${day}T10:00:0${String(n + 1)}.500Z`, version: '2.1.300', sessionId: id, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id.slice(0, 8)}${String(n)}`, content: text, is_error: failed }] } });
  return [
    use(2, 'Bash', { command: 'git commit -m "rename the secret helper in parse.ts"', run_in_background: true }),
    result(2, 'fatal: not a git repository', true),
    use(3, 'Edit', { file_path: join(cwd, 'src', edited), old_string: 'a', new_string: 'b' }),
    result(3, 'ok', false),
  ];
};

// The free-text audit: every string in the output is judged by its key. A key this list does not name fails, so a new field cannot carry text in unseen.
const HEX64 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,40}$/;
// A redacted name: one word, no whitespace, no path separator, short. `private` is a name too.
const NAME = /^[^\s/\\]{1,64}$/;
// A shell template: the first word is a program from the gated list (or the unread and path stand-ins), and every other word is a slot, a flag, or a name.
const SLOT = /^<[a-z]{1,12}>$/;
const FLAG = /^--?[A-Za-z0-9][\w-]{0,40}$/;
const TEMPLATE = (value: string): boolean => {
  const [program = '', ...rest] = value.split(' ');
  return (PUBLIC_PROGRAMS.has(program) || [LITERAL, PRIVATE, '<path>'].includes(program)) && rest.length <= 12 && rest.every((word) => SLOT.test(word) || FLAG.test(word) || NAME.test(word));
};
// The owners the fixture's owners file names: a closed list for the build.
const OWNERS = ['Many Oars Co.'];
const TERMS = Object.values(HARNESS_TERMS).flatMap((row) => row.terms);
const oneOf = (...allowed: readonly string[]) => (value: string): boolean => allowed.includes(value);
const RULES: { readonly [key: string]: (value: string) => boolean } = {
  matchId: (v) => HEX64.test(v), id: (v) => HEX64.test(v), merkleRoot: (v) => HEX64.test(v), timingPrint: (v) => HEX64.test(v), repoKey: (v) => HEX16.test(v),
  day: (v) => DATE.test(v), startedAt: (v) => DATE.test(v), endedAt: (v) => DATE.test(v),
  harness: oneOf(...Object.keys(HARNESS_TERMS)), permittedUses: oneOf(...PERMITTED_USES), training: oneOf('not-offered', 'priced-add-on'), reasoning: oneOf('kept', 'stripped'),
  harnessVersions: (v) => VERSION.test(v), harnessVersion: (v) => VERSION.test(v), vocabVersion: (v) => VERSION.test(v), redactionVersion: (v) => VERSION.test(v),
  skeleton: oneOf('skeleton.json'), sourceLicense: (v) => /^[A-Za-z0-9.+-]{1,40}$/.test(v),
  repoOwner: oneOf(...OWNERS),
  // The harness terms are the fixed text of the terms table, not session text.
  name: (v) => TERMS.some((term) => term.name === v) || NAME.test(v), version: (v) => TERMS.some((term) => term.version === v),
  model: (v) => NAME.test(v), platform: (v) => NAME.test(v), orgSize: (v) => NAME.test(v), team: (v) => NAME.test(v), repoVisibility: (v) => NAME.test(v),
  cls: (v) => NAME.test(v), intervention: (v) => NAME.test(v), status: (v) => NAME.test(v), errorCode: (v) => NAME.test(v), targetClass: (v) => NAME.test(v),
  argClass: (v) => NAME.test(v), changeKind: (v) => NAME.test(v), diffShape: (v) => NAME.test(v), keys: (v) => NAME.test(v), kind: (v) => NAME.test(v), value: (v) => NAME.test(v), format: (v) => NAME.test(v),
  templates: TEMPLATE,
  // pack.json: the build's own bookkeeping. `seed` has no rule, so a free-text --seed written there fails.
  built: (v) => DATE.test(v), keyId: (v) => HEX16.test(v), objections: (v) => HEX64.test(v) || v === NO_OBJECTIONS, enumValue: (v) => NAME.test(v),
  // Skeleton fields the first fixture did not reach: each is a name or a size, and the program is from the gated list.
  shell: (v) => NAME.test(v), language: (v) => NAME.test(v), languages: (v) => NAME.test(v), languageShare: (v) => NAME.test(v), next: (v) => NAME.test(v), action: (v) => NAME.test(v), native: (v) => NAME.test(v),
  program: (v) => PUBLIC_PROGRAMS.has(v) || [LITERAL, PRIVATE].includes(v), sub: (v) => NAME.test(v), flags: (v) => FLAG.test(v), key: (v) => NAME.test(v), valueSize: (v) => /^[0-9a-z+-]{1,12}$/.test(v), pathDepth: (v) => /^\d{1,3}\+?$/.test(v), extension: (v) => NAME.test(v), dirKind: (v) => NAME.test(v),
};

// A count table's keys are strings in the upload too: each table's keys are judged by its parent field.
const KEY_RULES: { readonly [field: string]: (key: string) => boolean } = {
  model: (k) => NAME.test(k), models: (k) => NAME.test(k), harness: oneOf(...Object.keys(HARNESS_TERMS)), harnessVersion: (k) => VERSION.test(k),
  errorCode: (k) => ERROR_CODES.has(k), recovery: oneOf('edit followed', 'no edit followed'), intervention: oneOf(...PROMPT_INTERVENTIONS),
  promptClass: oneOf(...PROMPT_CLASSES), turnBucket: (k) => /^\d{1,6}$/.test(k),
};

const audit = (value: unknown, where: string, key = ''): string[] => {
  if (typeof value === 'string') {
    const rule = RULES[key];
    return rule?.(value) === true ? [] : [`${where}${key === '' ? '' : `.${key}`}`];
  }
  if (Array.isArray(value)) return value.flatMap((item) => audit(item, where, key));
  if (typeof value === 'object' && value !== null) {
    const keyRule = KEY_RULES[key];
    return Object.entries(value).flatMap(([name, item]) => [...(keyRule === undefined || keyRule(name) ? [] : [`${where}.${key}{${name}}`]), ...audit(item, where, name)]);
  }
  return [];
};

// The card: every line is the template's fixed text, a slot the build fills with a number, a date, or a version, or a count-table row whose name is judged by the table's title.
const CARD_TABLES: { readonly [title: string]: string } = {
  'Sessions per harness': 'harness', 'Sessions per harness version': 'harnessVersion', 'Prompts per model': 'model', 'Failed calls per error code': 'errorCode',
  'Failed calls by what followed': 'recovery', 'Prompts per human intervention': 'intervention', 'Sessions per turn bucket (lowest turn count of the bucket)': 'turnBucket',
};
const CARD_LINES: readonly RegExp[] = [
  /^$/, /^---$/, /^license: other$/, /^license_link: https:\/\/manyoars\.com\/packs#rights$/, /^tags:$/, /^ {2}- agent-traces$/, /^# Many Oars: open session skeletons$/, /^## What is counted$/,
  /^\d+ coding-agent session skeletons, published by Many Oars Co\., each a record of the session's steps, errors, recoveries, and human interventions\. No transcript text is in this release, and every session ended at least \d+ days before it was built( \(\d{4}-\d{2}-\d{2}\))?\.$/,
  /^- License and rights: https:\/\/manyoars\.com\/packs#rights\.$/,
  /^- Redaction version: [0-9A-Za-z][0-9A-Za-z.+-]{0,40}; model reasoning: (kept|stripped|unknown)\. Redaction is best effort\.$/,
  /^- Layout: `manifest\.jsonl` \(one row per session, `transcripts: 0`\), `sessions\/<match id>\/skeleton\.json`, `census\.json` \(counts only\), and `pack\.json` \(how it was built\)\.$/,
  /^- Check it: `npm run validate-pack -w packages\/pool -- <this folder>` in the Many Oars repository \(spec: `docs\/session-record\.md`\)\. It needs no key, account, or network\.$/,
  /^- Fresher sessions, whole transcripts, and rights for use: https:\/\/manyoars\.com\/packs\.$/,
];
const auditCard = (text: string): string[] => {
  let table = '';
  return text.split('\n').flatMap((row, at) => {
    const title = /^\*\*(.+)\*\*$/.exec(row)?.[1];
    if (title !== undefined) {
      table = CARD_TABLES[title] ?? '';
      return table === '' ? [`README.md:${String(at + 1)} table title`] : [];
    }
    const entry = /^- `(.+)`: \d+$/.exec(row)?.[1];
    if (entry !== undefined) return KEY_RULES[table]?.(entry) === true ? [] : [`README.md:${String(at + 1)} ${table}{${entry}}`];
    return CARD_LINES.some((pattern) => pattern.test(row)) ? [] : [`README.md:${String(at + 1)} line`];
  });
};

interface Built {
  root: string;
  runtime: SessionsRuntime;
  options: (extra?: Partial<PackOptions>) => PackOptions;
  owners: string;
}

/** Sessions 1 to 3 are old (June, September, and the 13th of October); 4 is two days old; 5 holds the term. */
const fixture = async (edited = 'parse.ts'): Promise<Built> => {
  const root = mkdtempSync(join(tmpdir(), 'oars-skeleton-only-'));
  dirs.push(root);
  const projectsRoot = join(root, 'projects');
  const cwd = join(root, 'work', 'app');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  writeFileSync(join(cwd, '.git', 'config'), `[remote "origin"]\n\turl = https://example.com/acme/app.git\n`);
  const days = ['2026-06-01', '2026-09-01', '2026-10-13', '2026-11-11', '2026-06-02'];
  days.forEach((day, n) => {
    mkdirSync(join(projectsRoot, '-work-oars'), { recursive: true });
    writeFileSync(join(projectsRoot, '-work-oars', `${S(n + 1)}.jsonl`), `${session(S(n + 1), cwd, day, n === 4 ? `please fix ${TERM}` : `task number ${String(n)}`, n === 0 ? edited : false).join('\n')}\n`);
  });
  const terms = join(root, 'terms.txt');
  writeFileSync(terms, `${TERM}\n`);
  const owners = join(root, 'owners.json');
  writeFileSync(owners, JSON.stringify([{ folder: '*-oars*', owner: 'Many Oars Co.', license: 'Apache-2.0' }]));
  const indexKey = join(root, 'index.key');
  writeFileSync(indexKey, 'ab'.repeat(32));
  const runtime: SessionsRuntime = { storeDir: join(root, 'store'), projectsRoot, sources: [], stdin: process.stdin, stdout: { write: () => true } };
  await deposit(runtime, { allow: [], redactDomains: [], now: () => Date.parse('2026-11-12T00:00:00Z') });
  let n = 0;
  const options = (extra: Partial<PackOptions> = {}): PackOptions => ({ terms, owners, indexKey, buyerKey: 'open', out: join(root, `pack${String((n += 1))}`), size: 25, seed: '1', minTurns: 1, now: () => NOW, ...extra });
  return { root, runtime, options, owners };
};

const isRow = (value: unknown): value is ManifestRow => typeof value === 'object' && value !== null && 'matchId' in value;
const manifest = (out: string): ManifestRow[] =>
  readFileSync(join(out, 'manifest.jsonl'), 'utf8').split('\n').filter((row) => row !== '').map((row): ManifestRow => {
    const value: unknown = JSON.parse(row);
    if (!isRow(value)) throw new Error('a manifest row with no matchId');
    return value;
  });
const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)) : [join(dir, name)]));
const names = (out: string): string[] => filesUnder(out).map((file) => relative(out, file).split(sep).join('/'));
const isIndexRow = (value: unknown): value is { pack: string; session: string; matchId: string } => typeof value === 'object' && value !== null && 'pack' in value && 'session' in value && 'matchId' in value;
const indexRows = (owners: string): { pack: string; session: string; matchId: string }[] =>
  readFileSync(join(owners, '..', 'index.jsonl'), 'utf8').split('\n').filter((row) => row !== '').map((row) => {
    const value: unknown = JSON.parse(row);
    if (!isIndexRow(value)) throw new Error('an index row with no session');
    return value;
  });

describe('a skeleton-only build', () => {
  it('writes rows, skeletons, the census, pack.json, and the card, and no transcript, and the validator passes', async () => {
    const f = await fixture();
    const opts = f.options({ skeletonOnly: true });
    await buildPack(f.runtime, opts);
    const rows = manifest(opts.out);
    expect(rows.length).toBe(3);
    expect(rows.every((row) => row.transcripts === 0 && row.skeleton === 'skeleton.json')).toBe(true);
    const files = names(opts.out).sort();
    expect(files.filter((file) => file.startsWith('sessions/'))).toEqual(rows.map((row) => `sessions/${row.matchId}/skeleton.json`).sort());
    expect(files.filter((file) => !file.startsWith('sessions/'))).toEqual(['README.md', 'census.json', 'manifest.jsonl', 'pack.json']);
    const result = await validate(opts.out);
    expect(result?.violations).toEqual([]);
    expect(result).toMatchObject({ rows: 3, records: 3, transcripts: 0 });
  });

  it('fails the validator on any other file in the folder', async () => {
    const f = await fixture();
    const opts = f.options({ skeletonOnly: true });
    await buildPack(f.runtime, opts);
    const [row] = manifest(opts.out);
    const folder = join(opts.out, 'sessions', row?.matchId ?? '');
    for (const stray of [join(folder, 'main.jsonl'), join(folder, 'notes.txt'), join(opts.out, 'notes.txt')]) {
      writeFileSync(stray, '{}\n');
      expect((await validate(opts.out))?.violations.length).toBeGreaterThan(0);
      rmSync(stray);
      expect((await validate(opts.out))?.violations).toEqual([]);
    }
  });

  it('refuses a no-transcript row that names no skeleton', async () => {
    const f = await fixture();
    const opts = f.options({ skeletonOnly: true });
    await buildPack(f.runtime, opts);
    const rows = manifest(opts.out).map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'skeleton')));
    writeFileSync(join(opts.out, 'manifest.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
    expect((await validate(opts.out))?.violations.some((v) => v.field === 'skeleton')).toBe(true);
  });

  it('allows README.md at the root only when every row says 0, and refuses a pack that mixes the two kinds of row', async () => {
    const f = await fixture();
    const full = f.options();
    await buildPack(f.runtime, full);
    expect((await validate(full.out))?.violations).toEqual([]);
    writeFileSync(join(full.out, 'README.md'), 'a card\n');
    expect((await validate(full.out))?.violations.some((v) => v.where === 'README.md')).toBe(true);
    rmSync(join(full.out, 'README.md'));
    // One row rewritten to say 0, its transcripts removed: the pack now mixes the two kinds.
    const rows = manifest(full.out);
    const [first] = rows;
    for (const file of readdirSync(join(full.out, 'sessions', first?.matchId ?? ''))) if (file.endsWith('.jsonl')) rmSync(join(full.out, 'sessions', first?.matchId ?? '', file));
    writeFileSync(join(full.out, 'manifest.jsonl'), rows.map((row, at) => `${JSON.stringify(at === 0 ? { ...row, transcripts: 0 } : row)}\n`).join(''));
    expect((await validate(full.out))?.violations.some((v) => v.field === 'transcripts' && /mixes/.test(v.rule))).toBe(true);
  });

  it('leaves out a session that holds an exclusion term, counted by reason', async () => {
    const f = await fixture();
    const opts = f.options({ skeletonOnly: true });
    const counts = await buildPack(f.runtime, opts);
    expect(counts.excluded.term).toBe(1);
    expect(indexRows(f.owners).map((row) => row.session)).not.toContain(S(5));
  });

  it('keeps fresh sessions out with --older-than, 30 days by default in this mode', async () => {
    const f = await fixture();
    const byDefault = f.options({ skeletonOnly: true });
    const counts = await buildPack(f.runtime, byDefault);
    expect(counts).toMatchObject({ emitted: 3, fresh: 1 });
    const wider = f.options({ skeletonOnly: true, olderThanDays: 60 });
    expect(await buildPack(f.runtime, wider)).toMatchObject({ emitted: 2, fresh: 2 });
    // The line is inclusive: a session that ended exactly N days ago is old enough.
    const exact = f.options({ skeletonOnly: true, olderThanDays: 2, now: () => Date.parse('2026-11-13T10:00:02.000Z') });
    expect(await buildPack(f.runtime, exact)).toMatchObject({ emitted: 4, fresh: 0 });
    expect(JSON.parse(readFileSync(join(wider.out, 'pack.json'), 'utf8'))).toMatchObject({ skeletonOnly: true, olderThanDays: 60 });
  });

  it('leaves out every session an earlier lot holds, and stops when the lot is not in the index', async () => {
    const f = await fixture();
    const lot = f.options({ size: 2, seed: 'lot' });
    await buildPack(f.runtime, lot);
    const lotSessions = indexRows(f.owners).filter((row) => row.pack === lot.out).map((row) => row.session);
    expect(lotSessions.length).toBe(2);
    const open = f.options({ skeletonOnly: true, excludeManifest: join(lot.out, 'manifest.jsonl'), olderThanDays: 0 });
    const counts = await buildPack(f.runtime, open);
    const shared = indexRows(f.owners).filter((row) => row.pack === open.out && lotSessions.includes(row.session));
    expect(shared).toEqual([]);
    expect(counts.inExcludedLot).toBe(2);
    expect(counts.emitted).toBe(2);
    // The same lot by its folder.
    const byFolder = f.options({ skeletonOnly: true, excludeManifest: lot.out, olderThanDays: 0 });
    expect((await buildPack(f.runtime, byFolder)).inExcludedLot).toBe(2);
    // A manifest whose match ids the index does not hold.
    const foreign = join(f.root, 'foreign.jsonl');
    writeFileSync(foreign, `${JSON.stringify({ matchId: 'f'.repeat(64) })}\n`);
    await expect(buildPack(f.runtime, f.options({ skeletonOnly: true, excludeManifest: foreign }))).rejects.toThrow(/not in index\.jsonl/);
    await expect(buildPack(f.runtime, f.options({ skeletonOnly: true, excludeManifest: join(f.root, 'absent.jsonl') }))).rejects.toThrow(/Cannot read the --exclude-manifest file/);
  });

  it('writes only strings from a closed list, a redacted name, or private, in every json file and the manifest', async () => {
    const f = await fixture();
    const opts = f.options({ skeletonOnly: true, seed: 'fix the login bug for acme' });
    await buildPack(f.runtime, opts);
    const documents = names(opts.out).filter((name) => name.endsWith('.json')).map((name): [string, unknown] => [name, JSON.parse(readFileSync(join(opts.out, name), 'utf8'))]);
    documents.push(['manifest.jsonl', manifest(opts.out)]);
    const bad = documents.flatMap(([name, document]) => audit(document, name.replace(/[0-9a-f]{64}/, '<id>')));
    expect(bad).toEqual([]);
    expect(auditCard(readFileSync(join(opts.out, 'README.md'), 'utf8'))).toEqual([]);
    expect(documents.map(([name]) => name)).toContain('pack.json');
    // The fixture reaches the tool keys: the audited skeletons carry them, so their rules ran on real output.
    const text = JSON.stringify(documents);
    for (const key of ['names', 'templates', 'keys', 'argValues', 'errorCode', 'recovery', 'recoveryCalls']) expect(text, key).toContain(`"${key}"`);
    expect(text).toContain('git commit -m <text>');
    // A free-text --seed does not reach pack.json.
    expect(JSON.parse(readFileSync(join(opts.out, 'pack.json'), 'utf8'))).not.toHaveProperty('seed');
    expect(text).not.toContain('login bug');
  });

  it('stamps built from the build clock, not the wall clock', async () => {
    const f = await fixture();
    const opts = f.options({ skeletonOnly: true });
    await buildPack(f.runtime, opts);
    expect(JSON.parse(readFileSync(join(opts.out, 'pack.json'), 'utf8'))).toMatchObject({ built: new Date(NOW).toISOString() });
    expect(readFileSync(join(opts.out, 'README.md'), 'utf8')).toContain('(2026-11-13)');
  });

  it('the audit fails on free text, an unknown field, and a raw id', () => {
    expect(audit({ model: 'please rename the helper in parse.ts' }, 'x')).toHaveLength(1);
    expect(audit({ note: 'private' }, 'x')).toHaveLength(1);
    expect(audit({ harness: 'someone-elses-harness' }, 'x')).toHaveLength(1);
    expect(audit({ seed: 'fix the login bug' }, 'x')).toHaveLength(1);
    expect(audit({ repoOwner: 'Someone Else Inc.' }, 'x')).toHaveLength(1);
    expect(audit({ templates: ['please fix the bug now'] }, 'x')).toHaveLength(1);
    expect(audit({ templates: ['git commit -m <text>', 'pytest <path> -k <ident>'] }, 'x')).toEqual([]);
    expect(audit({ id: '11111111-1111-4111-8111-111111111111' }, 'x')).toHaveLength(1);
    expect(audit({ day: 'last tuesday' }, 'x')).toHaveLength(1);
    expect(audit({ model: { 'fix the login bug': 1 } }, 'x')).toHaveLength(1);
    expect(audit({ models: { 'claude-opus-5-5': 2, 'fix the bug': 1 } }, 'x')).toHaveLength(1);
    expect(audit({ recovery: { 'edit followed': 1, 'the secret plan': 1 } }, 'x')).toHaveLength(1);
    expect(audit({ errorCode: { '127': 1, 'file not found in acme': 1 } }, 'x')).toHaveLength(1);
    expect(audit({ harness: { 'claude-code': 1 }, harnessVersion: { '2.1.300': 1 }, errorCode: { other: 2 }, promptClass: { 'edit-verify': 1 }, turnBucket: { '20': 1 } }, 'x')).toEqual([]);
    expect(audit({ model: 'private', templates: ['git commit -m <text>'], names: [{ name: 'parse.ts' }] }, 'x')).toEqual([]);
  });
});

describe('the data card', () => {
  it('is README.md, made from pack.json and census.json, and a number in it changes with the fixture', async () => {
    const f = await fixture();
    const opts = f.options({ skeletonOnly: true });
    await buildPack(f.runtime, opts);
    const card = readFileSync(join(opts.out, 'README.md'), 'utf8');
    expect(card).toContain('3 coding-agent session skeletons');
    expect(card).toContain('at least 30 days');
    for (const fact of ['license: other', 'license_link: https://manyoars.com/packs#rights', 'agent-traces', 'validate-pack', 'https://manyoars.com/packs', 'transcripts: 0']) expect(card).toContain(fact);
    expect(card).toMatchSnapshot();
    const wider = f.options({ skeletonOnly: true, olderThanDays: 60 });
    await buildPack(f.runtime, wider);
    const next = readFileSync(join(wider.out, 'README.md'), 'utf8');
    expect(next).toContain('2 coding-agent session skeletons');
    expect(next).toContain('at least 60 days');
    expect(next).not.toEqual(card);
  });

  it('the card audit fails on a line the template lacks and on a census name that is free text', () => {
    const good = cardOf({ olderThanDays: 30, built: '2026-11-13T00:00:00Z', redactionVersion: '4', reasoning: 'kept' }, { sessions: 1, harness: { 'claude-code': 1 }, harnessVersion: {}, model: { 'claude-opus-5-5': 1 }, errorCode: {}, recovery: { 'edit followed': 1 }, intervention: {}, promptClass: {}, turnBucket: { '2': 1 } });
    expect(auditCard(good)).toEqual([]);
    expect(auditCard(good.replace('`claude-opus-5-5`', '`fix the login bug`'))).toHaveLength(1);
    expect(auditCard(good.replace('`edit followed`', '`the secret plan`'))).toHaveLength(1);
    expect(auditCard(`${good}\nPlease fix the login bug for acme.`)).toHaveLength(1);
    expect(auditCard(good.replace('Prompts per model', 'Prompts about acme'))).not.toEqual([]);
  });

  it('refuses a census or pack whose numbers are not numbers', () => {
    expect(() => cardOf({ olderThanDays: 30 }, { sessions: 'x' })).toThrow(/census sessions/);
    expect(() => cardOf({}, { sessions: 1 })).toThrow(/olderThanDays/);
    expect(() => cardOf({ olderThanDays: 1 }, { sessions: 1, harness: { a: 'x' } })).toThrow(/census turnBucket|census harness/);
  });

  it('writeCard reads the two files in a folder', async () => {
    const f = await fixture();
    mkdirSync(join(f.root, 'card'));
    writeFileSync(join(f.root, 'card', 'pack.json'), JSON.stringify({ olderThanDays: 7, built: '2026-11-13T00:00:00Z' }));
    writeFileSync(join(f.root, 'card', 'census.json'), JSON.stringify({ sessions: 9, harness: { 'claude-code': 9 }, harnessVersion: {}, model: {}, errorCode: {}, recovery: {}, intervention: {}, promptClass: {}, turnBucket: { '20': 9 } }));
    await writeCard(join(f.root, 'card'));
    const card = readFileSync(join(f.root, 'card', 'README.md'), 'utf8');
    expect(card).toContain('9 coding-agent session skeletons');
    expect(card).toContain('- `claude-code`: 9');
    expect(card).toContain('(2026-11-13)');
  });
});

describe('the command', () => {
  it('takes --skeleton-only, --older-than, and --exclude-manifest, and refuses a bad age', async () => {
    const f = await fixture();
    const printed: string[] = [];
    const common = ['--terms', join(f.root, 'terms.txt'), '--owners', f.owners, '--index-key', join(f.root, 'index.key'), '--buyer-key', 'open', '--min-turns', '1'];
    expect(await main([...common, '--out', join(f.root, 'cli1'), '--skeleton-only', '--older-than', '-1'], { runtime: f.runtime, print: (t) => printed.push(t), now: () => NOW })).toBe(2);
    expect(printed.join('\n')).toContain('--older-than takes a number of days');
    printed.length = 0;
    expect(await main([...common, '--out', join(f.root, 'cli2'), '--skeleton-only'], { runtime: f.runtime, print: (t) => printed.push(t), now: () => NOW })).toBe(0);
    expect(printed.join('\n')).toContain('Left out as newer than the age limit');
    printed.length = 0;
    expect(await main([...common, '--out', join(f.root, 'cli3'), '--skeleton-only', '--exclude-manifest', join(f.root, 'cli2')], { runtime: f.runtime, print: (t) => printed.push(t), now: () => NOW })).toBe(0);
    expect(printed.join('\n')).toContain('held by the excluded lot: 3');
    // pack.json `built` follows the clock the command was given.
    expect(JSON.parse(readFileSync(join(f.root, 'cli2', 'pack.json'), 'utf8'))).toMatchObject({ built: new Date(NOW).toISOString() });
    const later = Date.parse('2027-03-01T00:00:00Z');
    expect(await main([...common, '--out', join(f.root, 'cli4'), '--skeleton-only'], { runtime: f.runtime, print: () => undefined, now: () => later })).toBe(0);
    expect(JSON.parse(readFileSync(join(f.root, 'cli4', 'pack.json'), 'utf8'))).toMatchObject({ built: new Date(later).toISOString() });
  });
});

// t1275: --exclude-names leaves out a session whose skeleton would publish a listed word inside a kept name.
// The integration word is one the machine's temp path cannot hold (the build prints that path); the boundary cases use `robin`, the cases the spec names.
const WORD = 'quillon';
const skeletonWith = (...names: { kind: string; name: string }[]): string => JSON.stringify({ transcripts: [{ tools: [{ names }] }] });

describe('the names filter', () => {
  const filterFor = async (text: string | undefined): Promise<((skeleton: string) => boolean) | undefined> => {
    const dir = mkdtempSync(join(tmpdir(), 'oars-names-'));
    dirs.push(dir);
    if (text === undefined) return namesFilterOf(join(dir, 'absent.txt'));
    writeFileSync(join(dir, 'words.txt'), text);
    return namesFilterOf(join(dir, 'words.txt'));
  };

  it('matches a whole word at a boundary, in any case, and not inside a longer word', async () => {
    const hit = await filterFor(`# the owner\n\nrobin\n`);
    expect(hit?.(skeletonWith({ kind: 'file', name: 'robin-notes.md' }))).toBe(true);
    expect(hit?.(skeletonWith({ kind: 'file', name: 'Robin_plan.txt' }))).toBe(true);
    expect(hit?.(skeletonWith({ kind: 'file', name: 'ROBIN' }))).toBe(true);
    expect(hit?.(skeletonWith({ kind: 'file', name: 'robinson.ts' }))).toBe(false);
    expect(hit?.(skeletonWith({ kind: 'file', name: 'chrobin.ts' }))).toBe(false);
    expect(hit?.(skeletonWith({ kind: 'file', name: 'robin2.ts' }))).toBe(false);
  });

  it('reads every kind of name, and lets a comment line list nothing', async () => {
    const hit = await filterFor(`#${WORD}\n${WORD}\n`);
    for (const kind of ['file', 'dir', 'branch', 'other']) expect(hit?.(skeletonWith({ kind: 'file', name: 'a.ts' }, { kind, name: `${WORD}-x` })), kind).toBe(true);
    expect((await filterFor(`#${WORD}\n`))?.(skeletonWith({ kind: 'file', name: `${WORD}.md` }))).toBe(false);
  });

  it('leaves no session out for an empty or absent file, and no filter without the option', async () => {
    const named = skeletonWith({ kind: 'file', name: `${WORD}.md` });
    expect((await filterFor(''))?.(named)).toBe(false);
    expect((await filterFor('\n\n'))?.(named)).toBe(false);
    expect((await filterFor(undefined))?.(named)).toBe(false);
    expect(await namesFilterOf(undefined)).toBeUndefined();
  });

  it('leaves the matching session out of a built pack, counts it apart, and prints no word anywhere', async () => {
    const f = await fixture(`${WORD}-notes.md`);
    const words = join(f.root, 'names.txt');
    writeFileSync(words, `${WORD}\n`);
    const opts = f.options({ skeletonOnly: true, excludeNames: words });
    const counts = await buildPack(f.runtime, opts);
    expect(counts.namesFiltered).toBe(1);
    expect(counts.emitted).toBe(2);
    // Every numeric reason, so a new one that breaks the sum shows here.
    const reasons = [...Object.entries(counts).filter(([key]) => !['frame', 'scanned', 'emitted'].includes(key)), ...Object.entries(counts.excluded)].reduce((sum, [, value]) => sum + (typeof value === 'number' ? value : 0), 0);
    expect(counts.scanned).toBe(counts.emitted + reasons);
    expect(manifest(opts.out).length).toBe(2);
    expect(indexRows(f.owners).filter((row) => row.pack === opts.out).map((row) => row.session)).not.toContain(S(1));
    expect(names(opts.out).filter((file) => file.startsWith('sessions/')).length).toBe(2);
    // The whole output folder, and the captured output of the command, never hold the word.
    for (const file of filesUnder(opts.out)) expect(readFileSync(file, 'utf8').toLowerCase(), file).not.toContain(WORD);
    const printed: string[] = [];
    const again = f.options({ skeletonOnly: true, excludeNames: words });
    const code = await main(['--terms', again.terms, '--owners', again.owners, '--index-key', again.indexKey, '--buyer-key', 'open', '--out', again.out, '--min-turns', '1', '--skeleton-only', '--exclude-names', words], { runtime: f.runtime, print: (text: string) => printed.push(text), now: () => NOW });
    expect(code).toBe(0);
    expect(printed.join('\n')).toContain('Left out for a listed name in a kept name: 1.');
    expect(printed.join('\n').toLowerCase()).not.toContain(WORD);
    expect(JSON.parse(readFileSync(join(again.out, 'pack.json'), 'utf8'))).toMatchObject({ counts: { namesFiltered: 1 } });
    expect((await validate(again.out))?.violations).toEqual([]);
  });

  it('keeps the session when the file lists no word, and adds no count without the option', async () => {
    const f = await fixture(`${WORD}-notes.md`);
    expect(await buildPack(f.runtime, f.options({ skeletonOnly: true }))).toMatchObject({ emitted: 3 });
    expect((await buildPack(f.runtime, f.options({ skeletonOnly: true }))).namesFiltered).toBeUndefined();
    expect(await buildPack(f.runtime, f.options({ skeletonOnly: true, excludeNames: join(f.root, 'absent.txt') }))).toMatchObject({ emitted: 3, namesFiltered: 0 });
  });

  it('is refused with no value', async () => {
    const printed: string[] = [];
    expect(await main(['--exclude-names'], { runtime: (await fixture()).runtime, print: (text: string) => printed.push(text), now: () => NOW })).toBe(2);
    expect(printed.join('
')).toContain('--exclude-names');
  });
});
