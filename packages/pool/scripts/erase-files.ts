// The scratch files the find reads a raw object from. `wrangler r2 object get --file` writes an object to disk, and the find streams it from there a piece at a time, so memory never holds an object whole and no wrangler output buffer ever does.
// The folder is made lazily, readable by the operator alone, and a file is removed as soon as its object has been read; `dispose` removes the folder whatever a failed run left in it.
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObjectFiles } from './erase-wrangler.js';

/** The most bytes one read of a scratch file hands the find. */
export const READ_CHUNK_BYTES = 64 * 1024;

/** The scratch files of one run, on disk. */
export const nodeFiles = (): ObjectFiles & { dispose: () => Promise<void> } => {
  let folder: string | undefined;
  let made = 0;
  return {
    temp: async () => {
      folder ??= await mkdtemp(join(tmpdir(), 'oars-erase-'));
      made += 1;
      return join(folder, `object-${String(made)}`);
    },
    read: (path) => createReadStream(path, { highWaterMark: READ_CHUNK_BYTES }),
    write: (path, text) => writeFile(path, text, 'utf8'),
    remove: (path) => rm(path, { force: true }),
    dispose: async () => {
      if (folder !== undefined) await rm(folder, { recursive: true, force: true });
    },
  };
};
