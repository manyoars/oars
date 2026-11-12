// The public spec (docs/session-record.md) and its validator: the page and the writer's fields cannot drift apart, and a pack, a manifest, or a record is checked offline.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BATCH_FIELDS } from '../../cli/src/sessions/pool-outbox.js';
import { OPTIONAL, SKELETON_FORMAT } from '../../cli/src/sessions/pool-wire.js';
import { checkRecord, checkRow, lineOf, main, MANIFEST_OBJECTS, SPEC_VERSION, validate, type Violation } from './validate-pack.js';

const PAGE = readFileSync(fileURLToPath(new URL('../../../docs/session-record.md', import.meta.url)), 'utf8');

interface Table {
  /** The object's name in the heading: `row`, `frame`. */
  name: string;
  kind: 'Manifest' | 'Record';
  fields: { name: string; required: boolean }[];
}

/** Every `### Manifest object` and `### Record object` table of the page, in order. */
const tablesOf = (page: string): Table[] => {
  const tables: Table[] = [];
  let current: Table | undefined;
  for (const text of page.split('\n')) {
    const heading = /^### (Manifest|Record) object `(\w+)`/.exec(text);
    if (heading !== null) {
      current = { name: heading[2] ?? '', kind: heading[1] === 'Manifest' ? 'Manifest' : 'Record', fields: [] };
      tables.push(current);
      continue;
    }
    if (text.startsWith('## ')) current = undefined;
    const cells = text.split('|').map((cell) => cell.trim());
    if (current === undefined || cells.length < 6 || cells[1] === 'Field' || /^-+$/.test(cells[1] ?? '')) continue;
    current.fields.push({ name: cells[1] ?? '', required: cells[3] === 'yes' });
  }
  return tables;
};

const TABLES = tablesOf(PAGE);
const tableOf = (kind: Table['kind'], name: string): Table => {
  const found = TABLES.find((table) => table.kind === kind && table.name === name);
  if (found === undefined) throw new Error(`the page has no ${kind} table for ${name}`);
  return found;
};

describe('the page and the writer cannot drift', () => {
  it('states the validator\'s spec version', () => {
    expect(PAGE).toContain(`Spec version: \`${SPEC_VERSION}\``);
  });

  it.each(Object.keys(MANIFEST_OBJECTS))('lists the manifest %s with the fields the validator checks, and which are required', (name) => {
    const spec = MANIFEST_OBJECTS[name] ?? {};
    const page = tableOf('Manifest', name).fields;
    expect(page.map((field) => field.name).sort()).toEqual(Object.keys(spec).sort());
    for (const field of page) expect(field.required, `${name}.${field.name}`).toBe(spec[field.name]?.required);
  });

  it('has no manifest table the validator does not check', () => {
    expect(TABLES.filter((table) => table.kind === 'Manifest').map((table) => table.name).sort()).toEqual(Object.keys(MANIFEST_OBJECTS).sort());
  });

  it('lists every field of a record the writer emits, and no other (less the digest pair, which a conforming record leaves out)', () => {
    const page = TABLES.filter((table) => table.kind === 'Record' && table.name !== 'digests').flatMap((table) => table.fields.map((field) => field.name));
    const written = BATCH_FIELDS.filter((name) => !['digests', 'old', 'new'].includes(name));
    expect([...new Set(page)].sort()).toEqual([...written].sort());
  });

  it.each(Object.entries(OPTIONAL))('lists the %s fields the reader allows to be absent as optional, and the rest as required', (level, optional) => {
    const page = tableOf('Record', level).fields;
    expect(page.filter((field) => !field.required).map((field) => field.name).sort()).toEqual(optional.filter((name) => name !== 'digests').sort());
    expect(page.filter((field) => field.required).length).toBeGreaterThan(0);
  });

  it('names the digest pair as not allowed', () => {
    expect(tableOf('Record', 'digests').fields.map((field) => field.name).sort()).toEqual(['new', 'old']);
    expect(PAGE).toMatch(/A conforming record has none/);
  });

  it('links to nothing outside the repository and names no key, account, or address', () => {
    expect(PAGE).not.toMatch(/https?:\/\//);
    expect(PAGE).toMatch(/no key, no network, and no Many Oars account/);
  });
});

const MATCH = 'a1'.repeat(32);
const OTHER_MATCH = 'b2'.repeat(32);

const frame = (): object => ({ harness: 'claude-code', platform: 'linux', stack: { languages: [], frameworks: [] } });

/** The smallest record the pool's reader accepts: one transcript, one prompt, no tools. */
const without = (value: { [key: string]: unknown }, key: string): { [key: string]: unknown } => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
const objects = (value: unknown): { [key: string]: unknown }[] => (Array.isArray(value) ? value.filter((item): item is { [key: string]: unknown } => typeof item === 'object' && item !== null) : []);

const record = (id = MATCH): { [key: string]: unknown } => ({
  format: SKELETON_FORMAT,
  vocabVersion: '1',
  fieldsVersion: 1,
  id,
  timingPrint: null,
  transcripts: [{
    merkleRoot: 'c3'.repeat(32),
    leaves: 2,
    harness: 'claude-code',
    frame: frame(),
    frames: [frame()],
    prompts: [{ cls: 'other', errors: 0, usage: { input: null, cacheWrite: null, cacheRead: null, output: null, thinking: null }, frame: frame() }],
    tools: [],
  }],
});

const row = (matchId = MATCH): { [key: string]: unknown } => ({
  matchId,
  harness: 'claude-code',
  harnessVersions: ['2.1.300'],
  repoOwner: 'Acme',
  sourceLicense: 'Apache-2.0',
  harnessTerms: [{ name: 'Anthropic Consumer Terms', version: 'effective 2025-10-08' }],
  permittedUses: ['evaluation'],
  training: 'not-offered',
  transcripts: 1,
  models: { 'claude-opus-5-5': 2 },
  turns: 2,
  skeleton: 'skeleton.json',
  redactionVersion: '4',
  startedAt: '2026-06-01T10:00:00.000Z',
  endedAt: '2026-06-01T10:05:00.000Z',
});

const dirs: string[] = [];
const temp = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'oars-validate-pack-'));
  dirs.push(folder);
  return folder;
};

interface PackParts {
  row?: { [key: string]: unknown };
  record?: { [key: string]: unknown } | undefined;
  main?: string;
}

/** A pack on disk: one session, its manifest row, its record, and a one-line transcript. */
const pack = (parts: PackParts = {}): string => {
  const folder = temp();
  const given = parts.row ?? row();
  const id = typeof given.matchId === 'string' ? given.matchId : MATCH;
  const session = join(folder, 'sessions', id);
  mkdirSync(session, { recursive: true });
  writeFileSync(join(folder, 'manifest.jsonl'), `${JSON.stringify(given)}\n`);
  writeFileSync(join(session, 'main.jsonl'), parts.main ?? `${JSON.stringify({ type: 'user', sessionId: id, message: { role: 'user', content: 'hello' } })}\n`);
  if ('record' in parts) {
    if (parts.record !== undefined) writeFileSync(join(session, 'skeleton.json'), JSON.stringify(parts.record));
  } else writeFileSync(join(session, 'skeleton.json'), JSON.stringify(record(id)));
  return folder;
};

const lines = async (path: string): Promise<{ code: number; out: string[] }> => {
  const out: string[] = [];
  const code = await main([path], { print: (text) => out.push(text) });
  return { code, out: out.flatMap((text) => text.split('\n')) };
};

const fetched = vi.fn(() => {
  throw new Error('the validator made a network call');
});

beforeEach(() => {
  // No store, no account, and no buyer key: the validator reads the path it is given and nothing else.
  vi.stubEnv('APPDATA', temp());
  vi.stubEnv('XDG_CONFIG_HOME', temp());
  vi.stubEnv('OARS_BUYER_KEY', '');
  vi.stubGlobal('fetch', fetched);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetched.mockClear();
  for (const folder of dirs.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const found = (violations: readonly Violation[] | undefined): string[] => (violations ?? []).map(lineOf);

describe('a pack', () => {
  it('conforms when its row, record, and transcript do, and says what it counted', async () => {
    const result = await validate(pack());
    expect(found(result?.violations)).toEqual([]);
    expect(result).toMatchObject({ rows: 1, records: 1, transcripts: 1 });
    const printed = await lines(pack());
    expect(printed.code).toBe(0);
    expect(printed.out).toEqual([`Conforms to the session record spec, version ${SPEC_VERSION}: 1 manifest row, 1 record, 1 transcript.`]);
  });

  it('conforms with no record, when the row names none', async () => {
    const bare = without(row(), 'skeleton');
    expect(found((await validate(pack({ row: bare, record: undefined })))?.violations)).toEqual([]);
  });

  it('reports a missing required field by its name', async () => {
    const short = without(row(), 'redactionVersion');
    const printed = await lines(pack({ row: short }));
    expect(printed.code).toBe(1);
    expect(printed.out).toEqual(['manifest.jsonl:1 redactionVersion: missing']);
  });

  const DEPOSIT = { repoOwner: 'depositor:0123456789abcdef', sourceLicense: 'manyoars-covenant 2.1 sha256:abc', acceptedAt: '2026-07-01T00:00:00.000Z' };

  it('validate-pack accepts a row with acceptedAt', async () => {
    expect(found((await validate(pack({ row: { ...row(), ...DEPOSIT } })))?.violations)).toEqual([]);
  });

  it('validate-pack refuses an acceptedAt that is not a time', async () => {
    for (const bad of ['yesterday-planted', null, 5]) {
      const printed = await lines(pack({ row: { ...row(), ...DEPOSIT, acceptedAt: bad } }));
      expect(printed.code).toBe(1);
      expect(printed.out).toHaveLength(1);
      expect(printed.out[0]).toMatch(/^manifest\.jsonl:1 acceptedAt: not a (string|date and time)/);
      expect(printed.out.join('\n')).not.toContain('planted');
    }
  });

  it('validate-pack refuses acceptedAt on a row whose owner is not a depositor value', async () => {
    for (const owner of ['Acme', 'depositor:xyz', 'depositor:0123456789abcdef0']) {
      const printed = await lines(pack({ row: { ...row(), ...DEPOSIT, repoOwner: owner } }));
      expect(printed.code).toBe(1);
      expect(printed.out).toEqual(['manifest.jsonl:1 acceptedAt: only a row with a depositor: owner value has it']);
    }
  });

  it('an operator row has no acceptedAt and still conforms', async () => {
    expect(Object.hasOwn(row(), 'acceptedAt')).toBe(false);
    expect(found((await validate(pack()))?.violations)).toEqual([]);
  });

  it('reports a field the spec does not list', async () => {
    const printed = await lines(pack({ row: { ...row(), extra: 1 } }));
    expect(printed.out).toEqual(['manifest.jsonl:1 extra: unknown field']);
  });

  it('reports a value of the wrong type, and never the value', async () => {
    const printed = await lines(pack({ row: { ...row(), turns: 'seventeen-planted' } }));
    expect(printed.code).toBe(1);
    expect(printed.out).toEqual(['manifest.jsonl:1 turns: not a whole number']);
    expect(printed.out.join('\n')).not.toContain('seventeen-planted');
  });

  it('reports a raw id in a row, in a record, and in a transcript, and never the id', async () => {
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const tool = 'toolu_01A09q90qw90lq917835lq9';
    const dirty = { ...record(), transcripts: [{ ...objects(record().transcripts)[0], frames: [{ ...frame(), model: tool }] }] };
    const printed = await lines(pack({ row: { ...row(), repoOwner: uuid }, record: dirty, main: `${JSON.stringify({ type: 'user', content: `see ${tool}` })}\n` }));
    expect(printed.code).toBe(1);
    expect(printed.out).toContain('manifest.jsonl:1 repoOwner: holds a raw id');
    expect(printed.out).toContain('sessions/' + MATCH + '/main.jsonl:1 (text): holds a raw id');
    expect(printed.out.some((text) => /skeleton\.json transcripts\[0\]\.frames\[0\]\.model: holds a raw id/.test(text))).toBe(true);
    for (const planted of [uuid, tool]) expect(printed.out.join('\n')).not.toContain(planted);
  });

  it('accepts a masked harness id: the prefix and 24 hex characters', async () => {
    const masked = `toolu_${'ab12'.repeat(6)}`;
    expect(found((await validate(pack({ main: `${JSON.stringify({ type: 'user', content: masked })}\n` })))?.violations)).toEqual([]);
  });

  it('reports a transcript line whose session id is not a match id', async () => {
    const printed = await lines(pack({ main: `${JSON.stringify({ type: 'user', sessionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' })}\n` }));
    expect(printed.out).toEqual([`sessions/${MATCH}/main.jsonl:1 sessionId: not a match id`]);
  });

  it('reports a record with an unknown field, a wrong shape, a plain digest, or the wrong match id', async () => {
    expect((await lines(pack({ record: { ...record(), mystery: 1 } }))).out).toEqual([`sessions/${MATCH}/skeleton.json mystery: unknown field`]);
    expect((await lines(pack({ record: { ...record(), fieldsVersion: 'x' } }))).out).toHaveLength(1);
    expect((await lines(pack({ record: record(OTHER_MATCH) }))).out).toEqual([`sessions/${MATCH}/skeleton.json id: not the match id of its manifest row`]);
    const digested = record();
    const [main0] = objects(digested.transcripts);
    const tool = { side: false, status: 'ok', steps: [{ action: 'other', native: 'private', identity: null, status: 'ok', agentType: null, frame: 0 }], digests: [{ new: 'ab'.repeat(16) }] };
    digested.transcripts = [{ ...main0, tools: [tool] }];
    expect((await lines(pack({ record: digested }))).out).toEqual([expect.stringContaining('tools[0].digests: not allowed')]);
  });

  it('reports a file in a session folder that is not a transcript, and never counts it', async () => {
    const folder = pack();
    writeFileSync(join(folder, 'sessions', MATCH, 'notes.txt'), 'private notes');
    const printed = await lines(folder);
    expect(printed.out).toEqual([`sessions/${MATCH}/notes.txt (file): not a transcript file`]);
    expect(printed.code).toBe(1);
  });

  it('reports a transcript count that does not match the folder, a folder no row names, and a missing folder', async () => {
    const folder = pack({ row: { ...row(), transcripts: 2 } });
    mkdirSync(join(folder, 'sessions', OTHER_MATCH));
    const printed = await lines(folder);
    expect(printed.out).toContain('manifest.jsonl:1 transcripts: not the number of transcript files in the session folder');
    expect(printed.out).toContain(`sessions/${OTHER_MATCH} (folder): no manifest row names it`);
    const empty = temp();
    writeFileSync(join(empty, 'manifest.jsonl'), `${JSON.stringify(row())}\n`);
    expect((await lines(empty)).out).toEqual(['manifest.jsonl:1 matchId: no folder of that name under sessions/']);
  });
});

describe('a single file', () => {
  it('checks a manifest and a record alone', async () => {
    const folder = temp();
    writeFileSync(join(folder, 'manifest.jsonl'), `${JSON.stringify(row())}\n${JSON.stringify(row())}\nnot json\n`);
    writeFileSync(join(folder, 'one.json'), JSON.stringify(record()));
    expect((await lines(join(folder, 'manifest.jsonl'))).out).toEqual(['manifest.jsonl:3 (row): not JSON', 'manifest.jsonl:2 matchId: repeats an earlier row']);
    expect((await lines(join(folder, 'one.json'))).out).toEqual([`Conforms to the session record spec, version ${SPEC_VERSION}: 1 record.`]);
  });

  it('exits 2 for a missing path or no path, and prints the usage', async () => {
    expect((await lines(join(temp(), 'absent'))).code).toBe(2);
    const out: string[] = [];
    expect(await main([], { print: (text) => out.push(text) })).toBe(2);
    expect(out.join('')).toContain('Usage:');
  });

  it('checks a row and a record value directly', () => {
    expect(checkRow([], 'x')).toEqual([{ where: 'x', field: '(row)', rule: 'not a JSON object' }]);
    expect(checkRecord('x', 'y')).toEqual([{ where: 'y', field: '(file)', rule: 'not a JSON object' }]);
    expect(checkRecord({}, 'z').map(lineOf)[0]).toBe('z id: missing');
  });
});

describe('no registry', () => {
  it('needs no key, no network, and no account: nothing was fetched, and the output holds no planted value', async () => {
    const planted = 'planted-owner-name';
    const printed = await lines(pack({ row: { ...row(), repoOwner: 7, sourceLicense: planted + '-x' }, main: `${JSON.stringify({ planted })}\n` }));
    expect(printed.code).toBe(1);
    expect(fetched).not.toHaveBeenCalled();
    expect(printed.out.join('\n')).not.toContain(planted);
  });
});
