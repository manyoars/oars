import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where a command got to, for the rerun that follows a failure (design §3.2). It holds step names and the HTTP status each
 * answered with, never a secret: the SDK key is shown once and the platform replays every finished step by its idempotency key.
 */
export interface JournalRecord {
  /** The human base key (`--idempotency-key` or the UUID the first run made). */
  base: string;
  steps: Array<{ step: string; status: number }>;
}

export interface JournalStore {
  /** Undefined when no run with this base key has left a record, including when the file is unreadable as one. */
  read: (base: string) => Promise<JournalRecord | undefined>;
  write: (record: JournalRecord) => Promise<void>;
  delete: (base: string) => Promise<void>;
}

/** One step's `Idempotency-Key`: the lowercase SHA-256 hex of `<base>:<step>`, the 64-hex form every aor-common interceptor accepts. */
export const stepKey = (base: string, step: string): string => createHash('sha256').update(`${base}:${step}`).digest('hex');

const isRecord = (value: unknown): value is JournalRecord => {
  if (typeof value !== 'object' || value === null) return false;
  const base: unknown = Reflect.get(value, 'base');
  const steps: unknown = Reflect.get(value, 'steps');
  return (
    typeof base === 'string' &&
    Array.isArray(steps) &&
    steps.every((entry: unknown) => typeof entry === 'object' && entry !== null && typeof Reflect.get(entry, 'step') === 'string' && typeof Reflect.get(entry, 'status') === 'number')
  );
};

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * Keeps one file per base key in `<dir>/oars/journal/`, named by the key's hash because the key is whatever the developer typed.
 * A write goes to a sibling file and is renamed over the old one; a torn file reads as no record, and the platform's replay
 * makes the rerun correct either way.
 */
export const fileJournalStore = (dir: string): JournalStore => {
  const folder = join(dir, 'oars', 'journal');
  const fileFor = (base: string): string => join(folder, `${createHash('sha256').update(base).digest('hex')}.json`);
  return {
    read: async (base) => {
      let text: string;
      try {
        text = await readFile(fileFor(base), 'utf8');
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) && parsed.base === base ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    write: async (record) => {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const file = fileFor(record.base);
      const temp = `${file}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        await rename(temp, file);
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
    },
    delete: (base) => rm(fileFor(base), { force: true }),
  };
};
