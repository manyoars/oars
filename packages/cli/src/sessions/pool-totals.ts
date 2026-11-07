// What the outboxes hold across every server, for `oars sessions verify`: how much of it was already sent, and how many values the raw copies masked. Counts only.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { heldBatches } from './pool-outbox.js';
import { heldRaw } from './pool-raw.js';
import { sentHashes } from './pool-sent.js';
import { placeholders } from './redact.js';

export interface OutboxTotals {
  /** Batches of the current stamp whose hash `sent.log` holds. */
  sentBatches: number;
  /** Raw copies of the current stamp whose hash `sent.log` holds. */
  sentRaw: number;
  /** Raw copies queued now, and the placeholders in their bodies: the values masked locally before anything is sent. */
  rawCopies: number;
  rawMasked: number;
}

export const outboxTotals = async (storeDir: string): Promise<OutboxTotals> => {
  const root = join(storeDir, 'pool-outbox');
  const totals: OutboxTotals = { sentBatches: 0, sentRaw: 0, rawCopies: 0, rawMasked: 0 };
  for (const name of await readdir(root).catch((): string[] => [])) {
    const outbox = join(root, name);
    const done = await sentHashes(outbox);
    totals.sentBatches += (await heldBatches(outbox)).batches.filter(({ hash }) => done.has(hash)).length;
    const { copies } = await heldRaw(outbox);
    totals.sentRaw += copies.filter(({ hash }) => done.has(hash)).length;
    totals.rawCopies += copies.length;
    totals.rawMasked += copies.reduce((sum, { body }) => sum + placeholders(body), 0);
  }
  return totals;
};
