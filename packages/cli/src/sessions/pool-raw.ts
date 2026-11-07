// The raw part of the outbox (t884): one redacted copy of each transcript of a session that passed the gates, in the same outbox as the batches and printed by the same command. A copy is named for its
// session key, its place among the session's transcripts (0 is the main one), and the SHA-256 of its redacted bytes, which is the hash the pool's `/v1/raw/:sha256` routes take.
import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdirOwnerOnly, writeOwnerOnly } from './owner-only.js';
import { partsOf } from './pool-outbox.js';
import { REDACTION_VERSION } from './redact.js';
import { CAPTURE_VERSION } from './schema.js';

const RAW_FILE = /^([0-9a-f]{16})\.(\d+)\.([0-9a-f]{64})\.redacted$/;

/** Parts of a raw copy, each at most this many bytes: under the pool's 1 MB per request. */
export const RAW_PART_BYTES = 512 * 1024;

/** The folder of the raw copies this client builds now; one built under another redaction or capture version is never sent. */
export const rawStamp = (): string => `raw-r${REDACTION_VERSION}-c${CAPTURE_VERSION}`;

export const rawHash = (bytes: string): string => createHash('sha256').update(Buffer.from(bytes, 'utf8')).digest('hex');

const namesIn = async (folder: string): Promise<string[]> => {
  try {
    return (await readdir(folder)).sort();
  } catch {
    return [];
  }
};

/** Writes one redacted transcript for a session, replacing an earlier copy of the same place. */
export const writeRaw = async (outbox: string, key: string, place: number, bytes: string): Promise<{ hash: string; bytes: number }> => {
  const folder = join(outbox, rawStamp());
  const hash = rawHash(bytes);
  await mkdirOwnerOnly(folder);
  for (const name of await namesIn(folder)) {
    const found = RAW_FILE.exec(name);
    if (found?.[1] === key && Number(found[2]) === place && found[3] !== hash) await rm(join(folder, name), { force: true });
  }
  await writeOwnerOnly(join(folder, `${key}.${String(place)}.${hash}.redacted`), bytes);
  return { hash, bytes: Buffer.byteLength(bytes) };
};

export interface HeldRaw {
  key: string;
  place: number;
  hash: string;
  file: string;
  body: string;
  bytes: number;
}

/** The raw copies under the current stamp that still hash to their names; `edited` counts those that no longer do, which are neither printed nor sent. */
export const heldRaw = async (outbox: string): Promise<{ copies: HeldRaw[]; edited: number }> => {
  const folder = join(outbox, rawStamp());
  const copies: HeldRaw[] = [];
  let edited = 0;
  for (const name of await namesIn(folder)) {
    const found = RAW_FILE.exec(name);
    if (found === null) continue;
    const file = join(folder, name);
    const body = await readFile(file, 'utf8');
    if (rawHash(body) === found[3]) copies.push({ key: found[1] ?? '', place: Number(found[2]), hash: found[3], file, body, bytes: Buffer.byteLength(body) });
    else edited += 1;
  }
  return { copies, edited };
};

/** Removes every raw copy whose session key is not in `kept` (all of them when none is), and returns how many went. A folder switched off, a consent withdrawn, or a session no longer passing the gates leaves nothing queued. */
export const removeRawExcept = async (outbox: string, kept: ReadonlySet<string>, only?: string): Promise<number> => {
  const folder = join(outbox, rawStamp());
  let removed = 0;
  for (const name of await namesIn(folder)) {
    const found = RAW_FILE.exec(name);
    if (found !== null && !kept.has(found[1] ?? '') && (only === undefined || found[1] === only)) {
      await rm(join(folder, name), { force: true });
      removed += 1;
    }
  }
  return removed;
};

/** The parts a raw copy goes in, in order. */
export const rawParts = (body: string): string[] => partsOf(body, RAW_PART_BYTES);
