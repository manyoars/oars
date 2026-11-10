// `npm run hide-nickname -w packages/pool -- --club <id|open> --nickname <name> --by <who> --reason <why> [--confirm] [--local]`: the operator's hide of a nickname on a club board or the open board (docs/pool.md, "Boards"). It removes that member's row and records who hid it and why in `club_hides`; it does not bar the account from joining again. It changes nothing until `--confirm` is given.
import { wranglerStore, type ObjectFiles, type Wrangler } from './erase-wrangler.js';
import type { EraseStore } from './erase.js';

export { nodeFiles } from './erase-files.js';

export const USAGE = [
  'Usage: hide-nickname --club <id|open> --nickname <name> --by <name> --reason <text> [--confirm] [--local]',
  '  Removes the member with that nickname (any case) from the club, or from the open board with --club open, and records who and why. Without --confirm it only says what it would do.',
  '  --local uses the local wrangler state instead of the account\'s.',
].join('\n');

const CLUB = /^[A-Za-z0-9._-]{1,128}$/;

type Store = Pick<EraseStore, 'rows' | 'run'>;

const FIND = 'SELECT account, nickname FROM club_members WHERE club = ? AND nickname = ? COLLATE NOCASE';

/** `hidden` when the member's row was removed and the hide recorded; `absent` when nobody in the club holds that nickname. The nickname is matched in its NFKC form, the form the pool stores. */
export const hideNickname = async (store: Store, hide: { club: string; nickname: string; by: string; reason: string }, now: Date): Promise<'hidden' | 'absent'> => {
  if (!CLUB.test(hide.club)) throw new Error('the club is not a club id: letters, digits, dot, dash, and underscore, 1 to 128, or open');
  const nickname = hide.nickname.normalize('NFKC').trim();
  if (nickname === '') throw new Error('--nickname is required: the member to hide');
  if (hide.by.trim() === '' || hide.reason.trim() === '') throw new Error('--by and --reason are required: the hide is a record of who decided and why');
  if ((await store.rows(FIND, [hide.club, nickname])).length === 0) return 'absent';
  // The store runs one statement at a time, so the two writes cannot share a transaction. The record goes first and only once per seating (none at or after the member's `joined_at` yet): a run that failed before the delete leaves the member seated and one record, and the rerun adds none and finishes the delete.
  await store.run('INSERT INTO club_hides (club, account, nickname, hidden_at, hidden_by, reason) SELECT m.club, m.account, m.nickname, ?, ?, ? FROM club_members m WHERE m.club = ? AND m.nickname = ? COLLATE NOCASE AND NOT EXISTS (SELECT 1 FROM club_hides h WHERE h.club = m.club AND h.account = m.account AND h.hidden_at >= m.joined_at)', [now.getTime(), hide.by.trim(), hide.reason.trim(), hide.club, nickname]);
  await store.run('DELETE FROM club_members WHERE club = ? AND nickname = ? COLLATE NOCASE', [hide.club, nickname]);
  return 'hidden';
};

export interface Io {
  print: (text: string) => void;
  wrangler: Wrangler;
  files: ObjectFiles;
  now: () => Date;
}

const TARGET = { database: 'oars-pool', bucket: 'oars-pool-raw', telemetryBucket: 'oars-telemetry' } as const;

const VALUED = new Set(['--club', '--nickname', '--by', '--reason']);

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
  const [club, nickname, by, reason] = [given.get('--club'), given.get('--nickname'), given.get('--by'), given.get('--reason')];
  if (club === undefined || nickname === undefined || by === undefined || reason === undefined) {
    io.print(USAGE);
    return 2;
  }
  const store = wranglerStore(io.wrangler, { ...TARGET, local }, io.files);
  const where = local ? 'local state' : 'the remote pool';
  try {
    if (!confirm) {
      // The dry run reads the member too, so a mistyped club or nickname shows here.
      if (!CLUB.test(club) || (await store.rows(FIND, [club, nickname.normalize('NFKC').trim()])).length === 0) throw new Error(`No member "${nickname}" in club ${club} in ${where}.`);
      io.print(`Would hide "${nickname}" in club ${club} in ${where} (by ${by}: ${reason}). Nothing was changed: run again with --confirm.`);
      return 0;
    }
    const result = await hideNickname(store, { club, nickname, by, reason }, io.now());
    if (result === 'absent') throw new Error(`No member "${nickname}" in club ${club} in ${where}.`);
    io.print(JSON.stringify({ club, nickname, result }));
    return 0;
  } catch (error) {
    io.print(error instanceof Error ? error.message : 'the hide failed');
    return 1;
  }
};
