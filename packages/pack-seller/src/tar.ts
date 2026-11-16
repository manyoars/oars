import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const BLOCK = 512;
const CHUNK = 64 * 1024;
/** Longest name a ustar header holds: a 100-byte name after a 155-byte prefix. */
const MAX_NAME = 100;
const MAX_PREFIX = 155;

/** A path the ustar format cannot hold; the build is then refused before any byte is sent. */
export class TarError extends Error {}

const field = (header: Buffer, at: number, length: number, value: string): void => {
  header.write(value, at, length, 'utf8');
};

const octal = (header: Buffer, at: number, length: number, value: number): void => {
  field(header, at, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
};

const split = (name: string): { prefix: string; base: string } => {
  if (Buffer.byteLength(name) <= MAX_NAME) return { prefix: '', base: name };
  for (let at = name.indexOf('/'); at !== -1; at = name.indexOf('/', at + 1)) {
    const [prefix, base] = [name.slice(0, at), name.slice(at + 1)];
    if (Buffer.byteLength(prefix) <= MAX_PREFIX && Buffer.byteLength(base) <= MAX_NAME) return { prefix, base };
  }
  throw new TarError('A file name in the pack is too long for the archive.');
};

const header = (name: string, size: number): Buffer => {
  const block = Buffer.alloc(BLOCK);
  const { prefix, base } = split(name);
  field(block, 0, MAX_NAME, base);
  octal(block, 100, 8, 0o644);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  octal(block, 124, 12, size);
  octal(block, 136, 12, 0);
  field(block, 148, 8, '        ');
  field(block, 156, 1, '0');
  field(block, 257, 6, 'ustar\0');
  field(block, 263, 2, '00');
  field(block, 345, MAX_PREFIX, prefix);
  const sum = block.reduce((total, byte) => total + byte, 0);
  field(block, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
};

const filesUnder = async (dir: string, below = ''): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of (await readdir(join(dir, below), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = below === '' ? entry.name : `${below}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(dir, path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
};

/** The file `validate-pack` checks before anything else; it is sent last, so an archive cut before it is rejected. */
export const MANIFEST_NAME = 'manifest.jsonl';

/**
 * The file list, checked up front so a name the archive cannot hold stops the download before a credit is reserved against a stream.
 * The manifest is last: the seller holds the last entry back until the credit is committed.
 */
export const archiveNames = async (dir: string): Promise<string[]> => {
  const found = await filesUnder(dir);
  for (const name of found) split(name);
  return [...found.filter((name) => name !== MANIFEST_NAME), ...found.filter((name) => name === MANIFEST_NAME)];
};

/** The two zero blocks that end a tar archive; the seller sends them only after the credit is committed, so a cut stream leaves an archive without its terminator. */
export const END_OF_ARCHIVE = Buffer.alloc(BLOCK * 2);

/** The files of `names` under `dir` as ustar entries, chunk by chunk, without the end blocks. */
export async function* entries(dir: string, names: readonly string[]): AsyncGenerator<Uint8Array> {
  for (const name of names) {
    const { size } = await stat(join(dir, name));
    yield header(name, size);
    const handle = await open(join(dir, name), 'r');
    try {
      for (let left = size; left > 0; ) {
        const chunk = Buffer.alloc(Math.min(CHUNK, left));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, size - left);
        if (bytesRead === 0) throw new TarError('A file in the pack changed while it was sent.');
        left -= bytesRead;
        yield chunk.subarray(0, bytesRead);
      }
    } finally {
      await handle.close();
    }
    if (size % BLOCK !== 0) yield Buffer.alloc(BLOCK - (size % BLOCK));
  }
}
