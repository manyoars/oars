// The two filters a skeleton-only release adds to the lot builder (sample-pack.ts): an age limit, and the sessions an earlier lot already holds.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** The delay ruled on 2026-11-12 for the public slice: fresh sessions stay paid. */
export const SKELETON_DEFAULT_DAYS = 30;

const DAY_MS = 86_400_000;

/** Whether a session whose last line is at `tsLast` is old enough; one with no date, or a date that is not one, is not provably old. A missing limit asks nothing. */
export const ageFilterOf = (days: number | undefined, now: () => number): ((tsLast: string | null) => boolean) | undefined => {
  if (days === undefined) return undefined;
  const line = now() - days * DAY_MS;
  return (tsLast) => {
    const at = tsLast === null ? NaN : Date.parse(tsLast);
    return Number.isFinite(at) && at <= line;
  };
};

const isAbsent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const linesOf = async (file: string, what: string, PackError: new (message: string) => Error): Promise<unknown[]> => {
  const text = await readFile(file, 'utf8').catch((error: unknown) => {
    if (isAbsent(error)) throw new PackError(`Cannot read ${what}.`);
    throw error;
  });
  return text.split(/\r?\n/).filter((row) => row.trim() !== '').map((row): unknown => JSON.parse(row));
};

const fieldOf = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null && key in value ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined);

/**
 * The store session ids behind every match id in a lot's manifest (a path to `manifest.jsonl`, or to the pack folder). A match id is keyed to its buyer, so the only way back is the operator's `index.jsonl`;
 * a match id it does not hold stops the build, since a lot that is silently not excluded would put a paid session in the public slice.
 */
export const excludedSessionsOf = async (manifest: string, indexFile: string, PackError: new (message: string) => Error): Promise<Set<string>> => {
  const file = (await stat(manifest).catch(() => undefined))?.isDirectory() === true ? join(manifest, 'manifest.jsonl') : manifest;
  const matchIds = new Set((await linesOf(file, 'the --exclude-manifest file', PackError)).map((row) => fieldOf(row, 'matchId')).filter((id): id is string => typeof id === 'string'));
  const sessions = new Set<string>();
  const found = new Set<string>();
  for (const row of await linesOf(indexFile, 'index.jsonl beside the owners file, which maps the excluded lot\'s match ids to sessions', PackError)) {
    const [matchId, session] = [fieldOf(row, 'matchId'), fieldOf(row, 'session')];
    if (typeof matchId === 'string' && typeof session === 'string' && matchIds.has(matchId)) {
      sessions.add(session);
      found.add(matchId);
    }
  }
  if (found.size < matchIds.size) throw new PackError(`${String(matchIds.size - found.size)} of the ${String(matchIds.size)} rows in the excluded manifest are not in index.jsonl beside the owners file. Build from the folder that holds that lot's index.`);
  return sessions;
};
