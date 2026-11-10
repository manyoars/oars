// What the machine child does with the pool, after it has built and held a session's batch (`machine-child.ts` calls it under the send lock). First the key: a token is activated (`POST /v1/machines/activate`), and where the disk is durable the pool says to trade it for a fresh key
// (`/rotate`), which is written owner-only before the token is deleted, so a crash between the two leaves nothing worse than a run that finds the key and deletes the spent token. A cloud machine's token is held by its runtime's proxy and is its key for good. Then, once the covenant
// is accepted, every unsent batch the machine built goes to the pool (raw never: a machine key deposits none), and the key's expiry, from any answer that carries it or from the refusal of a dead key, is written to the notice file for the next Stop. A refusal is one masked line in
// `pool-send.log` and leaves the batch unsent; a dead key sends nothing and deletes nothing. No key or token value is ever logged or put in a notice.
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunDeps } from '../cli.js';
import { CliError } from '../errors.js';
import { credentialOf, keyFile, tokenFile, type MachineCredential } from './machine-credential.js';
import { machineOf } from './machine.js';
import { recordNotice, type NoticeCode } from './machine-notice.js';
import { writeOwnerOnly } from './owner-only.js';
import { ask, DEPOSIT, isObject, networkSender, poolServer, postBatch, refusal, runtimeOf, textIn, type Sender } from './pool-command.js';
import { logFailure } from './pool-due.js';
import { heldAcross, lockedBatch, outboxFolder } from './pool-outbox.js';
import { markSent, sentHashes } from './pool-sent.js';

/** A key this close to its expiry, or past it, is told to the person. */
export const EXPIRY_NOTICE_MS = 14 * 24 * 60 * 60 * 1000;

export type MachineSendOutcome = 'not-machine' | 'no-server' | 'no-credential' | 'refused' | 'not-accepted' | 'sent';

export interface MachineSend {
  outcome: MachineSendOutcome;
  /** Batches this run sent. */
  batches: number;
}

/** A cloud VM is new every time, so "activated" is a file in its own store; a durable machine's mark is its key file. */
const markerOf = (storeDir: string): string => join(storeDir, 'machine-activated');

const DEAD: { [code: string]: NoticeCode } = { machine_expired: 'machine_key_expired', machine_revoked: 'machine_key_revoked' };

interface Run {
  deps: RunDeps;
  server: string;
  storeDir: string;
  via: Sender;
  credential: MachineCredential;
}

/** The expiry an answer states, in epoch milliseconds: the deposit and covenant answers carry `machineExpiresAt`, activation the machine's `expiresAt`. A number or a date string. */
const expiryOf = (body: unknown): number | undefined => {
  if (!isObject(body)) return undefined;
  const machine: unknown = Reflect.get(body, 'machine');
  const value: unknown = Reflect.get(body, 'machineExpiresAt') ?? (isObject(machine) ? Reflect.get(machine, 'expiresAt') : undefined);
  const at = typeof value === 'string' ? Date.parse(value) : value;
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
};

/** Writes the key's state for the next Stop: expired, or expiring within the window; a key with longer to live writes nothing. */
const noteExpiry = async (storeDir: string, now: number, expiresAt: number): Promise<void> => {
  if (expiresAt <= now) await recordNotice(storeDir, 'machine_key_expired', now);
  else if (expiresAt - now <= EXPIRY_NOTICE_MS) await recordNotice(storeDir, 'machine_key_expiring', now, expiresAt);
};

/** A sender that notes the expiry any answer states as it passes. */
const watching = (deps: RunDeps, storeDir: string, net: Sender): Sender => async (request) => {
  const reply = await net(request);
  const expiresAt = reply.status < 300 ? expiryOf(reply.body) : undefined;
  if (expiresAt !== undefined) await noteExpiry(storeDir, deps.now(), expiresAt);
  return reply;
};

/** Whether the pool refused the key itself: that is written for the person, and the caller sends no more. */
const deadKey = async (run: Run, error: unknown): Promise<boolean> => {
  const notice = DEAD[error instanceof CliError ? (error.problem.code ?? '') : ''];
  if (notice === undefined) return false;
  await recordNotice(run.storeDir, notice, run.deps.now());
  return true;
};

/** A refusal that is logged, and noticed when it names a dead key. */
const failed = async (run: Run, error: unknown): Promise<undefined> => {
  await logFailure(run.storeDir, run.deps.now(), error);
  await deadKey(run, error);
  return undefined;
};

/** Activates a token and, where the pool says so, trades it for a key written owner-only; the token goes after the key is on disk. Returns the credential to send with, or `undefined` when the pool refused. */
const activated = async (run: Run, hostClass: string): Promise<MachineCredential | undefined> => {
  const { deps, server, storeDir, via, credential } = run;
  if (credential.source === 'key') {
    // A crash after the key was written and before the token was deleted leaves the token behind; it is spent, so it goes now.
    await rm(tokenFile(deps.env, storeDir), { force: true });
    return credential;
  }
  if (hostClass === 'cloud' && (await stat(markerOf(storeDir)).then(() => true, () => false))) return credential;
  const call = credential.token === undefined ? {} : { token: credential.token };
  const reply = await ask(deps, DEPOSIT, server, '/v1/machines/activate', { ...call, body: {} }, via);
  if (reply.status !== 200 || !isObject(reply.body)) {
    // A cloud machine whose runtime holds no network secret is a hold-only enrollment: the pool says the request carries no credential, and that is not a failure to report.
    const holdOnly = hostClass === 'cloud' && reply.status === 401 && isObject(reply.body) && textIn(reply.body, 'error') === 'unauthorized';
    return holdOnly ? undefined : failed(run, refusal(DEPOSIT, reply));
  }
  if (Reflect.get(reply.body, 'rotate') !== true) {
    await writeOwnerOnly(markerOf(storeDir), `${new Date(deps.now()).toISOString()}\n`);
    return credential;
  }
  const traded = await ask(deps, DEPOSIT, server, '/v1/machines/rotate', { ...call, body: {} }, via);
  const key = traded.status === 200 && isObject(traded.body) ? textIn(traded.body, 'key') : undefined;
  if (key === undefined) return failed(run, refusal(DEPOSIT, traded));
  await writeOwnerOnly(keyFile(storeDir), `${key}\n`);
  await rm(tokenFile(deps.env, storeDir), { force: true });
  return { source: 'key', token: key };
};

/** A refusal about this one batch (its content), after which the next may still go; anything else (a dead key, a closed pool, an unreachable one) ends the run. */
const aboutBatch = (error: unknown): boolean => error instanceof CliError && [400, 409, 413, 422].includes(error.problem.status ?? 0);

/** Activates if needed, checks the covenant, and sends every unsent batch this machine built. Never throws: every failure is a line in `pool-send.log`. */
export const machineSend = async (deps: RunDeps, via?: Sender): Promise<MachineSend> => {
  const none = (outcome: MachineSendOutcome): MachineSend => ({ outcome, batches: 0 });
  const machine = machineOf(deps.env);
  if (machine === undefined) return none('not-machine');
  const { storeDir } = runtimeOf(deps);
  try {
    let server: string;
    try {
      server = poolServer(deps.env, DEPOSIT);
    } catch {
      return none('no-server');
    }
    const first = await credentialOf(machine.hostClass, deps.env, storeDir);
    if (first === undefined) return none('no-credential');
    const net = watching(deps, storeDir, via ?? networkSender(deps, DEPOSIT));
    const credential = await activated({ deps, server, storeDir, via: net, credential: first }, machine.hostClass);
    if (credential === undefined) return none('refused');
    const run: Run = { deps, server, storeDir, via: net, credential };
    const { token } = credential;
    const covenant = await ask(deps, DEPOSIT, server, '/v1/covenant', token === undefined ? {} : { token }, net);
    if (covenant.status !== 200 || !isObject(covenant.body)) {
      await failed(run, refusal(DEPOSIT, covenant));
      return none('refused');
    }
    if (Reflect.get(covenant.body, 'accepted') !== true) return none('not-accepted');
    const outbox = outboxFolder(storeDir, server);
    const done = await sentHashes(outbox);
    const result = none('sent');
    for (const batch of (await heldAcross(outbox)).batches) {
      // A batch `hold pull` admitted is the trusted machine's to rescan against its terms and send; this machine's own are sent as built.
      if (done.has(batch.hash) || batch.pulled) continue;
      const locked = await lockedBatch(outbox, batch.hash, { requireShown: false, stamp: batch.stamp });
      if (!locked.ok) continue;
      try {
        await postBatch(deps, { server, token, bytes: locked.bytes, hash: batch.hash, via: net });
      } catch (error) {
        await failed(run, error);
        if (aboutBatch(error)) continue;
        return { ...result, outcome: 'refused' };
      }
      await markSent(outbox, batch.hash, deps.now());
      result.batches += 1;
    }
    return result;
  } catch (error) {
    await logFailure(storeDir, deps.now(), error);
    return none('refused');
  }
};
