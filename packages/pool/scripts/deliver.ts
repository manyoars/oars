// The first sale's hand-over register (plan S5, 2.2; P98 (10) to (12)): which recipient received which session of a sample pack, under which match id.
// It writes local records only, beside the owners file, and sends nothing: Art. 15(1)(c) and 19 need the recipients named, Art. 21(1) needs an objection checked before anything is handed over.
import type { Dirent } from 'node:fs';
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { bareOf, decodedStrings, insideRepository, isAbsent, isText, keyIdOf, PackError, readObjections, squashed } from './sample-pack.js';

export const USAGE = [
  'Usage: deliver --pack <dir> --recipient <name> --license <id> --buyer-key <key> --owners <file>',
  '       deliver recipients <session id or person\'s name> --owners <file>',
  '  --pack <dir>         a pack built by sample-pack, outside every git repository',
  '  --recipient <name>   the buyer\'s legal name as on the term sheet',
  '  --license <id>       the term sheet\'s version, so the rights the recipient holds are the ones it signed',
  '  --buyer-key <key>    the key the pack was built under (checked against pack.json; it is never written down)',
  '  --owners <file>      the owners file; deliveries.jsonl, index.jsonl, and objections.jsonl sit beside it',
  'deliver appends one row per session to deliveries.jsonl, when you send the pack: it sends nothing itself, and it refuses a pack built under other objections than objections.jsonl holds now (rebuild, then deliver).',
  'recipients prints each recipient of a session, or of every session whose text names the person, with the match id that recipient holds it under (Art. 15(1)(c), 19).',
].join('\n');

export const DELIVERIES_FILE = 'deliveries.jsonl';

/** One line of `deliveries.jsonl` (plan 2.2): the buyer key is named by `keyId`, never held, and `session` is the store's id, which never leaves the machine. */
export interface Delivery {
  recipient: string;
  lot: string;
  keyId: string;
  matchId: string;
  session: string;
  deliveredAt: string;
  license: string;
}

export interface DeliverOptions {
  pack: string;
  recipient: string;
  license: string;
  buyerKey: string;
  owners: string;
  /** When the recipient got the pack: the send, not the build. A test injects its own. */
  now?: (() => Date) | undefined;
}

export const fieldOf = (value: unknown, name: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  const found: unknown = Reflect.get(value, name);
  return found;
};

const linesOf = async (file: string): Promise<unknown[]> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isAbsent(error)) return [];
    throw error;
  }
  return text.split(String.fromCharCode(10)).filter((row) => row.trim() !== '').map((row): unknown => JSON.parse(row));
};

export const deliveriesOf = async (dir: string): Promise<Delivery[]> =>
  (await linesOf(join(dir, DELIVERIES_FILE))).flatMap((row): Delivery[] => {
    const [recipient, lot, keyId, matchId, session, deliveredAt, license] = ['recipient', 'lot', 'keyId', 'matchId', 'session', 'deliveredAt', 'license'].map((name) => fieldOf(row, name));
    if (!isText(recipient) || !isText(lot) || !isText(keyId) || !isText(matchId) || !isText(session) || !isText(deliveredAt) || !isText(license)) throw new PackError(`${DELIVERIES_FILE} holds a line that is not a delivery.`);
    return [{ recipient, lot, keyId, matchId, session, deliveredAt, license }];
  });

export interface IndexEntry {
  pack: string;
  session: string;
  matchId: string;
}

export const indexOf = async (dir: string): Promise<IndexEntry[]> =>
  (await linesOf(join(dir, 'index.jsonl'))).flatMap((row): IndexEntry[] => {
    const [pack, session, matchId] = ['pack', 'session', 'matchId'].map((name) => fieldOf(row, name));
    return isText(pack) && isText(session) && isText(matchId) ? [{ pack, session, matchId }] : [];
  });

/** A lot's name is its pack folder's name: what `deliveries.jsonl` records, and what `license-status` reads the index by. */
export const lotOf = (pack: string): string => pack.split(/[\\/]/).pop() ?? pack;

const textOf = async (file: string, what: string): Promise<string> => {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isAbsent(error)) throw new PackError(`${what} is missing: this folder is not a pack built by sample-pack.`);
    throw error;
  }
};

const jsonOf = async (file: string, what: string): Promise<unknown> => JSON.parse(await textOf(file, what));

/** What `deliver` wrote, and how many (recipient, lot, match id) rows the register already held, which it leaves alone. */
export interface Delivered {
  rows: Delivery[];
  skipped: number;
}

/** Appends one row per session of the pack for `recipient`, all or none: every refusal comes before the first byte is written. */
export const deliver = async (options: DeliverOptions): Promise<Delivered> => {
  const recipient = options.recipient.trim();
  const license = options.license.trim();
  if (recipient === '') throw new PackError('The recipient must be the buyer\'s legal name.');
  if (license === '') throw new PackError('The license must be the term sheet\'s version.');
  const pack = resolve(options.pack);
  const dir = dirname(resolve(options.owners));
  if (insideRepository(pack)) throw new PackError('The pack folder is inside a git repository. Deliver a pack kept outside every repository.');
  if (insideRepository(dir)) throw new PackError('The owners file is inside a git repository, and the delivery register is written beside it. Move the owners file outside every repository.');
  const record = await jsonOf(join(pack, 'pack.json'), 'pack.json');
  const [built, keyId] = [fieldOf(record, 'built'), fieldOf(record, 'keyId')];
  if (!isText(built) || Number.isNaN(Date.parse(built))) throw new PackError('pack.json has no build time.');
  if (keyId !== keyIdOf(options.buyerKey)) throw new PackError('The buyer key is not the one this pack was built under (or the pack predates the key id in pack.json). Rebuild the pack under this key.');
  // Art. 21(1): the pack records the hash of the objections it was built under, and an objection recorded since (whatever its `received` says) was never applied to it, so it goes out only after a rebuild.
  const recorded = fieldOf(record, 'objections');
  if (recorded !== (await readObjections(dir)).hash) throw new PackError(`${recorded === undefined ? 'This pack predates the objections hash in pack.json' : 'The objections changed since the build'}: rebuild the pack, then deliver.`);
  const sessions = new Map((await indexOf(dir)).map(({ matchId, session }) => [matchId, session]));
  const matchIds = (await textOf(join(pack, 'manifest.jsonl'), 'manifest.jsonl')).split(String.fromCharCode(10)).filter((row) => row.trim() !== '').map((row): string => {
    const matchId = fieldOf(JSON.parse(row), 'matchId');
    if (!isText(matchId)) throw new PackError('manifest.jsonl holds a row with no match id.');
    return matchId;
  });
  const deliveredAt = (options.now ?? ((): Date => new Date()))().toISOString();
  const lot = lotOf(pack);
  const held = new Set((await deliveriesOf(dir)).filter((row) => row.recipient === recipient && row.lot === lot).map((row) => row.matchId));
  const rows = matchIds.filter((matchId) => !held.has(matchId)).map((matchId): Delivery => {
    const session = sessions.get(matchId);
    if (session === undefined) throw new PackError(`The operator index (index.jsonl beside the owners file) has no session for match id ${matchId}, so the delivery could not be recorded.`);
    return { recipient, lot, keyId, matchId, session, deliveredAt, license };
  });
  if (rows.length > 0) await appendFile(join(dir, DELIVERIES_FILE), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  return { rows, skipped: matchIds.length - rows.length };
};

/** The deliveries that hold a session, or every session whose delivered text names the person (read from the packs the index lists, which are local folders). Empty when nothing was delivered. */
export const recipientsOf = async (owners: string, query: string): Promise<Delivery[]> => {
  const dir = dirname(resolve(owners));
  const [deliveries, index] = [await deliveriesOf(dir), await indexOf(dir)];
  const named = new Set<string>();
  // An objection may name a Codex session by its transcript id, so a query may too: the store id and its bare form are one session.
  const known = [...deliveries, ...index].map(({ session }) => session).filter((session) => session === query || bareOf(session) === query);
  if (known.length > 0) for (const session of known) named.add(session);
  else {
    const wanted = squashed(query.trim());
    for (const entry of index) {
      let found: Dirent[];
      try {
        found = await readdir(join(entry.pack, 'sessions', entry.matchId), { recursive: true, withFileTypes: true });
      } catch (error) {
        // A pack folder removed since the delivery has nothing to read; any other failure (EACCES) must not read as "no recipient".
        if (isAbsent(error)) continue;
        throw error;
      }
      for (const file of found.filter((item) => item.isFile())) {
        // Raw text and decoded JSON strings: an escape in the file can hide the name from the raw bytes.
        const text = await readFile(join(file.parentPath, file.name), 'utf8');
        if ([text, ...decodedStrings(text)].some((candidate) => squashed(candidate).includes(wanted))) named.add(entry.session);
      }
    }
  }
  return deliveries.filter(({ session }) => named.has(session));
};

export interface Io {
  print: (text: string) => void;
  now?: (() => Date) | undefined;
}

const VALUED = new Set(['--pack', '--recipient', '--license', '--buyer-key', '--owners']);

const flagsOf = (argv: readonly string[]): Map<string, string> | string => {
  const values = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 2) {
    const [flag, value] = [argv[at] ?? '', argv[at + 1]];
    if (!VALUED.has(flag) || value === undefined) return `Unknown or incomplete option: ${flag}`;
    values.set(flag, value);
  }
  return values;
};

/** 0 when the rows were written or the question answered, 2 on a usage error or a refusal (nothing written). */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const asking = argv[0] === 'recipients';
  const query = asking ? argv[1] : undefined;
  const flags = flagsOf(asking ? argv.slice(2) : argv);
  const owners = typeof flags === 'string' ? undefined : flags.get('--owners');
  const [pack, recipient, license, buyerKey] = typeof flags === 'string' ? [] : ['--pack', '--recipient', '--license', '--buyer-key'].map((flag) => flags.get(flag));
  const usage = (reason: string): number => {
    io.print(`${reason}\n${USAGE}`);
    return 2;
  };
  if (typeof flags === 'string') return usage(flags);
  if (owners === undefined) return usage('Missing --owners.');
  try {
    if (asking) {
      if (query === undefined || query.trim() === '') return usage('Missing the session id or the person\'s name.');
      const found = await recipientsOf(owners, query);
      io.print(found.length === 0 ? 'No recipient holds this session: nothing in deliveries.jsonl names it.' : found.map((row) => [row.recipient, `match id ${row.matchId}`, `lot ${row.lot}`, `delivered ${row.deliveredAt}`, `license ${row.license}`, `session ${row.session}`].join('\t')).join('\n'));
      return 0;
    }
    if (pack === undefined || recipient === undefined || license === undefined || buyerKey === undefined) return usage('Missing a required option.');
    const { rows, skipped } = await deliver({ pack, recipient, license, buyerKey, owners, now: io.now });
    io.print(`Recorded ${String(rows.length)} sessions of ${rows[0]?.lot ?? pack} as delivered to ${recipient.trim()} in ${DELIVERIES_FILE} (${String(skipped)} already recorded, skipped). Nothing was sent: send the pack yourself.`);
    return 0;
  } catch (error) {
    if (!(error instanceof PackError) && !(error instanceof SyntaxError)) throw error;
    io.print(error.message);
    return 2;
  }
};
