// `npm run erase -w packages/pool -- <what> ...`: the operator's erasure command (docs/pool.md, "Erasure"). It changes nothing until `--confirm` is given; without it, it says what it would do.
import { depositExists, eraseAccount, eraseLeakedSecret, eraseRawObject, type Erased, type EraseStore } from './erase.js';
import { wranglerStore, type Target, type Wrangler } from './erase-wrangler.js';

export const USAGE = [
  'Usage: erase <what> [options]',
  '  raw <r2-key>                        delete one raw object (raw/<account>/<sha256>), tombstone it, and mark its ledger row',
  '  row --account <id> --id <session>   replace a deposit row that holds a leaked secret with a marker and tombstone it',
  '        [--value-stdin]               also read the leaked value from stdin: scrub it from aggregates, erase every row that holds it,',
  '                                      and make ingest refuse it again (only its SHA-256 is kept)',
  '  account --account <id>              erase one account\'s deposit rows and raw objects, scrub its machines\' labels and allow lists, delete its repo keys, deposit hours, and contributor records, and disable its tokens (a lawful request); the shared totals stay',
  'Options: --confirm (without it nothing is changed), --local (the local wrangler state instead of the account\'s)',
  `Runs with the wrangler login already on this machine against D1 database "oars-pool" and R2 bucket "oars-pool-raw".`,
].join('\n');

export interface Io {
  /** The leaked value, read to the end of stdin. */
  stdin: () => Promise<string>;
  print: (text: string) => void;
  wrangler: Wrangler;
  now: () => Date;
}

const TARGET = { database: 'oars-pool', bucket: 'oars-pool-raw' } as const;

interface Options {
  positional: string[];
  account?: string;
  id?: string;
  valueStdin: boolean;
  confirm: boolean;
  local: boolean;
}

const optionsOf = (argv: readonly string[]): Options | string => {
  const options: Options = { positional: [], valueStdin: false, confirm: false, local: false };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? '';
    if (arg === '--confirm') options.confirm = true;
    else if (arg === '--local') options.local = true;
    else if (arg === '--value-stdin') options.valueStdin = true;
    else if (arg === '--account' || arg === '--id') {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
      options[arg === '--account' ? 'account' : 'id'] = value;
      at += 1;
    } else if (arg.startsWith('--')) return `unknown option ${arg}`;
    else options.positional.push(arg);
  }
  return options;
};

const summary = (erased: Erased): string => JSON.stringify({ rowsErased: erased.rows, objectsErased: erased.objects });

/** Runs the command; answers the exit code. */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const options = optionsOf(argv);
  if (typeof options === 'string') {
    io.print(`${options}\n${USAGE}`);
    return 2;
  }
  const [what, key, ...extra] = options.positional;
  const target: Target = { ...TARGET, local: options.local };
  const store: EraseStore = wranglerStore(io.wrangler, target);
  const where = options.local ? 'local state' : 'the remote pool';
  try {
    if (what === 'raw' && key !== undefined && extra.length === 0 && options.account === undefined) {
      if (!options.confirm) return plan(io, `delete raw object ${key} from ${where}`);
      io.print(summary(await eraseRawObject(store, key, io.now())));
      return 0;
    }
    if (what === 'row' && options.positional.length === 1 && options.account !== undefined && options.id !== undefined) {
      if (!options.confirm) {
        // The dry run reads the row, so a mistyped selector shows here and not as a tombstone for a session that was never deposited.
        const found = await depositExists(store, options.account, options.id);
        if (!found && !options.valueStdin) {
          io.print(`No deposit row for account ${options.account}, session ${options.id} in ${where}. Nothing would be erased: check the selector.`);
          return 1;
        }
        return plan(io, `erase deposit ${options.id} of account ${options.account} in ${where} (${found ? 'the row exists' : 'no such row: only the value would be erased'})${options.valueStdin ? ', and scrub the value read from stdin from every deposit row, motif, cell, and contributor record that holds it, and drop the unfinished staged parts of each account that held it' : ''}`);
      }
      const value = options.valueStdin ? (await io.stdin()).replace(/\r?\n$/, '') : undefined;
      io.print(summary(await eraseLeakedSecret(store, { account: options.account, id: options.id, ...(value === undefined ? {} : { value }) }, io.now())));
      return 0;
    }
    if (what === 'account' && options.positional.length === 1 && options.account !== undefined && options.id === undefined) {
      if (!options.confirm) return plan(io, `erase every deposit row and raw object of account ${options.account} in ${where}, scrub the label and allow list of its machines, delete its repo keys, deposit hours, and contributor records, and disable its tokens`);
      io.print(summary(await eraseAccount(store, options.account, io.now())));
      return 0;
    }
  } catch (error) {
    io.print(error instanceof Error ? error.message : 'the erasure failed');
    return 1;
  }
  io.print(USAGE);
  return 2;
};

const plan = (io: Io, action: string): number => {
  io.print(`Would ${action}. Nothing was changed: run again with --confirm.`);
  return 0;
};
