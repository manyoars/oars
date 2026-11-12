// The buyer key of a sample pack is a secret, and a value on a command line is logged by npm (debug logs), `just build` (builds.jsonl),
// process listings, and process-creation auditing. `--buyer-key-file <path>` keeps the value out of every argv; `deliver` and `sample-pack` share this one reader so they cannot drift.
import { readFile } from 'node:fs/promises';

/** The usage line both commands print for the file flag. */
export const BUYER_KEY_FILE_USAGE = '  --buyer-key-file <path>  read the buyer key from this file (trailing whitespace trimmed): the route for a real key, because a --buyer-key value on the command line is logged by npm and just';

/**
 * The buyer key from `--buyer-key` or `--buyer-key-file`, or a one-line refusal. A refusal names the flags and the path, never the key or any part of it.
 * Undefined `key` and `file` return `undefined` so the caller keeps its own "missing option" message.
 */
export const resolveBuyerKey = async (key: string | undefined, file: string | undefined): Promise<{ key: string } | { refusal: string } | undefined> => {
  if (key !== undefined && file !== undefined) return { refusal: 'Give --buyer-key or --buyer-key-file, not both.' };
  if (file === undefined) return key === undefined ? undefined : { key };
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return { refusal: `Cannot read the --buyer-key-file ${file}.` };
  // A BOM (Windows PowerShell 5 Out-File, some editors) is not part of the key.
  const trimmed = text.replace(/^\uFEFF/, '').trimEnd();
  return trimmed === '' ? { refusal: `The --buyer-key-file ${file} is empty.` } : { key: trimmed };
};
