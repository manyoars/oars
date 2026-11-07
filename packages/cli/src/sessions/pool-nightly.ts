// The nightly send (t884 Item 4). After the person has accepted the pool's covenant, the nightly task builds the outbox and sends what is new: skeleton batches, and, only after a yes to the raw prompt, the locally redacted raw copies.
// Acceptance is the consent: this module never accepts a covenant, and with an unusable server URL, no sign-in, or no acceptance it makes one request at most (the covenant read) and sends nothing. `oars pool outbox` still prints everything that is queued.
// It never throws, and what it records is counts and an outcome word, never a path, a host, or a byte of a transcript.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunDeps } from '../cli.js';
import { ask, DEPOSIT, isObject, networkSender, poolDeposit, poolServer, postBatch, postRaw, runtimeOf, signedIn, textIn, vocabularyExpired, type Sender } from './pool-command.js';
import { heldBatches, lockedBatch, outboxFolder } from './pool-outbox.js';
import { heldRaw } from './pool-raw.js';
import { withSendLock } from './pool-send-lock.js';
import { markSent, sentHashes } from './pool-sent.js';
import { readState } from './store.js';

export type NightlyOutcome = 'no-server' | 'not-signed-in' | 'not-accepted' | 'failed' | 'sent';

export interface NightlyPool {
  outcome: NightlyOutcome;
  /** Batches and raw copies this night sent. */
  batches: number;
  raw: number;
}

const record = async (storeDir: string, result: NightlyPool, at: number): Promise<void> => {
  // A note that cannot be written changes nothing about the night.
  await writeFile(join(storeDir, 'pool-nightly.json'), `${JSON.stringify({ at: new Date(at).toISOString(), ...result })}\n`, 'utf8').catch(() => undefined);
};

/** Whether the pool says this account has accepted the covenant now in force. Anything else, a closed pool and a refusal included, is no. */
const accepted = async (deps: RunDeps, server: string, token: string, via: Sender): Promise<boolean> => {
  const reply = await ask(deps, DEPOSIT, server, '/v1/covenant', { token }, via);
  return reply.status === 200 && isObject(reply.body) && textIn(reply.body, 'version') !== undefined && Reflect.get(reply.body, 'accepted') === true;
};

const night = async (deps: RunDeps, net: Sender, tally: NightlyPool): Promise<NightlyPool> => {
  const none = (outcome: NightlyOutcome): NightlyPool => ({ outcome, batches: 0, raw: 0 });
  let server: string;
  try {
    server = poolServer(deps.env, DEPOSIT);
  } catch {
    return none('no-server');
  }
  const { storeDir } = runtimeOf(deps);
  let token: string;
  try {
    ({ token } = await signedIn(deps, storeDir, server, DEPOSIT));
  } catch {
    return none('not-signed-in');
  }
  if (vocabularyExpired(deps) !== undefined) return none('failed');
  if (!(await accepted(deps, server, token, net))) return none('not-accepted');
  const outbox = outboxFolder(storeDir, server);
  tally.outcome = 'sent';
  // One sender at a time per outbox, the lock `deposit --send` takes: a second run waits, then finds `sent.log` full and sends nothing twice.
  await withSendLock(outbox, async () => {
    // The outbox is built only for an account that has accepted, then sent: the same gates `oars pool deposit` runs, so nothing queues that a person could not print.
    await poolDeposit(deps, { server });
    const done = await sentHashes(outbox);
    for (const batch of (await heldBatches(outbox)).batches) {
      if (done.has(batch.hash)) continue;
      // Acceptance is the consent, so nothing was printed first; the file is still read and hashed again just before the request.
      const locked = await lockedBatch(outbox, batch.hash, { requireShown: false });
      if (!locked.ok) continue;
      await postBatch(deps, { server, token, bytes: locked.bytes, hash: batch.hash, via: net });
      await markSent(outbox, batch.hash, deps.now());
      tally.batches += 1;
    }
    // Raw goes only with its own yes, read again here so an answer changed since the build wins.
    if ((await readState(storeDir)).pool.rawConsent === 'granted') {
      for (const copy of (await heldRaw(outbox)).copies) {
        if (done.has(copy.hash) || copy.bytes === 0) continue;
        await postRaw(deps, { server, token, hash: copy.hash, body: copy.body, bytes: copy.bytes, via: net });
        await markSent(outbox, copy.hash, deps.now());
        tally.raw += 1;
      }
    }
  });
  return tally;
};

export const nightlyPoolSend = async (deps: RunDeps, via?: Sender): Promise<NightlyPool> => {
  // The tally is filled as sends land, so a night that fails halfway still records what it did send.
  const tally: NightlyPool = { outcome: 'failed', batches: 0, raw: 0 };
  let result: NightlyPool;
  try {
    result = await night(deps, via ?? networkSender(deps, DEPOSIT), tally);
  } catch {
    result = { ...tally, outcome: 'failed' };
  }
  await record(runtimeOf(deps).storeDir, result, deps.now());
  return result;
};
