// The erasure store over the operator's own `wrangler` login: D1 through `wrangler d1 execute` and R2 through `wrangler r2 object delete`, remote or local. No token is held anywhere: wrangler uses the login the operator already has.
import type { EraseStore } from './erase.js';

/** Runs wrangler with these arguments and answers what it printed; a failure throws. */
export type Wrangler = (args: readonly string[]) => Promise<string>;

/** Where the store points: the D1 database and the R2 bucket (the names `wrangler.jsonc` binds), and local state instead of the account's. */
export interface Target {
  database: string;
  bucket: string;
  local: boolean;
}

type Bind = string | number | null;

const literal = (value: Bind): string => {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('a bound number is a whole number');
    return String(value);
  }
  if (value.includes('\0')) throw new Error('a bound text holds no NUL');
  return `'${value.replaceAll("'", "''")}'`;
};

/** The statement with its values written in, because `wrangler d1 execute` takes SQL text and no bindings. Every `?` is a placeholder: the statements the command writes hold no other. */
export const inline = (sql: string, binds: readonly Bind[]): string => {
  const parts = sql.split('?');
  if (parts.length - 1 !== binds.length) throw new Error(`${String(parts.length - 1)} placeholders and ${String(binds.length)} values`);
  return parts.map((part, at) => (at < binds.length ? `${part}${literal(binds[at] ?? null)}` : part)).join('');
};

const fieldOf = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

/** The first result set of `wrangler d1 execute --json`: an array with one `{results, meta, success}` per statement. */
const resultOf = (printed: string): unknown => {
  const parsed: unknown = JSON.parse(printed);
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  if (fieldOf(first, 'success') !== true) throw new Error('wrangler d1 execute did not report success');
  return first;
};

export const wranglerStore = (wrangler: Wrangler, target: Target): EraseStore => {
  const where = target.local ? '--local' : '--remote';
  const execute = async (sql: string, binds: readonly Bind[]): Promise<unknown> => resultOf(await wrangler(['d1', 'execute', target.database, where, '--json', '--command', inline(sql, binds)]));
  return {
    rows: async (sql, binds) => {
      const results = fieldOf(await execute(sql, binds), 'results');
      return Array.isArray(results) ? results.map((row: unknown) => row) : [];
    },
    run: async (sql, binds) => {
      const changes = fieldOf(fieldOf(await execute(sql, binds), 'meta'), 'changes');
      return typeof changes === 'number' ? changes : 0;
    },
    deleteObject: async (key) => {
      await wrangler(['r2', 'object', 'delete', `${target.bucket}/${key}`, where]);
    },
  };
};
