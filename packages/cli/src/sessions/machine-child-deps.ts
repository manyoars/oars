// The real parts of the machine child (`machine-child.ts`): the session store's capture, the pool's batch build, the file system and the clock. Loaded only by `hook-bin.js machine-child`, so a per-tool hook and the Stop
// itself never pay for the store and pool modules. It never throws: a failure is one masked line in `pool-send.log`, and the next Stop builds the same batch.
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { machineChild, parseChildInput, type SettleTimes } from './machine-child.js';
import { DEPOSIT, poolDeposit, poolServer } from './pool-command.js';
import { machineOf, withInlineTerms } from './machine.js';
import { repoAllowed } from './machine-repo.js';
import { logFailure } from './pool-due.js';
import { nightlyPoolDeps } from './pool-nightly-deps.js';
import { outboxFolder } from './pool-outbox.js';
import { depositSession, type SessionsRuntime } from './store.js';
import { runGit } from './survival.js';

/** Runs the child for one Stop's forwarded input (`text`, the one argument `machine-stop.ts` passes). `settle` replaces the settle wait's times, which a test shortens. */
export const runMachineChild = async (env: NodeJS.ProcessEnv, sessions: SessionsRuntime, version: string, now: () => number, text: string, settle?: SettleTimes): Promise<void> => {
  const input = parseChildInput(text);
  if (input === undefined) return;
  try {
    // The terms the enrollment put in one variable are written to an owner-only file first, so every gate below reads the term file the way it always does.
    const deps = nightlyPoolDeps(await withInlineTerms(env, sessions.storeDir), sessions, version, now);
    const allowRepos = machineOf(env)?.allowRepos ?? [];
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
          await depositSession(sessions, forwarded.transcript, now);
        },
        // The store names a session by its transcript's file name, which is what the Stop's session is on every harness this build runs under.
        build: async (forwarded) => {
          await poolDeposit(deps, { session: basename(forwarded.transcript, '.jsonl') });
        },
      },
      input,
    );
  } catch (error) {
    await logFailure(sessions.storeDir, now(), error);
  }
};
