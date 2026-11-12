// The erasure-notice register (GDPR Art. 17(2) and 19): that a recipient was told to erase a row that was withdrawn after it was delivered, and that it confirmed.
// `notices.jsonl` sits beside the owners file and is append-only: a confirmation is a second line for the same (recipient, match id), never an edit of the first.
// It records what the operator did and sends nothing. A line carries a recipient and a match id, both of which the recipient already holds, and never a session id, an owner, a project folder, a pack path, or a key.
import { appendFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DELIVERIES_FILE, deliveriesOf, fieldOf } from './deliver.js';
import { idsIn, MATCH_ID, sound } from './operator-files.js';
import { insideRepository, isAbsent, isText, PackError } from './sample-pack.js';

export const USAGE = [
  'Usage: notices sent <match id> --recipient <name> --operator <dir>',
  '       notices sent --ids <file> --recipient <name> --operator <dir>',
  '       notices confirmed (<match id> | --ids <file>) --recipient <name> --operator <dir>',
  '  sent               record that the recipient was told to erase these rows (Art. 17(2), 19)',
  '  confirmed          record that the recipient confirmed it erased them; each needs a notice recorded first',
  '  <match id>         the 64 hex characters the recipient holds the session under',
  '  --ids <file>       a file of match ids, one per line',
  '  --recipient <name> the buyer\'s legal name, as deliveries.jsonl holds it: every id needs a delivery to this recipient',
  '  --operator <dir>   the folder the owners file sits in, outside every git repository; notices.jsonl is appended there',
  'It appends to notices.jsonl and sends nothing: tell the recipient yourself. All the lines are written or none, and a line already recorded is skipped and counted.',
].join('\n');

export const NOTICES_FILE = 'notices.jsonl';

/** One line of `notices.jsonl`. A confirmation repeats the notice's `sentAt` and adds `confirmedAt`, so each line stands alone. */
export interface Notice {
  recipient: string;
  matchId: string;
  sentAt: string;
  confirmedAt: string | undefined;
}

/** The register in file order; empty when no notice was ever recorded. A line that is not a notice is named by its number and never quoted. */
export const noticesOf = async (dir: string): Promise<Notice[]> => {
  let text: string;
  try {
    text = await readFile(join(dir, NOTICES_FILE), 'utf8');
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
  const lines = text.split(String.fromCharCode(10)).map((row, at): [string, number] => [row.trim(), at + 1]).filter(([row]) => row !== '');
  return lines.map(([row, at]): Notice => {
    let value: unknown;
    try {
      value = JSON.parse(row);
    } catch {
      throw new PackError(`${NOTICES_FILE} holds a line that is not JSON.`);
    }
    const [recipient, matchId, sentAt, confirmedAt] = ['recipient', 'matchId', 'sentAt', 'confirmedAt'].map((name) => fieldOf(value, name));
    if (!isText(recipient) || !isText(matchId) || !isText(sentAt) || (confirmedAt !== undefined && !isText(confirmedAt))) throw new PackError(`Line ${String(at)} of ${NOTICES_FILE} is not a notice.`);
    return { recipient, matchId, sentAt, confirmedAt };
  });
};

/** Where a (recipient, match id) stands: its newest line, or nothing when the recipient was never told. */
export const noticeOf = (notices: readonly Notice[], recipient: string, matchId: string): Notice | undefined => notices.filter((notice) => notice.recipient === recipient && notice.matchId === matchId).at(-1);

export interface RecordOptions {
  operator: string;
  recipient: string;
  matchIds: readonly string[];
  /** False records that the notice was sent, true that the recipient confirmed it. */
  confirmed: boolean;
  /** When the operator did it. A test injects its own. */
  now?: (() => Date) | undefined;
}

/** What `recordNotices` wrote, and how many (recipient, match id) lines the register already held, which it leaves alone. */
export interface Recorded {
  rows: Notice[];
  skipped: number;
}

const idsOf = (ids: readonly string[]): string => `match id${ids.length === 1 ? '' : 's'} ${ids.join(', ')}`;

/** Appends one line per match id, all or none: every refusal comes before the first byte is written. The recipient is trimmed by the caller. */
export const recordNotices = async (options: RecordOptions): Promise<Recorded> => {
  const dir = resolve(options.operator);
  if (insideRepository(dir)) throw new PackError('The operator folder is inside a git repository, and the notice register is written there. Move the owners file and its folder outside every repository.');
  const { recipient } = options;
  const delivered = new Set((await sound(DELIVERIES_FILE, deliveriesOf(dir))).filter((row) => row.recipient === recipient).map((row) => row.matchId));
  const ids = [...new Set(options.matchIds)];
  const undelivered = ids.filter((matchId) => !delivered.has(matchId));
  // The ids are 64 hex characters (checked at the command), so naming them repeats nothing private.
  if (undelivered.length > 0) throw new PackError(`No delivery to this recipient holds ${idsOf(undelivered)}: record a notice only for a row this recipient received.`);
  const notices = await noticesOf(dir);
  const at = (options.now ?? ((): Date => new Date()))().toISOString();
  const rows: Notice[] = [];
  const unnoticed: string[] = [];
  let skipped = 0;
  for (const matchId of ids) {
    const current = noticeOf(notices, recipient, matchId);
    if (!options.confirmed) {
      if (current === undefined) rows.push({ recipient, matchId, sentAt: at, confirmedAt: undefined });
      else skipped += 1;
    } else if (current === undefined) unnoticed.push(matchId);
    else if (current.confirmedAt === undefined) rows.push({ ...current, confirmedAt: at });
    else skipped += 1;
  }
  if (unnoticed.length > 0) throw new PackError(`No erasure notice to this recipient is recorded for ${idsOf(unnoticed)}: record the notice first.`);
  if (rows.length > 0) await appendFile(join(dir, NOTICES_FILE), rows.map((row) => `${JSON.stringify(row)}${String.fromCharCode(10)}`).join(''));
  return { rows, skipped };
};

export interface Io {
  print: (text: string) => void;
  now?: (() => Date) | undefined;
}

const VALUED = new Set(['--ids', '--recipient', '--operator']);

interface Asked {
  values: Map<string, string>;
  matchId: string | undefined;
}

/** The call as asked, or why it cannot be read. A refusal never repeats a word it did not know: that word may be a key or a session id typed in the wrong place. */
const askedOf = (argv: readonly string[]): Asked | string => {
  const asked: Asked = { values: new Map(), matchId: undefined };
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at] ?? '';
    if (VALUED.has(word)) {
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

/** 0 when the lines were written or all were already recorded, 2 on a usage error or a refusal (nothing written). */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const usage = (reason: string): number => {
    io.print(`${reason}\n${USAGE}`);
    return 2;
  };
  const kind = argv[0];
  if (kind !== 'sent' && kind !== 'confirmed') return usage('Say whether the notice was sent or confirmed.');
  const asked = askedOf(argv.slice(1));
  if (typeof asked === 'string') return usage(asked);
  const [ids, recipient, operator] = ['--ids', '--recipient', '--operator'].map((flag) => asked.values.get(flag));
  if ((asked.matchId === undefined) === (ids === undefined)) return usage('Give a match id, or a file of them with --ids.');
  if (recipient === undefined || recipient.trim() === '') return usage('Missing --recipient.');
  if (operator === undefined) return usage('Missing --operator.');
  if (asked.matchId !== undefined && !MATCH_ID.test(asked.matchId)) return usage('A match id is 64 hex characters.');
  try {
    const matchIds = asked.matchId !== undefined ? [asked.matchId] : await idsIn(ids ?? '');
    const confirmed = kind === 'confirmed';
    const { rows, skipped } = await recordNotices({ operator, recipient: recipient.trim(), matchIds: matchIds.map((matchId) => matchId.toLowerCase()), confirmed, now: io.now });
    const what = confirmed ? `erasure confirmation${rows.length === 1 ? '' : 's'} from` : `erasure notice${rows.length === 1 ? '' : 's'} as sent to`;
    io.print(`Recorded ${String(rows.length)} ${what} ${recipient.trim()} in ${NOTICES_FILE} (${String(skipped)} already recorded, skipped). Nothing was sent: ${confirmed ? 'this only records what the recipient told you' : 'send the notice yourself'}.`);
    return 0;
  } catch (error) {
    if (!(error instanceof PackError)) throw error;
    io.print(error.message);
    return 2;
  }
};
