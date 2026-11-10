// The erasure store over the operator's own `wrangler` login: D1 through `wrangler d1 execute` and R2 through `wrangler r2 object delete` and `get`, remote or local. No token is held anywhere: wrangler uses the login the operator already has.
import type { EraseStore } from './erase.js';

/** Runs wrangler with these arguments and answers what it printed; a failure throws. */
export type Wrangler = (args: readonly string[]) => Promise<string>;

/** Where the store points: the D1 database and the R2 bucket (the names `wrangler.jsonc` binds), and local state instead of the account's. */
export interface Target {
  database: string;
  bucket: string;
  /** The telemetry bucket, where an erased account's batches are rewritten. */
  telemetryBucket: string;
  local: boolean;
}

/** Where an object is written to be read: a scratch path, a stream of its bytes in bounded pieces, and its removal. The command's own are real files (`erase-files.ts`); the tests' are in memory. */
export interface ObjectFiles {
  /** A path for one object, in a folder of this run's own. */
  temp: () => Promise<string>;
  read: (path: string) => AsyncIterable<Uint8Array>;
  /** Writes the text to the path, for `r2 object put --file`. */
  write: (path: string, text: string) => Promise<void>;
  /** Removes the file; one that is not there is not an error. */
  remove: (path: string) => Promise<void>;
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

/** Lists every key under a prefix. Wrangler cannot list a bucket, so the command's own is R2's S3 API (`erase-r2-list.ts`); one that is not given refuses the batch step with what to set. */
export type Lister = (prefix: string) => Promise<readonly string[]>;

const NO_LISTER = 'listing the telemetry bucket needs an R2 API token: export R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY (read on the bucket oars-telemetry), then run the erasure again; every other step is already done';

export const wranglerStore = (wrangler: Wrangler, target: Target, files: ObjectFiles, list: Lister = () => Promise.reject(new Error(NO_LISTER))): EraseStore => {
  const where = target.local ? '--local' : '--remote';
  /** One object's text, read through a scratch file that is removed; null when the object is not there. */
  const textOf = async (key: string): Promise<string | null> => {
    const file = await files.temp();
    try {
      await wrangler(['r2', 'object', 'get', `${target.telemetryBucket}/${key}`, '--file', file, where]);
      const chunks: Buffer[] = [];
      for await (const piece of files.read(file)) chunks.push(Buffer.from(piece));
      return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      if (/does not exist/i.test(String(error))) return null;
      throw error;
    } finally {
      await files.remove(file);
    }
  };
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
    telemetry: {
      list,
      read: textOf,
      write: async (key, text) => {
        const file = await files.temp();
        try {
          await files.write(file, text);
          await wrangler(['r2', 'object', 'put', `${target.telemetryBucket}/${key}`, '--file', file, '--content-type', 'application/json', where]);
        } finally {
          await files.remove(file);
        }
      },
      remove: async (key) => {
        await wrangler(['r2', 'object', 'delete', `${target.telemetryBucket}/${key}`, where]);
      },
    },
    // Wrangler writes the object to a scratch file (`--file`; `--pipe` would put it all in a buffer here), the stream reads that file a piece at a time, and the file goes when the stream ends or is left.
    readObject: async (key) => {
      const file = await files.temp();
      try {
        await wrangler(['r2', 'object', 'get', `${target.bucket}/${key}`, '--file', file, where]);
      } catch (error) {
        await files.remove(file);
        if (/does not exist/i.test(String(error))) return null;
        throw error;
      }
      return (async function* pieces() {
        try {
          yield* files.read(file);
        } finally {
          await files.remove(file);
        }
      })();
    },
  };
};
