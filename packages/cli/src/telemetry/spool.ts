// The telemetry folder: a per-install random id, and an append-only spool of one JSON event per line. Nothing here sends anything. The spool is
// capped: when a line would pass the cap, the current file becomes the old file (replacing the one before) and a new one starts, so the folder
// never holds more than twice the cap.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One mebibyte per file, so the folder holds at most two. */
export const SPOOL_CAP_BYTES = 1_048_576;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const spoolPaths = (dir: string): { current: string; previous: string; idFile: string; settings: string } => ({
  current: join(dir, 'events.jsonl'),
  previous: join(dir, 'events.1.jsonl'),
  idFile: join(dir, 'install-id'),
  settings: join(dir, 'settings.json'),
});

const readIfPresent = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * This install's id: a random version 4 UUID made on first use and kept in the folder. It comes from the system's random source, never from the
 * machine, the user, or a path, so deleting the file starts a new, unrelated id.
 */
export const installId = (dir: string): string => {
  const { idFile } = spoolPaths(dir);
  const existing = readIfPresent(idFile);
  const kept = existing?.trim();
  if (kept !== undefined && UUID.test(kept)) return kept;
  mkdirSync(dir, { recursive: true });
  const fresh = randomUUID();
  try {
    // Exclusive when no file stood there, so two first runs at once cannot each keep their own id; a file that is not an id is replaced.
    writeFileSync(idFile, `${fresh}\n`, { flag: existing === undefined ? 'wx' : 'w' });
    return fresh;
  } catch (error) {
    const winner = readIfPresent(idFile)?.trim();
    if (winner !== undefined && UUID.test(winner)) return winner;
    throw error;
  }
};

/** Appends one line, rotating first when it would pass `capBytes`; a line larger than the cap on its own is not written. */
export const appendLine = (dir: string, line: string, capBytes: number = SPOOL_CAP_BYTES): void => {
  const { current, previous } = spoolPaths(dir);
  const bytes = Buffer.byteLength(line) + 1;
  if (bytes > capBytes) return;
  mkdirSync(dir, { recursive: true });
  let size = 0;
  try {
    size = statSync(current).size;
  } catch {
    // No spool yet.
  }
  if (size + bytes > capBytes) renameSync(current, previous);
  appendFileSync(current, `${line}\n`);
};

/** Every spooled line, oldest first. */
export const readSpool = (dir: string): string[] => {
  const { current, previous } = spoolPaths(dir);
  return [previous, current].flatMap((path) => (readIfPresent(path) ?? '').split('\n').filter((line) => line !== ''));
};
