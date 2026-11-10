// `npm run erase -w packages/pool -- <what> ...`: the operator's erasure command (docs/pool.md, "Erasure"). It changes nothing until `--confirm` is given; without it, it says what it would do.
import { closeAccount, depositExists, eraseAccount, eraseLeakedSecret, eraseRawObject, findDepositsContaining, findRawContaining, restrictAccount, type Erased, type EraseStore } from './erase.js';
import { exportAccount, type ExportFolder } from './export-account.js';
import { rawConsentOf, withdrawRaw } from './withdraw-account.js';
import { wranglerStore, type Lister, type ObjectFiles, type Target, type Wrangler } from './erase-wrangler.js';

export { nodeFiles, nodeFolder } from './erase-files.js';
export { r2Lister } from './erase-r2-list.js';

export const USAGE = [
  'Usage: erase <what> [options]',
  '  raw <r2-key>                        delete one raw object (raw/<account>/<sha256>), tombstone it, and mark its ledger row',
  '  raw --contains --value-stdin        find the raw objects that hold a text (a person named in a deposit), read from stdin: it prints each object\'s key, account, and size and deletes nothing;',
  '        (--account <id> | --all-accounts)   exactly one; the keys it prints go to `raw <r2-key>`',
  '  row --contains --value-stdin        find the deposit rows, motifs, cells, and contributor records that hold a text (a person named in a deposit), read from stdin: it prints the account, session, and day of each deposit row and the counts of the rest, and changes nothing;',
  '        (--account <id> | --all-accounts)   exactly one; the sessions it prints go to `row --account <id> --id <session> --value-stdin`',
  '  row --account <id> --id <session>   replace a deposit row that holds a leaked secret with a marker and tombstone it',
  '        [--value-stdin]               also read the leaked value from stdin: scrub it from aggregates, erase every row that holds it,',
  '                                      and make ingest refuse it again (only its SHA-256 is kept)',
  '  account --account <id>              erase one account\'s deposit rows and raw objects, scrub its machines\' labels and allow lists, delete its repo keys, deposit hours, and contributor records, and disable its tokens, then rewrite each telemetry batch within retention that names it (needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY, to list the bucket); the shared totals stay',
  '  close --account <id>               close one account (covenant 6.1): revoke its tokens and machine keys and record when it closed, so sign-in, enrollment, and activation refuse it; its Deposits, raw objects, and the shared totals stay',
  '  restrict --account <id> [--lift]   restrict one account on the person\'s request (GDPR Art. 18), or lift it: it keeps its data stored and takes nothing more (deposits, raw parts, machine enrollment, and club joins are refused, its rows leave every club board, its telemetry batches roll into no row, and it counts toward the holder count of no cell); its export, an erasure, and the sweeps still run, and nothing is revoked',
  '  export --account <id> --out <folder> [--raw]   write the export of the account (the pages `oars pool export` saves, as account-export-NNNN.json) to the folder, and with --raw each raw object not erased under raw/<sha256>: it reads and changes nothing, so it takes no --confirm; run it only for a requester confirmed by a token proof',
  '  withdraw --account <id>             withdraw the raw consent of one account (Art. 7(3)): record the withdrawal as the route does and drop its staged raw parts (needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY, to list the bucket); the nightly sweep erases the raw objects it holds; run it only for a requester confirmed by a token proof',
  'Options: --confirm (without it nothing is changed), --local (the local wrangler state instead of the account\'s)',
  `Runs with the wrangler login already on this machine against D1 database "oars-pool" and R2 buckets "oars-pool-raw" and "oars-telemetry".`,
].join('\n');

export interface Io {
  /** The leaked value, read to the end of stdin. */
  stdin: () => Promise<string>;
  print: (text: string) => void;
  wrangler: Wrangler;
  /** Where the find writes an object to read it (`erase-files.ts`). */
  files: ObjectFiles;
  /** Lists the telemetry bucket (`erase-r2-list.ts`); absent when the operator exported no R2 token. */
  list?: Lister;
  /** Lists the raw bucket (`erase-r2-list.ts`) for the staged parts a withdrawal drops; absent when the operator exported no R2 token, and always for `--local`, since wrangler cannot list local R2. */
  listRaw?: Lister;
  /** The folder an export is written to, by path (`erase-files.ts`). */
  folder: (path: string) => ExportFolder;
  now: () => Date;
}

const NO_RAW_LISTER = 'listing the raw bucket needs an R2 API token: export R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY (read on the bucket oars-pool-raw), then run the withdrawal again; nothing was changed';

const TARGET = { database: 'oars-pool', bucket: 'oars-pool-raw', telemetryBucket: 'oars-telemetry' } as const;

interface Options {
  positional: string[];
  account?: string;
  id?: string;
  valueStdin: boolean;
  contains: boolean;
  allAccounts: boolean;
  lift: boolean;
  raw: boolean;
  out?: string;
  confirm: boolean;
  local: boolean;
}

const optionsOf = (argv: readonly string[]): Options | string => {
  const options: Options = { positional: [], valueStdin: false, contains: false, allAccounts: false, lift: false, raw: false, confirm: false, local: false };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? '';
    if (arg === '--confirm') options.confirm = true;
    else if (arg === '--local') options.local = true;
    else if (arg === '--value-stdin') options.valueStdin = true;
    else if (arg === '--contains') options.contains = true;
    else if (arg === '--all-accounts') options.allAccounts = true;
    else if (arg === '--lift') options.lift = true;
    else if (arg === '--raw') options.raw = true;
    else if (arg === '--account' || arg === '--id' || arg === '--out') {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
      options[arg === '--account' ? 'account' : arg === '--out' ? 'out' : 'id'] = value;
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
  // --raw and --out belong to export alone: on any other verb they would be ignored without a word, like a typo that still erases.
  if (what !== 'export' && (options.raw || options.out !== undefined)) {
    io.print(USAGE);
    return 2;
  }
  const target: Target = { ...TARGET, local: options.local };
  const store: EraseStore = wranglerStore(io.wrangler, target, io.files, io.list, io.listRaw);
  const where = options.local ? 'local state' : 'the remote pool';
  try {
    // The find reads and changes nothing, so it needs no --confirm. The text comes from stdin only: an argument would be in the process table and the shell's history.
    if (what === 'raw' && options.contains && options.valueStdin && key === undefined && options.positional.length === 1) {
      const value = (await io.stdin()).replace(/\r?\n$/, '');
      const found = await findRawContaining(store, { ...(options.account === undefined ? {} : { account: options.account }), allAccounts: options.allAccounts }, value, (hit) => {
        io.print(JSON.stringify(hit));
      });
      io.print(JSON.stringify({ objectsRead: found.read, objectsMatched: found.matched, objectsMissing: found.missing }));
      // wrangler turns every remote 404 into a missing key, so a wrong bucket would read nothing: a missing object is a failed find, not a clean one.
      return found.missing > 0 ? 1 : 0;
    }
    if (what === 'raw' && key !== undefined && extra.length === 0 && options.account === undefined && !options.contains) {
      if (!options.confirm) return plan(io, `delete raw object ${key} from ${where}`);
      io.print(summary(await eraseRawObject(store, key, io.now())));
      return 0;
    }
    // The deposit find reads and changes nothing, so it takes no --confirm. Like the raw find, the text is stdin's alone.
    if (what === 'row' && options.contains && options.valueStdin && !options.confirm && options.id === undefined && options.positional.length === 1) {
      const value = (await io.stdin()).replace(/\r?\n$/, '');
      const found = await findDepositsContaining(store, { ...(options.account === undefined ? {} : { account: options.account }), allAccounts: options.allAccounts }, value);
      for (const deposit of found.deposits) io.print(JSON.stringify(deposit));
      io.print(JSON.stringify({ depositsHeld: found.deposits.length, motifsHeld: found.motifs, cellsHeld: found.cells, contributorsHeld: found.contributors }));
      return 0;
    }
    if (what === 'row' && !options.contains && options.positional.length === 1 && options.account !== undefined && options.id !== undefined) {
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
    if (what === 'close' && options.positional.length === 1 && options.account !== undefined && options.id === undefined) {
      if (!options.confirm) return plan(io, `close account ${options.account} in ${where}: record when it closed, revoke its tokens and machine keys, and delete nothing a Deposit holds`);
      io.print(JSON.stringify({ rowsChanged: (await closeAccount(store, options.account, io.now())).rows }));
      return 0;
    }
    if (what === 'restrict' && options.positional.length === 1 && options.account !== undefined && options.id === undefined) {
      if (!options.confirm) return plan(io, options.lift ? `lift the restriction on account ${options.account} in ${where}: its deposits, raw parts, machine enrollment, and club joins are taken again, its rows return to the club boards, its telemetry batches roll into a row again, and it counts toward cell holder counts again; tell the person first (Art. 18(3))` : `restrict account ${options.account} in ${where}: record when it was restricted; its deposits, raw parts, machine enrollment, and club joins are refused, its rows leave every club board, and its telemetry batches roll into no row; stop counting it toward cell holder counts; delete and revoke nothing`);
      io.print(JSON.stringify({ rowsChanged: (await restrictAccount(store, options.account, options.lift, io.now())).rows }));
      return 0;
    }
    // The export reads and changes nothing, so it needs no --confirm. It is for a requester the operator has confirmed by a token proof, never a machine key (docs/pool-rights.md, "Who is asking").
    if (what === 'export' && options.positional.length === 1 && options.account !== undefined && options.out !== undefined && options.id === undefined) {
      const done = await exportAccount(store, io.folder(options.out), options.account, options.raw);
      for (const failure of done.failed) io.print(`Not saved: raw object ${failure}.`);
      io.print(JSON.stringify({ pages: done.pages, ...(options.raw ? { rawObjects: done.rawObjects, rawFailed: done.failed.length } : {}) }));
      // A raw object the ledger lists and the bucket does not hold, or one that does not hash to its name, makes the copy incomplete: the requester is not sent it as whole.
      return done.failed.length > 0 ? 1 : 0;
    }
    if (what === 'withdraw' && options.positional.length === 1 && options.account !== undefined && options.id === undefined) {
      const consent = await rawConsentOf(store, options.account);
      if (consent.standing !== 'yes') {
        const said = consent.standing === 'never' ? `account ${consent.account} never gave a raw yes` : `account ${consent.account} withdrew its raw yes on ${new Date(consent.withdrawnAt ?? 0).toISOString().slice(0, 10)}`;
        if (!options.confirm) {
          io.print(`No raw consent stands: ${said}. The account row would not change${consent.standing === 'never' ? '' : '; --confirm only drops any staged parts that remain'}. Nothing was changed.`);
          return 0;
        }
      } else if (!options.confirm) return plan(io, `withdraw the raw consent of account ${consent.account} in ${where}: clear the yes and record the time, and drop its staged raw parts; the nightly sweep erases the raw objects it holds`);
      // A remote run that cannot list the bucket stops before it changes anything; a local one cannot ever list, and says so after.
      if (!options.local && io.listRaw === undefined && consent.standing !== 'never') throw new Error(NO_RAW_LISTER);
      const done = await withdrawRaw(store, consent.account, io.now());
      if (!done.stagedListed) io.print('Local R2 cannot be listed: any staged parts in the local state were not dropped.');
      if (consent.standing === 'never') io.print(`Account ${consent.account} never gave a raw yes: nothing to withdraw, nothing changed.`);
      io.print(JSON.stringify({ withdrawn: done.withdrawn, stagedDropped: done.stagedDropped }));
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
