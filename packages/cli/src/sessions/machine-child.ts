// What the detached child of a machine Stop does (`hook-bin.js machine-child <input>`, started by `machine-stop.ts`): capture the session's transcript, then build its batch into the outbox. One child at a time per outbox, on the send
// lock: a Stop that finds the lock held writes the dirty mark (`send.dirty`, one input per line) and leaves, and the holder takes the mark and runs those sessions too before it lets go, so the last Stop of a burst is
// always built from the transcript as it ended. Before each extraction the child waits for the transcript to stop growing, because Stop can fire while the harness is still writing the last lines.
import { appendFile, rename, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SendLockBusy, withSendLock, type LockTimes } from './pool-send-lock.js';

/** What a Stop forwards: the session, its transcript, and the folder it ran in (the repository the allow list is checked against). */
export interface ChildInput {
  session: string;
  transcript: string;
  cwd: string | undefined;
}

export interface SettleTimes {
  /** The transcript must be this long unchanged. */
  quietMs: number;
  /** The wait is never longer than this: a transcript still growing is captured as it is. */
  maxMs: number;
  pollMs: number;
}

export const SETTLE: SettleTimes = { quietMs: 2000, maxMs: 15_000, pollMs: 250 };

export interface MachineChildDeps {
  outbox: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The transcript's size, or `undefined` when it cannot be read. */
  size: (path: string) => Promise<number | undefined>;
  /** Whether the session's repository is on the operator's allow list (`machine-repo.ts`); a session that is not is neither captured nor built. */
  allowed: (input: ChildInput) => Promise<boolean>;
  /** Captures the transcript (and its subagents) into the session store. */
  capture: (input: ChildInput) => Promise<void>;
  /** Builds the session's batch into the outbox, with the gates. */
  build: (input: ChildInput) => Promise<void>;
  settle?: SettleTimes;
  lock?: Partial<LockTimes>;
}

const DIRTY = 'send.dirty';

/** The input a Stop forwarded, or `undefined` when it names no session or transcript. */
export const parseChildInput = (text: string): ChildInput | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const session: unknown = Reflect.get(parsed, 'session_id');
  const transcript: unknown = Reflect.get(parsed, 'transcript_path');
  const cwd: unknown = Reflect.get(parsed, 'cwd');
  if (typeof session !== 'string' || session === '' || typeof transcript !== 'string' || transcript === '') return undefined;
  return { session, transcript, cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined };
};

/** Waits until the transcript has been the same size for `quietMs`, at most `maxMs` in all. */
export const settle = async (path: string, deps: Pick<MachineChildDeps, 'now' | 'sleep' | 'size'>, times: SettleTimes = SETTLE): Promise<'quiet' | 'timeout'> => {
  const start = deps.now();
  let last = await deps.size(path);
  let changed = start;
  for (;;) {
    const at = deps.now();
    if (at - changed >= times.quietMs) return 'quiet';
    if (at - start >= times.maxMs) return 'timeout';
    await deps.sleep(times.pollMs);
    const size = await deps.size(path);
    if (size !== last) {
      last = size;
      changed = deps.now();
    }
  }
};

/** The session's own latest input wins, in the order the sessions were first named. */
const byLatest = (inputs: readonly ChildInput[]): ChildInput[] => [...new Map(inputs.map((input) => [input.session, input])).values()];

/** One line in the wire shape a Stop forwards, so the holder reads a mark with the one parser. */
const markDirty = (outbox: string, input: ChildInput): Promise<void> => appendFile(join(outbox, DIRTY), `${JSON.stringify({ session_id: input.session, transcript_path: input.transcript, cwd: input.cwd })}\n`, 'utf8');

const hasDirty = (outbox: string): Promise<boolean> => stat(join(outbox, DIRTY)).then(() => true, () => false);

/** Claims the mark by renaming it, so two takers never read one mark and a Stop writing after the claim starts a mark of its own. */
const takeDirty = async (outbox: string): Promise<ChildInput[]> => {
  const claimed = join(outbox, `${DIRTY}.${String(process.pid)}`);
  try {
    await rename(join(outbox, DIRTY), claimed);
  } catch {
    return [];
  }
  const lines = (await readFile(claimed, 'utf8').catch(() => '')).split('\n');
  await rm(claimed, { force: true });
  return lines.flatMap((line) => {
    const input = line === '' ? undefined : parseChildInput(line);
    return input === undefined ? [] : [input];
  });
};

/** One session: check its repository against the allow list, wait for the transcript to settle, capture it, build its batch. A session off the list is not captured, so its transcript is never copied into the store; nothing is withdrawn either. */
const extract = async (deps: MachineChildDeps, input: ChildInput): Promise<void> => {
  if (!(await deps.allowed(input))) return;
  await settle(input.transcript, deps, deps.settle);
  await deps.capture(input);
  await deps.build(input);
};

/** Takes the lock without waiting and runs `work`, then every session marked dirty meanwhile; `false` when another child holds it. The first failure is rethrown once every session has had its turn. */
const locked = async (deps: MachineChildDeps, work: readonly ChildInput[]): Promise<boolean> => {
  try {
    await withSendLock(
      deps.outbox,
      async () => {
        let failure: Error | undefined;
        for (let pending = byLatest([...work, ...(await takeDirty(deps.outbox))]); pending.length > 0; pending = byLatest(await takeDirty(deps.outbox))) {
          for (const input of pending) {
            try {
              await extract(deps, input);
            } catch (error) {
              failure ??= error instanceof Error ? error : new Error(String(error));
            }
          }
        }
        if (failure !== undefined) throw failure;
      },
      { ...deps.lock, waitMs: 0 },
    );
    return true;
  } catch (error) {
    if (error instanceof SendLockBusy) return false;
    throw error;
  }
};

/**
 * `built` when this child ran the session (and anything marked while it did), `marked` when another child held the lock and the mark is left for it. Two windows are closed on purpose: a Stop that marks just after the holder's last look
 * finds the lock free on its second try, and a holder that lets go while a mark is being written looks once more after it has released.
 */
export const machineChild = async (deps: MachineChildDeps, input: ChildInput): Promise<'built' | 'marked'> => {
  if (await locked(deps, [input])) {
    if (await hasDirty(deps.outbox)) await locked(deps, []);
    return 'built';
  }
  await markDirty(deps.outbox, input);
  return (await locked(deps, [])) ? 'built' : 'marked';
};
