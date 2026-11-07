// The last bytes of a transcript and what they state, light enough for a hook to import: the bare `oars gate hook` loads this and never the recall machinery.
import { open, type FileHandle } from 'node:fs/promises';

/** How far back a hook looks in a growing file: enough for the session's latest lines, and a bound on what a hook on every call can cost. */
const TAIL_BYTES = 64 * 1024;

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const openIfThere = async (file: string): Promise<FileHandle | undefined> => {
  try {
    return await open(file, 'r');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/** A file's last bytes; a first line this cuts in two fails to parse and is skipped by whoever reads it. */
export const tailOf = async (file: string): Promise<string> => {
  const handle = await openIfThere(file);
  if (handle === undefined) return '';
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
};

export const isRecord = (value: unknown): value is { [key: string]: unknown } => typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const parsedLines = (tail: string): Array<{ [key: string]: unknown }> =>
  tail.split('\n').flatMap((line) => {
    try {
      const parsed: unknown = JSON.parse(line);
      return isRecord(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });

/** What a transcript's tail states of the asker: the harness version, the model, and the effort, each the newest line's that states it. */
export interface Stated {
  harnessVersion: string | null;
  model: string | null;
  effort: string | null;
}

export const statedOf = (tail: string): Stated => {
  let harnessVersion: string | null = null;
  let model: string | null = null;
  let effort: string | null = null;
  // Oldest first, so the newest line that states a field wins.
  for (const line of parsedLines(tail)) {
    harnessVersion = text(line.version) ?? harnessVersion;
    effort = text(line.effort) ?? effort;
    if (isRecord(line.message)) model = text(line.message.model) ?? model;
  }
  return { harnessVersion, model, effort };
};

/** The same from a transcript file. A file that cannot be read states nothing: telemetry must never cost a hook its answer. */
export const statedAt = async (file: string): Promise<Stated> => {
  try {
    return statedOf(await tailOf(file));
  } catch {
    return { harnessVersion: null, model: null, effort: null };
  }
};
