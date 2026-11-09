// The real parts of the machine child (`machine-child.ts`): the session store's capture, the pool's batch build, the file system and the clock. Loaded only by `hook-bin.js machine-child`, so a per-tool hook and the Stop
// itself never pay for the store and pool modules. It never throws: a failure is one masked line in `pool-send.log`, and the next Stop builds the same batch.
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { machineChild, parseChildInput } from './machine-child.js';
import { DEPOSIT, poolDeposit, poolServer } from './pool-command.js';
import { logFailure } from './pool-due.js';
import { nightlyPoolDeps } from './pool-nightly-deps.js';
import { outboxFolder } from './pool-outbox.js';
import { depositSession, type SessionsRuntime } from './store.js';

/** Runs the child for one Stop's forwarded input (`text`, the one argument `machine-stop.ts` passes). */
export const runMachineChild = async (env: NodeJS.ProcessEnv, sessions: SessionsRuntime, version: string, now: () => number, text: string): Promise<void> => {
  const input = parseChildInput(text);
  if (input === undefined) return;
  const deps = nightlyPoolDeps(env, sessions, version, now);
  try {
    await machineChild(
      {
        outbox: outboxFolder(sessions.storeDir, poolServer(env, DEPOSIT)),
        now,
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
