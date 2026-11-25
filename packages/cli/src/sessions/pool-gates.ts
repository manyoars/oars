// The consent gates a build of the outbox applied, kept as one digest beside the batches (t1586 fix round). A full build withdraws the batch of every session that no
// longer passes them, so a batch in the outbox is only as current as the last build that finished. A night whose build throws sends what is already queued only while
// the gates read the same as they did then: a folder taken off the allowlist, a folder switched off, or a changed term file since means a held batch may be one the
// person has since withdrawn, and it is not sent until a build runs to take it out. The digest is a hash, never a folder name or a term.
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { writeOwnerOnly } from './owner-only.js';
import { contentHash } from './read.js';
import type { PoolChoices } from './store.js';

const GATES = 'gates.json';

/** One hash of the gate inputs a build reads: the allowlist, the per-folder send choices in `state.json`, and the exclusion terms (by their own hash, as the scan cache keys them). */
export const gateDigest = (allow: readonly string[], choices: Pick<PoolChoices, 'folders'>, terms: readonly string[]): string => contentHash([allow, choices.folders, contentHash(terms)]);

/** Records the digest of the gates a build that finished applied. Written aside and renamed, so a reader finds the old digest or the new one, never a part. */
export const recordGates = async (outbox: string, digest: string): Promise<void> => {
  const staged = join(outbox, `${GATES}.tmp`);
  await writeOwnerOnly(staged, `${JSON.stringify({ digest })}\n`);
  await rename(staged, join(outbox, GATES));
};

/** The digest the last finished build recorded; none when no build has recorded one or the file cannot be read as one, which a caller treats as changed gates. */
export const recordedGates = async (outbox: string): Promise<string | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(outbox, GATES), 'utf8'));
    const digest: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'digest') : undefined;
    return typeof digest === 'string' ? digest : undefined;
  } catch {
    return undefined;
  }
};
