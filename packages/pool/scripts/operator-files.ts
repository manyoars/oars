// What the operator's local commands (`license-status`, `notices`) share when they read match ids and the register files beside the owners file.
import { readFile } from 'node:fs/promises';
import { isAbsent, PackError } from './sample-pack.js';

export const MATCH_ID = /^[0-9a-f]{64}$/i;

/** A register file read, with a cut line named by its file and never quoted: the engine's own message repeats the text it could not read, which may be a session id. */
export const sound = async <T>(what: string, read: Promise<T>): Promise<T> => {
  try {
    return await read;
  } catch (error) {
    if (error instanceof SyntaxError) throw new PackError(`${what} holds a line that is not JSON.`);
    throw error;
  }
};

/** The match ids of an `--ids` file, one per line, blank lines skipped. A refusal names the line, never its text, which may be a session id. */
export const idsIn = async (file: string): Promise<string[]> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isAbsent(error)) throw new PackError('The --ids file is missing.');
    throw error;
  }
  const ids = text.split(String.fromCharCode(10)).map((row, at): [string, number] => [row.trim(), at + 1]).filter(([row]) => row !== '');
  const wrong = ids.find(([row]) => !MATCH_ID.test(row));
  if (wrong !== undefined) throw new PackError(`Line ${String(wrong[1])} of the --ids file is not a match id (64 hex characters).`);
  if (ids.length === 0) throw new PackError('The --ids file names no match id.');
  return ids.map(([row]) => row);
};
