// `npm run set-source -w packages/pool -- --account <id> --source <user|operator-fleet|seed> --by <who> --reason <why> [--confirm] [--local]`: the operator's change of an account's `source` (migration 0012), which the panel count, the covenant funnel, and the proof sheet read. No route writes it; this command is the only writer. It changes nothing until `--confirm` is given.
import { wranglerStore, type ObjectFiles, type Wrangler } from './erase-wrangler.js';
import type { EraseStore } from './erase.js';

export { nodeFiles } from './erase-files.js';

export const USAGE = [
  'Usage: set-source --account <id> --source <user|operator-fleet|seed> --by <name> --reason <text> [--confirm] [--local]',
  '  Sets the account\'s source. Without --confirm it only says the value before and after.',
  '  With --confirm it writes the value and prints one audit line (who, why, when, before, after): keep it, the pool holds no other record.',
  '  --local uses the local wrangler state instead of the account\'s.',
].join('\n');

const NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** The values the command writes: `user` is the default of every sign-up, the other two are inputs and not depositors. */
export const SOURCES: readonly string[] = ['user', 'operator-fleet', 'seed'];

type Store = Pick<EraseStore, 'rows' | 'run'>;

interface Change {
  account: string;
  source: string;
  by: string;
  reason: string;
}

const checked = (change: Change): void => {
  if (!NAME.test(change.account)) throw new Error('the account is not a pool id: letters, digits, dot, dash, and underscore, 1 to 128');
  if (!SOURCES.includes(change.source)) throw new Error('the source must be user, operator-fleet, or seed');
  if (change.by.trim() === '' || change.reason.trim() === '') throw new Error('--by and --reason are required: the change is a record of who decided and why');
};

const sourceBefore = async (store: Store, account: string, where: string): Promise<string> => {
  const found = (await store.rows('SELECT source FROM accounts WHERE id = ?', [account]))[0];
  if (found === undefined) throw new Error(`No account ${account} in ${where}.`);
  return String(Reflect.get(Object(found), 'source'));
};

/** Sets the source of an account the pool has seen and answers the value before and after; an account it has not seen is an error, so a mistyped id never looks like success. */
export const setSource = async (store: Store, change: Change, where = 'the pool'): Promise<{ account: string; before: string; after: string }> => {
  checked(change);
  const before = await sourceBefore(store, change.account, where);
  await store.run('UPDATE accounts SET source = ? WHERE id = ?', [change.source, change.account]);
  return { account: change.account, before, after: change.source };
};

export interface Io {
  print: (text: string) => void;
  wrangler: Wrangler;
  files: ObjectFiles;
  now: () => Date;
}

const TARGET = { database: 'oars-pool', bucket: 'oars-pool-raw', telemetryBucket: 'oars-telemetry' } as const;

const VALUED = new Set(['--account', '--source', '--by', '--reason']);

/** Runs the command; answers the exit code. */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  const given = new Map<string, string>();
  let confirm = false;
  let local = false;
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? '';
    if (arg === '--confirm') confirm = true;
    else if (arg === '--local') local = true;
    else if (VALUED.has(arg)) {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith('--')) {
        io.print(`${arg} needs a value\n${USAGE}`);
        return 2;
      }
      given.set(arg, value);
      at += 1;
    } else {
      io.print(`unknown argument ${arg}\n${USAGE}`);
      return 2;
    }
  }
  const [account, source, by, reason] = [given.get('--account'), given.get('--source'), given.get('--by'), given.get('--reason')];
  if (account === undefined || source === undefined || by === undefined || reason === undefined) {
    io.print(USAGE);
    return 2;
  }
  const store = wranglerStore(io.wrangler, { ...TARGET, local }, io.files);
  const where = local ? 'local state' : 'the remote pool';
  try {
    const change = { account, source, by, reason };
    if (!confirm) {
      // The dry run reads the account too, so a mistyped id or value shows here.
      checked(change);
      io.print(`Would set the source of account ${account} in ${where} from ${await sourceBefore(store, account, where)} to ${source} (by ${by.trim()}: ${reason.trim()}). Nothing was changed: run again with --confirm.`);
      return 0;
    }
    const done = await setSource(store, change, where);
    io.print(JSON.stringify({ audit: 'set-source', ...done, by: by.trim(), reason: reason.trim(), at: io.now().toISOString(), where: local ? 'local' : 'remote' }));
    return 0;
  } catch (error) {
    io.print(error instanceof Error ? error.message : 'the change failed');
    return 1;
  }
};
