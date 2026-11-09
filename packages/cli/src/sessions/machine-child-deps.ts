// The real parts of the machine child (`machine-child.ts`): the session store's capture, the pool's batch build, the file system and the clock. Loaded only by `hook-bin.js machine-child`, so a per-tool hook and the Stop
// itself never pay for the store and pool modules. It never throws: a failure is one masked line in `pool-send.log`, and the next Stop builds the same batch.
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { exclusionPaths, loadTerms } from './exclusion.js';
import { machineChild, parseChildInput, type ChildInput, type SettleTimes } from './machine-child.js';
import { holdBatch, runNetGit } from './machine-hold.js';
import { DEPOSIT, machineKeyOf, poolDeposit, poolServer, vocabularyExpired } from './pool-command.js';
import { machineOf, withInlineTerms, type MachineConfig } from './machine.js';
import { recordNotice } from './machine-notice.js';
import { repoAllowed } from './machine-repo.js';
import { logFailure } from './pool-due.js';
import { nightlyPoolDeps } from './pool-nightly-deps.js';
import { currentStamp, heldBatchOf, outboxFolder } from './pool-outbox.js';
import { depositSession, type SessionsRuntime } from './store.js';
import { runGit } from './survival.js';

/**
 * Holds the session's batch on its branch in the session's own repository (`machine-hold.ts`). A machine holds only when its enrollment gave it a machine id (the branch's `<machine>`) and `OARS_SESSION_SALT` (the key of the terms digest); one
 * enrolled without them builds into its outbox as before, and `runMachineChild` has told the person (before any gate, so a session a gate withdrew or a build that threw is told too). A session whose batch a gate withdrew has none in the outbox, so nothing is held for it.
 */
const holdSession = async (env: NodeJS.ProcessEnv, gated: NodeJS.ProcessEnv, sessions: SessionsRuntime, now: () => number, machine: MachineConfig | undefined, forwarded: ChildInput): Promise<void> => {
  if (machine === undefined) return;
  const { machine: name, sessionSalt: salt } = machine;
  if (name === undefined || salt === undefined) return;
  const id = machineKeyOf(machine, basename(forwarded.transcript, '.jsonl'));
  const held = await heldBatchOf(outboxFolder(sessions.storeDir, poolServer(env, DEPOSIT)), id);
  if (held === undefined) return;
  const terms = await loadTerms(exclusionPaths(sessions.projectsRoot, gated).terms);
  await holdBatch(
    { git: runGit, net: runNetGit, log: (error) => logFailure(sessions.storeDir, now(), error) },
    { cwd: forwarded.cwd, allowRepos: machine.allowRepos, machine: name, id, batch: held.bytes, stamp: currentStamp(), terms, salt },
  );
};

/** Runs the child for one Stop's forwarded input (`text`, the one argument `machine-stop.ts` passes). `settle` replaces the settle wait's times, which a test shortens. */
export const runMachineChild = async (env: NodeJS.ProcessEnv, sessions: SessionsRuntime, version: string, now: () => number, text: string, settle?: SettleTimes): Promise<void> => {
  const input = parseChildInput(text);
  if (input === undefined) return;
  try {
    // The terms the enrollment put in one variable are written to an owner-only file first, so every gate below reads the term file the way it always does.
    const gated = await withInlineTerms(env, sessions.storeDir);
    const repoSalt = env.OARS_REPO_SALT?.trim();
    const keyed = repoSalt === undefined || repoSalt === '' ? sessions : { ...sessions, repoSalt };
    const deps = nightlyPoolDeps(gated, keyed, version, now);
    // A client past its vocabulary's age builds no batch and its sessions wait. The child has no terminal, so the next Stop tells the person, from the notice file; nothing is captured or built until the client is upgraded.
    if (vocabularyExpired(deps) !== undefined) {
      await recordNotice(sessions.storeDir, 'vocabulary_expired', now());
      return;
    }
    const machine = machineOf(env);
    // A machine that cannot hold loses its session's data unseen, so the person is told at every Stop, before the work that can fail or withdraw: the next Stop prints it once.
    if (machine !== undefined && (machine.machine === undefined || machine.sessionSalt === undefined)) await recordNotice(sessions.storeDir, 'hold_unconfigured', now());
    const allowRepos = machine?.allowRepos ?? [];
    await machineChild(
      {
        outbox: outboxFolder(sessions.storeDir, poolServer(env, DEPOSIT)),
        now,
        ...(settle === undefined ? {} : { settle }),
        // The operator's repository list: the child builds a session only for a repository `origin` names on it.
        allowed: (forwarded) => repoAllowed(allowRepos, forwarded.cwd, runGit),
        sleep: async (ms) => {
          await sleep(ms);
        },
        size: (path) => stat(path).then((found) => found.size, () => undefined),
        capture: async (forwarded) => {
          await depositSession(keyed, forwarded.transcript, now);
        },
        // The store names a session by its transcript's file name, which is what the Stop's session is on every harness this build runs under.
        build: async (forwarded) => {
          await poolDeposit(deps, { session: basename(forwarded.transcript, '.jsonl') });
        },
        hold: (forwarded) => holdSession(env, gated, sessions, now, machine, forwarded),
      },
      input,
    );
  } catch (error) {
    await logFailure(sessions.storeDir, now(), error);
  }
};
