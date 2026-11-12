// The registry read of a sample pack row: for one match id under one buyer key id, which lots it was built into and under which terms, who received it under which license, and whether an objection has withdrawn it since.
// It reads the operator folder and the pack folders `index.jsonl` names, and writes nothing. A row carries what a recipient already holds (the match id) and what the register says about it:
// never a session id, an owner, a project folder, an objector's name, or a key, so the same rows can later be served to the buyer who holds the key.
import type { Dirent } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DELIVERIES_FILE, deliveriesOf, fieldOf, indexOf, lotOf } from './deliver.js';
import { bareOf, decodedStrings, isAbsent, isText, PackError, readObjections, squashed, type HarnessTerms, type Objection } from './sample-pack.js';

export const USAGE = [
  'Usage: license-status <match id> --key-id <id> --operator <dir> [--json]',
  '       license-status --ids <file> --key-id <id> --operator <dir> [--json]',
  '  <match id>         the 64 hex characters a recipient holds a session under',
  '  --ids <file>       a file of match ids, one per line',
  '  --key-id <id>      the id of the buyer key the match ids belong to (keyId in pack.json: 16 hex characters), never the key',
  '  --operator <dir>   the folder the owners file sits in, with index.jsonl, deliveries.jsonl, and objections.jsonl',
  '  --json             one JSON document in place of the table',
  'It prints one row per match id: built, delivered, withdrawn (an objection in objections.jsonl covers it), or unknown (the register holds no such id under this key).',
  'A value reads unknown when no operator file records it: the covenant version always, and the erasure at a recipient for a delivered row that was withdrawn. It reads files only and writes nothing.',
].join('\n');

export const UNKNOWN = 'unknown';
type Unknown = typeof UNKNOWN;

/** One lot a row was built into, from the newest `index.jsonl` line for that lot and the pack folder it names. */
export interface LotStatus {
  lot: string;
  /** The pack's build time, or `unknown`. */
  built: string;
  /** Whether that pack folder lists the row now: a rebuild can leave a row out while the index keeps its line, and a folder no longer on the machine cannot say. */
  listed: boolean | Unknown;
  harnessTerms: HarnessTerms[] | Unknown;
  permittedUses: string[] | Unknown;
  /** The manifest row's `training` (`not-offered` or `priced-add-on`), or `unknown`. */
  training: string;
}

export interface DeliveryStatus {
  lot: string;
  recipient: string;
  license: string;
  deliveredAt: string;
}

/** An objection that covers the row: by its session, or by a person's name found in its delivered text. The name itself is never carried. */
export interface Withdrawal {
  received: string;
  scope: Objection['scope'];
  basis: 'session' | 'name';
}

export interface LicenseStatus {
  matchId: string;
  state: 'unknown' | 'built' | 'delivered' | 'withdrawn';
  /** Whether a pack.json or a delivery still on the machine ties the row to the asked key id. */
  keyVerified: boolean;
  lots: LotStatus[];
  deliveries: DeliveryStatus[];
  /** Unknown when an objection names a person and the row's text is no longer on the machine to look in. */
  withdrawn: Withdrawal[] | Unknown;
  /** Whether each recipient was told to erase a withdrawn row, and did, is recorded nowhere yet: unknown for a delivered row that is (or may be) withdrawn, and for an unknown row. */
  erasure: 'none-due' | Unknown;
  /** No operator file records a covenant version. */
  covenant: Unknown;
}

export interface StatusReport {
  keyId: string;
  rows: LicenseStatus[];
  /** Asked ids the register holds under a different key id: they read unknown, and the count tells a wrong `--key-id` from an empty register. */
  underAnotherKey: number;
}

/** A file's JSON, with a failure that names the file and never quotes it: the engine's own message repeats the text it could not read, which may be a session id. */
const parsed = (text: string, what: string): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new PackError(`${what} is not JSON.`);
  }
};

const sound = async <T>(what: string, read: Promise<T>): Promise<T> => {
  try {
    return await read;
  } catch (error) {
    if (error instanceof SyntaxError) throw new PackError(`${what} holds a line that is not JSON.`);
    throw error;
  }
};

const linesIn = (text: string): string[] => text.split(String.fromCharCode(10)).map((row) => row.trim()).filter((row) => row !== '');

interface PackRead {
  keyId: unknown;
  built: unknown;
  rows: Map<string, unknown>;
}

/** A pack folder's own record, or nothing when the folder is no longer where the index says. */
const packOf = async (pack: string): Promise<PackRead | undefined> => {
  let texts: [string, string];
  try {
    texts = [await readFile(join(pack, 'pack.json'), 'utf8'), await readFile(join(pack, 'manifest.jsonl'), 'utf8')];
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
  const lot = lotOf(pack);
  const record = parsed(texts[0], `pack.json of lot ${lot}`);
  const rows = new Map<string, unknown>();
  for (const [at, line] of linesIn(texts[1]).entries()) {
    const row = parsed(line, `manifest.jsonl of lot ${lot}, row ${String(at + 1)},`);
    const matchId = fieldOf(row, 'matchId');
    if (isText(matchId)) rows.set(matchId, row);
  }
  return { keyId: fieldOf(record, 'keyId'), built: fieldOf(record, 'built'), rows };
};

const NOT_READ = { built: UNKNOWN, harnessTerms: UNKNOWN, permittedUses: UNKNOWN, training: UNKNOWN } as const;

/** The terms a manifest row states, field by field: `repoOwner` and every other field of the row stay where they are. */
const termsOf = (row: unknown): Pick<LotStatus, 'harnessTerms' | 'permittedUses' | 'training'> => {
  const [terms, uses, training] = [fieldOf(row, 'harnessTerms'), fieldOf(row, 'permittedUses'), fieldOf(row, 'training')];
  return {
    harnessTerms: !Array.isArray(terms) ? UNKNOWN : terms.flatMap((term: unknown): HarnessTerms[] => {
      const [name, version] = [fieldOf(term, 'name'), fieldOf(term, 'version')];
      return isText(name) && isText(version) ? [{ name, version }] : [];
    }),
    permittedUses: !Array.isArray(uses) ? UNKNOWN : uses.filter(isText),
    training: isText(training) ? training : UNKNOWN,
  };
};

/** The text of a row's delivered files in each folder still on the machine, squashed as an objection's name is, or nothing when no folder is left to read. */
const textsOf = async (folders: readonly string[]): Promise<string[] | undefined> => {
  let texts: string[] | undefined;
  for (const folder of folders) {
    let found: Dirent[];
    try {
      found = await readdir(folder, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (isAbsent(error)) continue;
      throw error;
    }
    texts ??= [];
    for (const file of found.filter((item) => item.isFile())) {
      // Raw text and decoded JSON strings, as `deliver recipients` reads them: an escape in the file can hide a name from the raw bytes.
      const text = await readFile(join(file.parentPath, file.name), 'utf8');
      texts.push(...[text, ...decodedStrings(text)].map(squashed));
    }
  }
  return texts;
};

const unknownRow = (matchId: string): LicenseStatus => ({ matchId, state: 'unknown', keyVerified: false, lots: [], deliveries: [], withdrawn: UNKNOWN, erasure: UNKNOWN, covenant: UNKNOWN });

/** One row per distinct match id, in the order asked, for the rows the register holds under `keyId`. */
export const licenseStatus = async (operator: string, keyId: string, matchIds: readonly string[]): Promise<StatusReport> => {
  const dir = resolve(operator);
  try {
    await access(join(dir, 'index.jsonl'));
  } catch (error) {
    if (!isAbsent(error)) throw error;
    // An absent index would read every id as unknown, which is the answer a mistyped folder must never give.
    throw new PackError('The operator folder holds no index.jsonl: name the folder the owners file sits in.');
  }
  const index = await sound('index.jsonl', indexOf(dir));
  const deliveries = await sound(DELIVERIES_FILE, deliveriesOf(dir));
  const { objections } = await readObjections(dir);
  const names = objections.flatMap((objection): { wanted: string; objection: Objection }[] => (objection.name === undefined ? [] : [{ wanted: squashed(objection.name.trim()), objection }]));
  const packs = new Map<string, Promise<PackRead | undefined>>();
  const packAt = (pack: string): Promise<PackRead | undefined> => {
    const read = packs.get(pack) ?? packOf(pack);
    packs.set(pack, read);
    return read;
  };
  const rows: LicenseStatus[] = [];
  let underAnotherKey = 0;
  for (const matchId of new Set(matchIds)) {
    const entries = index.filter((entry) => entry.matchId === matchId);
    const sent = deliveries.filter((row) => row.matchId === matchId);
    // A match id is an HMAC under one buyer key, so it belongs to one key: whichever a delivery records, or the pack.json of a pack that lists it.
    const keys = new Set(sent.map((row) => row.keyId));
    const lots: LotStatus[] = [];
    const folders: string[] = [];
    // The index is appended per build, so a lot's newest line names the folder it was last built into.
    for (const [lot, pack] of new Map(entries.map((entry) => [lotOf(entry.pack), entry.pack]))) {
      const found = await packAt(pack);
      const row = found?.rows.get(matchId);
      if (found === undefined || row === undefined) {
        lots.push({ lot, listed: found === undefined ? UNKNOWN : false, ...NOT_READ });
        continue;
      }
      if (isText(found.keyId)) keys.add(found.keyId);
      folders.push(join(pack, 'sessions', matchId));
      lots.push({ lot, built: isText(found.built) ? found.built : UNKNOWN, listed: true, ...termsOf(row) });
    }
    const held = entries.length > 0 || sent.length > 0;
    if (!held || (keys.size > 0 && !keys.has(keyId))) {
      if (held) underAnotherKey += 1;
      rows.push(unknownRow(matchId));
      continue;
    }
    for (const lot of new Set(sent.map((row) => row.lot))) if (!lots.some((known) => known.lot === lot)) lots.push({ lot, listed: UNKNOWN, ...NOT_READ });
    // An objection names a store id or the bare id its transcript carries (a Codex session), as the build reads it.
    const sessions = [...new Set([...entries, ...sent].map(({ session }) => session))];
    const covering: Withdrawal[] = objections.filter(({ session }) => session !== undefined && sessions.some((own) => own === session || bareOf(own) === session)).map(({ received, scope }): Withdrawal => ({ received, scope, basis: 'session' }));
    const texts = names.length === 0 ? [] : await textsOf(folders);
    for (const { wanted, objection } of names) if (texts?.some((text) => text.includes(wanted)) === true) covering.push({ received: objection.received, scope: objection.scope, basis: 'name' });
    const withdrawn = covering.length === 0 && texts === undefined ? UNKNOWN : covering;
    const delivered = sent.map(({ lot, recipient, license, deliveredAt }): DeliveryStatus => ({ lot, recipient, license, deliveredAt }));
    rows.push({
      matchId,
      state: withdrawn !== UNKNOWN && withdrawn.length > 0 ? 'withdrawn' : delivered.length > 0 ? 'delivered' : 'built',
      keyVerified: keys.has(keyId),
      lots,
      deliveries: delivered,
      withdrawn,
      erasure: delivered.length === 0 || (withdrawn !== UNKNOWN && withdrawn.length === 0) ? 'none-due' : UNKNOWN,
      covenant: UNKNOWN,
    });
  }
  return { keyId, rows, underAnotherKey };
};

const HEADER = ['match id', 'state', 'lots', 'delivered to', 'withdrawn', 'recipient erasure', 'covenant'];

const cellsOf = (row: LicenseStatus): string[] => [
  row.matchId,
  row.state === 'unknown' || row.keyVerified ? row.state : `${row.state} (key not verified)`,
  row.lots.map(({ lot, listed }) => (listed === false ? `${lot} (not in the pack now)` : lot)).join('; ') || '-',
  row.deliveries.map(({ recipient, lot, license, deliveredAt }) => `${recipient} (${lot}, ${license}, ${deliveredAt})`).join('; ') || '-',
  row.withdrawn === UNKNOWN ? UNKNOWN : row.withdrawn.map(({ received, scope, basis }) => `${received} ${scope} (${basis})`).join('; ') || '-',
  row.erasure,
  row.covenant,
];

/** The rows as a table, columns padded to their widest cell, then one line of counts. */
export const tableOf = (report: StatusReport): string => {
  const lines = [HEADER, ...report.rows.map(cellsOf)];
  const widths = HEADER.map((_name, at) => Math.max(...lines.map((cells) => (cells[at] ?? '').length)));
  const unknown = report.rows.filter((row) => row.state === 'unknown').length;
  const count = `${String(report.rows.length)} match ${report.rows.length === 1 ? 'id' : 'ids'} under key id ${report.keyId}: ${String(unknown)} unknown${report.underAnotherKey > 0 ? `, ${String(report.underAnotherKey)} of them recorded under another key id` : ''}.`;
  return [...lines.map((cells) => cells.map((cell, at) => cell.padEnd(widths[at] ?? 0)).join('  ').trimEnd()), count].join('\n');
};

export interface Io {
  print: (text: string) => void;
}

const VALUED = new Set(['--ids', '--key-id', '--operator']);
const MATCH_ID = /^[0-9a-f]{64}$/i;
const KEY_ID = /^[0-9a-f]{16}$/;

interface Asked {
  values: Map<string, string>;
  json: boolean;
  matchId: string | undefined;
}

/** The call as asked, or why it cannot be read. A refusal never repeats a word it did not know: that word may be a key or a session id typed in the wrong place. */
const askedOf = (argv: readonly string[]): Asked | string => {
  const asked: Asked = { values: new Map(), json: false, matchId: undefined };
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at] ?? '';
    if (word === '--json') asked.json = true;
    else if (VALUED.has(word)) {
      const value = argv[at + 1];
      if (value === undefined) return `Missing the value of ${word}.`;
      asked.values.set(word, value);
      at += 1;
    } else if (word.startsWith('--')) return 'Unknown option.';
    else if (asked.matchId === undefined) asked.matchId = word;
    else return 'Give one match id, or a file of them with --ids.';
  }
  return asked;
};

const idsIn = async (file: string): Promise<string[]> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isAbsent(error)) throw new PackError('The --ids file is missing.');
    throw error;
  }
  const ids = text.split(String.fromCharCode(10)).map((row, at): [string, number] => [row.trim(), at + 1]).filter(([row]) => row !== '');
  const wrong = ids.find(([row]) => !MATCH_ID.test(row));
  if (wrong !== undefined) throw new PackError(`Line ${String(wrong[1])} of the --ids file is not a match id (64 hex characters).`);
  if (ids.length === 0) throw new PackError('The --ids file names no match id.');
  return ids.map(([row]) => row);
};

/** 0 when the question was answered (an unknown id is an answer), 2 on a usage error or a file that cannot be read as what it should be. */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const usage = (reason: string): number => {
    io.print(`${reason}\n${USAGE}`);
    return 2;
  };
  const asked = askedOf(argv);
  if (typeof asked === 'string') return usage(asked);
  const [ids, keyId, operator] = ['--ids', '--key-id', '--operator'].map((flag) => asked.values.get(flag));
  if ((asked.matchId === undefined) === (ids === undefined)) return usage('Give a match id, or a file of them with --ids.');
  if (keyId === undefined) return usage('Missing --key-id.');
  if (operator === undefined) return usage('Missing --operator.');
  if (!KEY_ID.test(keyId)) return usage('--key-id takes the key\'s id, the 16 hex characters pack.json holds as keyId, never the key.');
  if (asked.matchId !== undefined && !MATCH_ID.test(asked.matchId)) return usage('A match id is 64 hex characters.');
  try {
    const matchIds = asked.matchId !== undefined ? [asked.matchId] : await idsIn(ids ?? '');
    const report = await licenseStatus(operator, keyId, matchIds.map((matchId) => matchId.toLowerCase()));
    io.print(asked.json ? JSON.stringify(report, null, 2) : tableOf(report));
    return 0;
  } catch (error) {
    if (!(error instanceof PackError)) throw error;
    io.print(error.message);
    return 2;
  }
};
