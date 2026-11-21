import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const BLOCK = 512;
export const MANIFEST_FILE = 'manifest.jsonl';
const BACKSLASH = String.fromCharCode(92);

/** An archive the buyer must not unpack: the message says which rule it broke, never a value from the archive's contents. */
export class UnsafePack extends Error {}

export interface TarFile {
  name: string;
  data: Uint8Array;
}

const text = (block: Uint8Array, at: number, length: number): string => {
  const raw = Buffer.from(block.subarray(at, at + length));
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
};

/** The rules for one entry name: relative, forward-slashed, no `..`, no drive letter, no NUL. */
export const checkName = (name: string): void => {
  if (name === '' || name.includes('\0')) throw new UnsafePack('The pack has an entry with no usable name.');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes(BACKSLASH)) throw new UnsafePack('The pack has an entry with an absolute or drive path, so nothing was written.');
  if (name.split('/').includes('..')) throw new UnsafePack('The pack has an entry that climbs out of the folder with "..", so nothing was written.');
};

/**
 * Reads a ustar archive whole and returns its files; directories are implied by file paths. Links, devices, and extended
 * headers are refused, and so is an archive with no end blocks (a cut download) or whose last file is not the manifest.
 * Nothing touches the disk here, so a refusal leaves nothing behind.
 */
export const readTar = (archive: Uint8Array): TarFile[] => {
  const files: TarFile[] = [];
  let at = 0;
  for (;;) {
    if (at + BLOCK * 2 > archive.length) throw new UnsafePack('The pack archive ends before its end blocks: the download was cut short.');
    const header = archive.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const prefix = text(header, 345, 155);
    const name = `${prefix === '' ? '' : `${prefix}/`}${text(header, 0, 100)}`;
    const type = String.fromCharCode(header[156] ?? 0);
    const size = Number.parseInt(text(header, 124, 12).trim() || '0', 8);
    if (type === '1' || type === '2') throw new UnsafePack('The pack has a link entry, so nothing was written.');
    if (type !== '0' && type !== '\0' && type !== '5') throw new UnsafePack('The pack has an entry of a kind this command does not unpack, so nothing was written.');
    if (!Number.isSafeInteger(size) || size < 0) throw new UnsafePack('The pack has an entry with an unreadable size.');
    checkName(type === '5' ? name.replace(/\/$/, '') : name);
    at += BLOCK;
    if (at + size > archive.length) throw new UnsafePack('The pack archive ends inside a file: the download was cut short.');
    if (type !== '5') files.push({ name, data: archive.subarray(at, at + size) });
    at += Math.ceil(size / BLOCK) * BLOCK;
  }
  if (files.at(-1)?.name !== MANIFEST_FILE) throw new UnsafePack(`The pack does not end with ${MANIFEST_FILE}: the download is incomplete.`);
  return files;
};

/** Writes the files under `folder`, which must already exist. Each name was checked by `readTar`. */
export const writeFiles = async (folder: string, files: readonly TarFile[]): Promise<void> => {
  for (const file of files) {
    const target = join(folder, ...file.name.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data);
  }
};

/**
 * A structural check of an unpacked pack: the manifest parses row by row and each row's `matchId` has its folder under
 * `sessions/`. The full spec check is `validate-pack` in packages/pool/scripts, which this package cannot import.
 * Returns one line per problem; none means the pack holds together.
 */
export const checkPack = async (folder: string): Promise<string[]> => {
  const problems: string[] = [];
  const lines = (await readFile(join(folder, MANIFEST_FILE), 'utf8')).split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) problems.push(`${MANIFEST_FILE}: no rows`);
  const ids = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const where = `${MANIFEST_FILE}:${String(index + 1)}`;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      problems.push(`${where}: not JSON`);
      continue;
    }
    const id: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'matchId') : undefined;
    if (typeof id !== 'string' || id === '') {
      problems.push(`${where}: matchId missing`);
      continue;
    }
    ids.add(id);
    const kept = await stat(join(folder, 'sessions', id)).then((entry) => entry.isDirectory(), () => false);
    if (!kept) problems.push(`${where}: no folder sessions/${id}`);
  }
  const folders = await readdir(join(folder, 'sessions')).catch((): string[] => []);
  for (const name of folders) if (!ids.has(name)) problems.push(`sessions/${name}: no manifest row names it`);
  return problems;
};
