// The scratch files the find reads a raw object from. `wrangler r2 object get --file` writes an object to disk, and the find streams it from there a piece at a time, so memory never holds an object whole and no wrangler output buffer ever does.
// The folder is made lazily, readable by the operator alone, and a file is removed as soon as its object has been read; `dispose` removes the folder whatever a failed run left in it.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ExportFolder } from './export-account.js';
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

/**
 * The folder an export is written to (`export-account.ts`): made on first write, and every file in it readable by the operator alone, since it holds the requester's personal data until it is encrypted for sending. A folder that already holds files is refused at the first write: a rerun would keep the files it does not write again, and a stale copy could be sent. Each run takes a new, empty folder. Within one run a file written twice is replaced.
 * The names come from the export (a page number or `raw/<sha256>`), never from the pool's text.
 */
export const nodeFolder = (path: string): ExportFolder => {
  const root = resolve(path);
  let checked: Promise<void> | undefined;
  const empty = async (): Promise<void> => {
    const held = await readdir(root).catch((error: unknown) => {
      // A folder not made yet reads as empty; any other failure (permissions, a file in its place) must not read as empty.
      if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return [];
      throw error;
    });
    if (held.length > 0) throw new Error(`${path} already holds files: use a new, empty folder for each run, so no copy from an earlier run is sent.`);
  };
  return {
    write: async (name, content) => {
      checked ??= empty();
      await checked;
      const file = join(root, name);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      if (typeof content === 'string') await writeFile(file, content, { encoding: 'utf8', mode: 0o600 });
      else await pipeline(Readable.from(content), createWriteStream(file, { mode: 0o600 }));
    },
    remove: (name) => rm(join(root, name), { force: true }),
  };
};
