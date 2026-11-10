// What the pool commands keep on this machine is the operator's alone: the pool account file holds a credential, and the outbox holds redacted transcripts and batches (census S9, S10). Files are written 0600 and folders 0700.
// `writeFile` and `mkdir` apply a mode only to what they create, so a file or folder an older client made wider is narrowed here too, and a file is narrowed before new bytes go into it.
// Windows has no POSIX mode bits (its own file ACLs apply), so there the calls are skipped.
import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises';

const POSIX = process.platform !== 'win32';

export const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Narrows a file that exists to 0600 before bytes go into it; a file not made yet is created 0600 by the write itself. */
const narrow = async (file: string): Promise<void> => {
  if (!POSIX) return;
  try {
    await chmod(file, 0o600);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
};

/** Appends `text` to `file`, which stays readable and writable by the owner only whether or not it existed. */
export const appendOwnerOnly = async (file: string, text: string): Promise<void> => {
  await narrow(file);
  await appendFile(file, text, { encoding: 'utf8', mode: 0o600 });
};

/** Writes `text` (or bytes, kept exactly as they are) to `file`, readable and writable by the owner only, whether or not the file existed. */
export const writeOwnerOnly = async (file: string, text: string | Uint8Array): Promise<void> => {
  await narrow(file);
  await writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
};

/** Makes `folder` (and any parent it has to create) 0700; a `folder` that exists is narrowed to 0700 as well. */
export const mkdirOwnerOnly = async (folder: string): Promise<void> => {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if (POSIX) await chmod(folder, 0o700);
};
