// The detached sender (`hook-bin.js nightly`). After the person has accepted the pool's covenant, the sender builds the outbox and sends what is new: skeleton batches, and, only after a yes to the raw prompt, the locally redacted raw copies.
// Acceptance is the consent: this module never accepts a covenant, and with an unusable server URL, no sign-in, or no acceptance it makes one request at most (the covenant read) and sends nothing. `oars pool outbox` still prints everything that is queued.
// It never throws, and what it records is counts and an outcome word, never a path, a host, or a byte of a transcript.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunDeps } from '../cli.js';
import { CliError } from '../errors.js';
import { machineOf } from './machine.js';
import { ask, currentTerms, DEPOSIT, isObject, networkSender, poolDeposit, poolServer, postBatch, postRaw, runtimeOf, signedIn, textIn, vocabularyExpired, type Sender } from './pool-command.js';
import { rawStale } from './pool-choices.js';
import { heldAcross, lockedBatch, outboxFolder, rescanPulled } from './pool-outbox.js';
import { heldRaw } from './pool-raw.js';
import { withSendLock } from './pool-send-lock.js';
import { markSent, retirePulled, sentHashes } from './pool-sent.js';
import { readState } from './store.js';

export type NightlyOutcome = 'no-server' | 'machine' | 'not-signed-in' | 'not-accepted' | 'failed' | 'sent';

export interface NightlyPool {
  outcome: NightlyOutcome;
  /** Batches and raw copies this night sent. */
  batches: number;
  raw: number;
  /** Pulled batches the pool refused for its closed vocabulary or its format this night: each stays in the outbox, unsent, and is asked again the next night. Set only when there were some. */
  refused?: number;
  /** Pulled batches removed this night because they now hold a term of the exclusion file. Set only when there were some. */
  removed?: number;
  /** Set when a raw yes was held back because it was given under another covenant than the one in force; `oars pool raw --consent yes` answers for the covenant now in force. The sender prints nothing, so this note is where it shows. */
  rawHeld?: true;
}

const record = async (storeDir: string, result: NightlyPool, at: number): Promise<void> => {
  // A note that cannot be written changes nothing about the night.
  await writeFile(join(storeDir, 'pool-nightly.json'), `${JSON.stringify({ at: new Date(at).toISOString(), ...result })}\n`, 'utf8').catch(() => undefined);
};

/** The covenant version in force when the pool says this account has accepted it. Anything else, a closed pool and a refusal included, is `undefined`. */
const accepted = async (deps: RunDeps, server: string, token: string, via: Sender): Promise<string | undefined> => {
  const reply = await ask(deps, DEPOSIT, server, '/v1/covenant', { token }, via);
  return reply.status === 200 && isObject(reply.body) && Reflect.get(reply.body, 'accepted') === true ? textIn(reply.body, 'version') : undefined;
};

/** The pool's 422 for a value or a format its closed vocabulary does not read (a format older than it reads is the same code, on the field `format`). */
const isVocabularyRefusal = (error: unknown): boolean => error instanceof CliError && error.problem.code === 'closed_vocabulary';

const night = async (deps: RunDeps, net: Sender, tally: NightlyPool): Promise<NightlyPool> => {
  const none = (outcome: NightlyOutcome): NightlyPool => ({ outcome, batches: 0, raw: 0 });
  let server: string;
  try {
    server = poolServer(deps.env, DEPOSIT);
  } catch {
    return none('no-server');
  }
  // A machine's batches wait in the outbox: its Stop builds them for open sessions and allow-listed repositories only, and none of that is checked here, so this sender must never post them.
  if (machineOf(deps.env) !== undefined) return none('machine');
  const { storeDir } = runtimeOf(deps);
  let token: string;
  try {
    ({ token } = await signedIn(deps, storeDir, server, DEPOSIT));
  } catch {
    return none('not-signed-in');
  }
  if (vocabularyExpired(deps) !== undefined) return none('failed');
  const version = await accepted(deps, server, token, net);
  if (version === undefined) return none('not-accepted');
  const outbox = outboxFolder(storeDir, server);
  tally.outcome = 'sent';
  // One sender at a time per outbox, the lock `deposit --send` takes: a second run waits, then finds `sent.log` full and sends nothing twice.
  await withSendLock(outbox, async () => {
    // The outbox is built only for an account that has accepted, then sent: the same gates `oars pool deposit` runs, so nothing queues that a person could not print.
    await poolDeposit(deps, { server, covenant: version });
    const done = await sentHashes(outbox);
    // The current stamp's batches, then those `hold pull` filed under another stamp that outlived a vocabulary or field-list change.
    // A pulled batch can wait as long as the covenant stays closed, so each pass reads it against the term file as it is now: one that holds a term goes, and with no terms none is sent.
    const scan = await rescanPulled(outbox, await currentTerms(deps));
    if (scan.removed.length > 0) tally.removed = scan.removed.length;
    try {
      for (const batch of (await heldAcross(outbox)).batches) {
        if (done.has(batch.hash) || (batch.pulled && !scan.open)) continue;
        // Acceptance is the consent, so nothing was printed first; the file is still read and hashed again just before the request.
        const locked = await lockedBatch(outbox, batch.hash, { requireShown: false, stamp: batch.stamp });
        if (!locked.ok) continue;
        try {
          await postBatch(deps, { server, token, bytes: locked.bytes, hash: batch.hash, via: net });
        } catch (error) {
          // A pulled batch cannot be rebuilt (its raw is gone), and one the pool no longer reads must not stop the batches after it on every night: it stays, unsent and unmarked, and the note counts it.
          if (batch.pulled && isVocabularyRefusal(error)) {
            tally.refused = (tally.refused ?? 0) + 1;
            continue;
          }
          throw error;
        }
        await markSent(outbox, batch.hash, deps.now());
        tally.batches += 1;
      }
    } finally {
      // A pulled batch whose hash is in `sent.log` is done, however the night ended.
      await retirePulled(outbox, 'pool-nightly');
    }
    // Raw goes only with its own yes, read again here so an answer changed since the build wins.
    const choices = (await readState(storeDir)).pool;
    if (rawStale(choices, version)) tally.rawHeld = true;
    if (choices.rawConsent === 'granted' && !rawStale(choices, version)) {
      for (const copy of (await heldRaw(outbox)).copies) {
        if (done.has(copy.hash) || copy.bytes === 0) continue;
        await postRaw(deps, { server, token, hash: copy.hash, body: copy.body, bytes: copy.bytes, consent: version, via: net });
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
