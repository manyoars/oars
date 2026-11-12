// The validator of the public spec (docs/session-record.md): a manifest, a record, or a whole pack, checked on the machine that holds it.
// It reads files and nothing else: no key, no account, and no network call, so anyone who is handed a pack can run it.
// A violation line names where, which field, and which rule. It never repeats a value, since a terminal log can travel further than the pack.
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseSkeleton } from '../../cli/src/sessions/pool-wire.js';
import type { DepositManifestRow, HarnessTerms, Outcome, OutcomeCommit, RepositoryPointer } from './sample-pack.js';

/** The version of the spec page this validator checks against; the page states the same string. */
export const SPEC_VERSION = '1';

export const USAGE = [
  'Usage: npm run validate-pack -w packages/pool -- <pack folder | manifest.jsonl | record.json>',
  `Checks a pack, a manifest, or one session record against the public spec (docs/session-record.md, version ${SPEC_VERSION}).`,
  'Exit 0: it conforms. Exit 1: one line per violation (where, field, rule; never a value). Exit 2: nothing to read at that path.',
].join('\n');

export interface Violation {
  /** A file of the pack, with a line number where the file has rows. */
  where: string;
  /** The field's path inside the row or the record; `(file)`, `(row)`, or `(text)` when the rule is about the whole of one. */
  field: string;
  rule: string;
}

export const lineOf = ({ where, field, rule }: Violation): string => `${where} ${field}: ${rule}`;

interface Fields {
  readonly [key: string]: unknown;
}

const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A match id: an HMAC-SHA-256 in lowercase hex. A harness's own session id (a uuid) never has this shape. */
const MATCH_ID = /^[0-9a-f]{64}$/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// The harness id shapes the pack writer masks wherever they stand (`HARNESS_PREFIXED` in sample-pack.ts), and the one form a mask has: the prefix and 24 lowercase hex characters.
const PREFIXED_ID = /(?<![A-Za-z0-9])(?:srvtoolu|toolu|msg|req)_(?=[A-Za-z_-]*[0-9])[A-Za-z0-9][A-Za-z0-9_-]{14,}[A-Za-z0-9]/g;
const MASKED_ID = /^[a-z]+_[0-9a-f]{24}(?![0-9A-Za-z])/;
/** A deposit row's owner: the keyed pseudonym of the depositor (16 hex), never an account id. */
const DEPOSITOR_OWNER = /^depositor:[0-9a-f]{16}$/;
const HARNESS_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const USE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const TRAINING = ['not-offered', 'priced-add-on', 'included'] as const;
export const VERIFY = ['passed', 'failed', 'masked', 'none', 'na'] as const;

const RAW_ID = 'holds a raw id';

/** Whether a text holds a harness id that is not masked. Stateless: the pattern is rebuilt per call through `matchAll`. */
const holdsPrefixedId = (text: string): boolean => [...text.matchAll(PREFIXED_ID)].some(([token]) => !MASKED_ID.test(token));

/** The rule a value breaks, or undefined when it holds. A rule is fixed text: it never quotes the value. */
type Check = (value: unknown) => string | undefined;

export interface FieldSpec {
  required: boolean;
  check: Check;
}

const text: Check = (value) => (!isText(value) ? 'not a string' : value === '' ? 'empty' : undefined);
const textOrNull: Check = (value) => (value === null ? undefined : text(value));
const count: Check = (value) => (isCount(value) ? undefined : 'not a whole number');
const instantOrNull: Check = (value) => (value === null ? undefined : !isText(value) ? 'not a string or null' : Number.isNaN(Date.parse(value)) ? 'not a date and time' : undefined);
const real: Check = (value) => (isText(value) && Number.isNaN(Date.parse(value)) ? 'not a date and time' : undefined);
const oneOf = (list: readonly string[]): Check => (value) => (isText(value) && list.includes(value) ? undefined : 'not one of the listed values');
const shaped = (shape: RegExp, rule: string): Check => (value) => (!isText(value) ? 'not a string' : shape.test(value) ? undefined : rule);
const isoTime = shaped(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'not an ISO 8601 time');
const listOf = (item: Check): Check => (value) => (!Array.isArray(value) ? 'not a list' : value.map(item).find((rule) => rule !== undefined));

const required = (check: Check): FieldSpec => ({ required: true, check });
const optional = (check: Check): FieldSpec => ({ required: false, check });

/** A nested object or list of objects is checked field by field (`nested` below), so its own check only says it is one. */
const objectOrNull: Check = (value) => (value === null || isFields(value) ? undefined : 'not an object or null');
const object: Check = (value) => (isFields(value) ? undefined : 'not an object');
const objects: Check = (value) => (!Array.isArray(value) ? 'not a list' : value.every(isFields) ? undefined : 'not a list of objects');

// Each table is typed by the writer's own interface, so a field the writer gains or loses fails the typecheck here until the table and the spec page follow.
const TERMS_FIELDS: { readonly [K in keyof Required<HarnessTerms>]: FieldSpec } = { name: required(text), version: required(text) };
const POINTER_FIELDS: { readonly [K in keyof Required<RepositoryPointer>]: FieldSpec } = { remote: required(text), commit: required(textOrNull) };
const COMMIT_FIELDS: { readonly [K in keyof Required<OutcomeCommit>]: FieldSpec } = { sha: required(text), landed: required((value) => (value === null || typeof value === 'boolean' ? undefined : 'not true, false, or null')) };
const OUTCOME_FIELDS: { readonly [K in keyof Required<Outcome>]: FieldSpec } = { verify: required((value) => (value === null ? undefined : oneOf(VERIFY)(value))), commits: required(objects) };
const ROW_FIELDS: { readonly [K in keyof Required<DepositManifestRow>]: FieldSpec } = {
  matchId: required(shaped(MATCH_ID, 'not a match id')),
  harness: required(shaped(HARNESS_NAME, 'not a harness name')),
  harnessVersions: required(listOf(text)),
  repoOwner: required(text),
  sourceLicense: required(textOrNull),
  harnessTerms: required((value) => objects(value) ?? (Array.isArray(value) && value.length === 0 ? 'empty' : undefined)),
  // Training has a field of its own, so a list of uses that names it would state the same right twice.
  permittedUses: required((value) => listOf(shaped(USE_NAME, 'not a use name'))(value) ?? (Array.isArray(value) && value.includes('training') ? 'training is stated in the training field' : undefined)),
  training: required(oneOf(TRAINING)),
  transcripts: required((value) => count(value) ?? (value === 0 ? 'less than one' : undefined)),
  models: required((value) => (!isFields(value) ? 'not an object' : Object.values(value).every(isCount) ? undefined : 'a count is not a whole number')),
  turns: required(count),
  skeleton: optional(shaped(FILE_NAME, 'not a file name')),
  pointer: optional(objectOrNull),
  outcome: optional(object),
  // Optional: a pack built before the field existed holds the reasoning and says nothing.
  reasoning: optional(oneOf(['kept', 'stripped'])),
  // Optional: a deposit row has it (checkRow ties it to a depositor owner value); an operator row does not.
  acceptedAt: optional((value) => isoTime(value) ?? real(value)),
  redactionVersion: required(text),
  startedAt: required(instantOrNull),
  endedAt: required(instantOrNull),
};

/** The manifest's objects by the name the spec page gives each table: the drift test holds the page's tables equal to these. */
export const MANIFEST_OBJECTS: { readonly [object: string]: { readonly [field: string]: FieldSpec } } = {
  row: ROW_FIELDS,
  harnessTerms: TERMS_FIELDS,
  pointer: POINTER_FIELDS,
  outcome: OUTCOME_FIELDS,
  commits: COMMIT_FIELDS,
};

/** Where each nested object of a table sits: the field that holds it and the table it is checked against. */
const NESTED: { readonly [object: string]: { readonly [field: string]: string } } = {
  row: { harnessTerms: 'harnessTerms', pointer: 'pointer', outcome: 'outcome' },
  outcome: { commits: 'commits' },
};

/** Every string of a value, with the path of the field that holds it; an object's keys count as strings of that object. */
const stringsOf = (value: unknown, at: string): { at: string; text: string }[] => {
  if (isText(value)) return [{ at, text: value }];
  if (Array.isArray(value)) return value.flatMap((entry: unknown, index) => stringsOf(entry, `${at}[${String(index)}]`));
  if (!isFields(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => [{ at, text: key }, ...stringsOf(entry, at === '' ? key : `${at}.${key}`)]);
};

/** A manifest and a record are built from closed lists, counts, and keyed hashes, so a uuid or a harness id anywhere in one is an id that was not replaced. */
const rawIdsIn = (value: unknown): string[] => [...new Set(stringsOf(value, '').filter(({ text: held }) => UUID.test(held) || holdsPrefixedId(held)).map(({ at }) => (at === '' ? '(row)' : at)))];

const checkObject = (name: string, value: Fields, at: string, where: string): Violation[] => {
  const table = MANIFEST_OBJECTS[name] ?? {};
  const found: Violation[] = [];
  const under = (key: string): string => (at === '' ? key : `${at}.${key}`);
  for (const [key, spec] of Object.entries(table)) {
    if (!Object.hasOwn(value, key)) {
      if (spec.required) found.push({ where, field: under(key), rule: 'missing' });
      continue;
    }
    const entry = value[key];
    const rule = spec.check(entry);
    if (rule !== undefined) {
      found.push({ where, field: under(key), rule });
      continue;
    }
    const nested = NESTED[name]?.[key];
    if (nested === undefined) continue;
    if (Array.isArray(entry)) entry.forEach((item: unknown, index) => {
        if (isFields(item)) found.push(...checkObject(nested, item, `${under(key)}[${String(index)}]`, where));
      });
    else if (isFields(entry)) found.push(...checkObject(nested, entry, under(key), where));
  }
  for (const key of Object.keys(value)) if (!Object.hasOwn(table, key)) found.push({ where, field: under(key), rule: 'unknown field' });
  return found;
};

/** One manifest row against the spec. `where` is the row's place (`manifest.jsonl:3`). */
export const checkRow = (value: unknown, where: string): Violation[] => {
  if (!isFields(value)) return [{ where, field: '(row)', rule: 'not a JSON object' }];
  // A match id of the wrong shape is reported once, by its own rule, not again as a raw id.
  const raw = rawIdsIn(value).filter((field) => field !== 'matchId');
  const found = checkObject('row', value, '', where);
  // acceptedAt is the proof of a depositor's grant; a row owned by anyone else has no such grant to date.
  const depositor = isText(value.repoOwner) && DEPOSITOR_OWNER.test(value.repoOwner);
  // ...and a depositor row with none cites no acceptance, so it never validates.
  if (depositor && !Object.hasOwn(value, 'acceptedAt')) found.push({ where, field: 'acceptedAt', rule: 'missing' });
  if (Object.hasOwn(value, 'acceptedAt') && !depositor) found.push({ where, field: 'acceptedAt', rule: 'only a row with a depositor: owner value has it' });
  return [...found, ...raw.map((field) => ({ where, field, rule: RAW_ID }))];
};

// The record parser is the pool's own, and the pool's id is 16 hex characters where a pack's is the match id: the id is checked here and the parser is handed a stand-in.
const STAND_IN_ID = '0'.repeat(16);

/**
 * One session record against the spec: the pool's own reader (`parseSkeleton`) decides the shape, so the spec and the reader cannot disagree. The reader stops at a record's first shape error, so a record reports
 * one at a time. A field the reader does not know is a violation here (the reader itself would set it aside), and a value off a closed list is not: a newer writer's value reads as `other`.
 */
export const checkRecord = (value: unknown, where: string, matchId?: string): Violation[] => {
  if (!isFields(value)) return [{ where, field: '(file)', rule: 'not a JSON object' }];
  const found: Violation[] = [];
  if (!Object.hasOwn(value, 'id')) found.push({ where, field: 'id', rule: 'missing' });
  else if (!isText(value.id) || !MATCH_ID.test(value.id)) found.push({ where, field: 'id', rule: 'not a match id' });
  else if (matchId !== undefined && value.id !== matchId) found.push({ where, field: 'id', rule: 'not the match id of its manifest row' });
  const parsed = parseSkeleton({ ...value, id: STAND_IN_ID });
  if (!parsed.ok) return [...found, { where, field: parsed.field, rule: parsed.reason }];
  for (const { at, kind } of parsed.extensions) if (kind !== 'value') found.push({ where, field: at, rule: 'unknown field' });
  // A digest is a plain hash of unredacted text: a guess at a masked value could be confirmed against it, so a record that leaves its holder carries none.
  parsed.skeleton.transcripts.forEach(({ tools }, transcript) => {
    tools.forEach(({ digests }, call) => {
      if (digests !== undefined) found.push({ where, field: `transcripts[${String(transcript)}].tools[${String(call)}].digests`, rule: 'not allowed: a plain digest of unredacted text' });
    });
  });
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'id'));
  return [...found, ...rawIdsIn(rest).map((field) => ({ where, field, rule: RAW_ID }))];
};

const isAbsent = (error: unknown): boolean => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

const readOrAbsent = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
};

const json = (body: string): { value: unknown } | undefined => {
  try {
    const value: unknown = JSON.parse(body);
    return { value };
  } catch {
    return undefined;
  }
};

interface Row {
  where: string;
  value: unknown;
}

const rowsOf = (body: string, where: string): { rows: Row[]; found: Violation[] } => {
  const rows: Row[] = [];
  const found: Violation[] = [];
  body.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    const at = `${where}:${String(index + 1)}`;
    const parsed = json(line);
    if (parsed === undefined) found.push({ where: at, field: '(row)', rule: 'not JSON' });
    else rows.push({ where: at, value: parsed.value });
  });
  return { rows, found };
};

const checkRows = (body: string, where: string): { rows: Row[]; found: Violation[] } => {
  const { rows, found } = rowsOf(body, where);
  const seen = new Set<string>();
  for (const row of rows) {
    found.push(...checkRow(row.value, row.where));
    const id = isFields(row.value) ? row.value.matchId : undefined;
    if (!isText(id)) continue;
    if (seen.has(id)) found.push({ where: row.where, field: 'matchId', rule: 'repeats an earlier row' });
    seen.add(id);
  }
  return { rows, found };
};

/** A transcript is the harness's own lines, so only the ids are checked: no harness id left unmasked, and every line's session id replaced by a match id. */
const checkTranscript = async (file: string, where: string): Promise<Violation[]> => {
  const found: Violation[] = [];
  let number = 0;
  for await (const line of createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })) {
    number += 1;
    const at = `${where}:${String(number)}`;
    if (holdsPrefixedId(line)) found.push({ where: at, field: '(text)', rule: RAW_ID });
    const parsed = json(line);
    if (parsed === undefined || !isFields(parsed.value)) continue;
    const { sessionId } = parsed.value;
    if (isText(sessionId) && !MATCH_ID.test(sessionId)) found.push({ where: at, field: 'sessionId', rule: 'not a match id' });
  }
  return found;
};

const filesUnder = async (folder: string): Promise<string[]> => (await readdir(folder, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(folder.length + 1).replaceAll('\\', '/'));

export interface Result {
  violations: Violation[];
  /** What was counted on the way, for the line a conforming input prints. */
  rows: number;
  records: number;
  transcripts: number;
}

const MANIFEST_FILE = 'manifest.jsonl';
const MAIN_FILE = 'main.jsonl';

const checkPack = async (folder: string): Promise<Result> => {
  const body = await readOrAbsent(join(folder, MANIFEST_FILE));
  if (body === undefined) return { violations: [{ where: MANIFEST_FILE, field: '(file)', rule: 'missing' }], rows: 0, records: 0, transcripts: 0 };
  const { rows, found } = checkRows(body, MANIFEST_FILE);
  let records = 0;
  let transcripts = 0;
  const named = new Set<string>();
  for (const { where, value } of rows) {
    const id = isFields(value) ? value.matchId : undefined;
    if (!isFields(value) || !isText(id) || !MATCH_ID.test(id) || named.has(id)) continue;
    named.add(id);
    const session = `sessions/${id}`;
    let files: string[];
    try {
      files = await filesUnder(join(folder, 'sessions', id));
    } catch (error) {
      if (!isAbsent(error)) throw error;
      found.push({ where, field: 'matchId', rule: 'no folder of that name under sessions/' });
      continue;
    }
    const skeleton = isText(value.skeleton) && FILE_NAME.test(value.skeleton) ? value.skeleton : undefined;
    const others = files.filter((file) => file !== skeleton).sort();
    const lines = others.filter((file) => file.endsWith('.jsonl'));
    for (const file of others) if (!file.endsWith('.jsonl')) found.push({ where: `${session}/${file}`, field: '(file)', rule: 'not a transcript file' });
    if (!lines.includes(MAIN_FILE)) found.push({ where: `${session}/${MAIN_FILE}`, field: '(file)', rule: 'missing' });
    if (isCount(value.transcripts) && value.transcripts !== lines.length) found.push({ where, field: 'transcripts', rule: 'not the number of transcript files in the session folder' });
    for (const file of lines) found.push(...(await checkTranscript(join(folder, 'sessions', id, file), `${session}/${file}`)));
    transcripts += lines.length;
    if (skeleton === undefined) continue;
    const record = await readOrAbsent(join(folder, 'sessions', id, skeleton));
    const parsed = record === undefined ? undefined : json(record);
    if (record === undefined) found.push({ where: `${session}/${skeleton}`, field: '(file)', rule: 'missing' });
    else if (parsed === undefined) found.push({ where: `${session}/${skeleton}`, field: '(file)', rule: 'not JSON' });
    else {
      records += 1;
      found.push(...checkRecord(parsed.value, `${session}/${skeleton}`, id));
    }
  }
  let folders: string[] = [];
  try {
    folders = (await readdir(join(folder, 'sessions'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (!isAbsent(error)) throw error;
  }
  for (const name of folders) if (!named.has(name)) found.push({ where: `sessions/${name}`, field: '(folder)', rule: 'no manifest row names it' });
  return { violations: found, rows: rows.length, records, transcripts };
};

/** A folder is a pack, a `.jsonl` file a manifest, and any other file one record. Undefined when nothing is at the path. */
export const validate = async (path: string): Promise<Result | undefined> => {
  let isFolder: boolean;
  try {
    isFolder = (await stat(path)).isDirectory();
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
  if (isFolder) return checkPack(path);
  const body = await readFile(path, 'utf8');
  const name = path.replaceAll('\\', '/').split('/').pop() ?? path;
  if (name.endsWith('.jsonl')) {
    const { rows, found } = checkRows(body, name);
    return { violations: found, rows: rows.length, records: 0, transcripts: 0 };
  }
  const parsed = json(body);
  if (parsed === undefined) return { violations: [{ where: name, field: '(file)', rule: 'not JSON' }], rows: 0, records: 0, transcripts: 0 };
  return { violations: checkRecord(parsed.value, name), rows: 0, records: 1, transcripts: 0 };
};

const counted = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

export interface Io {
  print: (text: string) => void;
}

export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const [path, ...rest] = argv;
  if (path === undefined || rest.length > 0 || path.startsWith('--')) {
    io.print(USAGE);
    return 2;
  }
  const result = await validate(path);
  if (result === undefined) {
    io.print(`Nothing to read at that path.\n${USAGE}`);
    return 2;
  }
  if (result.violations.length > 0) {
    io.print(result.violations.map(lineOf).join('\n'));
    return 1;
  }
  const { rows, records, transcripts } = result;
  const held = [...(rows > 0 ? [counted(rows, 'manifest row', 'manifest rows')] : []), ...(records > 0 || rows > 0 ? [counted(records, 'record', 'records')] : []), ...(transcripts > 0 ? [counted(transcripts, 'transcript', 'transcripts')] : [])];
  io.print(`Conforms to the session record spec, version ${SPEC_VERSION}: ${held.join(', ')}.`);
  return 0;
};
