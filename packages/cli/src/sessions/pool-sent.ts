// What the nightly send has already sent, so a night after a failure sends only what was not taken: one line for each hash, in the outbox beside `shown.log`. A batch that is rebuilt hashes differently and so is sent again, which is what a deposit that changed should do.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isMissing } from './pool-outbox.js';

const sentFile = (outbox: string): string => join(outbox, 'sent.log');

export const sentHashes = async (outbox: string): Promise<Set<string>> => {
  try {
    return new Set((await readFile(sentFile(outbox), 'utf8')).split('\n').map((line) => line.split(' ')[0] ?? '').filter((hash) => hash !== ''));
  } catch (error) {
    if (isMissing(error)) return new Set();
    throw error;
  }
};

export const markSent = async (outbox: string, hash: string, at: number): Promise<void> => {
  await mkdir(outbox, { recursive: true });
  await appendFile(sentFile(outbox), `${hash} ${new Date(at).toISOString()}\n`, 'utf8');
};
