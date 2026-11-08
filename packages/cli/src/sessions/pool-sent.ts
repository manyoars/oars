// What the nightly send has already sent, so a night after a failure sends only what was not taken: one line for each hash, in the outbox beside `shown.log`. A batch that is rebuilt hashes differently and so is sent again, which is what a deposit that changed should do.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissing } from './pool-outbox.js';
import { appendOwnerOnly, mkdirOwnerOnly } from './owner-only.js';

const sentFile = (outbox: string): string => join(outbox, 'sent.log');

/** Each hash that was sent, with the time it was sent. A hash sent twice keeps its first time. */
export const sentLog = async (outbox: string): Promise<Map<string, string>> => {
  const log = new Map<string, string>();
  try {
    for (const line of (await readFile(sentFile(outbox), 'utf8')).split('\n')) {
      const [hash = '', at = ''] = line.split(' ');
      if (hash !== '' && !log.has(hash)) log.set(hash, at);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return log;
};

export const sentHashes = async (outbox: string): Promise<Set<string>> => new Set((await sentLog(outbox)).keys());

export const markSent = async (outbox: string, hash: string, at: number): Promise<void> => {
  await mkdirOwnerOnly(outbox);
  await appendOwnerOnly(sentFile(outbox), `${hash} ${new Date(at).toISOString()}\n`);
};
