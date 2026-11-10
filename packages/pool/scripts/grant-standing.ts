// `npm run grant-standing -w packages/pool -- --account <id> --by <who> --reason <why> [--confirm] [--local]`: the operator's grant of standing on the open board (docs/pool.md, "Boards"). No route writes `board_standing`; this command is the only writer. It changes nothing until `--confirm` is given.
import { wranglerStore, type ObjectFiles, type Wrangler } from './erase-wrangler.js';
import type { EraseStore } from './erase.js';

export { nodeFiles } from './erase-files.js';

export const USAGE = [
  'Usage: grant-standing --account <id> --by <name> --reason <text> [--confirm] [--local]',
  '  Lists the account on the open board without the 90 days of standing (the fleet). Without --confirm it only says what it would do.',
  '  --local uses the local wrangler state instead of the account\'s.',
].join('\n');

const NAME = /^[A-Za-z0-9._-]{1,128}$/;

type Store = Pick<EraseStore, 'rows' | 'run'>;

/** Whether the grant was written (`granted`), was already there (`held`); an account the pool has not seen is an error, so a mistyped id never looks like success. */
export const grantStanding = async (store: Store, grant: { account: string; by: string; reason: string }, now: Date): Promise<'granted' | 'held'> => {
  if (!NAME.test(grant.account)) throw new Error('the account is not a pool id: letters, digits, dot, dash, and underscore, 1 to 128');
  if (grant.by.trim() === '' || grant.reason.trim() === '') throw new Error('--by and --reason are required: the grant is a record of who decided and why');
  if ((await store.rows('SELECT 1 AS found FROM accounts WHERE id = ?', [grant.account])).length === 0) throw new Error(`No account ${grant.account} in the pool.`);
  const changed = await store.run('INSERT OR IGNORE INTO board_standing (account, granted_at, granted_by, reason) VALUES (?, ?, ?, ?)', [grant.account, now.getTime(), grant.by.trim(), grant.reason.trim()]);
  return changed > 0 ? 'granted' : 'held';
};

export interface Io {
  print: (text: string) => void;
  wrangler: Wrangler;
  files: ObjectFiles;
  now: () => Date;
}

const TARGET = { database: 'oars-pool', bucket: 'oars-pool-raw', telemetryBucket: 'oars-telemetry' } as const;

const VALUED = new Set(['--account', '--by', '--reason']);

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
  const [account, by, reason] = [given.get('--account'), given.get('--by'), given.get('--reason')];
  if (account === undefined || by === undefined || reason === undefined) {
    io.print(USAGE);
    return 2;
  }
  const store = wranglerStore(io.wrangler, { ...TARGET, local }, io.files);
  const where = local ? 'local state' : 'the remote pool';
  try {
    if (!confirm) {
      // The dry run reads the account too, so a mistyped id shows here.
      if ((await store.rows('SELECT 1 AS found FROM accounts WHERE id = ?', [account])).length === 0) throw new Error(`No account ${account} in ${where}.`);
      io.print(`Would grant standing on the open board to account ${account} in ${where} (by ${by}: ${reason}). Nothing was changed: run again with --confirm.`);
      return 0;
    }
    io.print(JSON.stringify({ account, result: await grantStanding(store, { account, by, reason }, io.now()) }));
    return 0;
  } catch (error) {
    io.print(error instanceof Error ? error.message : 'the grant failed');
    return 1;
  }
};
