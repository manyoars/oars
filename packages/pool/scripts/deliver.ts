// The first sale's hand-over register (plan S5, 2.2; P98 (10) to (12)): which recipient received which session of a sample pack, under which match id.
// It writes local records only, beside the owners file, and sends nothing: Art. 15(1)(c) and 19 need the recipients named, Art. 21(1) needs an objection checked before anything is handed over.
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { insideRepository, keyIdOf, PackError, readObjections } from './sample-pack.js';

export const USAGE = [
  'Usage: deliver --pack <dir> --recipient <name> --license <id> --buyer-key <key> --owners <file>',
  '       deliver recipients <session id or person\'s name> --owners <file>',
  '  --pack <dir>         a pack built by sample-pack, outside every git repository',
  '  --recipient <name>   the buyer\'s legal name as on the term sheet',
  '  --license <id>       the term sheet\'s version, so the rights the recipient holds are the ones it signed',
  '  --buyer-key <key>    the key the pack was built under (checked against pack.json; it is never written down)',
  '  --owners <file>      the owners file; deliveries.jsonl, index.jsonl, and objections.jsonl sit beside it',
  'deliver appends one row per session to deliveries.jsonl, when you send the pack: it sends nothing itself, and it refuses a pack built before the newest objection.',
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

const isText = (value: unknown): value is string => typeof value === 'string';

const fieldOf = (value: unknown, name: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  const found: unknown = Reflect.get(value, name);
  return found;
};

const absent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const linesOf = async (file: string): Promise<unknown[]> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
  return text.split(String.fromCharCode(10)).filter((row) => row.trim() !== '').map((row): unknown => JSON.parse(row));
};

const deliveriesOf = async (dir: string): Promise<Delivery[]> =>
  (await linesOf(join(dir, DELIVERIES_FILE))).flatMap((row): Delivery[] => {
    const [recipient, lot, keyId, matchId, session, deliveredAt, license] = ['recipient', 'lot', 'keyId', 'matchId', 'session', 'deliveredAt', 'license'].map((name) => fieldOf(row, name));
    if (!isText(recipient) || !isText(lot) || !isText(keyId) || !isText(matchId) || !isText(session) || !isText(deliveredAt) || !isText(license)) throw new PackError(`${DELIVERIES_FILE} holds a line that is not a delivery.`);
    return [{ recipient, lot, keyId, matchId, session, deliveredAt, license }];
  });

interface IndexEntry {
  pack: string;
  session: string;
  matchId: string;
}

const indexOf = async (dir: string): Promise<IndexEntry[]> =>
  (await linesOf(join(dir, 'index.jsonl'))).flatMap((row): IndexEntry[] => {
    const [pack, session, matchId] = ['pack', 'session', 'matchId'].map((name) => fieldOf(row, name));
    return isText(pack) && isText(session) && isText(matchId) ? [{ pack, session, matchId }] : [];
  });

const jsonOf = async (file: string, what: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (absent(error)) throw new PackError(`${what} is missing: this folder is not a pack built by sample-pack.`);
    throw error;
  }
};

/** Appends one row per session of the pack for `recipient`, all or none: every refusal comes before the first byte is written. */
export const deliver = async (options: DeliverOptions): Promise<Delivery[]> => {
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
  // Art. 21(1): an objection that arrived after the build was never applied to this pack, so it goes out only after a rebuild.
  const newest = (await readObjections(dir)).reduce<string | undefined>((latest, { received }) => (latest === undefined || Date.parse(received) > Date.parse(latest) ? received : latest), undefined);
  if (newest !== undefined && Date.parse(newest) > Date.parse(built)) throw new PackError(`This pack was built before the newest objection (received ${newest}). Rebuild it, then deliver.`);
  const sessions = new Map((await indexOf(dir)).map(({ matchId, session }) => [matchId, session]));
  const matchIds = (await readFile(join(pack, 'manifest.jsonl'), 'utf8')).split(String.fromCharCode(10)).filter((row) => row.trim() !== '').map((row): string => {
    const matchId = fieldOf(JSON.parse(row), 'matchId');
    if (!isText(matchId)) throw new PackError('manifest.jsonl holds a row with no match id.');
    return matchId;
  });
  const deliveredAt = (options.now ?? ((): Date => new Date()))().toISOString();
  const lot = pack.split(/[\\/]/).pop() ?? pack;
  const rows = matchIds.map((matchId): Delivery => {
    const session = sessions.get(matchId);
    if (session === undefined) throw new PackError(`The operator index (index.jsonl beside the owners file) has no session for match id ${matchId}, so the delivery could not be recorded.`);
    return { recipient, lot, keyId, matchId, session, deliveredAt, license };
  });
  await appendFile(join(dir, DELIVERIES_FILE), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  return rows;
};

const squashed = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

/** The deliveries that hold a session, or every session whose delivered text names the person (read from the packs the index lists, which are local folders). Empty when nothing was delivered. */
export const recipientsOf = async (owners: string, query: string): Promise<Delivery[]> => {
  const dir = dirname(resolve(owners));
  const [deliveries, index] = [await deliveriesOf(dir), await indexOf(dir)];
  const named = new Set<string>();
  if ([...deliveries, ...index].some(({ session }) => session === query)) named.add(query);
  else {
    const wanted = squashed(query.trim());
    for (const entry of index) {
      let files: string[];
      try {
        files = await readdir(join(entry.pack, 'sessions', entry.matchId), { recursive: true });
      } catch (error) {
        if (absent(error)) continue;
        throw error;
      }
      for (const file of files) {
        let text: string;
        try {
          text = await readFile(join(entry.pack, 'sessions', entry.matchId, file), 'utf8');
        } catch {
          continue;
        }
        if (squashed(text).includes(wanted)) named.add(entry.session);
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
    const written = await deliver({ pack, recipient, license, buyerKey, owners, now: io.now });
    io.print(`Recorded ${String(written.length)} sessions of ${written[0]?.lot ?? pack} as delivered to ${recipient.trim()} in ${DELIVERIES_FILE}. Nothing was sent: send the pack yourself.`);
    return 0;
  } catch (error) {
    if (!(error instanceof PackError) && !(error instanceof SyntaxError)) throw error;
    io.print(error.message);
    return 2;
  }
};
