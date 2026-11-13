// `npm run grant-crew -w packages/pool -- --by <who> [--confirm] [--local]`: the operator's founding-crew grant (docs/pool.md, "Founding crew"). It numbers the first 100 counting accounts (crew 1 to 100) and grants board standing to them, and grants board standing to a vouched account once it has two counting weeks. A vouch inside one cluster earns nothing, and a closed or restricted account earns nothing. No route writes a crew number or `board_standing`; this command is the only writer, and it changes nothing until `--confirm` is given.
import { clusterHolders, type Holder } from '../src/clusters.js';
import { wranglerStore, type ObjectFiles, type Wrangler } from './erase-wrangler.js';
import type { EraseStore } from './erase.js';

export { nodeFiles } from './erase-files.js';

export const USAGE = [
  'Usage: grant-crew --by <name> [--confirm] [--local]',
  '  Numbers the first 100 counting accounts as the founding crew and lists them on the open board without the 90 days of standing; grants the same standing to an account a crew or standing member vouched for once it has two counting weeks, unless the two share a cluster.',
  '  Without --confirm it only says what it would do. --local uses the local wrangler state instead of the account\'s.',
].join('\n');

/** The founding crew is the first this many counting accounts. */
export const CREW_CAP = 100;
/** Counting weeks a vouched account needs before it is granted. */
export const VOUCHED_WEEKS = 2;

type Store = Pick<EraseStore, 'rows' | 'run'>;

export interface Plan {
  /** Accounts to number, in the order they first counted, each with the lowest free crew number. */
  founding: { account: string; crew: number }[];
  /** Vouched accounts to grant, with who vouched. */
  vouched: { account: string; inviter: string }[];
  /** Candidates that earn nothing, with why. */
  skipped: { account: string; reason: string }[];
}

const text = (row: unknown, name: string): string => String(typeof row === 'object' && row !== null ? Reflect.get(row, name) : '');
const whole = (row: unknown, name: string): number | undefined => {
  const found: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, name) : undefined;
  return typeof found === 'number' ? found : undefined;
};

/** What the pool holds for an account, as the cluster rule reads it: the same signals `clusters.ts` joins accounts on. */
const holderOf = async (store: Store, account: string): Promise<Holder> => {
  const [[profile], keys, hours, [counted]] = await Promise.all([
    store.rows('SELECT first_seen, provider_created FROM accounts WHERE id = ?', [account]),
    store.rows('SELECT repo_key FROM account_repo_keys WHERE account = ?', [account]),
    store.rows('SELECT day, hour FROM deposit_hours WHERE account = ?', [account]),
    store.rows("SELECT MIN(counted_at) AS first FROM deposits WHERE account = ? AND counted_at IS NOT NULL AND tier <> 'none'", [account]),
  ]);
  const cadence = new Map<string, Set<number>>();
  for (const row of hours) cadence.set(text(row, 'day'), (cadence.get(text(row, 'day')) ?? new Set<number>()).add(whole(row, 'hour') ?? 0));
  return { account, repoKeys: keys.map((row) => text(row, 'repo_key')), createdAt: whole(profile, 'provider_created') ?? whole(profile, 'first_seen'), firstDeposit: whole(counted, 'first') ?? 0, cadence };
};

/** Whether the pool's own cluster rule puts the two accounts in one cluster. */
const sameCluster = async (store: Store, one: string, two: string): Promise<boolean> => clusterHolders([await holderOf(store, one), await holderOf(store, two)]).groups.length === 1;

const OPEN = 'a.closed_at IS NULL AND a.restricted_at IS NULL';

/** Reads what a confirmed run would write. Writes nothing. */
export const planCrew = async (store: Store): Promise<Plan> => {
  const numbered = new Set((await store.rows('SELECT crew_number FROM accounts WHERE crew_number IS NOT NULL', [])).map((row) => whole(row, 'crew_number')));
  const free = Array.from({ length: CREW_CAP }, (_, at) => at + 1).filter((crew) => !numbered.has(crew));
  const candidates = await store.rows(
    `SELECT d.account AS account, MIN(d.counted_at) AS first FROM deposits d JOIN accounts a ON a.id = d.account WHERE d.counted_at IS NOT NULL AND d.tier <> 'none' AND a.crew_number IS NULL AND ${OPEN} GROUP BY d.account ORDER BY first, d.account LIMIT ?`,
    [free.length],
  );
  const founding = candidates.map((row, at) => ({ account: text(row, 'account'), crew: free[at] ?? 0 }));
  const ids = new Set(founding.map((row) => row.account));
  const edges = await store.rows(
    `SELECT e.inviter AS inviter, e.invitee AS invitee FROM vouch_edges e JOIN accounts a ON a.id = e.invitee JOIN accounts i ON i.id = e.inviter WHERE ${OPEN} AND i.closed_at IS NULL AND i.restricted_at IS NULL AND NOT EXISTS (SELECT 1 FROM board_standing g WHERE g.account = e.invitee) AND (SELECT COUNT(*) FROM account_weeks w WHERE w.account = e.invitee AND w.sessions > 0) >= ? ORDER BY e.id`,
    [VOUCHED_WEEKS],
  );
  const vouched: Plan['vouched'] = [];
  const skipped: Plan['skipped'] = [];
  for (const edge of edges) {
    const [account, inviter] = [text(edge, 'invitee'), text(edge, 'inviter')];
    if (ids.has(account)) continue;
    if (await sameCluster(store, inviter, account)) skipped.push({ account, reason: 'same cluster as its inviter' });
    else vouched.push({ account, inviter });
  }
  return { founding, vouched, skipped };
};

/** Writes a plan. Every statement is conditional, so a rerun, or a plan gone stale, changes only what is still open. Answers the rows it wrote. */
export const writeCrew = async (store: Store, plan: Plan, grant: { by: string }, now: Date): Promise<{ founding: number; vouched: number }> => {
  let founding = 0;
  let vouched = 0;
  for (const row of plan.founding) {
    // The unique index on `crew_number` refuses a number taken since the plan was read; the standing row follows only a number that held.
    const numbered = await store.run('UPDATE accounts SET crew_number = ? WHERE id = ? AND crew_number IS NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE crew_number = ?)', [row.crew, row.account, row.crew]);
    if (numbered === 0) continue;
    await store.run('INSERT OR IGNORE INTO board_standing (account, granted_at, granted_by, reason) VALUES (?, ?, ?, ?)', [row.account, now.getTime(), grant.by, `founding crew #${String(row.crew)}`]);
    founding += 1;
  }
  for (const row of plan.vouched) {
    vouched += await store.run('INSERT OR IGNORE INTO board_standing (account, granted_at, granted_by, reason) VALUES (?, ?, ?, ?)', [row.account, now.getTime(), grant.by, 'vouched by a founding or standing account, two counting weeks']);
  }
  return { founding, vouched };
};

export interface Io {
  print: (text: string) => void;
  wrangler: Wrangler;
  files: ObjectFiles;
  now: () => Date;
  /** Reads and writes instead of wrangler; the fixture tests pass a local database here. */
  store?: Store;
}

const TARGET = { database: 'oars-pool', bucket: 'oars-pool-raw', telemetryBucket: 'oars-telemetry' } as const;

/** Runs the command; answers the exit code. */
export const main = async (argv: readonly string[], io: Io): Promise<number> => {
  let by: string | undefined;
  let confirm = false;
  let local = false;
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? '';
    if (arg === '--confirm') confirm = true;
    else if (arg === '--local') local = true;
    else if (arg === '--by') {
      by = argv[at + 1];
      if (by === undefined || by.startsWith('--')) {
        io.print(`--by needs a value\n${USAGE}`);
        return 2;
      }
      at += 1;
    } else {
      io.print(`unknown argument ${arg}\n${USAGE}`);
      return 2;
    }
  }
  if (by === undefined || by.trim() === '') {
    io.print(USAGE);
    return 2;
  }
  const store = io.store ?? wranglerStore(io.wrangler, { ...TARGET, local }, io.files);
  try {
    const plan = await planCrew(store);
    if (!confirm) {
      io.print(JSON.stringify({ dryRun: true, ...plan }));
      io.print(`Would number ${String(plan.founding.length)} account(s) and grant standing to ${String(plan.founding.length + plan.vouched.length)} (by ${by}). Nothing was changed: run again with --confirm.`);
      return 0;
    }
    io.print(JSON.stringify(await writeCrew(store, plan, { by: by.trim() }, io.now())));
    return 0;
  } catch (error) {
    io.print(error instanceof Error ? error.message : 'the grant failed');
    return 1;
  }
};
